// Where each track is while the song plays. The screen gives positions (the Song view's
// play marker per track, the marker after the row number on a chain or phrase view);
// between readings each track moves on through its chains, each step lasting the ticks its
// groove gives it (six, a sixteenth, by default): clock ticks when a MIDI clock is available,
// else ticks at the tempo the M8 shows.
//
// A reading says a step is showing *now*, so it started some time within the last step:
// each track keeps the window its anchor step started in, and every reading narrows it.
// Anchoring at the reading time instead runs a poll interval (or more) behind the M8.
//
// A HOP Y in a phrase sends the track, as it reaches the HOP's step, to row Y of the next phrase:
// the chain's next one, or the first of the next chain (the row after, or the start of the run).
// The HOP's own step does not play (on the device, HOP 00 on step 8 cycles steps 0-7). HOP FF
// stops the track there.
//
// A phrase can play more than once in a chain. The Phrase view marks its chain position (which
// repeat it shows) with a '<' in the margin, and while the song plays a second '<' on the chain
// row playing when that is another: the M8's own track is placed on the row playing, whichever
// repeat or phrase it is, MIDI or not.
//
// Play on a Phrase view plays that phrase alone, over and over, and sends no MIDI transport: one
// mark. A track loops its phrase when playing starts on a Phrase view (on the phrase's first beat,
// without a MIDI Start), or when the marker starts the phrase over while one mark stays; a second
// mark (the song plays on), the mark moving, or a reading elsewhere ends the loop.

import { type M8Screen, readPlayPositions } from '@yam8d/m8-sdk'
import { CLOCK_PPQ, chainStepTicks, DEFAULT_TICKS, occurrenceKey, summarizeTicks, type TicksSummary } from '../model/music/groove'
import { chainLength, fxValues, ROWS_PER_PHRASE, type SongModel, TRACKS } from '../model/song'
import type { Timeline } from '../model/timeline'
import { readChainMarks, type ViewKind, viewChainPosition, viewOf } from './screen/screenReader'

/** How late the screen shows a step (M8 redraw, serial, host, messages), roughly. */
const SCREEN_LATENCY_MS  = 20
/** Without a marker for this long, the song is taken as stopped. */
const STOPPED_AFTER_MS   = 900
/** A step window at most this share of the step counts as an exact position. */
const EXACT_WINDOW_SHARE = 0.6
const MIN_BPM            = 20
/**
 * The MIDI clock comes once per sixteenth, and runs even while the song is stopped. Without an
 * event for this long it is gone (SYNC OUT changed, another song loaded) and positions go back to
 * the tempo the screen shows; extrapolating a stale clock runs the playheads at the old tempo.
 */
const CLOCK_STALE_MS     = 2000
/** Walks through at most this many runs of steps (a chain, or up to a HOP) when moving a track on or measuring between steps. */
const MAX_CHAIN_WALK     = 512
const MAX_RUNS_AHEAD     = 32
/** HOP FF stops the track. */
const HOP_STOP           = 0xff
/** Play on a Phrase view starts the phrase from its top: the first marker seen is on one of these rows. */
const LOOP_START_ROWS    = 4
/** How long after a MIDI Stop the screen's play markers are stale (seen on the device: a read right after still had one). */
const STOP_SETTLE_MS     = 300

/** The step a track was last placed on, and the window its start lies in. */
interface Anchor {
  songRow : number
  /** Steps into the song row's chain. */
  step    : number
  /** When that step started lies in (earliest, latest], in ms or clock ticks (whichever drives the track). */
  earliest: number
  latest  : number
}

/** Step lengths of one chain occurrence in clock ticks, and where each step starts (one more entry: the total). */
interface ChainTicks {
  steps : number[]
  starts: number[]
}

interface SongViewReading {
  songRow: number
  at     : number
}

interface StepReading {
  songRow: number
  step   : number
  at     : number
}

interface MidiClock {
  ticks    : number
  /** When the last clock event came, in ms. */
  at       : number
  msPerTick: number
}

export interface TrackPlayhead {
  /** Timeline row being played, null when the track has nothing at this song row. */
  row    : number | null
  songRow: number
  /** True once the step is known (to within half a step), false while it is guessed. */
  exact  : boolean
  /** How far into its step the track is, 0 to 1 (the step lasts what its groove gives it). */
  phase  : number
  /** Step of the chain being played (a beat every 4). */
  step   : number
}

/** Why the song counts as stopped. */
export type StopReason = 'transport-stop' | 'markers-gone' | 'unmarked-view' | 'restart' | 'device-down' | 'other-song' | 'reset'

/** Things the tracker went through, for the debug log. */
export type PlaybackEvent =
  /** Playing began: from a MIDI Start / Continue (placed on a song row) or from a play marker on the screen. */
  | { kind: 'started'; source: 'transport' | 'screen'; spp: number | null; startRow: number | null }
  | { kind: 'stopped'; reason: StopReason }
  /** The MIDI clock went silent: positions are measured in ms again, at the tempo the screen shows. */
  | { kind: 'clock-lost'; silentMs: number }
  /** A reading did not fit the track's window: its position was restarted (a jump, a HOP, a tempo change, a drift). */
  | {
      kind    : 'reanchor'
      track   : number
      reason  : 'no-path' | 'window'
      /**
       * How far the M8 was from the prediction, in clock ticks: positive when it reached the step
       * later than the tracker had it, negative when earlier; null when no path led to it.
       */
      offTicks: number | null
      from    : { songRow: number; step: number }
      to      : { songRow: number; step: number }
    }
  /** A track began or stopped looping one phrase (Play on a Phrase view plays that phrase alone). */
  | {
      kind    : 'phrase-loop'
      track   : number
      looping : boolean
      why     : 'started-on-phrase' | 'started-over' | 'moved-on' | 'placed-elsewhere'
      songRow : number
      chainRow: number
    }

/** Where one track was placed, and how its steps differ from the plain sixteenth. */
export interface TrackPlacement {
  track  : number
  songRow: number
  step   : number
  chain  : number | null
  exact  : boolean
  ticks  : TicksSummary | null
}

const perTrack = <T>(): (T | null)[] => Array(TRACKS).fill(null)

function withStarts(steps: number[]): ChainTicks {
  const starts = [0]
  for (const ticks of steps) starts.push(starts[starts.length - 1] + ticks)
  return { steps, starts }
}

/** Ticks from the chain start to the start of `step` (the chain's total past its end). */
const startOf = (chain: ChainTicks, step: number): number => chain.starts[Math.min(step, chain.steps.length)]
const totalOf = (chain: ChainTicks): number => chain.starts[chain.steps.length]

/** A step of a track's chain on a song row. */
interface Place {
  songRow: number
  step   : number
}

/**
 * How a run of steps ends, from some step of a chain on: at the first HOP at or after it (the step
 * before it is the last one played), else at the chain's end (a looped phrase: at its own end).
 * `last` is the run's last step, `end` where in the chain's ticks it ends, `next` the step played
 * after it, null when a HOP FF stops the track.
 */
interface RunEnd {
  end : number
  last: number
  next: Place | null
}

/** A track playing one phrase over and over: the one at `chainRow` of its chain on `songRow`. */
interface PhraseLoop {
  songRow : number
  chainRow: number
}

/** The last marked Phrase view read: its phrase, marked row and chain position. */
interface PhraseMark {
  id           : number
  row          : number
  chainPosition: number | null
}

export class PlaybackTracker {
  playing      = false
  bpm          = 120
  /** Song row and track the M8 was last on (Song / Chain view), to tell which place a phrase on screen is. */
  context      : { songRow: number; track: number } | null = null
  /** The Phrase view's chain position as the M8 cursor knows it, for when two marks cannot say which is which. */
  viewChainRow : number | null = null
  /** Called when a phrase view shows another step than predicted (in steps). */
  onCorrection : (track: number, predicted: number, actual: number, clocked: boolean, songRow: number) => void = () => {}
  onEvent      : (event: PlaybackEvent) => void = () => {}

  private anchors                    = perTrack<Anchor>()
  /** Last Song view reading per track. */
  private lastSongViewReading        = perTrack<SongViewReading>()
  /** Last chain / phrase view reading per track. */
  private lastStepReading            = perTrack<StepReading>()
  private lastMarkerAt               = 0
  /** Since when a chain / phrase view that should show a marker has not (null while it does or is not expected to). */
  private unmarkedSince              : number | null = null
  /** MIDI Start / Continue came and no Stop since: the song ends with the Stop message, not with missing markers. */
  private transportRunning           = false
  private clock                      : MidiClock | null = null
  /** Step lengths of every chain occurrence, from the grooves (see chainStepTicks). */
  private readonly ticksByOccurrence = new Map<string, ChainTicks>()
  /** The HOPs of each chain: [chain step, value], by step. */
  private readonly hopsByChain       = new Map<number, [step: number, value: number][]>()
  /** The phrase each track loops, if it does. */
  private loops                      = perTrack<PhraseLoop>()
  /** The last Phrase view read, while each read shows it with a marker. */
  private lastPhraseMark             : PhraseMark | null = null
  /** The kind of the last grid view read (song, chain, phrase), null before any. */
  private lastViewKind               : ViewKind | null = null
  /** A MIDI Stop came: the next read starts the time its markers are ignored. */
  private stopPending                = false
  /** Screen markers count again from this time (ms). */
  private markersFrom                = 0
  /** The Phrase view's chain position (which of its marks is the view's), and the marks of the read before. */
  private viewMark                   : { id: number; row: number } | null = null
  private lastMarks                  : number[] = []
  /** The read before this one, when it was a Phrase view without a marker: its phrase and when. */
  private lastUnmarkedPhrase         : { id: number; at: number } | null = null

  constructor(
    private model: SongModel,
    private timeline: Timeline,
  ) {
    this.buildTicks()
  }

  setSong(model: SongModel, timeline: Timeline): void {
    this.model    = model
    this.timeline = timeline
    this.buildTicks()
  }

  private buildTicks(): void {
    this.ticksByOccurrence.clear()
    this.hopsByChain.clear()
    for (const [key, steps] of chainStepTicks(this.model, this.timeline)) this.ticksByOccurrence.set(key, withStarts(steps))
  }

  // ---------------------------------------------------------------------------
  // Time units: clock ticks when a MIDI clock runs, else milliseconds

  /** The "now" the anchors are measured in. */
  private now(ms: number): number {
    if (!this.clock) return ms
    return this.clock.ticks + (ms - this.clock.at) / this.clock.msPerTick
  }

  /** Forgets a clock that stopped: the anchors, measured in its ticks, are re-expressed in ms. */
  private dropStaleClock(ms: number): void {
    const clock = this.clock
    if (!clock || ms - clock.at < CLOCK_STALE_MS) return
    const toMs = (ticks: number) => clock.at + (ticks - clock.ticks) * clock.msPerTick
    for (const anchor of this.anchors) {
      if (!anchor) continue
      anchor.earliest = toMs(anchor.earliest)
      anchor.latest   = toMs(anchor.latest)
    }
    for (const reading of this.lastSongViewReading) if (reading) reading.at = toMs(reading.at)
    for (const reading of this.lastStepReading) if (reading) reading.at = toMs(reading.at)
    this.clock = null
    // Until the screen shows the tempo, the clock's own keeps the playheads where they are.
    this.bpm   = Math.max(MIN_BPM, 60000 / clock.msPerTick / CLOCK_PPQ)
    this.onEvent({
      kind    : 'clock-lost',
      silentMs: Math.round(ms - clock.at)
    })
  }

  /** One clock tick in the units the anchors are measured in. */
  private unitsPerTick(): number {
    return this.clock ? 1 : 60000 / this.bpm / CLOCK_PPQ
  }

  private latency(): number {
    return this.clock ? SCREEN_LATENCY_MS / this.clock.msPerTick : SCREEN_LATENCY_MS
  }

  // ---------------------------------------------------------------------------
  // The song's step lengths

  /** Step lengths of the chain a track plays on a song row; null for an empty cell. */
  private chainTicks(songRow: number, track: number): ChainTicks | null {
    if (this.model.song[songRow]?.[track] == null) return null
    // Rows the timeline does not have yet (read after it was built) play the default groove.
    return this.ticksByOccurrence.get(occurrenceKey(track, songRow)) ?? withStarts(Array(this.chainSteps(songRow, track)).fill(DEFAULT_TICKS))
  }

  /** How long a step lasts, in anchor units (a skipped step counts as a default one where a length is needed). */
  private stepUnits(songRow: number, track: number, step: number): number {
    return (this.chainTicks(songRow, track)?.steps[step] || DEFAULT_TICKS) * this.unitsPerTick()
  }

  /** How long phrase `chainRow` of a track's chain lasts, in anchor units. */
  private phraseUnits(songRow: number, track: number, chainRow: number): number {
    const chain = this.chainTicks(songRow, track)
    const ticks = chain ? startOf(chain, (chainRow + 1) * ROWS_PER_PHRASE) - startOf(chain, chainRow * ROWS_PER_PHRASE) : 0
    return (ticks || DEFAULT_TICKS * ROWS_PER_PHRASE) * this.unitsPerTick()
  }

  private chainSteps(songRow: number, track: number): number {
    const chainId = this.model.song[songRow]?.[track]
    return (chainId == null ? 0 : chainLength(this.model.chains[chainId])) * ROWS_PER_PHRASE
  }

  /** The row a track goes to after `row`: the next one, or back to the start of its block at an empty cell. */
  private nextRow(row: number, track: number): number {
    const chainAt = (songRow: number) => this.model.song[songRow]?.[track] ?? null
    if (chainAt(row + 1) != null) return row + 1
    let blockStart = row
    while (blockStart > 0 && chainAt(blockStart - 1) != null) blockStart -= 1
    return blockStart
  }

  /** The HOPs in the phrases a chain plays, by chain step (the first HOP of a step counts). */
  private chainHops(chainId: number): [step: number, value: number][] {
    const known = this.hopsByChain.get(chainId)
    if (known) return known
    const chain = this.model.chains[chainId]
    const hops  : [number, number][] = []
    for (let chainRow = 0; chain && chainRow < chainLength(chain); chainRow += 1) {
      this.model.phrases[chain.rows[chainRow]?.phrase ?? -1]?.steps.forEach((step, s) => {
        const [value] = fxValues(step.fx, 'HOP')
        if (value != null) hops.push([chainRow * ROWS_PER_PHRASE + s, value])
      })
    }
    this.hopsByChain.set(chainId, hops)
    return hops
  }

  /** How the run of steps from `step` of a track's chain on song row `songRow` ends (see RunEnd). */
  private runEnd(songRow: number, track: number, step: number, chain: ChainTicks): RunEnd {
    const loop  = this.loops[track]
    const first = loop?.songRow === songRow ? loop.chainRow * ROWS_PER_PHRASE : null
    if (loop && first != null && step >= first && step < first + ROWS_PER_PHRASE) return this.loopEnd(songRow, track, step, chain, loop)
    const run = this.chainRunEnd(songRow, track, step, chain)
    // A run that reaches the looped phrase goes into it.
    if (first != null && step < first && run.last >= first) return {
      end : startOf(chain, first),
      last: first - 1,
      next: {
        songRow,
        step: first
      }
    }
    return run
  }

  /** How the run of steps from `step` ends along the chain and its HOPs, loops aside. */
  private chainRunEnd(songRow: number, track: number, step: number, chain: ChainTicks): RunEnd {
    const chainId = this.model.song[songRow]?.[track]
    const hop     = chainId == null ? undefined : this.chainHops(chainId).find(([at]) => at >= step && at < chain.steps.length)
    if (!hop) return {
      end : totalOf(chain),
      last: chain.steps.length - 1,
      next: {
        songRow: this.nextRow(songRow, track),
        step   : 0
      }
    }
    const [at, value] = hop
    const chainRow    = Math.floor(at / ROWS_PER_PHRASE)
    const row         = value & 0x0f
    const inChain     = (chainRow + 1) * ROWS_PER_PHRASE < chain.steps.length
    return {
      end : startOf(chain, at),
      last: at - 1,
      next: value === HOP_STOP ? null : inChain ? {
        songRow,
        step: (chainRow + 1) * ROWS_PER_PHRASE + row
      } : {
        songRow: this.nextRow(songRow, track),
        step   : row
      }
    }
  }

  /**
   * How a run ends in a looped phrase: at its last step, back to its first; a HOP Y in it is taken
   * as going to its own row Y (not checked on the device), HOP FF as stopping the track.
   */
  private loopEnd(songRow: number, track: number, step: number, chain: ChainTicks, loop: PhraseLoop): RunEnd {
    const first   = loop.chainRow * ROWS_PER_PHRASE
    const after   = Math.min(first + ROWS_PER_PHRASE, chain.steps.length)
    const chainId = this.model.song[songRow]?.[track]
    const hop     = chainId == null ? undefined : this.chainHops(chainId).find(([at]) => at >= step && at < after)
    if (!hop) return {
      end : startOf(chain, after),
      last: after - 1,
      next: {
        songRow,
        step: first
      }
    }
    const [at, value] = hop
    return {
      end : startOf(chain, at),
      last: at - 1,
      next: value === HOP_STOP ? null : {
        songRow,
        step: first + (value & 0x0f)
      }
    }
  }

  /** The phrase at `chainRow` of a track's chain on `songRow`, null when there is none. */
  private phraseAt(songRow: number, track: number, chainRow: number): number | null {
    const chainId = this.model.song[songRow]?.[track]
    return chainId == null ? null : (this.model.chains[chainId]?.rows[chainRow]?.phrase ?? null)
  }

  /** Starts or ends a track's phrase loop. */
  private setLoop(track: number, loop: PhraseLoop | null, why: Extract<PlaybackEvent, { kind: 'phrase-loop' }>['why']): void {
    const was         = this.loops[track]
    this.loops[track] = loop
    const told        = loop ?? was
    if (told) this.onEvent({
      kind    : 'phrase-loop',
      track,
      looping : loop != null,
      why,
      songRow : told.songRow,
      chainRow: told.chainRow
    })
  }

  /** Places a track; a place outside the phrase it loops ends the loop. */
  private place(track: number, anchor: Anchor): void {
    const loop = this.loops[track]
    if (loop && (anchor.songRow !== loop.songRow || Math.floor(anchor.step / ROWS_PER_PHRASE) !== loop.chainRow)) this.setLoop(track, null, 'placed-elsewhere')
    this.anchors[track] = anchor
  }

  // ---------------------------------------------------------------------------
  // MIDI clock and transport

  /** MIDI clock: call on each clock event (ticks are monotonic, the clock may run while stopped). */
  clockTick(ticks: number, at: number, msPerTick: number): void {
    if (!this.clock) {
      // Re-express the anchors in ticks so the switch does not jump.
      const toTicks = (ms: number) => ticks - (at - ms) / msPerTick
      for (const anchor of this.anchors) {
        if (!anchor) continue
        anchor.earliest = toTicks(anchor.earliest)
        anchor.latest   = toTicks(anchor.latest)
      }
      for (const reading of this.lastSongViewReading) if (reading) reading.at = toTicks(reading.at)
      for (const reading of this.lastStepReading) if (reading) reading.at = toTicks(reading.at)
    }
    this.clock = { ticks, at, msPerTick }
  }

  /**
   * MIDI Start / Continue: the song plays from the cursor's song row. Every track has its own
   * playhead and loops its own run of chains: an empty cell ends the run and the track goes
   * back to the run's first chain. A track with an empty cell on the start row plays the last
   * chain above it. The Song Position counts from the start of the *cursor track's* run, up to
   * the cursor row (a cell without a chain counts the whole run: 2B, 2E and 33 sent 0 right
   * after empty rows, 2C 128, and the empty cells below a run all sent its length), so it does
   * not say which row plays: the song row the cursor is on does, and every track is placed
   * there at once, its first step starting on the next clock tick. Without a cursor, a position
   * only one song row starts at (counted from the last empty row, as for a song with one track)
   * is used. Returns false when no row is known (the screen markers take over).
   */
  transportStart(spp: number, ms: number): boolean {
    this.transportReset('restart')
    this.transportRunning = true
    const startRow        = this.context?.songRow ?? this.rowAtPosition(spp)
    if (startRow == null) return false
    const now  = this.now(ms)
    const tick = this.unitsPerTick()
    const into = this.stepsIntoChain(startRow, spp)
    for (let track = 0; track < TRACKS; track += 1) {
      const songRow = this.lastChainRow(startRow, track)
      const steps   = songRow == null ? 0 : this.chainSteps(songRow, track)
      if (songRow == null || steps === 0) continue
      // MIDI: after Start / Continue, the song moves on the first clock that follows.
      this.anchors[track] = {
        songRow,
        step    : songRow === startRow && into < steps ? into : 0,
        earliest: now + 0.5 * tick,
        latest  : now + 1.5 * tick
      }
    }
    this.playing      = true
    this.lastMarkerAt = ms
    this.onEvent({
      kind  : 'started',
      source: 'transport',
      spp,
      startRow
    })
    return true
  }

  /**
   * Shift+Play on a Chain or Phrase view continues the song at its chain position, and the Song
   * Position then counts the phrases before it in the chain too: 48 (3 x 16) from chain row 3 of
   * song row 00 (seen on the device, 2026-10-28). The steps into the chain the song starts at:
   * the whole phrases past the song row's own position, 0 elsewhere (Song view, or no fit).
   */
  private stepsIntoChain(songRow: number, spp: number): number {
    if (this.lastViewKind !== 'chain' && this.lastViewKind !== 'phrase') return 0
    const band  = this.timeline.bands.find((b) => b.songRow === songRow && !b.blank)
    const into  = band ? spp - (band.row - band.block) : 0
    const track = this.context?.track
    const steps = track == null ? 0 : this.chainSteps(songRow, track)
    return into > 0 && into < steps && into % ROWS_PER_PHRASE === 0 ? into : 0
  }

  /** The last song row at or above `row` where a track has a chain, null when it has none. */
  private lastChainRow(row: number, track: number): number | null {
    for (let songRow = row; songRow >= 0; songRow -= 1) if (this.model.song[songRow]?.[track] != null) return songRow
    return null
  }

  /** The one song row a Song Position names when the cursor is unknown (null when none or several do). */
  private rowAtPosition(spp: number): number | null {
    const starts = this.timeline.bands.filter((b) => !b.blank && b.row - b.block === spp)
    return starts.length === 1 ? starts[0].songRow : null
  }

  /** MIDI Start or Stop: positions start over (the clock itself keeps running). */
  transportReset(reason: StopReason = 'reset'): void {
    if (reason === 'transport-stop') this.stopPending = true
    const wasPlaying         = this.playing
    this.playing             = false
    this.transportRunning    = false
    this.unmarkedSince       = null
    this.anchors             = perTrack()
    this.loops               = perTrack()
    this.lastPhraseMark      = null
    this.lastSongViewReading = perTrack()
    this.lastStepReading     = perTrack()
    if (wasPlaying) this.onEvent({
      kind: 'stopped',
      reason
    })
  }

  // ---------------------------------------------------------------------------
  // Anchors

  /** When the anchor step started: the middle of its window, or its latest end while it is wide (a guess). */
  private anchorStart(anchor: Anchor, track: number): number {
    const window = anchor.latest - anchor.earliest
    return window > this.stepUnits(anchor.songRow, track, anchor.step) ? anchor.latest : (anchor.earliest + anchor.latest) / 2
  }

  private isExact(anchor: Anchor, track: number): boolean {
    return anchor.latest - anchor.earliest <= this.stepUnits(anchor.songRow, track, anchor.step) * EXACT_WINDOW_SHARE
  }

  /**
   * Song row and step a track is at, walking its steps' ticks from its anchor past HOPs and
   * chain ends; `stopped` once a HOP FF ended the track.
   */
  private walk(anchor: Anchor, track: number, now: number): { songRow: number; step: number; phase: number; stopped: boolean } {
    let songRow = anchor.songRow
    let from    = anchor.step
    let chain   = this.chainTicks(songRow, track)
    if (!chain) return {
      songRow,
      step   : from,
      phase  : 0,
      stopped: false
    }
    // Ticks to go from the start of step `from`.
    let left = Math.max(0, (now - this.anchorStart(anchor, track)) / this.unitsPerTick())
    let end  = this.runEnd(songRow, track, from, chain)
    for (let walked = 0; walked < MAX_CHAIN_WALK; walked += 1) {
      const room = end.end - startOf(chain, from)
      if (left < room) break
      // HOP FF: stopped on its step.
      if (!end.next) return {
        songRow,
        step   : end.last + 1,
        phase  : 0,
        stopped: true
      }
      if (end.next.songRow === songRow && end.next.step === from && room > 0) {
        // The run plays itself again (a looped phrase, a chain looping on itself): only the last time round counts.
        left %= room
        break
      }
      const next = this.chainTicks(end.next.songRow, track)
      // A run of skipped steps takes no time: stay rather than go round for ever.
      if (!next || room <= 0) break
      left    -= room
      songRow = end.next.songRow
      from    = end.next.step
      chain   = next
      end     = this.runEnd(songRow, track, from, chain)
    }
    // The step whose span holds the position (a skipped step has none), within the run.
    const position = Math.min(startOf(chain, from) + left, end.end - 1e-6)
    let step       = Math.min(from, chain.steps.length - 1)
    while (step < chain.steps.length - 1 && chain.starts[step + 1] <= position) step += 1
    const length = chain.steps[step]
    const phase  = length > 0 ? Math.min(0.999, Math.max(0, (position - chain.starts[step]) / length)) : 0
    return {
      songRow,
      step,
      phase,
      stopped: false
    }
  }

  /** Clock ticks from the start of (fromRow, fromStep) to the start of (toRow, toStep) on a track, along its HOPs; null when not ahead within a few runs. */
  private ticksBetween(track: number, fromRow: number, fromStep: number, toRow: number, toStep: number): number | null {
    let total = 0
    let place = {
      songRow: fromRow,
      step   : fromStep
    }
    for (let runs = 0; runs < MAX_RUNS_AHEAD; runs += 1) {
      const chain = this.chainTicks(place.songRow, track)
      if (!chain) return null
      const end   = this.runEnd(place.songRow, track, place.step, chain)
      if (place.songRow === toRow && toStep >= place.step && toStep <= end.last) return total + startOf(chain, toStep) - startOf(chain, place.step)
      total += end.end - startOf(chain, place.step)
      if (!end.next) return null
      place = end.next
    }
    return null
  }

  /** The step a track starts song row `songRow` on when it comes from `fromRow`: 0, or the row a HOP sends it to. */
  private entryStep(track: number, fromRow: number, songRow: number): number {
    let place = {
      songRow: fromRow,
      step   : 0
    }
    for (let runs = 0; runs < MAX_RUNS_AHEAD; runs += 1) {
      const chain = this.chainTicks(place.songRow, track)
      const next  = chain ? this.runEnd(place.songRow, track, place.step, chain).next : null
      if (!next) return 0
      if (next.songRow !== fromRow) return next.songRow === songRow ? next.step : 0
      place = next
    }
    return 0
  }

  /** True when (toRow, toStep) is the step a track plays right after (fromRow, fromStep), skipped steps aside. */
  private follows(track: number, fromRow: number, fromStep: number, toRow: number, toStep: number): boolean {
    const between = this.ticksBetween(track, fromRow, fromStep, toRow, toStep)
    const length  = this.chainTicks(fromRow, track)?.steps[fromStep] ?? 0
    return between != null && length > 0 && Math.abs(between - length) < 1e-6
  }

  /**
   * Narrows a track's window with "step `step` of song row `songRow` started in (earliest, latest]",
   * or restarts it there when the reading does not fit (a jump, a HOP, a tempo change).
   */
  private constrain(track: number, songRow: number, step: number, earliest: number, latest: number): void {
    const anchor = this.anchors[track]
    if (anchor) {
      const between = this.ticksBetween(track, anchor.songRow, anchor.step, songRow, step)
      let offTicks  : number | null = null
      if (between != null) {
        const shift            = between * this.unitsPerTick()
        const narrowedEarliest = Math.max(anchor.earliest, earliest - shift)
        const narrowedLatest   = Math.min(anchor.latest, latest - shift)
        if (narrowedEarliest < narrowedLatest) {
          // Kept on the latest reading: a run that comes round again (a looped phrase, a HOP back, a
          // chain looping on itself) would otherwise be measured from its first time round.
          this.anchors[track] = {
            songRow,
            step,
            earliest: narrowedEarliest + shift,
            latest  : narrowedLatest + shift
          }
          return
        }
        // The two windows do not meet: the gap between them is how far off the prediction was.
        const late = (earliest - shift - anchor.latest) / this.unitsPerTick()
        const soon = (latest - shift - anchor.earliest) / this.unitsPerTick()
        offTicks   = Math.round((late > 0 ? late : soon) * 10) / 10
      }
      this.onEvent({
        kind  : 'reanchor',
        track,
        reason: between == null ? 'no-path' : 'window',
        offTicks,
        from  : {
          songRow: anchor.songRow,
          step   : anchor.step
        },
        to    : {
          songRow,
          step
        }
      })
    }
    this.place(track, { songRow, step, earliest, latest })
  }

  // ---------------------------------------------------------------------------
  // Screen readings

  /** Feeds a screen read at `ms`. Returns true when it showed a play marker. */
  observe(screen: M8Screen, ms: number): boolean {
    this.dropStaleClock(ms)
    // The screen still shows the play markers a moment after a MIDI Stop: they would start it again.
    if (this.stopPending) {
      this.stopPending = false
      this.markersFrom = ms + STOP_SETTLE_MS
    }
    if (ms < this.markersFrom) return false
    const view  = viewOf(screen)
    const tempo = /T.(\d{2,3}(?:\.\d+)?)/.exec(screen.lines[5]?.slice(30) ?? '')
    if (tempo && !this.clock) this.bpm = Math.max(MIN_BPM, Number.parseFloat(tempo[1]))
    if (view.kind !== 'song' && view.kind !== 'chain' && view.kind !== 'phrase') {
      this.unmarkedSince      = null
      this.lastPhraseMark     = null
      this.lastUnmarkedPhrase = null
      this.lastMarks          = []
      return false
    }
    this.lastViewKind = view.kind
    const positions   = readPlayPositions(view.kind, screen)
    const now         = this.now(ms) - this.latency()
    const starting    = !this.playing
    let markerSeen    = false
    if (view.kind !== 'phrase' || positions?.row == null) this.lastPhraseMark = null
    // A Phrase view's marks: the chain row playing is the one that is not the view's, or the only one.
    const marks      = readChainMarks(view)
    const position   = view.kind === 'phrase' ? this.viewPosition(view.id, marks) : null
    const songOn     = marks.length === 2 && position != null
    const playingRow = songOn ? (marks.find((mark) => mark !== position) ?? null) : marks.length === 1 ? marks[0] : null
    this.lastMarks   = marks
    if (view.kind === 'song' && positions?.tracks) {
      markerSeen = this.observeSongView(positions.tracks, now)
    } else if (positions?.row != null && view.id != null) {
      markerSeen = true
      this.observeChainOrPhraseView(view.kind as 'chain' | 'phrase', view.id, positions.row, now, playingRow, starting, songOn)
    } else if (songOn && playingRow != null) {
      // Another phrase of the chain on screen plays: the second mark says which row.
      markerSeen = true
      this.observePlayingRow(playingRow, now)
    }
    this.updatePlaying(markerSeen, view.kind, view.id, ms, now)
    this.lastUnmarkedPhrase = view.kind === 'phrase' && view.id != null && positions?.row == null ? {
      id: view.id,
      at: now
    } : null
    return markerSeen
  }

  /** Which of a Phrase view's marks is its chain position, remembered for that phrase (see viewChainPosition). */
  private viewPosition(id: number | null, marks: number[]): number | null {
    const known   = id != null && this.viewMark?.id === id ? this.viewMark.row : this.viewChainRow
    const row     = viewChainPosition(marks, known, this.lastMarks)
    this.viewMark = id != null && row != null ? {
      id,
      row
    } : this.viewMark?.id === id ? this.viewMark : null
    return row
  }

  /**
   * A Phrase view whose second mark is on a row playing another phrase: the M8's track plays that
   * row of the chain on screen, which started within the last phrase (like a Chain view's marker).
   */
  private observePlayingRow(chainRow: number, now: number): void {
    const context = this.context
    const chainId = context ? this.model.song[context.songRow]?.[context.track] : null
    if (!context || chainId == null) return
    const track  = context.track
    if (this.loops[track]) this.setLoop(track, null, 'moved-on')
    const anchor  = this.anchors[track]
    const walked  = anchor ? this.walk(anchor, track, now) : null
    // The song row it walks when that row holds the same chain (a chain on several rows), else the M8's.
    const songRow = walked && !walked.stopped && this.model.song[walked.songRow]?.[track] === chainId ? walked.songRow : context.songRow
    this.constrain(track, songRow, chainRow * ROWS_PER_PHRASE, now - this.phraseUnits(songRow, track, chainRow), now)
  }

  /** The Song view marks each playing track's chain. */
  private observeSongView(trackRows: (number | null)[], now: number): boolean {
    let markerSeen = false
    trackRows.forEach((songRow, track) => {
      if (songRow == null) return
      markerSeen                      = true
      const before                    = this.lastSongViewReading[track]
      this.lastSongViewReading[track] = {
        songRow,
        at: now
      }
      const anchor                    = this.anchors[track]
      const placed                    = anchor ? this.walk(anchor, track, now) : null
      if (before && before.songRow !== songRow && this.nextRow(before.songRow, track) === songRow) {
        // Entered the row between the two readings (on step 0, or where a HOP sent it).
        this.constrain(track, songRow, this.entryStep(track, before.songRow, songRow), before.at, now)
      } else if (!placed || placed.stopped || placed.songRow !== songRow) {
        // First sight (or a jump): somewhere in the chain, shown from its start until known.
        const chain      = this.chainTicks(songRow, track)
        const chainUnits = (chain ? totalOf(chain) : 0) * this.unitsPerTick()
        this.place(track, {
          songRow,
          step    : 0,
          earliest: now - chainUnits,
          latest  : now
        })
      }
    })
    return markerSeen
  }

  /**
   * A Chain or Phrase view marks the row playing, for the tracks that play what it shows;
   * `chainPosition` is the chain row a Phrase view's marks say plays, `starting` says no song was
   * playing before this reading, `songOn` that a second mark says the song plays on.
   */
  private observeChainOrPhraseView(
    kind: 'chain' | 'phrase',
    id: number,
    markedRow: number,
    now: number,
    chainPosition: number | null,
    starting: boolean,
    songOn = false,
  ): void {
    if (kind === 'phrase') this.notePhraseLoop(id, markedRow, chainPosition, now, songOn)
    let matched = false
    for (let track = 0; track < TRACKS; track += 1) {
      const anchor = this.anchors[track]
      if (!anchor) continue
      const { songRow, step, stopped } = this.walk(anchor, track, now)
      const chainId                    = this.model.song[songRow]?.[track]
      if (chainId == null || stopped) continue
      const walkedRow = Math.floor(step / ROWS_PER_PHRASE)
      if (kind === 'chain' && chainId === id) {
        // That phrase started within the last phrase length.
        this.constrain(track, songRow, markedRow * ROWS_PER_PHRASE, now - this.phraseUnits(songRow, track, markedRow), now)
        matched = true
      }
      const chainRow = kind === 'phrase' ? this.phraseRepeat(track, songRow, walkedRow, id, chainPosition) : null
      if (chainRow != null) {
        const actual = chainRow * ROWS_PER_PHRASE + markedRow
        if (actual !== step) this.onCorrection(track, step, actual, this.clock != null, songRow)
        // Showing now: it started within the last step. Just after the step before it was
        // showing: it started between the two readings, a much tighter window.
        const stepUnits = this.stepUnits(songRow, track, actual)
        const before    = this.lastStepReading[track]
        const followed  = before && this.follows(track, before.songRow, before.step, songRow, actual)
        this.constrain(track, songRow, actual, followed ? Math.max(before.at, now - stepUnits) : now - stepUnits, now)
        this.lastStepReading[track] = {
          songRow,
          step: actual,
          at  : now
        }
        matched                     = true
      }
    }
    if (!matched) {
      const placed   = this.placeFromScreen(kind, id, markedRow, now, chainPosition)
      const anchor   = placed == null ? null : this.anchors[placed]
      // Playing that starts on a Phrase view without a MIDI Start is Play on that view: that phrase alone.
      // Started, not caught midway: on its first beat, or since the read before (the view without a marker).
      const unmarked = this.lastUnmarkedPhrase
      const fresh    =
        markedRow < LOOP_START_ROWS ||
        (placed != null && anchor != null && unmarked?.id === id && (markedRow - 1) * this.stepUnits(anchor.songRow, placed, anchor.step) <= now - unmarked.at)
      if (placed != null && anchor && kind === 'phrase' && starting && fresh && !songOn && !this.transportRunning) {
        this.setLoop(placed, {
          songRow : anchor.songRow,
          chainRow: Math.floor(anchor.step / ROWS_PER_PHRASE)
        }, 'started-on-phrase')
      }
    }
  }

  /**
   * A Phrase view whose marker starts the phrase over while its one mark stays: the M8 plays that
   * phrase alone, where the track's walk had it go on, so the track loops it. A second mark (the
   * song plays on) or the mark moved ends a loop, and the reading places the track afresh.
   */
  private notePhraseLoop(id: number, markedRow: number, chainPosition: number | null, now: number, songOn: boolean): void {
    const last          = this.lastPhraseMark
    this.lastPhraseMark = {
      id,
      row: markedRow,
      chainPosition
    }
    if (chainPosition == null) return
    // A song started from the MIDI transport plays on (Play on a Phrase view sends none).
    const startedOver = !songOn && !this.transportRunning && last != null && last.id === id && last.chainPosition === chainPosition && markedRow < last.row
    for (let track = 0; track < TRACKS; track += 1) {
      const loop = this.loops[track]
      if (loop) {
        if (songOn || loop.chainRow !== chainPosition) {
          this.setLoop(track, null, 'moved-on')
          this.anchors[track] = null
        }
        continue
      }
      const anchor = this.anchors[track]
      const before = this.lastStepReading[track]
      if (!startedOver || !anchor || !before || Math.floor(before.step / ROWS_PER_PHRASE) !== chainPosition) continue
      if (this.phraseAt(before.songRow, track, chainPosition) !== id) continue
      // The song going on to the same phrase at the same chain position (the chain on the next song row) looks the same.
      const { songRow, step, stopped } = this.walk(anchor, track, now)
      if (!stopped && Math.floor(step / ROWS_PER_PHRASE) === chainPosition && this.phraseAt(songRow, track, chainPosition) === id) continue
      this.setLoop(track, {
        songRow : before.songRow,
        chainRow: chainPosition
      }, 'started-over')
    }
  }

  /**
   * The chain row phrase `id` on screen plays at on a track whose walk is on `walkedRow`: on the
   * track the M8 shows, the row its marks say plays (`chainPosition`); else the walked row. Null
   * when that row plays another phrase.
   */
  private phraseRepeat(track: number, songRow: number, walkedRow: number, id: number, chainPosition: number | null): number | null {
    const chainId = this.model.song[songRow]?.[track]
    const rows    = chainId == null ? undefined : this.model.chains[chainId]?.rows
    const context = this.context
    const shown   =
      chainPosition != null &&
      context?.track === track &&
      this.model.song[context.songRow]?.[track] === chainId &&
      rows?.[chainPosition]?.phrase === id
    if (shown) return chainPosition
    return rows?.[walkedRow]?.phrase === id ? walkedRow : null
  }

  /** No track known to be there yet: the place of the song that plays what is on screen (on a Phrase view, the repeat at its '<'). */
  private placeFromScreen(kind: 'chain' | 'phrase', id: number, markedRow: number, now: number, chainPosition: number | null): number | null {
    const shown   = this.timeline.instances.filter((i) => (kind === 'chain' ? i.chain === id && i.chainRow === markedRow : i.phrase === id))
    const atMark  = shown.filter((i) => i.chainRow === chainPosition)
    const places  = atMark.length > 0 ? atMark : shown
    const context = this.context
    const place   =
      places.find((i) => context && i.track === context.track && i.songRow === context.songRow) ??
      places.find((i) => context && i.track === context.track) ??
      places[0]
    if (!place) return null
    const onPhrase = kind === 'phrase'
    const step     = onPhrase ? place.chainRow * ROWS_PER_PHRASE + markedRow : markedRow * ROWS_PER_PHRASE
    const window   = onPhrase ? this.stepUnits(place.songRow, place.track, step) : this.phraseUnits(place.songRow, place.track, markedRow)
    this.place(place.track, {
      songRow : place.songRow,
      step,
      earliest: now - window,
      latest  : now
    })
    return place.track
  }

  /**
   * True when the Phrase view on screen shows its chain position alone while the M8's track, by
   * what we know, plays another row of that chain: the song would add a second mark there.
   */
  private expectsSecondMark(now: number): boolean {
    const context  = this.context
    const position = this.viewMark?.row
    if (this.transportRunning || !context || position == null || this.lastMarks.length !== 1) return false
    const anchor = this.anchors[context.track]
    const walked = anchor ? this.walk(anchor, context.track, now) : null
    if (!walked || walked.stopped) return false
    const chainId = this.model.song[context.songRow]?.[context.track]
    return chainId != null && this.model.song[walked.songRow]?.[context.track] === chainId && Math.floor(walked.step / ROWS_PER_PHRASE) !== position
  }

  /** Whether the song still plays after a reading with or without a marker. */
  private updatePlaying(markerSeen: boolean, kind: 'song' | 'chain' | 'phrase', id: number | null, ms: number, now: number): void {
    if (markerSeen) {
      const started      = !this.playing
      this.playing       = true
      this.lastMarkerAt  = ms
      this.unmarkedSince = null
      if (started) this.onEvent({
        kind    : 'started',
        source  : 'screen',
        spp     : null,
        startRow: null
      })
      return
    }
    if (!this.playing) return
    if (kind === 'song') {
      // Every playing track has a marker on the Song view: none left means stopped, unless
      // the MIDI transport says it plays (the playing rows are scrolled off screen).
      if (!this.transportRunning && ms - this.lastMarkerAt > STOPPED_AFTER_MS) this.transportReset('markers-gone')
    } else if (this.expectsMarker(kind, id, now) || (kind === 'phrase' && this.expectsSecondMark(now))) {
      // The chain / phrase on screen should be playing by what we know, yet it shows no marker.
      this.unmarkedSince ??= ms
      if (ms - this.unmarkedSince > STOPPED_AFTER_MS) this.transportReset('unmarked-view')
    } else {
      // Another chain / phrase than the ones playing: no marker is expected there, which says
      // nothing about the song (the positions keep running from the clock and the anchors).
      this.unmarkedSince = null
    }
  }

  /**
   * True when a track is known to be on this chain / phrase, so its marker should show; a
   * missing one then means the song stopped. Without that knowledge (browsing the M8 to a
   * chain or phrase nothing plays) a missing marker is no evidence, and with the MIDI
   * transport the Stop message is what ends the song.
   */
  private expectsMarker(kind: 'chain' | 'phrase', id: number | null, now: number): boolean {
    if (this.transportRunning || id == null) return false
    for (let track = 0; track < TRACKS; track += 1) {
      const anchor = this.anchors[track]
      if (!anchor) continue
      const { songRow, step, stopped } = this.walk(anchor, track, now)
      const chainId                    = this.model.song[songRow]?.[track]
      if (chainId == null || stopped) continue
      const playing = kind === 'chain' ? chainId : this.model.chains[chainId]?.rows[Math.floor(step / ROWS_PER_PHRASE)]?.phrase
      if (playing === id) return true
    }
    return false
  }

  /** Clock ticks step `step` of the chain a track plays on a song row lasts (0 for a skipped step); null when it has no chain there. */
  ticksAt(songRow: number, track: number, step: number): number | null {
    return this.chainTicks(songRow, track)?.steps[step] ?? null
  }

  /** The tracks that have a position now: where they are and how their steps' lengths differ from the plain sixteenth. */
  describeTracks(): TrackPlacement[] {
    const placements: TrackPlacement[] = []
    this.anchors.forEach((anchor, track) => {
      if (!anchor) return
      const chain = this.chainTicks(anchor.songRow, track)
      placements.push({
        track,
        songRow: anchor.songRow,
        step   : anchor.step,
        chain  : this.model.song[anchor.songRow]?.[track] ?? null,
        exact  : this.isExact(anchor, track),
        ticks  : chain ? summarizeTicks(chain.steps) : null
      })
    })
    return placements
  }

  /** Each track's playhead at time `ms`. */
  playheads(ms: number): (TrackPlayhead | null)[] {
    this.dropStaleClock(ms)
    if (!this.playing) return perTrack()
    const now = this.now(ms)
    return this.anchors.map((anchor, track) => {
      if (!anchor) return null
      const { songRow, step, phase, stopped } = this.walk(anchor, track, now)
      if (stopped) return null
      const band   = this.timeline.bands.find((b) => b.songRow === songRow)
      const length = this.chainSteps(songRow, track)
      const row    = band && length ? band.row + Math.min(step, length - 1) : null
      return {
        row,
        songRow,
        exact: this.isExact(anchor, track),
        phase,
        step
      }
    })
  }
}

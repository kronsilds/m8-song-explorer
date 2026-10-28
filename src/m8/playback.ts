// Where each track is while the song plays. The screen gives positions (the Song view's
// play marker per track, the marker after the row number on a chain or phrase view);
// between readings each track moves on through its chains, each step lasting the ticks its
// groove gives it (six, a sixteenth, by default): clock ticks when a MIDI clock is available,
// else ticks at the tempo the M8 shows.
//
// A reading says a step is showing *now*, so it started some time within the last step:
// each track keeps the window its anchor step started in, and every reading narrows it.
// Anchoring at the reading time instead runs a poll interval (or more) behind the M8. A reading
// is measured from where the track was as its window opens, so a step the track comes back to (a
// chain looping on itself, a HOP back) is matched with its latest time round, not its first.
//
// Phrase HOPs follow PlayPath: HOP 0Y goes to row Y of the next phrase (the next song row's after
// the chain's last), its step never playing; HOP XY with X > 0 goes back to row Y of its own phrase
// X times, then plays on; HOP FF stops the track. The hops a track has taken travel with its anchor.
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
import { noteNumber } from '../model/music/pitch'
import { type HopCounts, hopsKey, NO_HOPS, type Place, PlayPath, type Run } from '../model/music/playPath'
import { ROWS_PER_PHRASE, type SongModel, TRACKS } from '../model/song'
import type { Timeline } from '../model/timeline'
import { readChainMarks, readTrackNotes, type ViewKind, viewChainPosition, viewOf } from './screen/screenReader'

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
const MAX_RUNS_AHEAD     = 64
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
  /** The counted HOPs the track has hopped at (see PlayPath). */
  hops    : HopCounts
  /** Steps started since playing began, this one included: a step played again counts again. */
  serial  : number
  /** Reached by moving on (a start), not read on screen: a HOP on its step hops rather than plays. */
  reached?: boolean
}

/** Where a walk from an anchor got to. */
interface Walked {
  songRow: number
  step   : number
  phase  : number
  /** A HOP FF stopped the track. */
  stopped: boolean
  /** Clock ticks from the anchor step's start to this step's start. */
  offset : number
  serial : number
  hops   : HopCounts
}

/** One time a track reaches a step ahead: clock ticks to it, and the track's state there. */
interface Reached {
  ticks : number
  hops  : HopCounts
  serial: number
}

/** The note a track's panel shows (right of most views), and when it last changed (ms). */
export interface TrackNote {
  /** Semitones (C-0 = 0), null for '---'. */
  pitch    : number | null
  changedAt: number
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
  hops   : HopCounts
}

interface MidiClock {
  ticks    : number
  /** When the last clock event came, in ms. */
  at       : number
  msPerTick: number
}

export interface TrackPlayhead {
  /** Timeline row being played, null when the track has nothing at this song row. */
  row      : number | null
  songRow  : number
  /** True once the step is known (to within half a step), false while it is guessed. */
  exact    : boolean
  /** How far into its step the track is, 0 to 1 (the step lasts what its groove gives it). */
  phase    : number
  /** Step of the chain being played (a beat every 4). */
  step     : number
  /** Steps started since playing began: it changes as each step starts, a step a HOP or a loop plays again too. */
  serial   : number
  /** When the step started, in ms (performance.now). */
  startedAt: number
  /** The note the M8's track panel shows, the evidence of what it really played (chance, random FX). */
  note     : TrackNote | null
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
const startOf = (chain: ChainTicks, step: number): number => chain.starts[Math.max(0, Math.min(step, chain.steps.length))]
const totalOf = (chain: ChainTicks): number => chain.starts[chain.steps.length]

/** Steps from `from` to `to` (both included) that start, a skipped step (no ticks) aside. */
function startsIn(chain: ChainTicks, from: number, to: number): number {
  let count = 0
  for (let step = Math.max(0, from); step <= to && step < chain.steps.length; step += 1) if (chain.steps[step] > 0) count += 1
  return count
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
  /** Where the tracks go: chain ends and phrase HOPs. */
  private path                       : PlayPath
  /** The note each track's panel last showed. */
  private trackNotes                 = perTrack<TrackNote & { text: string | null }>()
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
    this.path = new PlayPath(model)
    this.buildTicks()
  }

  setSong(model: SongModel, timeline: Timeline): void {
    this.model    = model
    this.timeline = timeline
    this.path     = new PlayPath(model)
    this.buildTicks()
  }

  private buildTicks(): void {
    this.ticksByOccurrence.clear()
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
    return this.path.chainSteps(songRow, track)
  }

  /** The run of steps from `place` on (see PlayPath.run), into the phrase the track loops if it reaches it. */
  private run(track: number, place: Place, hops: HopCounts, playing: boolean): Run {
    const loop  = this.loops[track]
    const first = loop?.songRow === place.songRow ? loop.chainRow * ROWS_PER_PHRASE : null
    if (loop && first != null && place.step >= first && place.step < first + ROWS_PER_PHRASE) return this.path.run(track, place, hops, playing, loop.chainRow)
    const run = this.path.run(track, place, hops, playing)
    // A run that reaches the looped phrase goes into it.
    if (first != null && place.step < first && run.last >= first) return {
      last: first - 1,
      next: {
        songRow: place.songRow,
        step   : first
      },
      hops: this.path.passed(track, place, hops, first - 1)
    }
    return run
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
        latest  : now + 1.5 * tick,
        hops    : NO_HOPS,
        serial  : 0,
        reached : true
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
   * Where a track is at `now`, walking its steps' ticks from its anchor past HOPs (taking their
   * counts) and chain ends; `stopped` once a HOP FF ended the track. A loop (a chain looping on
   * itself, HOPs back) is gone round as many whole times as fit, not step by step.
   */
  private walk(anchor: Anchor, track: number, now: number): Walked {
    let place : Place = {
      songRow: anchor.songRow,
      step   : anchor.step
    }
    let hops  = anchor.hops
    let chain = this.chainTicks(place.songRow, track)
    if (!chain) return {
      ...place,
      phase  : 0,
      stopped: false,
      offset : 0,
      serial : anchor.serial,
      hops
    }
    // Ticks to go from the start of the place's step, ticks walked to it, steps started before it.
    let left   = Math.max(0, (now - this.anchorStart(anchor, track)) / this.unitsPerTick())
    let walked = 0
    let serial = anchor.serial - 1
    let run    = this.run(track, place, hops, !anchor.reached)
    const seen = new Map<string, { walked: number; serial: number }>()
    for (let runs = 0; runs < MAX_CHAIN_WALK; runs += 1) {
      const room = startOf(chain, run.last + 1) - startOf(chain, place.step)
      if (left < room) break
      // HOP FF: stopped on its step.
      if (!run.next) return {
        songRow: place.songRow,
        step   : run.last + 1,
        phase  : 0,
        stopped: true,
        offset : walked + room,
        serial : serial + startsIn(chain, place.step, run.last),
        hops   : run.hops
      }
      const next = this.chainTicks(run.next.songRow, track)
      if (!next) break
      left         -= room
      walked       += room
      serial       += startsIn(chain, place.step, run.last)
      place        = run.next
      hops         = run.hops
      chain        = next
      // The same place with the same hops taken: the track goes round a loop, every whole turn of it alike.
      const key    = `${place.songRow}:${place.step}|${hopsKey(hops)}`
      const before = seen.get(key)
      if (before) {
        const turn = walked - before.walked
        if (turn > 0 && left >= turn) {
          const turns = Math.floor(left / turn)
          left        -= turns * turn
          walked      += turns * turn
          serial      += turns * (serial - before.serial)
        }
        seen.clear()
      }
      seen.set(key, {
        walked,
        serial
      })
      run = this.run(track, place, hops, false)
    }
    // The step whose span holds the position (a skipped step has none), within the run.
    const end      = startOf(chain, run.last + 1)
    const position = Math.min(startOf(chain, place.step) + left, end - 1e-6)
    let step       = Math.min(place.step, chain.steps.length - 1)
    while (step < chain.steps.length - 1 && chain.starts[step + 1] <= position) step += 1
    const length = chain.steps[step]
    const phase  = length > 0 ? Math.min(0.999, Math.max(0, (position - chain.starts[step]) / length)) : 0
    return {
      songRow: place.songRow,
      step,
      phase,
      stopped: false,
      offset : walked + chain.starts[step] - startOf(chain, place.step),
      serial : serial + startsIn(chain, place.step, step),
      hops   : this.path.passed(track, place, hops, step)
    }
  }

  /** The anchor moved on to where its track is at `at`, its window with it; the anchor itself when that is before it, or the track stopped. */
  private rebase(anchor: Anchor, track: number, at: number): Anchor {
    if (at <= this.anchorStart(anchor, track)) return anchor
    const walked = this.walk(anchor, track, at)
    if (walked.stopped) return anchor
    const shift  = walked.offset * this.unitsPerTick()
    return {
      songRow : walked.songRow,
      step    : walked.step,
      earliest: anchor.earliest + shift,
      latest  : anchor.latest + shift,
      hops    : walked.hops,
      serial  : walked.serial
    }
  }

  /** Each time, in order, a track reaches (toRow, toStep) from an anchor's step on, within a few runs. */
  private *reaches(track: number, from: Anchor, toRow: number, toStep: number): Generator<Reached> {
    let place   : Place = {
      songRow: from.songRow,
      step   : from.step
    }
    let hops    = from.hops
    let total   = 0
    let serial  = from.serial - 1
    let playing = !from.reached
    for (let runs = 0; runs < MAX_RUNS_AHEAD; runs += 1) {
      const chain = this.chainTicks(place.songRow, track)
      if (!chain) return
      const run   = this.run(track, place, hops, playing)
      if (place.songRow === toRow && toStep >= place.step && toStep <= run.last) yield {
        ticks : total + startOf(chain, toStep) - startOf(chain, place.step),
        hops  : this.path.passed(track, place, hops, toStep),
        serial: serial + startsIn(chain, place.step, toStep)
      }
      total  += startOf(chain, run.last + 1) - startOf(chain, place.step)
      serial += startsIn(chain, place.step, run.last)
      if (!run.next) return
      place   = run.next
      hops    = run.hops
      playing = false
    }
  }

  /** True when (toRow, toStep) is the step a track plays right after the one it was read on, skipped steps aside. */
  private follows(track: number, reading: StepReading, toRow: number, toStep: number): boolean {
    const from   : Anchor = {
      songRow : reading.songRow,
      step    : reading.step,
      earliest: 0,
      latest  : 0,
      hops    : reading.hops,
      serial  : 0
    }
    const length = this.chainTicks(reading.songRow, track)?.steps[reading.step] ?? 0
    for (const reached of this.reaches(track, from, toRow, toStep)) return length > 0 && Math.abs(reached.ticks - length) < 1e-6
    return false
  }

  /** A new anchor for a track placed afresh: its steps count on from where it was. */
  private fresh(track: number, songRow: number, step: number, earliest: number, latest: number, hops: HopCounts = NO_HOPS): Anchor {
    const anchor = this.anchors[track]
    return {
      songRow,
      step,
      earliest,
      latest,
      hops,
      serial: anchor ? this.walk(anchor, track, latest).serial + 1 : 0
    }
  }

  /**
   * Narrows a track's window with "step `step` of song row `songRow` started in (earliest, latest]",
   * or restarts it there when the reading does not fit (a jump, a tempo change, a random HOP).
   * Measured from where the track was as the window opens: a step it comes back to (a looping
   * chain, a HOP back) is matched with the time round the reading is about.
   */
  private constrain(track: number, songRow: number, step: number, earliest: number, latest: number): void {
    const anchor = this.anchors[track]
    let guess    : Reached | null = null
    if (anchor) {
      const units  = this.unitsPerTick()
      const base   = this.rebase(anchor, track, earliest)
      let offTicks : number | null = null
      for (const reached of this.reaches(track, base, songRow, step)) {
        const shift            = reached.ticks * units
        const narrowedEarliest = Math.max(base.earliest, earliest - shift)
        const narrowedLatest   = Math.min(base.latest, latest - shift)
        if (narrowedEarliest < narrowedLatest) {
          // Kept on the latest reading, so the next one is measured from here.
          this.anchors[track] = {
            songRow,
            step,
            earliest: narrowedEarliest + shift,
            latest  : narrowedLatest + shift,
            hops    : reached.hops,
            serial  : reached.serial
          }
          return
        }
        if (!guess) {
          guess      = reached
          // The two windows do not meet: the gap between them is how far off the prediction was.
          const late = (earliest - shift - base.latest) / units
          const soon = (latest - shift - base.earliest) / units
          offTicks   = Math.round((late > 0 ? late : soon) * 10) / 10
        }
        // Later times round start after the reading's window.
        if (base.earliest + shift > latest) break
      }
      this.onEvent({
        kind  : 'reanchor',
        track,
        reason: guess == null ? 'no-path' : 'window',
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
    this.place(track, this.fresh(track, songRow, step, earliest, latest, guess?.hops))
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
    this.noteTrackNotes(screen, ms)
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

  /**
   * The notes the track panel shows (most views have it): a change says the track played a note,
   * with the pitch its table gave it; nothing else on screen tells a chance note that played from
   * one that did not.
   */
  private noteTrackNotes(screen: M8Screen, ms: number): void {
    readTrackNotes(screen).forEach((text, track) => {
      const known = this.trackNotes[track]
      if (known && known.text === text) return
      this.trackNotes[track] = {
        text,
        pitch    : noteNumber(text),
        changedAt: ms - SCREEN_LATENCY_MS
      }
    })
  }

  /** The note a track's panel last showed, and when it changed. */
  trackNote(track: number): TrackNote | null {
    const known = this.trackNotes[track]
    return known ? {
      pitch    : known.pitch,
      changedAt: known.changedAt
    } : null
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
      if (before && before.songRow !== songRow && this.path.nextRow(before.songRow, track) === songRow) {
        // Entered the row between the two readings (on step 0, or where a HOP 0Y sent it).
        this.constrain(track, songRow, this.path.entryStep(track, before.songRow, songRow), before.at, now)
      } else if (!placed || placed.stopped || placed.songRow !== songRow) {
        // First sight (or a jump): somewhere in the chain, shown from its start until known.
        const chain      = this.chainTicks(songRow, track)
        const chainUnits = (chain ? totalOf(chain) : 0) * this.unitsPerTick()
        this.place(track, this.fresh(track, songRow, 0, now - chainUnits, now))
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
        // A track walking that phrase already fits (HOPs may keep it there without its first step coming
        // round again); else that phrase started within the last phrase length.
        if (walkedRow !== markedRow) this.constrain(track, songRow, markedRow * ROWS_PER_PHRASE, now - this.phraseUnits(songRow, track, markedRow), now)
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
        const followed  = before && this.follows(track, before, songRow, actual)
        this.constrain(track, songRow, actual, followed ? Math.max(before.at, now - stepUnits) : now - stepUnits, now)
        this.lastStepReading[track] = {
          songRow,
          step: actual,
          at  : now,
          hops: this.anchors[track]?.hops ?? NO_HOPS
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
    this.place(place.track, this.fresh(place.track, place.songRow, step, now - window, now))
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
    const now       = this.now(ms)
    const msPerTick = this.clock?.msPerTick ?? 60000 / this.bpm / CLOCK_PPQ
    return this.anchors.map((anchor, track) => {
      if (!anchor) return null
      const { songRow, step, phase, stopped, serial } = this.walk(anchor, track, now)
      if (stopped) return null
      const band   = this.timeline.bands.find((b) => b.songRow === songRow)
      const length = this.chainSteps(songRow, track)
      const row    = band && length ? band.row + Math.min(step, length - 1) : null
      return {
        row,
        songRow,
        exact    : this.isExact(anchor, track),
        phase,
        step,
        serial,
        startedAt: ms - phase * (this.chainTicks(songRow, track)?.steps[step] ?? 0) * msPerTick,
        note     : this.trackNote(track)
      }
    })
  }
}

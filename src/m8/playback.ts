// Where each track is while the song plays. The screen gives positions (the Song view's
// play marker per track, the marker after the row number on a chain or phrase view);
// between readings each track moves on through its chains, each step lasting the ticks its
// groove gives it (six, a sixteenth, by default): clock ticks when a MIDI clock is available,
// else ticks at the tempo the M8 shows.
//
// A reading says a step is showing *now*, so it started some time within the last step:
// each track keeps the window its anchor step started in, and every reading narrows it.
// Anchoring at the reading time instead runs a poll interval (or more) behind the M8.

import { type M8Screen, readPlayPositions } from '@yam8d/m8-sdk'
import { CLOCK_PPQ, chainStepTicks, DEFAULT_TICKS, occurrenceKey, summarizeTicks, type TicksSummary } from '../model/music/groove'
import { chainLength, ROWS_PER_PHRASE, type SongModel, TRACKS } from '../model/song'
import type { Timeline } from '../model/timeline'
import { viewOf } from './screen/screenReader'

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
/** Walks through at most this many chains when moving a track on or measuring between steps. */
const MAX_CHAIN_WALK     = 512
const MAX_CHAINS_AHEAD   = 16

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

export class PlaybackTracker {
  playing      = false
  bpm          = 120
  /** Song row and track the M8 was last on (Song / Chain view), to tell which place a phrase on screen is. */
  context      : { songRow: number; track: number } | null = null
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
    for (let track = 0; track < TRACKS; track += 1) {
      const songRow = this.lastChainRow(startRow, track)
      if (songRow == null || this.chainSteps(songRow, track) === 0) continue
      // MIDI: after Start / Continue, the song moves on the first clock that follows.
      this.anchors[track] = {
        songRow,
        step    : 0,
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
    const wasPlaying         = this.playing
    this.playing             = false
    this.transportRunning    = false
    this.unmarkedSince       = null
    this.anchors             = perTrack()
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

  /** Song row and step a track is at, walking its steps' ticks from its anchor past chain ends. */
  private walk(anchor: Anchor, track: number, now: number): { songRow: number; step: number; phase: number } {
    let songRow = anchor.songRow
    let chain   = this.chainTicks(songRow, track)
    if (!chain) return {
      songRow,
      step : anchor.step,
      phase: 0
    }
    let position = startOf(chain, anchor.step) + Math.max(0, (now - this.anchorStart(anchor, track)) / this.unitsPerTick())
    for (let walked = 0; walked < MAX_CHAIN_WALK; walked += 1) {
      const total = totalOf(chain)
      if (total === 0 || position < total) break
      const row  = this.nextRow(songRow, track)
      const next = this.chainTicks(row, track)
      if (!next) break
      position -= total
      songRow  = row
      chain    = next
    }
    // The step whose span holds the position (a skipped step has none).
    let step = 0
    while (step < chain.steps.length - 1 && chain.starts[step + 1] <= position) step += 1
    const length = chain.steps[step]
    const phase  = length > 0 ? Math.min(0.999, Math.max(0, (position - chain.starts[step]) / length)) : 0
    return { songRow, step, phase }
  }

  /** Clock ticks from the start of (fromRow, fromStep) to the start of (toRow, toStep) on a track; null when not ahead within a few chains. */
  private ticksBetween(track: number, fromRow: number, fromStep: number, toRow: number, toStep: number): number | null {
    const first = this.chainTicks(fromRow, track)
    if (!first) return null
    let total = -startOf(first, fromStep)
    let row   = fromRow
    for (let chainsAhead = 0; chainsAhead < MAX_CHAINS_AHEAD; chainsAhead += 1) {
      const chain = this.chainTicks(row, track)
      if (!chain) return null
      if (row === toRow && (chainsAhead > 0 || toStep >= fromStep)) return total + startOf(chain, toStep)
      total += totalOf(chain)
      row   = this.nextRow(row, track)
    }
    return null
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
          anchor.earliest = narrowedEarliest
          anchor.latest   = narrowedLatest
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
    this.anchors[track] = { songRow, step, earliest, latest }
  }

  // ---------------------------------------------------------------------------
  // Screen readings

  /** Feeds a screen read at `ms`. Returns true when it showed a play marker. */
  observe(screen: M8Screen, ms: number): boolean {
    this.dropStaleClock(ms)
    const view  = viewOf(screen)
    const tempo = /T.(\d{2,3}(?:\.\d+)?)/.exec(screen.lines[5]?.slice(30) ?? '')
    if (tempo && !this.clock) this.bpm = Math.max(MIN_BPM, Number.parseFloat(tempo[1]))
    if (view.kind !== 'song' && view.kind !== 'chain' && view.kind !== 'phrase') {
      this.unmarkedSince = null
      return false
    }
    const positions = readPlayPositions(view.kind, screen)
    const now       = this.now(ms) - this.latency()
    let markerSeen  = false
    if (view.kind === 'song' && positions?.tracks) {
      markerSeen = this.observeSongView(positions.tracks, now)
    } else if (positions?.row != null && view.id != null) {
      markerSeen = true
      this.observeChainOrPhraseView(view.kind as 'chain' | 'phrase', view.id, positions.row, now)
    }
    this.updatePlaying(markerSeen, view.kind, view.id, ms, now)
    return markerSeen
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
      if (before && before.songRow !== songRow && this.nextRow(before.songRow, track) === songRow) {
        // Entered the row between the two readings.
        this.constrain(track, songRow, 0, before.at, now)
      } else if (!anchor || this.walk(anchor, track, now).songRow !== songRow) {
        // First sight (or a jump): somewhere in the chain, shown from its start until known.
        const chain         = this.chainTicks(songRow, track)
        const chainUnits    = (chain ? totalOf(chain) : 0) * this.unitsPerTick()
        this.anchors[track] = {
          songRow,
          step    : 0,
          earliest: now - chainUnits,
          latest  : now
        }
      }
    })
    return markerSeen
  }

  /** A Chain or Phrase view marks the row playing, for the tracks that play what it shows. */
  private observeChainOrPhraseView(kind: 'chain' | 'phrase', id: number, markedRow: number, now: number): void {
    let matched = false
    for (let track = 0; track < TRACKS; track += 1) {
      const anchor = this.anchors[track]
      if (!anchor) continue
      const { songRow, step } = this.walk(anchor, track, now)
      const chainId           = this.model.song[songRow]?.[track]
      if (chainId == null) continue
      const chainRow = Math.floor(step / ROWS_PER_PHRASE)
      if (kind === 'chain' && chainId === id) {
        // That phrase started within the last phrase length.
        this.constrain(track, songRow, markedRow * ROWS_PER_PHRASE, now - this.phraseUnits(songRow, track, markedRow), now)
        matched = true
      }
      if (kind === 'phrase' && this.model.chains[chainId]?.rows[chainRow]?.phrase === id) {
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
    if (!matched) this.placeFromScreen(kind, id, markedRow, now)
  }

  /** No track known to be there yet: the place of the song that plays what is on screen. */
  private placeFromScreen(kind: 'chain' | 'phrase', id: number, markedRow: number, now: number): void {
    const places  = this.timeline.instances.filter((i) => (kind === 'chain' ? i.chain === id && i.chainRow === markedRow : i.phrase === id))
    const context = this.context
    const place   =
      places.find((i) => context && i.track === context.track && i.songRow === context.songRow) ??
      places.find((i) => context && i.track === context.track) ??
      places[0]
    if (!place) return
    const onPhrase            = kind === 'phrase'
    const step                = onPhrase ? place.chainRow * ROWS_PER_PHRASE + markedRow : markedRow * ROWS_PER_PHRASE
    const window              = onPhrase ? this.stepUnits(place.songRow, place.track, step) : this.phraseUnits(place.songRow, place.track, markedRow)
    this.anchors[place.track] = {
      songRow : place.songRow,
      step,
      earliest: now - window,
      latest  : now
    }
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
    } else if (this.expectsMarker(kind, id, now)) {
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
      const { songRow, step } = this.walk(anchor, track, now)
      const chainId           = this.model.song[songRow]?.[track]
      if (chainId == null) continue
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
      const { songRow, step, phase } = this.walk(anchor, track, now)
      const band                     = this.timeline.bands.find((b) => b.songRow === songRow)
      const length                   = this.chainSteps(songRow, track)
      const row                      = band && length ? band.row + Math.min(step, length - 1) : null
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

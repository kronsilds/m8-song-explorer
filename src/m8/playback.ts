// Where each track is while the song plays. The screen gives positions (the Song view's
// play marker per track, the marker after the row number on a chain or phrase view);
// between readings each track moves on through its chains, each step lasting the ticks its
// groove gives it (six, a sixteenth, by default): clock ticks when a MIDI clock is available,
// else ticks at the tempo the M8 shows.
//
// A reading says a step is showing *now*, so it started some time within the last step:
// each track keeps the window its anchor step started in, and every reading narrows it.
// Anchoring at the reading time instead runs a poll interval (or more) behind the M8.

import { readPlayPositions, type M8Screen } from '@yam8d/m8-sdk'
import { CLOCK_PPQ, chainStepTicks, DEFAULT_TICKS, occurrenceKey } from '../model/groove'
import { chainLength, ROWS_PER_PHRASE, type SongModel, TRACKS, type Timeline } from '../model/song'
import { viewOf } from './driver'

/** Clock ticks per phrase step with the default groove (24 PPQ, 16th notes). */
export const TICKS_PER_STEP = DEFAULT_TICKS
/** How late the screen shows a step (M8 redraw, serial, host, messages), roughly. */
const SCREEN_LATENCY_MS = 20

interface Anchor {
  songRow: number
  /** Steps into the song row's chain. */
  step: number
  /** When that step started lies in (lo, hi], in ms or clock ticks (whichever drives the track). */
  lo: number
  hi: number
}

/** Step lengths of one chain occurrence in clock ticks, and where each step starts (one more entry: the total). */
interface ChainTicks {
  steps: number[]
  starts: number[]
}

export interface TrackPlayhead {
  /** Timeline row being played, null when the track has nothing at this song row. */
  row: number | null
  songRow: number
  /** True once the step is known (to within half a step), false while it is guessed. */
  exact: boolean
  /** How far into its step the track is, 0 to 1 (the step lasts what its groove gives it). */
  phase: number
  /** Step of the chain being played (a beat every 4). */
  step: number
}

export class PlaybackTracker {
  playing = false
  bpm = 120
  private anchors: (Anchor | null)[] = Array(TRACKS).fill(null)
  /** Last Song view reading per track: its song row and when it was read. */
  private seen: ({ songRow: number; at: number } | null)[] = Array(TRACKS).fill(null)
  /** Last chain / phrase view reading per track: the step it showed and when. */
  private shown: ({ songRow: number; step: number; at: number } | null)[] = Array(TRACKS).fill(null)
  private lastMarkerAt = 0
  /** Since when a chain / phrase view that should show a marker has not (null while it does or is not expected to). */
  private unmarkedSince: number | null = null
  /** MIDI Start / Continue came and no Stop since: the song ends with the Stop message, not with missing markers. */
  private transportOn = false
  /** Clock ticks and when the last clock event came, when MIDI clock is used. */
  private clock: { ticks: number; at: number; msPerTick: number } | null = null
  /** Song row and track the M8 was last on (Song / Chain view), to tell which place a phrase on screen is. */
  context: { songRow: number; track: number } | null = null
  /** Called when a phrase view shows another step than predicted (in steps). */
  onCorrection: (track: number, predicted: number, actual: number, clocked: boolean) => void = () => {}
  /** Step lengths of every chain occurrence, from the grooves (see chainStepTicks). */
  private ticks = new Map<string, ChainTicks>()

  constructor(
    private model: SongModel,
    private timeline: Timeline,
  ) {
    this.buildTicks()
  }

  setSong(model: SongModel, timeline: Timeline): void {
    this.model = model
    this.timeline = timeline
    this.buildTicks()
  }

  private buildTicks(): void {
    this.ticks.clear()
    for (const [key, steps] of chainStepTicks(this.model, this.timeline)) this.ticks.set(key, withStarts(steps))
  }

  /** The "now" the anchors are measured in: clock ticks when available, else milliseconds. */
  private now(ms: number): number {
    if (!this.clock) return ms
    return this.clock.ticks + (ms - this.clock.at) / this.clock.msPerTick
  }

  /** One clock tick in the units the anchors are measured in. */
  private unitsPerTick(): number {
    return this.clock ? 1 : 60000 / this.bpm / CLOCK_PPQ
  }

  private latency(): number {
    return this.clock ? SCREEN_LATENCY_MS / this.clock.msPerTick : SCREEN_LATENCY_MS
  }

  /** Step lengths of the chain a track plays on a song row; null for an empty cell. */
  private chainTicks(songRow: number, track: number): ChainTicks | null {
    if (this.model.song[songRow]?.[track] == null) return null
    // Rows the timeline does not have yet (read after it was built) play the default groove.
    return this.ticks.get(occurrenceKey(track, songRow)) ?? withStarts(Array(this.chainSteps(songRow, track)).fill(DEFAULT_TICKS))
  }

  /** How long a step lasts, in anchor units (a skipped step counts as a default one where a length is needed). */
  private stepUnits(songRow: number, track: number, step: number): number {
    return (this.chainTicks(songRow, track)?.steps[step] || DEFAULT_TICKS) * this.unitsPerTick()
  }

  /** How long phrase `chainRow` of a track's chain lasts, in anchor units. */
  private phraseUnits(songRow: number, track: number, chainRow: number): number {
    const c = this.chainTicks(songRow, track)
    const at = (step: number) => (c ? c.starts[Math.min(step, c.steps.length)] : 0)
    const ticks = at((chainRow + 1) * ROWS_PER_PHRASE) - at(chainRow * ROWS_PER_PHRASE)
    return (ticks || DEFAULT_TICKS * ROWS_PER_PHRASE) * this.unitsPerTick()
  }

  /** MIDI clock: call on each clock event (ticks are monotonic, the clock may run while stopped). */
  clockTick(ticks: number, at: number, msPerTick: number): void {
    if (!this.clock) {
      // Re-express the anchors in ticks so the switch does not jump.
      const toTicks = (ms: number) => ticks - (at - ms) / msPerTick
      for (const a of this.anchors) {
        if (!a) continue
        a.lo = toTicks(a.lo)
        a.hi = toTicks(a.hi)
      }
      for (const s of this.seen) if (s) s.at = toTicks(s.at)
      for (const s of this.shown) if (s) s.at = toTicks(s.at)
    }
    this.clock = { ticks, at, msPerTick }
  }

  /**
   * MIDI Start / Continue: the song plays from Song Position `spp` (sixteenths from the song
   * start; Start means 0). On the M8 that is the timeline row the explorer uses for the start
   * of a song row (Play on song row 07 sent 448 = 7 x 64), so every track playing there is
   * placed at once, its first step starting on the next clock tick. Returns false when no song
   * row starts at that position (the screen markers take over).
   */
  transportStart(spp: number, ms: number): boolean {
    this.transportReset()
    this.transportOn = true
    const band = this.timeline.bands.find((b) => b.row === spp)
    if (!band) return false
    const now = this.now(ms)
    const tick = this.unitsPerTick()
    for (let t = 0; t < TRACKS; t += 1) {
      if (this.chainSteps(band.songRow, t) === 0) continue
      // MIDI: after Start / Continue, the song moves on the first clock that follows.
      this.anchors[t] = { songRow: band.songRow, step: 0, lo: now + 0.5 * tick, hi: now + 1.5 * tick }
    }
    this.playing = true
    this.lastMarkerAt = ms
    return true
  }

  /** MIDI Start or Stop: positions start over (the clock itself keeps running). */
  transportReset(): void {
    this.playing = false
    this.transportOn = false
    this.unmarkedSince = null
    this.anchors = Array(TRACKS).fill(null)
    this.seen = Array(TRACKS).fill(null)
    this.shown = Array(TRACKS).fill(null)
  }

  /** When the anchor step started: the middle of its window, or its latest end while it is wide (a guess). */
  private startOf(anchor: Anchor, track: number): number {
    return anchor.hi - anchor.lo > this.stepUnits(anchor.songRow, track, anchor.step) ? anchor.hi : (anchor.lo + anchor.hi) / 2
  }

  private exact(anchor: Anchor, track: number): boolean {
    return anchor.hi - anchor.lo <= this.stepUnits(anchor.songRow, track, anchor.step) * 0.6
  }

  private chainSteps(songRow: number, track: number): number {
    const chainId = this.model.song[songRow]?.[track]
    return (chainId == null ? 0 : chainLength(this.model.chains[chainId])) * ROWS_PER_PHRASE
  }

  /** The row a track goes to after `row`: the next one, or back to the start of its block at an empty cell. */
  private nextRow(row: number, track: number): number {
    const at = (r: number) => this.model.song[r]?.[track] ?? null
    if (at(row + 1) != null) return row + 1
    let start = row
    while (start > 0 && at(start - 1) != null) start -= 1
    return start
  }

  /** Song row and step a track is at, walking its steps' ticks from its anchor past chain ends. */
  private walk(anchor: Anchor, track: number, now: number): { songRow: number; step: number; phase: number } {
    let songRow = anchor.songRow
    let c = this.chainTicks(songRow, track)
    if (!c) return { songRow, step: anchor.step, phase: 0 }
    let pos = c.starts[Math.min(anchor.step, c.steps.length)] + Math.max(0, (now - this.startOf(anchor, track)) / this.unitsPerTick())
    for (let guard = 0; guard < 512; guard += 1) {
      const total = c.starts[c.steps.length]
      if (total === 0 || pos < total) break
      const row = this.nextRow(songRow, track)
      const next = this.chainTicks(row, track)
      if (!next) break
      pos -= total
      songRow = row
      c = next
    }
    // The step whose span holds pos (a skipped step has none).
    let step = 0
    while (step < c.steps.length - 1 && c.starts[step + 1] <= pos) step += 1
    const length = c.steps[step]
    const phase = length > 0 ? Math.min(0.999, Math.max(0, (pos - c.starts[step]) / length)) : 0
    return { songRow, step, phase }
  }

  /** Clock ticks from the start of (fromRow, fromStep) to the start of (toRow, toStep) on a track; null when not ahead within a few chains. */
  private ticksBetween(track: number, fromRow: number, fromStep: number, toRow: number, toStep: number): number | null {
    const first = this.chainTicks(fromRow, track)
    if (!first) return null
    let total = -first.starts[Math.min(fromStep, first.steps.length)]
    let row = fromRow
    for (let guard = 0; guard < 16; guard += 1) {
      const c = this.chainTicks(row, track)
      if (!c) return null
      if (row === toRow && (guard > 0 || toStep >= fromStep)) return total + c.starts[Math.min(toStep, c.steps.length)]
      total += c.starts[c.steps.length]
      row = this.nextRow(row, track)
    }
    return null
  }

  /** True when (toRow, toStep) is the step a track plays right after (fromRow, fromStep), skipped steps aside. */
  private follows(track: number, fromRow: number, fromStep: number, toRow: number, toStep: number): boolean {
    const between = this.ticksBetween(track, fromRow, fromStep, toRow, toStep)
    const length = this.chainTicks(fromRow, track)?.steps[fromStep] ?? 0
    return between != null && length > 0 && Math.abs(between - length) < 1e-6
  }

  /**
   * Narrows a track's window with "step `step` of song row `songRow` started in (lo, hi]",
   * or restarts it there when the reading does not fit (a jump, a HOP, a tempo change).
   */
  private constrain(track: number, songRow: number, step: number, lo: number, hi: number): void {
    const a = this.anchors[track]
    if (a) {
      const between = this.ticksBetween(track, a.songRow, a.step, songRow, step)
      if (between != null) {
        const shift = between * this.unitsPerTick()
        const nlo = Math.max(a.lo, lo - shift)
        const nhi = Math.min(a.hi, hi - shift)
        if (nlo < nhi) {
          a.lo = nlo
          a.hi = nhi
          return
        }
      }
    }
    this.anchors[track] = { songRow, step, lo, hi }
  }

  /** Feeds a screen read at `ms`. Returns true when it showed a play marker. */
  observe(screen: M8Screen, ms: number): boolean {
    const view = viewOf(screen)
    const tempo = /T.(\d{2,3}(?:\.\d+)?)/.exec(screen.lines[5]?.slice(30) ?? '')
    if (tempo && !this.clock) this.bpm = Math.max(20, parseFloat(tempo[1]))
    if (view.kind !== 'song' && view.kind !== 'chain' && view.kind !== 'phrase') {
      this.unmarkedSince = null
      return false
    }
    const positions = readPlayPositions(view.kind, screen)
    const now = this.now(ms) - this.latency()
    let seen = false

    if (view.kind === 'song' && positions?.tracks) {
      positions.tracks.forEach((row, t) => {
        if (row == null) return
        seen = true
        const before = this.seen[t]
        this.seen[t] = { songRow: row, at: now }
        const anchor = this.anchors[t]
        if (before && before.songRow !== row && this.nextRow(before.songRow, t) === row) {
          // Entered `row` between the two readings.
          this.constrain(t, row, 0, before.at, now)
        } else if (!anchor || this.walk(anchor, t, now).songRow !== row) {
          // First sight (or a jump): somewhere in the chain, shown from its start until known.
          const chainUnits = (this.chainTicks(row, t)?.starts.at(-1) ?? 0) * this.unitsPerTick()
          this.anchors[t] = { songRow: row, step: 0, lo: now - chainUnits, hi: now }
        }
      })
    } else if (positions?.row != null && view.id != null) {
      seen = true
      let matched = false
      for (let t = 0; t < TRACKS; t += 1) {
        const anchor = this.anchors[t]
        if (!anchor) continue
        const { songRow, step } = this.walk(anchor, t, now)
        const chainId = this.model.song[songRow]?.[t]
        if (chainId == null) continue
        const chain = this.model.chains[chainId]
        const phraseRow = Math.floor(step / ROWS_PER_PHRASE)
        if (view.kind === 'chain' && chainId === view.id) {
          // That phrase started within the last phrase length.
          this.constrain(t, songRow, positions.row * ROWS_PER_PHRASE, now - this.phraseUnits(songRow, t, positions.row), now)
          matched = true
        }
        if (view.kind === 'phrase' && chain?.rows[phraseRow]?.phrase === view.id) {
          const actual = phraseRow * ROWS_PER_PHRASE + positions.row
          if (actual !== step) this.onCorrection(t, step, actual, this.clock != null)
          // Showing now: it started within the last step. Just after the step before it was
          // showing: it started between the two readings, a much tighter window.
          const u = this.stepUnits(songRow, t, actual)
          const before = this.shown[t]
          const followed = before && this.follows(t, before.songRow, before.step, songRow, actual)
          this.constrain(t, songRow, actual, followed ? Math.max(before.at, now - u) : now - u, now)
          this.shown[t] = { songRow, step: actual, at: now }
          matched = true
        }
      }
      // No track known to be there yet: the place of the song that plays what is on screen.
      if (!matched) {
        const id = view.id
        const places = this.timeline.instances.filter((i) => (view.kind === 'chain' ? i.chain === id && i.chainRow === positions.row : i.phrase === id))
        const ctx = this.context
        const place =
          places.find((i) => ctx && i.track === ctx.track && i.songRow === ctx.songRow) ??
          places.find((i) => ctx && i.track === ctx.track) ??
          places[0]
        if (place) {
          const phrase = view.kind === 'phrase'
          const step = phrase ? place.chainRow * ROWS_PER_PHRASE + positions.row : positions.row * ROWS_PER_PHRASE
          const window = phrase ? this.stepUnits(place.songRow, place.track, step) : this.phraseUnits(place.songRow, place.track, positions.row)
          this.anchors[place.track] = { songRow: place.songRow, step, lo: now - window, hi: now }
        }
      }
    }

    if (seen) {
      this.playing = true
      this.lastMarkerAt = ms
      this.unmarkedSince = null
    } else if (this.playing) {
      if (view.kind === 'song') {
        // Every playing track has a marker on the Song view: none left means stopped, unless
        // the MIDI transport says it plays (the playing rows are scrolled off screen).
        if (!this.transportOn && ms - this.lastMarkerAt > 900) this.transportReset()
      } else if (this.expectsMarker(view.kind, view.id, now)) {
        // The chain / phrase on screen should be playing by what we know, yet it shows no marker.
        this.unmarkedSince ??= ms
        if (ms - this.unmarkedSince > 900) this.transportReset()
      } else {
        // Another chain / phrase than the ones playing: no marker is expected there, which says
        // nothing about the song (the positions keep running from the clock and the anchors).
        this.unmarkedSince = null
      }
    }
    return seen
  }

  /**
   * True when a track is known to be on this chain / phrase, so its marker should show; a
   * missing one then means the song stopped. Without that knowledge (browsing the M8 to a
   * chain or phrase nothing plays) a missing marker is no evidence, and with the MIDI
   * transport the Stop message is what ends the song.
   */
  private expectsMarker(kind: 'chain' | 'phrase', id: number | null, now: number): boolean {
    if (this.transportOn || id == null) return false
    for (let t = 0; t < TRACKS; t += 1) {
      const anchor = this.anchors[t]
      if (!anchor) continue
      const { songRow, step } = this.walk(anchor, t, now)
      const chainId = this.model.song[songRow]?.[t]
      if (chainId == null) continue
      if (kind === 'chain' ? chainId === id : this.model.chains[chainId]?.rows[Math.floor(step / ROWS_PER_PHRASE)]?.phrase === id) return true
    }
    return false
  }

  /** Each track's playhead at time `ms`. */
  playheads(ms: number): (TrackPlayhead | null)[] {
    if (!this.playing) return Array(TRACKS).fill(null)
    const now = this.now(ms)
    return this.anchors.map((anchor, t) => {
      if (!anchor) return null
      const { songRow, step, phase } = this.walk(anchor, t, now)
      const band = this.timeline.bands.find((b) => b.songRow === songRow)
      const length = this.chainSteps(songRow, t)
      const row = band && length ? band.row + Math.min(step, length - 1) : null
      return { row, songRow, exact: this.exact(anchor, t), phase, step }
    })
  }
}

function withStarts(steps: number[]): ChainTicks {
  const starts = [0]
  for (const t of steps) starts.push(starts[starts.length - 1] + t)
  return { steps, starts }
}

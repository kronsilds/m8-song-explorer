// The playheads: a marker per track across its front column and across its wall's step row,
// flashing on each beat. Each one runs at the tracker's speed and absorbs the tracker's small
// corrections (each screen read or clock message nudges it) over a few frames, so it glides
// without lagging; a step a HOP or a loop plays again is jumped to at once. Each step that starts
// lights the header of the instrument its note plays; a note left to chance (CHA) only once the
// M8's track panel shows it played. A playhead out of sight lights a halo at the edge of the view.

import type { TrackPlayhead } from '../../m8/playback'
import { fxValues, TRACKS } from '../../model/song'
import { FRONT_W, ROW_H, type SongLayout } from '../layout'
import type { Palette } from '../palette'
import { easeFactor, smoothstep } from '../shapes'
import { FRONT_NOTES_W, FRONT_NOTES_X, type TrackView, WALL_STEPS_U, WALL_STEPS_W } from '../track/trackView'
import { CellMarker, type CellRect } from './cellMarker'
import { PlayheadHalo } from './playheadHalo'

/** Heights in a track's front column between which its rows are in sight: under the header, above the bottom of the view. */
export interface ViewEdges {
  top   : number
  bottom: number
}

/** Where a playhead is drawn, in timeline rows (row + phase), and how fast it moves. */
interface ShownPlayhead {
  position     : number
  rowsPerSecond: number
  /** The tracker's position last frame. */
  target       : number
}

/** A jump larger than this (a new chain, a seek) is taken at once. */
const JUMP_ROWS          = 1.5
/** A step that starts this far back (a HOP back, a loop) is taken at once too. */
const BACK_ROWS          = 0.25
/** How long after a step starts its note may show on the M8's track panel (see TablePlayback). */
const NOTE_SHOWS_MS      = 160
const NOTE_EARLY_MS      = 40
/** CHA XY: X out of 15 is the note's chance. */
const ALWAYS             = 0x0f
const RATE_EASE_RATE     = 3
const POSITION_EASE_RATE = 7
const STEPS_PER_BEAT     = 4
/** How far a halo reaches into the view, in rows. */
const HALO_ROWS          = 1.2
/** A halo's opacity at its edge between beats, and what each beat adds to it. */
const HALO_OPACITY       = 0.14
const HALO_FLASH         = 0.22

export class PlayheadView {
  private readonly markers = Array.from({ length: TRACKS }, () => ({
    front: new CellMarker(),
    wall : new CellMarker(),
    halo : new PlayheadHalo()
  }))
  private readonly shown   : (ShownPlayhead | null)[] = Array(TRACKS).fill(null)
  /** Each track's step serial last frame (see TrackPlayhead). */
  private readonly serials : (number | null)[] = Array(TRACKS).fill(null)
  /** A note left to chance, flashed once the M8's track panel shows it played. */
  private readonly waiting : ({ row: number; startedAt: number } | null)[] = Array(TRACKS).fill(null)

  /** Top y of the playhead `phase` of the way from a row to the next (across a song row gap too). */
  static rowY(layout: SongLayout, row: number, phase: number): number {
    const from = layout.rowY(row)
    return from + (layout.rowY(row + 1) - from) * phase
  }

  /** Where track `track`'s playhead is drawn now, in timeline rows; null when it is not playing. */
  shownPosition(track: number): number | null {
    return this.shown[track]?.position ?? null
  }

  /**
   * The playhead furthest down the song, in timeline rows: where the song has got to. A track
   * looping a chain of its own (an empty cell under it) stays behind and does not hold it back.
   */
  leadPosition(): number | null {
    let lead: number | null = null
    for (const shown of this.shown) if (shown && (lead == null || shown.position > lead)) lead = shown.position
    return lead
  }

  /**
   * Places the playheads, and a halo at the edge of the view for each one out of sight
   * (`edges` gives a track's edges, null for none); returns true while anything plays.
   */
  update(
    heads: (TrackPlayhead | null)[],
    layout: SongLayout | null,
    views: TrackView[],
    palette: Palette,
    dt: number,
    edges: (track: number) => ViewEdges | null = () => null,
  ): boolean {
    let anyPlaying = false
    this.markers.forEach(({ front, wall, halo }, track) => {
      const head = heads[track]
      const view = views[track]
      if (!head || head.row == null || !layout || !view) {
        front.hide()
        wall.hide()
        halo.hide()
        this.shown[track]   = null
        this.serials[track] = null
        this.waiting[track] = null
        return
      }
      anyPlaying                 = true
      const before               = this.shown[track]?.position ?? null
      const started              = this.serials[track] != null && this.serials[track] !== head.serial
      this.serials[track]        = head.serial
      const { row, phase, step } = this.smooth(track, head.row + head.phase, head.row, head.step, dt, started)
      const after                = this.shown[track]?.position ?? null
      if (started && before != null && after != null) this.flashStartedNotes(layout, track, head, before, after)
      this.flashWaitingNote(layout, track, head)
      const y            = PlayheadView.rowY(layout, row, phase)
      // A flash on each beat: full at the beat, gone by the middle of it.
      const beatProgress = ((((step % STEPS_PER_BEAT) + STEPS_PER_BEAT) % STEPS_PER_BEAT) + phase) / STEPS_PER_BEAT
      const flash        = (1 - smoothstep(0, 0.5, beatProgress)) ** 2
      const fill         = (head.exact ? 0.2 : 0.12) + flash * 0.4
      const outline      = Math.min(1, (head.exact ? 0.6 : 0.35) + flash * 0.6)
      const frontRow     : CellRect = {
        parent: view.front,
        x     : FRONT_NOTES_X - 0.05,
        y,
        w     : FRONT_NOTES_W + 0.1,
        h     : ROW_H
      }
      const wallRow      : CellRect = {
        parent: view.wall,
        x     : WALL_STEPS_U - 0.05,
        y,
        w     : WALL_STEPS_W + 0.1,
        h     : ROW_H
      }
      front.show(frontRow, palette.device, fill, outline)
      if (view.wallAlpha > 0.05) wall.show(wallRow, palette.device, fill, outline)
      else wall.hide()
      // Out of sight (the middle of its row past an edge): a halo on that edge, beating with it.
      const edge   = edges(track)
      const middle = y - ROW_H / 2
      const reach  = middle > (edge?.top ?? Number.POSITIVE_INFINITY) ? HALO_ROWS * ROW_H : middle < (edge?.bottom ?? Number.NEGATIVE_INFINITY) ? -HALO_ROWS * ROW_H : 0
      if (edge && reach) halo.show(view.front, 0, reach > 0 ? edge.top : edge.bottom, FRONT_W, reach, palette.device, (HALO_OPACITY + flash * HALO_FLASH) * view.frontAlpha)
      else halo.hide()
    })
    return anyPlaying
  }

  /**
   * Steps started since the last frame: the rows passed when the playhead moved on, else (a HOP, a
   * loop, a jump) the row it is on. Each one's note lights the header of the instrument it plays;
   * a note left to chance (a CHA) waits until the M8's track panel shows it played.
   */
  private flashStartedNotes(layout: SongLayout, track: number, head: TrackPlayhead, before: number, after: number): void {
    const rows: number[] = []
    if (after > before && after - before <= JUMP_ROWS && Math.floor(after) > Math.floor(before)) {
      for (let row = Math.floor(before) + 1; row <= Math.floor(after); row += 1) rows.push(row)
    } else rows.push(Math.floor(after))
    for (const row of rows) {
      const step = this.noteStep(layout, track, row)
      if (!step) continue
      const [cha] = fxValues(step.fx, 'CHA')
      if (cha != null && cha >> 4 < ALWAYS) this.waiting[track] = {
        row,
        startedAt: head.startedAt
      }
      else this.flashNote(layout, track, row)
    }
  }

  /** The note left to chance on a track: lit once the track panel shows a new note since its step started, forgotten after. */
  private flashWaitingNote(layout: SongLayout, track: number, head: TrackPlayhead): void {
    const waiting = this.waiting[track]
    if (!waiting) return
    if (head.note && head.note.changedAt >= waiting.startedAt - NOTE_EARLY_MS) {
      this.flashNote(layout, track, waiting.row)
      this.waiting[track] = null
    } else if (performance.now() > waiting.startedAt + NOTE_SHOWS_MS) this.waiting[track] = null
  }

  /** The step on timeline row `row` of a track when it plays a note. */
  private noteStep(layout: SongLayout, track: number, row: number) {
    const instance = layout.instanceAt(track, row)
    const step     = instance ? layout.model.phrases[instance.phrase]?.steps[row - instance.row] : undefined
    return step?.note && step.note !== 'OFF' ? step : null
  }

  /** Lights the header of the instrument the note on timeline row `row` plays. */
  private flashNote(layout: SongLayout, track: number, row: number): void {
    const instance   = layout.instanceAt(track, row)
    const instrument = instance ? layout.effective.get(instance.key)?.[row - instance.row] : undefined
    const panel      = instrument == null ? undefined : layout.tracks[track].panels.find((p) => p.table === instrument)
    if (panel) panel.flash = 1
  }

  /** Moves a track's drawn playhead toward the tracker's `target` (row + phase). */
  private smooth(track: number, target: number, headRow: number, headStep: number, dt: number, started: boolean): { row: number; phase: number; step: number } {
    let shown  = this.shown[track]
    // A step that starts behind the last one (a HOP back, a loop playing it again) is taken at once, as a jump is.
    const back = started && shown != null && target < shown.target - BACK_ROWS
    if (!shown || back || Math.abs(target - shown.position) > JUMP_ROWS || target < shown.target - JUMP_ROWS) {
      shown             = {
        position     : target,
        rowsPerSecond: shown?.rowsPerSecond ?? 0,
        target
      }
      this.shown[track] = shown
    } else if (dt > 0) {
      // The tracker's own speed (rows per second), averaged so its nudges do not show.
      const moved = target - shown.target
      if (moved >= 0 && moved < 1) shown.rowsPerSecond += (moved / dt - shown.rowsPerSecond) * easeFactor(dt, RATE_EASE_RATE)
      shown.target   = target
      shown.position += shown.rowsPerSecond * dt
      shown.position += (target - shown.position) * easeFactor(dt, POSITION_EASE_RATE)
    }
    const row = Math.floor(shown.position)
    return {
      row,
      phase: shown.position - row,
      step : headStep + row - headRow
    }
  }
}

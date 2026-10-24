// The playheads: a marker per track across its front column and across its wall's step row,
// flashing on each beat. Each one runs at the tracker's speed and absorbs the tracker's small
// corrections (each screen read or clock message nudges it) over a few frames, so it glides
// without lagging.

import type { TrackPlayhead } from '../../m8/playback'
import { TRACKS } from '../../model/song'
import { ROW_H, type SongLayout } from '../layout'
import type { Palette } from '../palette'
import { easeFactor, smoothstep } from '../shapes'
import { FRONT_NOTES_W, FRONT_NOTES_X, type TrackView, WALL_STEPS_U, WALL_STEPS_W } from '../track/trackView'
import { CellMarker, type CellRect } from './cellMarker'

/** Where a playhead is drawn, in timeline rows (row + phase), and how fast it moves. */
interface ShownPlayhead {
  position     : number
  rowsPerSecond: number
  /** The tracker's position last frame. */
  target       : number
}

/** A jump larger than this (a new chain, a seek) is taken at once. */
const JUMP_ROWS          = 1.5
const RATE_EASE_RATE     = 3
const POSITION_EASE_RATE = 7
const STEPS_PER_BEAT     = 4

export class PlayheadView {
  private readonly markers = Array.from({ length: TRACKS }, () => ({
    front: new CellMarker(),
    wall : new CellMarker()
  }))
  private readonly shown   : (ShownPlayhead | null)[] = Array(TRACKS).fill(null)

  /** Top y of the playhead `phase` of the way from a row to the next (across a song row gap too). */
  static rowY(layout: SongLayout, row: number, phase: number): number {
    const from = layout.rowY(row)
    return from + (layout.rowY(row + 1) - from) * phase
  }

  /** Where track `track`'s playhead is drawn now, in timeline rows; null when it is not playing. */
  shownPosition(track: number): number | null {
    return this.shown[track]?.position ?? null
  }

  /** Places the playheads; returns true while anything plays. */
  update(heads: (TrackPlayhead | null)[], layout: SongLayout | null, views: TrackView[], palette: Palette, dt: number): boolean {
    let anyPlaying = false
    this.markers.forEach(({ front, wall }, track) => {
      const head = heads[track]
      const view = views[track]
      if (!head || head.row == null || !layout || !view) {
        front.hide()
        wall.hide()
        this.shown[track] = null
        return
      }
      anyPlaying                 = true
      const before               = this.shown[track]?.position ?? null
      const { row, phase, step } = this.smooth(track, head.row + head.phase, head.row, head.step, dt)
      const after                = this.shown[track]?.position ?? null
      if (before != null && after != null) this.flashPassedNotes(layout, track, before, after)
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
    })
    return anyPlaying
  }

  /** Lights the header of the instrument each note passed between two playhead positions plays (a jump passes none). */
  private flashPassedNotes(layout: SongLayout, track: number, before: number, after: number): void {
    if (after <= before || after - before > JUMP_ROWS) return
    for (let row = Math.floor(before) + 1; row <= Math.floor(after); row += 1) {
      const instance = layout.instanceAt(track, row)
      const step     = instance ? layout.model.phrases[instance.phrase]?.steps[row - instance.row] : undefined
      if (!instance || !step?.note || step.note === 'OFF') continue
      const instrument = layout.effective.get(instance.key)?.[row - instance.row]
      const panel      = instrument == null ? undefined : layout.tracks[track].panels.find((p) => p.table === instrument)
      if (panel) panel.flash = 1
    }
  }

  /** Moves a track's drawn playhead toward the tracker's `target` (row + phase). */
  private smooth(track: number, target: number, headRow: number, headStep: number, dt: number): { row: number; phase: number; step: number } {
    let shown = this.shown[track]
    if (!shown || Math.abs(target - shown.position) > JUMP_ROWS || target < shown.target - JUMP_ROWS) {
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

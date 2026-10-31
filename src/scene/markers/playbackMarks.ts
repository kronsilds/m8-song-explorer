// What the 3D view shows of the song playing: a playhead on each track (a halo at the top or bottom
// of a track whose playhead is out of sight) and the rows the playing tables are on.

import { Vector3 } from 'three'
import type { TrackPlayhead } from '../../model/live'
import { TablePlayback } from '../../model/music/tablePlayback'
import type { Palette } from '../../model/palette'
import type { SongContext } from '../../model/songContext'
import type { RigPose } from '../camera/rig'
import type { ViewProbe } from '../camera/viewProbe'
import type { SceneContent } from '../content'
import { FRONT_W } from '../layout'
import type { TrackPlacement } from '../track/placement'
import { PlayheadView, type ViewEdges } from './playheadView'
import { TablePlayheadView } from './tablePlayheadView'

/** Pixels above the bottom of the view where the halo of a playhead below it sits: just over the footer line. */
const HALO_BOTTOM_PX = 26

export class PlaybackMarks {
  /** Where the song plays, read each frame (null: nothing plays). */
  source                      : (() => (TrackPlayhead | null)[]) | null = null
  private readonly heads      = new PlayheadView()
  private readonly tableHeads = new TablePlayheadView()
  private tablePlayback       : TablePlayback | null = null

  constructor(
    private readonly content: Readonly<SceneContent>,
    private readonly placement: TrackPlacement,
    private readonly probe: ViewProbe,
  ) {}

  /** The song shown (its tables play along with it). */
  setSong(song: SongContext): void {
    this.tablePlayback = new TablePlayback(song.model, song.timeline, song.effective)
  }

  /** The M8's Table view shows table `table` on these rows (see TablePlayback.observeTableView). */
  observeTableView(table: number, main: number | null, lanes: (number | null)[], track: number | null): void {
    this.tablePlayback?.observeTableView(table, main, lanes, track)
  }

  /** Places the playheads for the camera at `pose`; returns true while anything plays. */
  update(dt: number, pose: RigPose, palette: Palette): boolean {
    const { layout, trackViews } = this.content
    const heads                  = this.source?.() ?? []
    const height                 = this.probe.height
    const bottom                 = height > 0 ? -1 + (2 * HALO_BOTTOM_PX) / height : -0.97
    let aimed                    = false
    const edges                  = (track: number): ViewEdges | null => {
      const view = trackViews[track]
      if (!view) return null
      if (!aimed) this.probe.aim(pose)
      aimed      = true
      return {
        top   : view.headerBottom,
        bottom: this.probe.heightAt(pose, this.placement.frontX(track) + FRONT_W / 2, bottom)
      }
    }
    const playing                = this.heads.update(heads, layout, trackViews, palette, dt, edges)
    this.tableHeads.update(this.tablePlayback, layout, trackViews, palette, heads, performance.now())
    return playing
  }

  /** The playhead furthest down the song, on a track's front column where it settles; null when nothing plays. */
  leadPoint(track: number): Vector3 | null {
    const position = this.heads.leadPosition()
    const layout   = this.content.layout
    if (position == null || !layout) return null
    const row = Math.floor(position)
    return new Vector3(this.placement.settledX(track) + FRONT_W / 2, PlayheadView.rowY(layout, row, position - row), 0)
  }
}

// The table playheads: on the panel of each table a track is playing, a marker across the row
// the table is on, and over the cell of each FX lane that runs elsewhere (its own speed or hop).
// Positions come from TablePlayback, which models them and puts them right from what the M8
// shows, so they are drawn fainter than the step playheads, fainter still while a chance note
// may have moved them, and not at all while a random THO left the row unknown.

import { fxColumn } from '../../model/columns'
import type { TablePlayback, TablePosition, TrackSound } from '../../model/music/tablePlayback'
import { FX_LANES, TRACKS } from '../../model/song'
import { CHAR_W, PANEL_CHARS, PANEL_FIELDS, ROW_H, type SongLayout, TITLE_ROWS } from '../layout'
import type { Palette } from '../palette'
import type { TrackView } from '../track/trackView'
import { CellMarker } from './cellMarker'

/** A row's marker and the markers of the lanes, per table of a track (its own and its aux one). */
const MARKERS_PER_TABLE = 1 + FX_LANES
const TABLES_PER_TRACK  = 2
const ROW_FILL          = 0.14
const ROW_OUTLINE       = 0.45
const LANE_FILL         = 0.2
const LANE_OUTLINE      = 0.8
/** Room around a table row, as the selection marker has. */
const ROW_PAD           = 0.3
const CELL_PAD          = 0.12
/** How much fainter a table playhead is drawn while its row is not known. */
const UNSURE_ALPHA      = 0.4

/** A track's playhead as the tracker gives it, with the note its track panel shows. */
export interface PlayingHead extends TablePosition {
  note: TrackSound | null
}

export class TablePlayheadView {
  private readonly markers = Array.from({ length: TRACKS }, () => Array.from({ length: TABLES_PER_TRACK * MARKERS_PER_TABLE }, () => new CellMarker()))

  /**
   * Moves each track's tables to its playhead (`heads`: the tracker's, with the note the M8's track
   * panel shows; null when it is not playing) at time `now` (ms), and draws them.
   */
  update(playback: TablePlayback | null, layout: SongLayout | null, views: TrackView[], palette: Palette, heads: (PlayingHead | null)[], now: number): void {
    this.markers.forEach((markers, track) => {
      const head = heads[track] ?? null
      playback?.update(track, head, head?.note ?? null, now)
      let used          = 0
      const view        = views[track]
      const trackPanels = layout?.tracks[track]?.panels ?? []
      for (const cursors of playback && view && view.wallAlpha > 0.05 ? playback.cursors(track) : []) {
        const panel = trackPanels.find((p) => p.table === cursors.table)
        // The table face only: a panel turned to its instrument face has no rows to mark.
        // A table a random THO sent somewhere nothing says has no row to mark (the Table view shows it again).
        if (!panel || panel.alpha < 0.05 || view.shownFace(panel) !== 'table' || !cursors.known) continue
        const frame = view.faceFrame(panel, 'table')
        // A row left unknown by chance or a random THO is drawn fainter until the M8 tells.
        const alpha = panel.alpha * view.wallAlpha * (cursors.aux ? 0.7 : 1) * (cursors.sure ? 1 : UNSURE_ALPHA)
        // Only rows the panel shows whole: a trimmed, empty or folded table hides the rest, and an opening one shows them as it grows.
        const shown = (tableRow: number) => tableRow + TITLE_ROWS + 1 <= view.shownRows(panel) + 1e-6
        if (shown(cursors.main)) {
          markers[used++].show({
            parent: frame,
            x     : -ROW_PAD,
            y     : -(cursors.main + 2) * ROW_H,
            w     : PANEL_CHARS * CHAR_W + 2 * ROW_PAD,
            h     : ROW_H
          }, palette.device, ROW_FILL * alpha, ROW_OUTLINE * alpha)
        }
        cursors.lanes.forEach((laneRow, lane) => {
          if (laneRow == null || laneRow === cursors.main || !shown(laneRow)) return
          const [cmdStart]           = PANEL_FIELDS[fxColumn(lane, 'cmd')]
          const [valStart, valWidth] = PANEL_FIELDS[fxColumn(lane, 'val')]
          markers[used++].show({
            parent: frame,
            x     : cmdStart * CHAR_W - CELL_PAD,
            y     : -(laneRow + 2) * ROW_H,
            w     : (valStart + valWidth - cmdStart) * CHAR_W + 2 * CELL_PAD,
            h     : ROW_H
          }, palette.device, LANE_FILL * alpha, LANE_OUTLINE * alpha)
        })
      }
      for (let i = used; i < markers.length; i += 1) markers[i].hide()
    })
  }
}

// The table playheads: on the panel of each table a track is playing, a marker across the row
// the table is on, and over the cell of each FX lane that runs elsewhere (its own speed or hop).
// Positions come from TablePlayback, which models them (and is not checked on the device yet),
// so they are drawn fainter than the step playheads.

import { fxColumn } from '../../model/columns'
import type { TablePlayback } from '../../model/music/tablePlayback'
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

export class TablePlayheadView {
  private readonly markers = Array.from({ length: TRACKS }, () => Array.from({ length: TABLES_PER_TRACK * MARKERS_PER_TABLE }, () => new CellMarker()))

  /** Moves each track's tables to its playhead (`positions`: timeline rows, null when it is not playing) and draws them. */
  update(playback: TablePlayback | null, layout: SongLayout | null, views: TrackView[], palette: Palette, positions: (number | null)[]): void {
    this.markers.forEach((markers, track) => {
      playback?.update(track, positions[track] ?? null)
      let used          = 0
      const view        = views[track]
      const trackPanels = layout?.tracks[track]?.panels ?? []
      for (const cursors of playback && view && view.wallAlpha > 0.05 ? playback.cursors(track) : []) {
        const panel = trackPanels.find((p) => p.table === cursors.table)
        // The table face only: a panel turned to its instrument face has no rows to mark.
        if (!panel || panel.alpha < 0.05 || view.shownFace(panel) !== 'table') continue
        const frame = view.faceFrame(panel, 'table')
        const alpha = panel.alpha * view.wallAlpha * (cursors.aux ? 0.7 : 1)
        // Only rows the panel shows: a trimmed, empty or folded table hides the rest.
        const shown = (tableRow: number) => tableRow + TITLE_ROWS < view.shownRows(panel)
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

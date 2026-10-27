// Where the M8 cursor is, as places of the song: every place the item under the cursor
// appears, and the one the device most likely came from (the song cell and chain row last
// visited).

import type { DeviceFocus } from '../m8/screen/liveScreen'
import { isPhraseColumn, isTableColumn } from '../model/columns'
import { cellAt, instrumentPage } from '../model/instrumentPage'
import { TITLE_ROW } from '../model/screens'
import type { Selection } from '../model/selection'
import type { SongLayout } from '../scene/layout'

export class DeviceCursor {
  /** Song row and track the M8 was last on (Song view). */
  songContext     : { songRow: number; track: number } | null = null
  /** Chain row the M8 was last on (Chain view). */
  private chainRow: number | null = null

  /** Every place of the song the item under the M8 cursor appears. Remembers the song cell and chain row on the way. */
  placesOf(layout: SongLayout, focus: DeviceFocus): Selection[] {
    const { id, row } = focus
    switch (focus.view) {
      case 'song': {
        const track = focus.column?.startsWith('track') ? Number(focus.column.slice(5)) - 1 : null
        if (row == null || track == null) return []
        this.songContext = {
          songRow: row,
          track
        }
        const instance   = layout.timeline.byTrack[track].find((i) => i.songRow === row && i.chainRow === 0)
        return instance ? [{
          kind: 'chain',
          instance,
          view: 'song'
        }] : []
      }
      case 'chain':
        if (id == null || row == null) return []
        this.chainRow = row
        return layout.timeline.instances.filter((i) => i.chain === id && i.chainRow === row).map((instance) => ({
          kind: 'chain',
          instance,
          view: 'chain'
        }))
      case 'phrase': {
        if (id == null) return []
        const column = isPhraseColumn(focus.column) ? focus.column : 'note'
        return (layout.timeline.byPhrase.get(id) ?? []).map((instance) => ({
          kind: 'step',
          instance,
          step: row ?? 0,
          column
        }))
      }
      case 'table': {
        if (id == null) return []
        const column = isTableColumn(focus.column) ? focus.column : 'transpose'
        return layout.tracks.flatMap((track) => {
          const panel = track.panels.find((p) => p.table === id)
          return panel ? [{
            kind      : 'table',
            table     : id,
            row       : row ?? 0,
            column,
            track     : track.track,
            instrument: panel.instrument
          } as const] : []
        })
      }
      case 'inst':
      case 'instmods': {
        if (id == null) return []
        // The value under the cursor, on every panel of that instrument; the header when none is under it.
        const instrument = layout.model.instruments[id]
        const screen     = focus.view === 'inst' ? 'inst' : 'mods'
        const cell       = instrument && focus.cursor ? cellAt(instrumentPage(instrument), screen, focus.cursor.y - TITLE_ROW, focus.cursor.x) : null
        return layout.tracks.flatMap((track): Selection[] => {
          const panel = track.panels.find((p) => p.instrument === id)
          if (!panel) return []
          return [cell ? {
            kind      : 'instParam',
            instrument: id,
            screen,
            line      : cell.line,
            x         : cell.x,
            table     : panel.table,
            track     : track.track
          } : {
            kind      : 'instrument',
            instrument: id,
            table     : panel.table,
            track     : track.track
          }]
        })
      }
      default:
        return []
    }
  }

  /** The place to follow: the one in the song cell and chain row the M8 came from, else the first. */
  preferred(places: Selection[]): Selection | null {
    const context     = this.songContext
    const fromContext = places.find(
      (place) =>
        (place.kind === 'step' || place.kind === 'chain') &&
        context &&
        place.instance.songRow === context.songRow &&
        place.instance.track === context.track &&
        (this.chainRow == null || place.instance.chainRow === this.chainRow),
    )
    return fromContext ?? places[0] ?? null
  }
}

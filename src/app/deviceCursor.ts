// Where the M8 cursor is, as places of the song: every place the item under the cursor
// appears, and the one the device is on: the song cell it came from, and the chain row (the
// Chain view's cursor row, the '<' the Phrase view draws at its chain position).

import type { DeviceFocus } from '../m8/screen/liveScreen'
import { viewChainPosition } from '../m8/screen/screenReader'
import { isPhraseColumn, isTableColumn } from '../model/columns'
import { cellAt, instrumentPage } from '../model/instrumentPage'
import { TITLE_ROW } from '../model/screens'
import type { Selection } from '../model/selection'
import { TRACKS } from '../model/song'
import type { SongLayout } from '../scene/layout'

/** A place in a chain: a song cell or a phrase step. */
type ChainPlace = Extract<Selection, { kind: 'chain' | 'step' }>

export class DeviceCursor {
  /** Song row and track the M8 is on: set on the Song view, then moved along with it on the Chain and Phrase views. */
  songContext      : { songRow: number; track: number } | null = null
  /** Chain row the M8 is on: the Chain view's cursor row, the Phrase view's chain position. */
  private chainRow : number | null = null
  /** The Phrase view's '<' marks last seen. */
  private lastMarks: number[] = []

  /** The chain row the M8 shows: the Chain view's cursor row, the Phrase view's chain position; null before any. */
  get chainPosition(): number | null {
    return this.chainRow
  }

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
        // The '<' tells the repeats of a phrase in its chain apart; without it the last chain row stands.
        const position = viewChainPosition(focus.chainMarks, this.chainRow, this.lastMarks)
        this.lastMarks = focus.chainMarks
        if (position != null) this.chainRow = position
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

  /**
   * The place to follow, at the chain row the M8 is on: in the song cell it came from; else in
   * the same song row on the nearest track (Option+Left/Right on the Chain and Phrase views);
   * else on its track at the nearest song row (Option+Up/Down on the Chain view); else the
   * first. The context follows the first two moves.
   */
  preferred(places: Selection[]): Selection | null {
    const inChains = places.filter((place): place is ChainPlace => place.kind === 'chain' || place.kind === 'step')
    const atRow    = inChains.filter((place) => place.instance.chainRow === this.chainRow)
    const choices  = atRow.length > 0 ? atRow : inChains
    const context  = this.songContext
    if (!context) {
      // No Song view seen yet (a reload on a Chain or Phrase view): one song cell holding them all is the one.
      const cell = choices[0]?.instance
      if (cell && choices.every(({ instance }) => instance.songRow === cell.songRow && instance.track === cell.track)) {
        this.songContext = {
          songRow: cell.songRow,
          track  : cell.track
        }
      }
      return choices[0] ?? places[0] ?? null
    }
    if (choices.length === 0) return places[0] ?? null
    const distance           = ({ instance }: ChainPlace): number => {
      if (instance.songRow === context.songRow) return Math.abs(instance.track - context.track)
      return instance.track === context.track ? TRACKS + Math.abs(instance.songRow - context.songRow) : Number.POSITIVE_INFINITY
    }
    const best               = choices.reduce((chosen, place) => (distance(place) < distance(chosen) ? place : chosen))
    const { songRow, track } = best.instance
    if (Number.isFinite(distance(best)) && (songRow !== context.songRow || track !== context.track)) this.songContext = { songRow, track }
    return best
  }
}

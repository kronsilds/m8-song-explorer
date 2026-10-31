// Where the M8 cursor is, as places of the song: every place the item under the cursor
// appears, and the one the device is on: the song cell it came from, and the chain row (the
// Chain view's cursor row, the '<' the Phrase view draws at its chain position).

import type { DeviceFocus } from '../m8/screen/liveScreen'
import { viewChainPosition } from '../m8/screen/screenReader'
import { isPhraseColumn, isTableColumn } from '../model/columns'
import { cellAt, instrumentPage } from '../model/instrumentPage'
import { TITLE_ROW } from '../model/screens'
import { type Selection, selectionTrack } from '../model/selection'
import { TRACKS } from '../model/song'
import type { SongContext } from '../model/songContext'

/** A place in a chain: a song cell or a phrase step. */
type ChainPlace = Extract<Selection, { kind: 'chain' | 'step' }>

/** The panels on a track's wall (the 3D layout's tracks): a table or an instrument is followed on them. */
export interface TrackPanels {
  track : number
  panels: readonly { table: number; instrument: number | null }[]
}

export class DeviceCursor {
  /** Song row and track the M8 is on: set on the Song view, then moved along with it on the Chain and Phrase views. */
  songContext      : { songRow: number; track: number } | null = null
  /**
   * Until a Song view gives the song context: the song cell of the place followed last, a guess
   * that keeps the next places near it (else a chain or phrase used in several song cells would
   * jump to its first one at every view).
   */
  private guess    : { songRow: number; track: number } | null = null
  /** Chain row the M8 is on: the Chain view's cursor row, the Phrase view's chain position. */
  private chainRow : number | null = null
  /** The Phrase view's '<' marks last seen. */
  private lastMarks: number[] = []

  /** The chain row the M8 shows: the Chain view's cursor row, the Phrase view's chain position; null before any. */
  get chainPosition(): number | null {
    return this.chainRow
  }

  /**
   * Every place of the song the item under the M8 cursor appears (tables and instruments: on the
   * tracks whose wall has their panel). Remembers the song cell and chain row on the way.
   */
  placesOf(song: SongContext, tracks: readonly TrackPanels[], focus: DeviceFocus): Selection[] {
    const { id, row }  = focus
    const { timeline } = song
    switch (focus.view) {
      case 'song': {
        const track = focus.column?.startsWith('track') ? Number(focus.column.slice(5)) - 1 : null
        if (row == null || track == null) return []
        this.songContext = {
          songRow: row,
          track
        }
        const instance   = timeline.byTrack[track].find((i) => i.songRow === row && i.chainRow === 0)
        return instance ? [{
          kind: 'chain',
          instance,
          view: 'song'
        }] : []
      }
      case 'chain':
        if (id == null || row == null) return []
        this.chainRow = row
        return timeline.instances.filter((i) => i.chain === id && i.chainRow === row).map((instance) => ({
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
        return (timeline.byPhrase.get(id) ?? []).map((instance) => ({
          kind: 'step',
          instance,
          step: row ?? 0,
          column
        }))
      }
      case 'table': {
        if (id == null) return []
        const column = isTableColumn(focus.column) ? focus.column : 'transpose'
        return tracks.flatMap((track) => {
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
        const instrument = song.model.instruments[id]
        const screen     = focus.view === 'inst' ? 'inst' : 'mods'
        const cell       = instrument && focus.cursor ? cellAt(instrumentPage(instrument), screen, focus.cursor.y - TITLE_ROW, focus.cursor.x) : null
        return tracks.flatMap((track): Selection[] => {
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
   * first. The context follows the first two moves. A table or an instrument (each track that
   * uses it has its panel) is followed on the track the M8 came from, else the nearest.
   */
  preferred(places: Selection[]): Selection | null {
    const inChains = places.filter((place): place is ChainPlace => place.kind === 'chain' || place.kind === 'step')
    const atRow    = inChains.filter((place) => place.instance.chainRow === this.chainRow)
    const choices  = atRow.length > 0 ? atRow : inChains
    const known    = this.songContext != null
    const context  = this.songContext ?? this.guess
    if (inChains.length === 0 && context && places.length > 1) {
      const away = (place: Selection) => Math.abs(selectionTrack(place) - context.track)
      return places.reduce((chosen, place) => (away(place) < away(chosen) ? place : chosen))
    }
    if (!known) {
      // No Song view seen yet (a reload on a Chain or Phrase view): one song cell holding them all is the one.
      const cell = choices[0]?.instance
      if (cell && choices.every(({ instance }) => instance.songRow === cell.songRow && instance.track === cell.track)) {
        this.songContext = {
          songRow: cell.songRow,
          track  : cell.track
        }
      }
    }
    if (!context) {
      const chosen = choices[0] ?? null
      if (chosen) this.guess = {
        songRow: chosen.instance.songRow,
        track  : chosen.instance.track
      }
      return chosen ?? places[0] ?? null
    }
    if (choices.length === 0) return places[0] ?? null
    const distance           = ({ instance }: ChainPlace): number => {
      if (instance.songRow === context.songRow) return Math.abs(instance.track - context.track)
      return instance.track === context.track ? TRACKS + Math.abs(instance.songRow - context.songRow) : Number.POSITIVE_INFINITY
    }
    const best               = choices.reduce((chosen, place) => (distance(place) < distance(chosen) ? place : chosen))
    const { songRow, track } = best.instance
    if (!this.songContext) this.guess = { songRow, track }
    else if (Number.isFinite(distance(best)) && (songRow !== context.songRow || track !== context.track)) this.songContext = { songRow, track }
    return best
  }
}

// The sizes of the 3D view's parts, in world units: character cells and rows, the front column,
// the wall with its step details and its columns of panels, and the rows a panel shows. Plain
// numbers and the Panel record; SongLayout places things with them.

import type { PhraseColumn, TableColumn } from '../model/columns'
import { ROWS_PER_TABLE, type Table } from '../model/song'
import { DEFAULT_WALL_DEGREES } from '../model/viewOptions'

export const FONT     = 1
export const CHAR_W   = 0.6 * FONT
export const ROW_H    = 1.34 * FONT
export const BAND_GAP = 1.6
/** Rows above the first song row, for the headers (three lines: fold buttons, track title, column names). */
export const HEADER_H = 5.5 + ROW_H

// Front column: "cc pp C-4 03" (chain label, phrase label, note, instrument)
export const FRONT_CHARS = 12
export const CHAIN_COL   = 0
export const PHRASE_COL  = 3
export const NOTE_COL    = 6
export const INST_COL    = 10
export const FRONT_W     = FRONT_CHARS * CHAR_W
export const TRACK_GAP   = 2.4
export const TRACK_PITCH = FRONT_W + TRACK_GAP

// Wall: step details "VV II CCCvv CCCvv CCCvv", then the panels. u runs along the wall.
/** How far the wall is turned from the front by default, in radians (the Options panel changes it). */
export const DEFAULT_WALL_ANGLE = (DEFAULT_WALL_DEGREES * Math.PI) / 180
export const WALL_HINGE         = FRONT_W + 0.35
export const SIDE_U0            = 0.5
export const SIDE_CHARS         = 23
/** Where the step details end along the wall. */
export const SIDE_END           = SIDE_U0 + SIDE_CHARS * CHAR_W + 0.35
export const PANEL_U0           = SIDE_U0 + SIDE_CHARS * CHAR_W + 2.5
/**
 * How far the wall slides back along itself while the step details are folded: by their width,
 * so the panels keep the room they have after the FX columns (for the links) from the front column.
 */
export const PANELS_SLIDE       = SIDE_U0 + SIDE_CHARS * CHAR_W
export const PANEL_CHARS        = 25
/** Panel rows: title, subtitle, 16 table rows. */
export const PANEL_ROWS         = 18
/** The title lines of a panel (title, subtitle): all a folded panel or an empty table shows. */
export const TITLE_ROWS         = 2
/** Panels that do not fit one column below each other tile into more columns, deeper along the wall. */
export const MAX_PANEL_COLS     = 4
/** Columns a wall has room for until its `+` button extends it (up to MAX_PANEL_COLS). */
export const DEFAULT_PANEL_COLS = 2
export const PANEL_COL_W        = PANEL_CHARS * CHAR_W + 2
/** Rows between panels stacked in a column: room for the tab over the lower one's corner. */
export const PANEL_GAP_ROWS     = 1.75
/** Room a panel takes on the wall, gap included. */
export const PANEL_SPAN         = (PANEL_ROWS + PANEL_GAP_ROWS) * ROW_H
/** Room a panel of `rows` rows takes on the wall, gap included. */
export const panelSpan          = (rows: number): number => (rows + PANEL_GAP_ROWS) * ROW_H

/** Length of a wall that has `cols` columns of panels. */
export const wallLength = (cols: number): number => PANEL_U0 + PANEL_CHARS * CHAR_W + 1 + (cols - 1) * PANEL_COL_W
/** Wall u of the left edge of a panel column. */
export const panelU     = (col: number): number => PANEL_U0 + col * PANEL_COL_W

/** A field's character columns: [start, width]. */
export type FieldSpan = [start: number, width: number]

/** Character columns of each phrase field on the wall. */
export const SIDE_FIELDS : Record<Exclude<PhraseColumn, 'note'>, FieldSpan> = {
  vel   : [0, 2],
  inst  : [3, 2],
  fx1cmd: [6, 3],
  fx1val: [9, 2],
  fx2cmd: [12, 3],
  fx2val: [15, 2],
  fx3cmd: [18, 3],
  fx3val: [21, 2]
}

/** Character columns of a table row in a panel: "R TT VV CCCvv CCCvv CCCvv". */
export const PANEL_FIELDS: Record<TableColumn, FieldSpan> = {
  transpose: [2, 2],
  volume   : [5, 2],
  fx1cmd   : [8, 3],
  fx1val   : [11, 2],
  fx2cmd   : [14, 3],
  fx2val   : [17, 2],
  fx3cmd   : [20, 3],
  fx3val   : [23, 2]
}

/** The field at character column `char` (a field takes the blank after it too), or `fallback`. */
export function fieldAt<K extends string>(fields: Record<K, FieldSpan>, char: number, fallback: K): K {
  const hit = (Object.entries(fields) as [K, FieldSpan][]).find(([, [start, width]]) => char >= start && char < start + width + 1)
  return hit?.[0] ?? fallback
}

/** First and last timeline rows of a phrase instance that use a panel (its notes, I column, INS, TBL, TBX). */
export type UseSpan = [first: number, last: number]

export interface Panel {
  track      : number
  table      : number
  /** The instrument whose table it is, when the table belongs to one. */
  instrument : number | null
  /** First and last timeline rows anywhere in the song that use it. */
  row        : number
  lastRow    : number
  /** Top y (title line) on the wall when nothing sticks: level with its first use. */
  naturalY   : number
  /** Top y it should be at now: it sticks near the top of the view while its rows are on screen (see PanelStacks.stick). */
  y          : number
  /** False while none of its rows is near the view. */
  visible    : boolean
  /** Column of the panel grid it is in, and the wall u of that column (see PanelStacks.stick). */
  col        : number
  u          : number
  /** Where it is drawn and how opaque (0..1): eases toward y / u / visible, so it glides and fades. */
  shownY     : number
  shownU     : number
  alpha      : number
  /** Rows and characters of the face it shows (or turns to) when open: the table's, or the larger instrument face. */
  rows       : number
  chars      : number
  /** How far it has turned over to its instrument face (0 the table, 1 the instrument). */
  flip       : number
  /** Glow of its header after a playhead passed a note that plays it (1 at the note, easing to 0). */
  flash      : number
  /** Table rows worth showing: down to the last one with something in it (0 for an empty table). */
  contentRows: number
  /** Where it is used, one stretch per phrase instance that uses it, sorted: how far from the view it is used. */
  spans      : UseSpan[]
  /** Its distance band (see PanelStacks): the first column it may take. */
  band       : number
  /** One of its uses is on screen (or was, a moment ago): it folds after the others. */
  now        : boolean
  /** Its place in its column: panels stack in the order they came into it (see PanelStacks.stick). */
  seq        : number
  /** Selected, or under the M8 cursor: never folded, kept whole on screen, placed first when it would not fit. */
  pinned     : boolean
  /** Linked from the selected step: never folded. */
  linked     : boolean
  /** Table row the selection or the M8 cursor is on, so the table shows down to it. */
  selectedRow: number | null
  /** Folded to its title lines by PanelStacks.stick: used far away, or too little room and others are more useful. */
  folded     : boolean
  /** At the top of its column (see PanelStacks.stick): pinned, and it would not have been whole on screen in its place. */
  promoted   : boolean
}

/** Rows a panel takes on the wall now: its title lines when folded, else its face's. */
export const shownPanelRows = (panel: Panel): number => (panel.folded ? TITLE_ROWS : panel.rows)

/**
 * Rows of a panel's table face: its title lines, then its 16 rows, or with `trim` only its rows
 * down to its last with content (or to the selected row).
 */
export const tableFaceRows = (panel: Panel, trim = true): number =>
  TITLE_ROWS + (trim ? Math.max(panel.contentRows, panel.selectedRow != null ? panel.selectedRow + 1 : 0) : ROWS_PER_TABLE)

/** Rows of a table worth showing: down to its last row with a transpose, a volume or an FX command. A table not read shows one ('not read'). */
export function tableContentRows(table: Table | undefined): number {
  if (!table) return 1
  let rows = 0
  table.rows.forEach((row, r) => {
    if (row.transpose || row.volume != null || row.fx.some((fx) => fx.cmd)) rows = r + 1
  })
  return rows
}

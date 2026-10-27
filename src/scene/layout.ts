// Where everything goes. Time runs down the Y axis, one row per phrase step, song rows
// separated by a small gap. Each track is a column facing the viewer (chain and phrase
// labels, then the notes) and a "wall" hinged on its right edge that recedes into depth:
// first the rest of each step (velocity, instrument, three FX), then the panels of the
// instruments and tables the track uses, joined to the steps that use them.

import { fxColumn, type PhraseColumn, type TableColumn } from '../model/columns'
import { ScaleMap } from '../model/music/harmony'
import { ROWS_PER_PHRASE, ROWS_PER_TABLE, type SongModel, type Table, TRACKS } from '../model/song'
import { buildTimeline, effectiveInstruments, instanceAt, type PhraseInstance, type Timeline } from '../model/timeline'
import { type InstrumentFace, layoutInstrumentFace } from './instrumentFace'

export const FONT     = 1
export const CHAR_W   = 0.6 * FONT
export const ROW_H    = 1.34 * FONT
export const BAND_GAP = 1.6
/** Rows above the first song row, for the headers. */
export const HEADER_H = 5.5

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
export const WALL_ANGLE     = (56 * Math.PI) / 180
export const WALL_HINGE     = FRONT_W + 0.35
export const SIDE_U0        = 0.5
export const SIDE_CHARS     = 23
export const PANEL_U0       = SIDE_U0 + SIDE_CHARS * CHAR_W + 2.5
export const PANEL_CHARS    = 25
/** Panel rows: title, subtitle, 16 table rows. */
export const PANEL_ROWS     = 18
/** The title lines of a panel (title, subtitle): all a folded panel or an empty table shows. */
export const TITLE_ROWS     = 2
/** Panels that do not fit one column below each other tile into more columns, deeper along the wall. */
export const MAX_PANEL_COLS = 4
export const PANEL_COL_W    = PANEL_CHARS * CHAR_W + 2
/** Panels a column is expected to show at once, to size the wall from how many are in use together. */
const PANELS_PER_COL        = 2
/** Rows around a panel's uses counted as "in view together" when sizing the wall. */
const PANEL_VIEW_PAD_ROWS   = 24
/** Rows between panels stacked in a column: room for the tab over the lower one's corner. */
const PANEL_GAP_ROWS        = 1.75
/** Height of a phrase on the wall. */
const PHRASE_HEIGHT         = ROWS_PER_PHRASE * ROW_H
/**
 * The reach panels are placed for: the view height, and at least this many phrases, so that when
 * zoomed in panels do not change band, or come and go, at every phrase of a fast song.
 */
const MIN_REACH_PHRASES     = 6
/**
 * Distance bands, in reaches between the view and a panel's nearest use: on screen or within half
 * a reach, within one and a half, within four, further. A panel's band is the first column it may
 * take, so how far along the wall it is tells how far away it is used.
 */
const DISTANCE_BANDS        = [0.5, 1.5, 4]
/** How far (in reaches) a panel may go past the edge of its band before it changes band, so panels do not change columns while a song plays or scrolls a little. */
const BAND_HYSTERESIS       = 0.5
/** The band of panels used further than the last DISTANCE_BANDS edge: they show their title lines only, while there is room. */
const FAR_BAND              = DISTANCE_BANDS.length
/** How far (in view heights, and at least a phrase) the uses of a panel may scroll off screen before it stops counting as used on screen (it then folds before those that are). */
const NOW_HYSTERESIS        = 0.25
/** Fewest table rows a fold must hide to make room: a smaller table is nearly its title lines, and folding it would mostly move the panels below (it still folds for a fuller table used on screen, or a title). */
const MIN_FOLD_ROWS         = 2
/** How much the view height may change (a zoom) before a track's grid is laid out afresh for it, in the order its panels had. */
const REPACK_ZOOM           = 0.15
/** Room a panel takes on the wall, gap included. */
export const PANEL_SPAN     = (PANEL_ROWS + PANEL_GAP_ROWS) * ROW_H
/** Room a panel of `rows` rows takes on the wall, gap included. */
export const panelSpan      = (rows: number): number => (rows + PANEL_GAP_ROWS) * ROW_H

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
  /** Top y it should be at now: it sticks near the top of the view while its rows are on screen (see stick()). */
  y          : number
  /** False while none of its rows is near the view. */
  visible    : boolean
  /** Column of the panel grid it is in, and the wall u of that column (see stick()). */
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
  /** Its distance band (see DISTANCE_BANDS): the first column it may take. */
  band       : number
  /** One of its uses is on screen (or was, a moment ago): it folds after the others. */
  now        : boolean
  /** Its place in its column: panels stack in the order they came into it (see stick()). */
  seq        : number
  /** Selected, or under the M8 cursor: never folded, kept whole on screen, placed first when it would not fit. */
  pinned     : boolean
  /** Linked from the selected step: never folded. */
  linked     : boolean
  /** Table row the selection or the M8 cursor is on, so the table shows down to it. */
  selectedRow: number | null
  /** Folded to its title lines by stick(): used far away, or too little room and others are more useful. */
  folded     : boolean
  /** At the top of its column (see stick()): pinned, and it would not have been whole on screen in its place. */
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

/** A panel being placed by stick(): the columns it may take, where it goes and how it shows. */
interface Placing {
  panel   : Panel
  band    : number
  now     : boolean
  /** Top y of its use nearest to the view: panels that come in together stack in the order of their uses. */
  useY    : number
  /** Turned to its instrument face: it opens where it is, at the top of its column. */
  turned  : boolean
  /** Its face is wider than a column (turned, on a wall with more than one): it takes the next column too. */
  wide    : boolean
  /** Selected and moved to the top of its column, so it is whole on screen. */
  promoted: boolean
  /** May fold to its title lines and make way (not selected, linked or turned). */
  foldable: boolean
  /** First and last columns it may take. */
  from    : number
  last    : number
  /** Its column (-1 while it has none) and its place in it. */
  col     : number
  seq     : number
  folded  : boolean
  hidden  : boolean
}

const placingRows = (placing: Placing): number => (placing.folded ? TITLE_ROWS : placing.panel.rows)

/** Height a column of panels takes stacked, its panels at `rows` rows (no gap after the last). */
function stackHeight(members: Placing[], rows = placingRows): number {
  if (!members.length) return 0
  return members.reduce((sum, member) => sum + panelSpan(rows(member)), 0) - PANEL_GAP_ROWS * ROW_H
}

/** First and last timeline rows of a phrase instance that use a panel (its notes, I column, INS, TBL, TBX). */
export type UseSpan = [first: number, last: number]

export type LinkKind = 'instrument' | 'table'

export interface Link {
  track   : number
  kind    : LinkKind
  /** Timeline row and wall character column of the cell it leaves from. */
  row     : number
  col     : number
  instance: PhraseInstance
  step    : number
  panel   : Panel
}

/** A cell of a phrase instance that points at an instrument (I column, INS) or a table (TBL, TBX). */
interface PanelReference {
  kind      : LinkKind
  row       : number
  col       : number
  step      : number
  table     : number
  instrument: number | null
}

export interface TrackLayout {
  track     : number
  instances : PhraseInstance[]
  panels    : Panel[]
  links     : Link[]
  /** Columns of panels its wall has room for, and the wall's length and x extent for them. */
  cols      : number
  wallLen   : number
  wallExtent: number
}

export class SongLayout {
  readonly model         : SongModel
  readonly timeline      : Timeline
  /** Top y of each song band. */
  readonly bandTop       : number[]
  readonly tracks        : TrackLayout[]
  /** The instrument each step plays, per instance key (see effectiveInstruments). */
  readonly effective     : Map<string, (number | null)[]>
  /** The scale each track plays with along the song. */
  readonly scales        : ScaleMap
  readonly bottomY       : number
  private readonly faces = new Map<number, InstrumentFace>()

  /** Tables show only their rows down to the last with content (an empty one its title lines); false: all 16. */
  trimTables        : boolean
  /** Panels that came into a column so far: the next one's place (see Panel.seq). */
  private arrivals  = 0
  /** View height each track's grid was last laid out afresh for (see REPACK_ZOOM). */
  private packedFor = new Map<number, number>()

  constructor(model: SongModel, trimTables = true) {
    this.trimTables = trimTables
    this.model      = model
    this.timeline   = buildTimeline(model)
    this.effective  = effectiveInstruments(model, this.timeline)
    this.scales     = new ScaleMap(model, this.timeline)
    this.bandTop    = this.timeline.bands.map((band, i) => -(band.row * ROW_H + i * BAND_GAP))
    const lastBand  = this.timeline.bands.length - 1
    let bottomY     = lastBand >= 0 ? this.bandTop[lastBand] - this.timeline.bands[lastBand].length * ROW_H : 0
    this.tracks     = Array.from({ length: TRACKS }, (_, track) => this.layoutTrack(track))
    // Panels can run below the last row; one more is allowed for a panel pushed down by its neighbours.
    for (const track of this.tracks) {
      for (const panel of track.panels) bottomY = Math.min(bottomY, panel.naturalY - PANEL_ROWS * ROW_H - PANEL_SPAN * 0.5)
    }
    this.bottomY = bottomY
  }

  /** The instrument face of an instrument (laid out once), null when the instrument was not read. */
  instrumentFace(id: number | null): InstrumentFace | null {
    if (id == null) return null
    const instrument = this.model.instruments[id]
    if (!instrument) return null
    let face = this.faces.get(id)
    if (!face) {
      face = layoutInstrumentFace(instrument)
      this.faces.set(id, face)
    }
    return face
  }

  /** Height a track header rests at, over the first song row, until the view scrolls past and it sticks. */
  get headerRestY(): number {
    return this.rowY(0) + ROW_H * 1.9
  }

  /** Rows of a panel's table face, trimmed or not (see trimTables). */
  tableFaceRows(panel: Panel): number {
    return tableFaceRows(panel, this.trimTables)
  }

  /** Index of the band that holds a timeline row. */
  bandIndex(row: number): number {
    const bands = this.timeline.bands
    let low     = 0
    let high    = bands.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (bands[middle].row <= row) low = middle
      else high = middle - 1
    }
    return low
  }

  /** Top y of a timeline row. */
  rowY(row: number): number {
    if (this.timeline.bands.length === 0) return -row * ROW_H
    const band = this.bandIndex(row)
    return this.bandTop[band] - (row - this.timeline.bands[band].row) * ROW_H
  }

  /** Timeline row drawn at height y, null in a gap between song rows or outside the song. */
  rowAtY(y: number): number | null {
    const bands = this.timeline.bands
    for (let band = 0; band < bands.length; band += 1) {
      const top    = this.bandTop[band]
      const bottom = top - bands[band].length * ROW_H
      if (y <= top && y > bottom) return bands[band].row + Math.floor((top - y) / ROW_H)
    }
    return null
  }

  /** The instance on `track` covering a timeline row. */
  instanceAt(track: number, row: number): PhraseInstance | null {
    return instanceAt(this.timeline, track, row)
  }

  private layoutTrack(track: number): TrackLayout {
    const instances     = this.timeline.byTrack[track]
    const panelsByTable = new Map<number, Panel>()
    const links         : Link[] = []

    // Every place links to the panels it uses; the view only draws the ones near it.
    for (const instance of instances) {
      if (!this.model.phrases[instance.phrase]) continue
      for (const reference of this.references(instance)) {
        let panel = panelsByTable.get(reference.table)
        if (!panel) {
          panel = newPanel(track, reference.table, reference.instrument, reference.row)
          panelsByTable.set(reference.table, panel)
        }
        panel.lastRow = Math.max(panel.lastRow, reference.row)
        links.push(linkOf(track, reference, instance, panel))
      }
    }
    for (const instance of instances) {
      for (const [table, span] of this.useSpans(instance)) panelsByTable.get(table)?.spans.push(span)
    }

    // Each panel waits level with its first use; stick() settles overlaps (columns, then down).
    const panels = [...panelsByTable.values()]
    for (const panel of panels) {
      panel.naturalY    = this.rowY(panel.row)
      panel.y           = panel.naturalY
      panel.shownY      = panel.naturalY
      panel.contentRows = tableContentRows(this.model.tables[panel.table])
      panel.rows        = this.tableFaceRows(panel)
      panel.spans.sort((a, b) => a[0] - b[0])
    }

    // An instrument face takes two columns, so a wall with one has room for two.
    const faces   = panels.some((panel) => this.instrumentFace(panel.instrument))
    const cols    = Math.max(faces ? 2 : 1, this.columnsFor(panels))
    const wallLen = wallLength(cols)
    return {
      track,
      instances,
      panels,
      links,
      cols,
      wallLen,
      wallExtent: wallLen * Math.cos(WALL_ANGLE)
    }
  }

  /**
   * Stretches of a phrase instance that use each panel, by table: from the first to the last
   * step that plays the instrument (its note, the one the track played last when the I column
   * is empty) or points at it (I column, INS, TBL, TBX).
   */
  private useSpans(instance: PhraseInstance): Map<number, UseSpan> {
    const spans     = new Map<number, UseSpan>()
    const effective = this.effective.get(instance.key) ?? []
    const use       = (table: number, row: number) => {
      const span = spans.get(table)
      if (span) span[1] = row
      else spans.set(table, [row, row])
    }
    this.model.phrases[instance.phrase]?.steps.forEach((step, s) => {
      const row = instance.row + s
      if (step.inst != null) use(step.inst, row)
      for (const fx of step.fx) if (fx.val != null && (fx.cmd === 'INS' || fx.cmd === 'TBL' || fx.cmd === 'TBX')) use(fx.val, row)
      const playing = effective[s]
      if (step.note && step.note !== 'OFF' && playing != null) use(playing, row)
    })
    return spans
  }

  /** Columns a wall needs: the most panels wanted together (a view's worth of rows around each), a column per few. */
  private columnsFor(panels: Panel[]): number {
    const edges: [row: number, change: number][] = []
    for (const panel of panels) edges.push([panel.row - PANEL_VIEW_PAD_ROWS, 1], [panel.lastRow + ROWS_PER_PHRASE + PANEL_VIEW_PAD_ROWS, -1])
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    let together     = 0
    let mostTogether = 0
    for (const [, change] of edges) {
      together     += change
      mostTogether = Math.max(mostTogether, together)
    }
    return Math.max(1, Math.min(MAX_PANEL_COLS, Math.ceil(mostTogether / PANELS_PER_COL)))
  }

  /**
   * Panels for the view [yBottom, yTop]. A panel shows while the view is between its first and
   * last use in the song (a wider margin to leave than to come, so it does not flicker at the edge).
   * Distances are measured in reaches: the view height, at least MIN_REACH_PHRASES phrases.
   *
   * Columns tell how far away a panel is used: by distance band (see DISTANCE_BANDS), the panels
   * used on screen or within half a reach of it may take the first column, the ones used further
   * start from the second, and so on along the wall. Panels used further than the last band show
   * their title lines only, in the last column, while it has room for them.
   *
   * The grid stays still while the song plays or scrolls: a panel keeps its column and its place
   * in it until its band changes. A panel that comes in, or comes nearer, takes the first column
   * (from its band on) with room for it, at the bottom; one that goes further leaves a column it
   * may no longer take. Panels stack from the top of the view in the order they came in, so the
   * ones in use for long stay on top and newcomers do not push them around. After a zoom (see
   * REPACK_ZOOM) every panel chooses its column afresh, in that order.
   *
   * When a column has too little room, the least useful make way, lowest first: empty tables and
   * panels not used on screen fold to their title lines (the furthest first, then the ones with
   * the least in their tables), far ones hide, then each panel that still does not fit, from the
   * top: one used on screen opens when tables above it with fewer rows in them fold, else moves
   * back open to an earlier column where the panels there make way for it, else moves on open to
   * a later column where they do (see roomFor); else it folds, else it moves on folded. A panel
   * used on screen never hides: at the bottom of a column its title line is enough (the rest may
   * reach below the view), else the panels above it fold for its title. Tables that would hide
   * fewer than MIN_FOLD_ROWS rows fold only for a fuller table, or a title. The selected panel,
   * the ones the selected step links to and the ones turned to their instrument face never fold.
   * A panel turned to its instrument face takes the top of its column and of the next one. A
   * selected panel is kept whole on screen: when it would not be, it moves to the top of its
   * column. Returns true when anything moved.
   *
   * `viewHeight` is the height of the whole view, which sets the reach and tells a zoom; the room
   * for panels [yBottom, yTop] is shorter while the track header rests lower, at the start of the
   * song.
   */
  stick(track: number, yTop: number, yBottom: number, viewHeight = yTop - yBottom): boolean {
    // A panel that had to make way may find room once the others settled: a second pass places it.
    const moved = this.settle(track, yTop, yBottom, viewHeight)
    if (moved) this.settle(track, yTop, yBottom, viewHeight)
    return moved
  }

  /** One pass of stick(). */
  private settle(track: number, yTop: number, yBottom: number, viewHeight: number): boolean {
    const trackLayout = this.tracks[track]
    if (!trackLayout) return false
    const { cols, panels } = trackLayout
    const view             = yTop - yBottom
    const reach            = Math.max(viewHeight, MIN_REACH_PHRASES * PHRASE_HEIGHT)
    // Zoomed in or out since the grid was laid out: every panel chooses its column afresh, in the order it had.
    const packed           = this.packedFor.get(track)
    const repack           = packed == null || Math.abs(viewHeight / packed - 1) > REPACK_ZOOM
    if (repack) this.packedFor.set(track, viewHeight)
    const placings         : Placing[] = []
    for (const panel of panels) {
      const firstY = this.rowY(panel.row)
      const lastY  = this.rowY(panel.lastRow) - ROW_H
      const margin = reach * (panel.visible ? 0.3 : 0.1)
      if (firstY <= yBottom - margin || lastY >= yTop + margin) continue
      const [distance, useY] = this.viewDistance(panel, yTop, yBottom)
      const band             = this.bandOf(panel, distance, reach)
      const turned           = panel.chars > PANEL_CHARS
      const wide             = turned && cols > 1
      const last             = cols - 1 - (wide ? 1 : 0)
      const foldable         = !panel.pinned && !panel.linked && !turned
      const from             = panel.pinned || turned ? 0 : Math.min(band, last)
      placings.push({
        panel,
        band,
        now     : distance <= 0 || (panel.visible && panel.now && distance <= Math.max(NOW_HYSTERESIS * viewHeight, PHRASE_HEIGHT)),
        useY,
        turned,
        wide,
        promoted: panel.pinned && panel.promoted,
        foldable,
        from,
        last,
        // It keeps its column while it stays as near (or goes further) and may still take it.
        col     : !repack && panel.visible && band >= panel.band && panel.col >= from && panel.col <= last ? panel.col : -1,
        seq     : panel.seq,
        folded  : foldable && band >= FAR_BAND,
        hidden  : false
      })
    }

    const members    = (col: number) => placings.filter((p) => !p.hidden && (p.col === col || (p.wide && p.col === col - 1)))
    const stackOrder = (list: Placing[]) => list.sort((a, b) => Number(b.turned || b.promoted) - Number(a.turned || a.promoted) || a.seq - b.seq)
    const evictable  = (p: Placing) => p.foldable && p.band >= FAR_BAND
    // Folding a table that shows fewer rows than that would only move the panels below it.
    const folds      = (p: Placing) => p.foldable && !p.folded && p.panel.rows - TITLE_ROWS >= MIN_FOLD_ROWS
    /**
     * Whether `placing` fits in a column at `rows` rows: far panels there make way for a nearer
     * one and, for one used on screen, the panels there that are not fold.
     */
    const fitsIn     = (col: number, placing: Placing, rows: number) => {
      const others = members(col).filter((m) => m !== placing && !(evictable(m) && !evictable(placing)))
      const yields = (m: Placing) => placing.now && !m.now && folds(m)
      const extra  = others.length ? panelSpan(rows) : rows * ROW_H
      return stackHeight(others, (m) => (yields(m) ? TITLE_ROWS : placingRows(m))) + extra <= view + 1e-6
    }
    const fitsAt     = (col: number, placing: Placing, rows: number) => fitsIn(col, placing, rows) && (!placing.wide || fitsIn(col + 1, placing, rows))
    const columns    = (placing: Placing, from = placing.from) => Array.from({ length: Math.max(0, placing.last - from + 1) }, (_, i) => from + i)
    const takes      = (placing: Placing, col: number) => {
      if (repack || !(placing.panel.visible && placing.panel.col === col && placing.col < 0)) placing.seq = ++this.arrivals
      placing.col = col
    }
    /**
     * The panels of column `col` that make way for `placing` (used on screen) to open there, the
     * lowest first: the ones not used on screen fold, far ones hide, then tables with fewer rows
     * in them fold (with `emptyRowsOnly`, only the ones that show empty rows: trimming off), as
     * long as they hide fewer rows than it shows. Null when that is not enough.
     */
    const roomFor    = (col: number, placing: Placing, emptyRowsOnly = false): { fold: Placing[]; hide: Placing[] } | null => {
      const here   = members(col).filter((m) => m !== placing)
      const own    = here.filter((m) => m.col === col && m.foldable).sort((a, b) => b.seq - a.seq)
      const fold   : Placing[] = []
      const hide   : Placing[] = []
      let height   = stackHeight(here) + (here.length ? panelSpan(placingRows(placing)) : placingRows(placing) * ROW_H)
      let lost     = 0
      const enough = () => height <= view + 1e-6
      for (const m of own.filter((m) => !m.now && folds(m))) {
        if (enough()) break
        fold.push(m)
        height -= (m.panel.rows - TITLE_ROWS) * ROW_H
      }
      for (const m of own.filter(evictable)) {
        if (enough()) break
        hide.push(m)
        height -= panelSpan(placingRows(m))
      }
      const shows = (m: Placing) => !emptyRowsOnly || m.panel.rows - TITLE_ROWS > m.panel.contentRows
      for (const m of own.filter((m) => m.now && !m.folded && m.panel.rows > TITLE_ROWS && m.panel.contentRows < placing.panel.contentRows && shows(m))) {
        if (enough()) break
        fold.push(m)
        height -= (m.panel.rows - TITLE_ROWS) * ROW_H
        lost   += m.panel.contentRows
      }
      return enough() && (lost === 0 || lost < placing.panel.contentRows) ? { fold, hide } : null
    }

    // Newcomers, and panels that came nearer, in band order, then in the order they had (after a zoom), then in the order of their uses.
    const had    = (p: Placing) => (p.panel.visible ? p.seq : Number.POSITIVE_INFINITY)
    const movers = placings.filter((p) => p.col < 0).sort((a, b) => a.band - b.band || had(a) - had(b) || b.useY - a.useY || a.panel.table - b.panel.table)
    for (const placing of movers) {
      if (placing.turned) {
        takes(placing, Math.min(Math.max(placing.panel.visible ? placing.panel.col : 0, placing.from), placing.last))
        continue
      }
      const open   = columns(placing).find((col) => fitsAt(col, placing, placingRows(placing)))
      const folded = placing.foldable ? columns(placing).find((col) => fitsAt(col, placing, TITLE_ROWS)) : undefined
      const chosen = open ?? folded
      if (chosen == null && evictable(placing)) {
        placing.hidden = true
        continue
      }
      // No room anywhere: the column where it reaches least far down.
      const roomiest = columns(placing).reduce((best, col) => (stackHeight(members(col)) < stackHeight(members(best)) ? col : best), placing.from)
      takes(placing, chosen ?? roomiest)
    }

    // Columns with too little room: the least useful make way, lowest first.
    for (let col = 0; col < cols; col += 1) {
      const over   = () => stackHeight(members(col)) - view > 1e-6
      const lowest = (list: Placing[]) => list.filter((p) => p.col === col).sort((a, b) => b.seq - a.seq)
      // Empty tables fold, then panels not used on screen, the furthest first, then the ones with the least in their tables; far ones hide.
      const empty  = (p: Placing) => Number(p.panel.contentRows === 0)
      for (const p of lowest(members(col).filter((m) => folds(m) && (!m.now || m.panel.contentRows === 0)))
        .sort((a, b) => empty(b) - empty(a) || b.band - a.band || a.panel.contentRows - b.panel.contentRows)) {
        if (!over()) break
        p.folded = true
      }
      for (const p of lowest(members(col).filter(evictable))) {
        if (!over()) break
        p.hidden = true
      }
      if (!over()) continue
      // Still too little: from the top, so the panels there longest keep their place, and each
      // lower one that does not fit makes way (see makeRoom).
      let height     = -PANEL_GAP_ROWS * ROW_H
      const above    : Placing[] = []
      const fits     = (rows: number) => height + panelSpan(rows) <= view + 1e-6
      /**
       * Room below the panels above for `rows` more rows, when that is enough: the titles there of
       * panels not used on screen move on to a later column (or hide), then the panels there that
       * `fold` picks fold, the lowest first, as long as they hide fewer table rows than `budget`.
       */
      const makeRoom = (rows: number, fold: (m: Placing) => boolean, budget = Number.POSITIVE_INFINITY): boolean => {
        const room   = (h: number) => h + panelSpan(rows) <= view + 1e-6
        const titles : Placing[] = []
        const opens  : Placing[] = []
        let left     = height
        let lost     = 0
        for (const m of above.filter((m) => m.col === col && m.foldable && m.folded && !m.now).reverse()) {
          if (room(left)) break
          titles.push(m)
          left -= panelSpan(TITLE_ROWS)
        }
        for (const m of above.filter((m) => m.col === col && m.foldable && !m.folded && m.panel.rows > TITLE_ROWS && fold(m)).reverse()) {
          if (room(left)) break
          opens.push(m)
          left -= (m.panel.rows - TITLE_ROWS) * ROW_H
          lost += m.panel.contentRows
        }
        if (!room(left) || lost >= budget) return false
        for (const title of titles) {
          const to = columns(title, col + 1).find((c) => fitsAt(c, title, TITLE_ROWS))
          if (to != null) takes(title, to)
          else title.hidden = true
        }
        for (const open of opens) open.folded = true
        height = left
        return true
      }
      for (const p of stackOrder(members(col))) {
        // One used on screen opens once the titles above make way, or tables above with less in them fold.
        const short = p.col === col && !fits(placingRows(p))
        const less  = (m: Placing) => m.panel.contentRows < p.panel.contentRows
        if (short && !(p.now && (makeRoom(placingRows(p), () => false) || makeRoom(placingRows(p), less, p.panel.contentRows)))) {
          const movable = !p.turned && !p.promoted
          const later   = (rows: number) => (movable ? columns(p, col + 1).find((c) => fitsAt(c, p, rows)) : undefined)
          // One used on screen moves back open to an earlier column where the panels there make
          // way for it (tables used on screen only when they show empty rows).
          const back    = movable && p.now ? columns(p).find((c) => c < col && roomFor(c, p, true)) : undefined
          if (back != null) {
            const room = roomFor(back, p, true) as { fold: Placing[]; hide: Placing[] }
            for (const m of room.fold) m.folded = true
            for (const m of room.hide) m.hidden = true
            takes(p, back)
            continue
          }
          // Else it moves on open to a later column with room; else it folds, when that is
          // enough; else it moves on folded.
          const open   = movable && p.now ? columns(p, col + 1).find((c) => roomFor(c, p)) : undefined
          const folded = open == null && !(folds(p) && fits(TITLE_ROWS)) ? later(p.foldable ? TITLE_ROWS : placingRows(p)) : undefined
          if (open != null || folded != null) {
            if (open == null) p.folded = p.foldable
            takes(p, (open ?? folded) as number)
            continue
          }
          if (folds(p) && fits(TITLE_ROWS)) p.folded = true
          // Used on screen, at the bottom: its title line is enough, rather than folding the tables above.
          else if (p.now && p.foldable && fits(1)) p.folded = folds(p)
          else if (p.foldable && !p.now) {
            // Not used on screen: it hides.
            p.hidden = true
            continue
          } else if (makeRoom(p.foldable ? TITLE_ROWS : placingRows(p), () => true)) p.folded = p.foldable
          else if (p.foldable) {
            // Used on screen: the panels above fold for its title, and it hides only when even that is not enough.
            p.hidden = true
            continue
          }
          // Selected or linked, with no room even then: it is cut at the bottom.
        }
        height += panelSpan(placingRows(p))
        above.push(p)
      }
    }

    // Stack each column from the top: turned and promoted panels first, then in the order they came in.
    const stack = () => {
      const ys = new Map<Placing, number>()
      for (let col = 0; col < cols; col += 1) {
        const ordered = stackOrder(members(col))
        let ceiling   = yTop
        for (const p of ordered) {
          const y = ys.get(p) ?? ceiling
          ys.set(p, y)
          ceiling = Math.min(ceiling, y - panelSpan(placingRows(p)))
        }
      }
      return ys
    }
    let ys      = stack()
    const cut   = placings.filter((p) => p.panel.pinned && !p.promoted && (ys.get(p) ?? yTop) - placingRows(p) * ROW_H < yBottom - 1e-6)
    if (cut.length) {
      for (const p of cut) p.promoted = true
      ys = stack()
    }

    let moved     = false
    const byPanel = new Map(placings.map((p) => [p.panel, p]))
    for (const panel of panels) {
      const placing = byPanel.get(panel)
      const at      = placing ? ys.get(placing) : undefined
      const visible = at != null && placing != null
      const y       = at ?? panel.naturalY
      const col     = visible ? placing.col : panel.col
      const folded  = visible && placing.folded
      if (visible !== panel.visible || col !== panel.col || folded !== panel.folded || Math.abs(y - panel.y) > 1e-3) moved = true
      panel.visible  = visible
      panel.band     = placing?.band ?? panel.band
      panel.now      = visible && placing.now
      panel.seq      = placing?.seq ?? panel.seq
      panel.y        = y
      panel.col      = col
      panel.u        = panelU(col)
      panel.folded   = folded
      panel.promoted = visible && placing.promoted
    }
    return moved
  }

  /**
   * The panels stick() would show for the view [yBottom, yTop], with the wall u of their column,
   * without moving any: for framing a view the camera is not at yet.
   */
  probe(track: number, yTop: number, yBottom: number, viewHeight = yTop - yBottom): { panel: Panel; u: number }[] {
    const panels   = this.tracks[track]?.panels ?? []
    const arrivals = this.arrivals
    const packed   = this.packedFor.get(track)
    const saved    = panels.map((panel) => ({
      visible : panel.visible,
      y       : panel.y,
      col     : panel.col,
      u       : panel.u,
      band    : panel.band,
      now     : panel.now,
      seq     : panel.seq,
      folded  : panel.folded,
      promoted: panel.promoted
    }))
    this.stick(track, yTop, yBottom, viewHeight)
    const shown = panels.filter((panel) => panel.visible).map((panel) => ({
      panel,
      u: panel.u
    }))
    panels.forEach((panel, i) => {
      Object.assign(panel, saved[i])
    })
    this.arrivals = arrivals
    if (packed == null) this.packedFor.delete(track)
    else this.packedFor.set(track, packed)
    return shown
  }

  /** Top y of a use stretch, and the y of its bottom edge. */
  private spanTop(span: UseSpan): number {
    return this.rowY(span[0])
  }

  private spanBottom(span: UseSpan): number {
    return this.rowY(span[1]) - ROW_H
  }

  /** Height between the view [yBottom, yTop] and the nearest stretch that uses a panel (0 when one is on screen), and that stretch's top y. */
  private viewDistance(panel: Panel, yTop: number, yBottom: number): [distance: number, top: number] {
    let nearest = Number.POSITIVE_INFINITY
    let top     = this.rowY(panel.row)
    for (const span of panel.spans) {
      const spanTop  = this.spanTop(span)
      const bottom   = this.spanBottom(span)
      const distance = spanTop < yBottom ? yBottom - spanTop : bottom > yTop ? bottom - yTop : 0
      if (distance < nearest) [nearest, top] = [distance, spanTop]
    }
    return [nearest, top]
  }

  /**
   * A panel's distance band for a reach `reach` (see DISTANCE_BANDS), from the height between
   * the view and its nearest use. It comes to the first band as soon as one of its uses is on
   * screen; otherwise a shown panel keeps its band until it is BAND_HYSTERESIS of a reach past
   * that band's edges.
   */
  private bandOf(panel: Panel, distance: number, reach: number): number {
    if (distance <= 0) return 0
    const bandAt = DISTANCE_BANDS.findIndex((edge) => distance <= edge * reach)
    const band   = bandAt < 0 ? FAR_BAND : bandAt
    if (!panel.visible || band === panel.band) return band
    const low   = panel.band > 0 ? DISTANCE_BANDS[panel.band - 1] * reach : 0
    const high  = panel.band < FAR_BAND ? DISTANCE_BANDS[panel.band] * reach : Number.POSITIVE_INFINITY
    const slack = BAND_HYSTERESIS * reach
    return distance >= low - slack && distance <= high + slack ? panel.band : band
  }

  /** Cells of a phrase instance that point at an instrument (I column, INS) or a table (TBL, TBX), first one per target. */
  private references(instance: PhraseInstance): PanelReference[] {
    const phrase     = this.model.phrases[instance.phrase]
    const references : PanelReference[] = []
    const seen       = new Set<string>()
    phrase?.steps.forEach((step, s) => {
      const row = instance.row + s
      const add = (kind: LinkKind, col: number, table: number, instrument: number | null) => {
        const key = `${kind}:${table}`
        if (seen.has(key)) return
        seen.add(key)
        references.push({
          kind,
          row,
          col,
          step: s,
          table,
          instrument
        })
      }
      if (step.inst != null) add('instrument', SIDE_FIELDS.inst[0], step.inst, step.inst)
      step.fx.forEach((fx, lane) => {
        if (fx.val == null) return
        const col = SIDE_FIELDS[fxColumn(lane, 'val')][0]
        if (fx.cmd === 'INS') add('instrument', col, fx.val, fx.val)
        // A table 00-7F belongs to the instrument of that number, when there is one.
        if (fx.cmd === 'TBL' || fx.cmd === 'TBX') add('table', col, fx.val, fx.val < 0x80 && this.model.instruments[fx.val] ? fx.val : null)
      })
    })
    return references
  }

  /** Links of one phrase instance to the panels of its track. */
  instanceLinks(instance: PhraseInstance): Link[] {
    const track = this.tracks[instance.track]
    return this.references(instance).flatMap((reference) => {
      const panel = track.panels.find((p) => p.table === reference.table)
      return panel ? [linkOf(instance.track, reference, instance, panel)] : []
    })
  }

  /**
   * One link per note of a phrase instance to the panel of the instrument it plays: the I column
   * (or INS command) when the step sets one, else the instrument the track played last (the
   * link then leaves from the empty I column). Notes off and notes with no instrument yet have none.
   */
  noteInstrumentLinks(instance: PhraseInstance): Link[] {
    const track     = this.tracks[instance.track]
    const steps     = this.model.phrases[instance.phrase]?.steps ?? []
    const effective = this.effective.get(instance.key) ?? []
    const links     : Link[] = []
    steps.forEach((step, s) => {
      const instrument = effective[s]
      if (!step.note || step.note === 'OFF' || instrument == null) return
      const panel = track.panels.find((p) => p.table === instrument)
      if (!panel) return
      const insLane = step.fx.findIndex((fx) => fx.cmd === 'INS' && fx.val != null)
      const col     = step.inst == null && insLane >= 0 ? SIDE_FIELDS[fxColumn(insLane, 'val')][0] : SIDE_FIELDS.inst[0]
      links.push(linkOf(instance.track, {
        kind : 'instrument',
        row  : instance.row + s,
        col,
        step : s,
        table: instrument,
        instrument
      }, instance, panel))
    })
    return links
  }
}

function newPanel(track: number, table: number, instrument: number | null, row: number): Panel {
  return {
    track,
    table,
    instrument,
    row,
    lastRow    : row,
    naturalY   : 0,
    y          : 0,
    visible    : false,
    col        : 0,
    u          : PANEL_U0,
    shownY     : 0,
    shownU     : PANEL_U0,
    alpha      : 0,
    rows       : PANEL_ROWS,
    chars      : PANEL_CHARS,
    flip       : 0,
    flash      : 0,
    contentRows: ROWS_PER_TABLE,
    spans      : [],
    band       : 0,
    now        : false,
    seq        : 0,
    pinned     : false,
    linked     : false,
    selectedRow: null,
    folded     : false,
    promoted   : false
  }
}

const linkOf = (track: number, reference: PanelReference, instance: PhraseInstance, panel: Panel): Link => ({
  track,
  kind: reference.kind,
  row : reference.row,
  col : reference.col,
  instance,
  step: reference.step,
  panel
})

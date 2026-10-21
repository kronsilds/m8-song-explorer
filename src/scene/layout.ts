// Where everything goes. Time runs down the Y axis, one row per phrase step, song rows
// separated by a small gap. Each track is a column facing the viewer (chain and phrase
// labels, then the notes) and a "wall" hinged on its right edge that recedes into depth:
// first the rest of each step (velocity, instrument, three FX), then the panels of the
// instruments and tables the track uses, joined to the steps that use them.

import { fxColumn, type PhraseColumn, type TableColumn } from '../model/columns'
import { ScaleMap } from '../model/music/harmony'
import { ROWS_PER_PHRASE, type SongModel, TRACKS } from '../model/song'
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
/** Panels that do not fit one column below each other tile into more columns, deeper along the wall. */
export const MAX_PANEL_COLS = 4
export const PANEL_COL_W    = PANEL_CHARS * CHAR_W + 2
/** Panels a column is expected to show at once, to size the wall from how many are in use together. */
const PANELS_PER_COL        = 2
/** Rows around a panel's uses counted as "in view together" when sizing the wall. */
const PANEL_VIEW_PAD_ROWS   = 24
/** Rows between panels stacked in a column: room for the tab over the lower one's corner. */
const PANEL_GAP_ROWS        = 1.75
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
  track     : number
  table     : number
  /** The instrument whose table it is, when the table belongs to one. */
  instrument: number | null
  /** First and last timeline rows that point at it: where it is worth showing. */
  row       : number
  lastRow   : number
  /** Top y (title line) on the wall when nothing sticks: level with its first use. */
  naturalY  : number
  /** Top y it should be at now: it sticks near the top of the view while its rows are on screen (see stick()). */
  y         : number
  /** False while none of its rows is near the view. */
  visible   : boolean
  /** Column of the panel grid it is in, and the wall u of that column (see stick()). */
  col       : number
  u         : number
  /** Where it is drawn and how opaque (0..1): eases toward y / u / visible, so it glides and fades. */
  shownY    : number
  shownU    : number
  alpha     : number
  /** Rows and characters of the face it shows (or turns to): the table's, or the larger instrument face. */
  rows      : number
  chars     : number
  /** How far it has turned over to its instrument face (0 the table, 1 the instrument). */
  flip      : number
}

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

  constructor(model: SongModel) {
    this.model     = model
    this.timeline  = buildTimeline(model)
    this.effective = effectiveInstruments(model, this.timeline)
    this.scales    = new ScaleMap(model, this.timeline)
    this.bandTop   = this.timeline.bands.map((band, i) => -(band.row * ROW_H + i * BAND_GAP))
    const lastBand = this.timeline.bands.length - 1
    let bottomY    = lastBand >= 0 ? this.bandTop[lastBand] - this.timeline.bands[lastBand].length * ROW_H : 0
    this.tracks    = Array.from({ length: TRACKS }, (_, track) => this.layoutTrack(track))
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

    // Each panel waits level with its first use; stick() settles overlaps (columns, then down).
    const panels = [...panelsByTable.values()]
    for (const panel of panels) {
      panel.naturalY = this.rowY(panel.row)
      panel.y        = panel.naturalY
      panel.shownY   = panel.naturalY
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
   * Sticky panels for the view [yBottom, yTop]: a panel whose rows are on screen stays in
   * sight, held near the top of the view while its first use has scrolled away above,
   * never below its own last use. Panels that would overlap go to the next column of the
   * wall (the one where they are pushed down least, keeping the column they were in unless
   * another is clearly better), and are stacked down only when every column is taken.
   * Panels with no row near the view are hidden. A panel turned to its instrument face is
   * placed first, so it takes the top of its column; it spans that column and the next one, so
   * it never goes in the last. Returns true when anything moved.
   */
  stick(track: number, yTop: number, yBottom: number): boolean {
    const trackLayout = this.tracks[track]
    if (!trackLayout) return false
    let moved            = false
    const columnCeilings = new Array<number>(trackLayout.cols).fill(yTop)
    const turned         = trackLayout.panels.filter((panel) => panel.chars > PANEL_CHARS)
    for (const panel of [...turned, ...trackLayout.panels.filter((panel) => panel.chars <= PANEL_CHARS)]) {
      const firstY  = this.rowY(panel.row)
      const lastY   = this.rowY(panel.lastRow) - ROW_H
      const span    = panelSpan(panel.rows)
      // A wider margin to leave than to come, so a panel at the edge does not flicker.
      const margin  = (yTop - yBottom) * (panel.visible ? 0.3 : 0.1)
      const visible = firstY > yBottom - margin && lastY < yTop + margin
      let y         = panel.naturalY
      let col       = panel.col
      const wide    = panel.chars > PANEL_CHARS && trackLayout.cols > 1
      if (visible) {
        // Held near the top while its first use is above the view; never below its last use.
        const wantedY = Math.max(Math.min(panel.naturalY, yTop), Math.min(lastY + span * 0.5, panel.naturalY))
        let bestScore = Number.NEGATIVE_INFINITY
        for (let candidate = 0; candidate < trackLayout.cols - (wide ? 1 : 0); candidate += 1) {
          const ceiling    = wide ? Math.min(columnCeilings[candidate], columnCeilings[candidate + 1]) : columnCeilings[candidate]
          const candidateY = Math.min(wantedY, ceiling)
          // Staying put is worth half a panel, so scrolling does not shuffle the grid.
          const stayBonus  = panel.visible && candidate === panel.col ? span * 0.5 : 0
          const score      = candidateY + stayBonus - candidate * 1e-3
          if (score > bestScore) [bestScore, col, y] = [score, candidate, candidateY]
        }
        columnCeilings[col] = y - span
        // A face wider than a column (the instrument face) takes room in the next one too.
        if (wide) columnCeilings[col + 1] = Math.min(columnCeilings[col + 1], y - span)
      }
      if (visible !== panel.visible || col !== panel.col || Math.abs(y - panel.y) > 1e-3) moved = true
      panel.visible = visible
      panel.y       = y
      panel.col     = col
      panel.u       = panelU(col)
    }
    return moved
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
}

function newPanel(track: number, table: number, instrument: number | null, row: number): Panel {
  return {
    track,
    table,
    instrument,
    row,
    lastRow : row,
    naturalY: 0,
    y       : 0,
    visible : false,
    col     : 0,
    u       : PANEL_U0,
    shownY  : 0,
    shownU  : PANEL_U0,
    alpha   : 0,
    rows    : PANEL_ROWS,
    chars   : PANEL_CHARS,
    flip    : 0
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

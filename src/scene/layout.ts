// Where everything goes. Time runs down the Y axis, one row per phrase step, song rows
// separated by a small gap. Each track is a column facing the viewer (chain and phrase
// labels, then the notes) and a "wall" hinged on its right edge that recedes into depth:
// first the rest of each step (velocity, instrument, three FX), then the panels of the
// instruments and tables the track uses, joined to the steps that use them.

import { type PhraseColumn, type TableColumn } from '../m8/device'
import { ScaleMap } from '../model/harmony'
import {
  buildTimeline,
  effectiveInstruments,
  type PhraseInstance,
  ROWS_PER_PHRASE,
  type SongModel,
  type Timeline,
  TRACKS,
} from '../model/song'

export const FONT = 1
export const CHAR_W = 0.6 * FONT
export const ROW_H = 1.34 * FONT
export const BAND_GAP = 1.6
/** Rows above the first song row, for the headers. */
export const HEADER_H = 5.5

// Front column: "cc pp C-4 03" (chain label, phrase label, note, instrument)
export const FRONT_CHARS = 12
export const CHAIN_COL = 0
export const PHRASE_COL = 3
export const NOTE_COL = 6
export const INST_COL = 10
export const FRONT_W = FRONT_CHARS * CHAR_W
export const TRACK_GAP = 2.4
export const TRACK_PITCH = FRONT_W + TRACK_GAP

// Wall: step details "VV II CCCvv CCCvv CCCvv", then the panels.
export const WALL_ANGLE = (56 * Math.PI) / 180
export const WALL_HINGE = FRONT_W + 0.35
export const SIDE_U0 = 0.5
export const SIDE_CHARS = 23
export const PANEL_U0 = SIDE_U0 + SIDE_CHARS * CHAR_W + 5.5
export const PANEL_CHARS = 25
/** Panel rows: title, subtitle, 16 table rows. */
export const PANEL_ROWS = 18
/** Panels that do not fit one column below each other tile into more columns, deeper along the wall. */
export const MAX_PANEL_COLS = 3
export const PANEL_COL_W = PANEL_CHARS * CHAR_W + 2
/** Panels a column is expected to show at once, to size the wall from how many are in use together. */
const PANELS_PER_COL = 3
/** Length of a wall that has `cols` columns of panels. */
export const wallLength = (cols: number): number => PANEL_U0 + PANEL_CHARS * CHAR_W + 1 + (cols - 1) * PANEL_COL_W
/** Wall u of the left edge of a panel column. */
export const panelU = (col: number): number => PANEL_U0 + col * PANEL_COL_W

/** Character columns of each phrase field on the wall (start, width). */
export const SIDE_FIELDS: Record<Exclude<PhraseColumn, 'note'>, [number, number]> = {
  vel: [0, 2],
  inst: [3, 2],
  fx1cmd: [6, 3],
  fx1val: [9, 2],
  fx2cmd: [12, 3],
  fx2val: [15, 2],
  fx3cmd: [18, 3],
  fx3val: [21, 2],
}

/** Character columns of a table row in a panel: "R TT VV CCCvv CCCvv CCCvv". */
export const PANEL_FIELDS: Record<TableColumn, [number, number]> = {
  transpose: [2, 2],
  volume: [5, 2],
  fx1cmd: [8, 3],
  fx1val: [11, 2],
  fx2cmd: [14, 3],
  fx2val: [17, 2],
  fx3cmd: [20, 3],
  fx3val: [23, 2],
}

export interface Panel {
  track: number
  table: number
  /** The instrument whose table it is, when the table belongs to one. */
  inst: number | null
  /** First and last timeline rows that point at it: where it is worth showing. */
  row: number
  lastRow: number
  /** Top y (title line) on the wall when nothing sticks: level with its first use. */
  naturalY: number
  /** Top y it should be at now: it sticks near the top of the view while its rows are on screen (see stick()). */
  y: number
  /** False while none of its rows is near the view. */
  visible: boolean
  /** Column of the panel grid it is in, and the wall u of that column (see stick()). */
  col: number
  u: number
  /** Where it is drawn and how opaque (0..1): eases toward y / u / visible, so it glides and fades. */
  shownY: number
  shownU: number
  alpha: number
}

/** Room a panel takes on the wall, gap included. */
export const PANEL_SPAN = (PANEL_ROWS + 1.5) * ROW_H

export interface Link {
  track: number
  kind: 'inst' | 'table'
  /** Timeline row and wall character column of the cell it leaves from. */
  row: number
  col: number
  instance: PhraseInstance
  step: number
  panel: Panel
}

export interface TrackLayout {
  track: number
  instances: PhraseInstance[]
  panels: Panel[]
  links: Link[]
  /** Columns of panels its wall has room for, and the wall's length and x extent for them. */
  cols: number
  wallLen: number
  wallExtent: number
  /** Most played instrument name, as a label for the track. */
  label: string | null
}

export class SongLayout {
  readonly model: SongModel
  readonly timeline: Timeline
  readonly bandTop: number[]
  readonly tracks: TrackLayout[]
  readonly effective: Map<string, (number | null)[]>
  /** The scale each track plays with along the song. */
  readonly scales: ScaleMap
  readonly bottomY: number

  constructor(model: SongModel) {
    this.model = model
    this.timeline = buildTimeline(model)
    this.effective = effectiveInstruments(model, this.timeline)
    this.scales = new ScaleMap(model, this.timeline)
    this.bandTop = this.timeline.bands.map((b, i) => -(b.row * ROW_H + i * BAND_GAP))
    const lastBand = this.timeline.bands.length - 1
    this.bottomY = lastBand >= 0 ? this.bandTop[lastBand] - this.timeline.bands[lastBand].length * ROW_H : 0
    this.tracks = Array.from({ length: TRACKS }, (_, t) => this.layoutTrack(t))
    // Panels can run below the last row; one more is allowed for a panel pushed down by its neighbours.
    for (const track of this.tracks) {
      for (const panel of track.panels) this.bottomY = Math.min(this.bottomY, panel.naturalY - PANEL_ROWS * ROW_H - PANEL_SPAN * 0.5)
    }
  }

  /** Index of the band that holds a timeline row. */
  bandIndex(row: number): number {
    const bands = this.timeline.bands
    let lo = 0
    let hi = bands.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (bands[mid].row <= row) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Top y of a timeline row. */
  rowY(row: number): number {
    if (this.timeline.bands.length === 0) return -row * ROW_H
    const b = this.bandIndex(row)
    return this.bandTop[b] - (row - this.timeline.bands[b].row) * ROW_H
  }

  /** Timeline row drawn at height y, null in a gap between song rows or outside the song. */
  rowAtY(y: number): number | null {
    const bands = this.timeline.bands
    for (let b = 0; b < bands.length; b += 1) {
      const top = this.bandTop[b]
      const bottom = top - bands[b].length * ROW_H
      if (y <= top && y > bottom) return bands[b].row + Math.floor((top - y) / ROW_H)
    }
    return null
  }

  private layoutTrack(track: number): TrackLayout {
    const instances = this.timeline.byTrack[track]
    const panels = new Map<number, Panel>()
    const order: Panel[] = []
    const links: Link[] = []
    const plays = new Map<number, number>()

    const panelFor = (table: number, inst: number | null, row: number): Panel => {
      let panel = panels.get(table)
      if (!panel) {
        panel = { track, table, inst, row, lastRow: row, naturalY: 0, y: 0, visible: false, col: 0, u: PANEL_U0, shownY: 0, shownU: PANEL_U0, alpha: 0 }
        panels.set(table, panel)
        order.push(panel)
      }
      return panel
    }

    // Every place links to the panels it uses; the view only draws the ones near it.
    for (const instance of instances) {
      const phrase = this.model.phrases[instance.phrase]
      if (!phrase) continue
      const eff = this.effective.get(instance.key) ?? []
      phrase.steps.forEach((step, s) => {
        if (step.note && eff[s] != null) plays.set(eff[s] as number, (plays.get(eff[s] as number) ?? 0) + 1)
      })
      for (const ref of this.references(instance)) {
        const panel = panels.get(ref.table) ?? panelFor(ref.table, ref.inst, ref.row)
        panel.lastRow = Math.max(panel.lastRow, ref.row)
        links.push({ track, kind: ref.kind, row: ref.row, col: ref.col, instance, step: ref.step, panel })
      }
    }

    // Each panel waits level with its first use; stick() settles overlaps (columns, then down).
    for (const panel of order) {
      panel.naturalY = this.rowY(panel.row)
      panel.y = panel.naturalY
      panel.shownY = panel.naturalY
    }

    let label: string | null = null
    let best = 0
    for (const [inst, n] of plays) {
      const name = this.model.instruments[inst]?.name
      if (name && n > best) [label, best] = [name, n]
    }
    const cols = this.columnsFor(order)
    const wallLen = wallLength(cols)
    return { track, instances, panels: order, links, cols, wallLen, wallExtent: wallLen * Math.cos(WALL_ANGLE), label }
  }

  /** Columns a wall needs: the most panels wanted together (a view's worth of rows around each), a column per few. */
  private columnsFor(panels: Panel[]): number {
    const pad = 24
    const events: [number, number][] = []
    for (const p of panels) events.push([p.row - pad, 1], [p.lastRow + ROWS_PER_PHRASE + pad, -1])
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    let now = 0
    let most = 0
    for (const [, d] of events) {
      now += d
      most = Math.max(most, now)
    }
    return Math.max(1, Math.min(MAX_PANEL_COLS, Math.ceil(most / PANELS_PER_COL)))
  }

  /**
   * Sticky panels for the view [yBottom, yTop]: a panel whose rows are on screen stays in
   * sight, held near the top of the view while its first use has scrolled away above,
   * never below its own last use. Panels that would overlap go to the next column of the
   * wall (the one where they are pushed down least, keeping the column they were in unless
   * another is clearly better), and are stacked down only when every column is taken.
   * Panels with no row near the view are hidden. Returns true when anything moved.
   */
  stick(track: number, yTop: number, yBottom: number): boolean {
    const tl = this.tracks[track]
    if (!tl) return false
    let moved = false
    const ceilings = new Array<number>(tl.cols).fill(yTop)
    for (const panel of tl.panels) {
      const firstY = this.rowY(panel.row)
      const lastY = this.rowY(panel.lastRow) - ROW_H
      // A wider margin to leave than to come, so a panel at the edge does not flicker.
      const margin = (yTop - yBottom) * (panel.visible ? 0.3 : 0.1)
      const visible = firstY > yBottom - margin && lastY < yTop + margin
      let y = panel.naturalY
      let col = panel.col
      if (visible) {
        // Held near the top while its first use is above the view; never below its last use.
        const wanted = Math.max(Math.min(panel.naturalY, yTop), Math.min(lastY + PANEL_SPAN * 0.5, panel.naturalY))
        let bestScore = Number.NEGATIVE_INFINITY
        for (let c = 0; c < tl.cols; c += 1) {
          const at = Math.min(wanted, ceilings[c])
          // Staying put is worth half a panel, so scrolling does not shuffle the grid.
          const score = at + (panel.visible && c === panel.col ? PANEL_SPAN * 0.5 : 0) - c * 1e-3
          if (score > bestScore) [bestScore, col, y] = [score, c, at]
        }
        ceilings[col] = y - PANEL_SPAN
      }
      const u = panelU(col)
      if (visible !== panel.visible || col !== panel.col || Math.abs(y - panel.y) > 1e-3) moved = true
      panel.visible = visible
      panel.y = y
      panel.col = col
      panel.u = u
    }
    return moved
  }

  /** Cells of a phrase instance that point at an instrument (I column, INS) or a table (TBL, TBX), first one per target. */
  references(instance: PhraseInstance): { kind: Link['kind']; row: number; col: number; step: number; table: number; inst: number | null }[] {
    const phrase = this.model.phrases[instance.phrase]
    const out: ReturnType<SongLayout['references']> = []
    const seen = new Set<string>()
    phrase?.steps.forEach((step, s) => {
      const row = instance.row + s
      const add = (kind: Link['kind'], col: number, table: number, inst: number | null) => {
        const key = `${kind}:${table}`
        if (seen.has(key)) return
        seen.add(key)
        out.push({ kind, row, col, step: s, table, inst })
      }
      if (step.inst != null) add('inst', SIDE_FIELDS.inst[0], step.inst, step.inst)
      step.fx.forEach((f, lane) => {
        if (f.val == null) return
        const col = SIDE_FIELDS[`fx${lane + 1}val` as 'fx1val'][0]
        if (f.cmd === 'INS') add('inst', col, f.val, f.val)
        if (f.cmd === 'TBL' || f.cmd === 'TBX') add('table', col, f.val, f.val < 0x80 && this.model.instruments[f.val] ? f.val : null)
      })
    })
    return out
  }

  /** Links of one phrase instance to the panels of its track. */
  instanceLinks(instance: PhraseInstance): Link[] {
    const track = this.tracks[instance.track]
    return this.references(instance).flatMap((ref) => {
      const panel = track.panels.find((p) => p.table === ref.table)
      return panel ? [{ track: instance.track, kind: ref.kind, row: ref.row, col: ref.col, instance, step: ref.step, panel }] : []
    })
  }

  /** The instance on `track` covering a timeline row. */
  instanceAt(track: number, row: number): PhraseInstance | null {
    const list = this.timeline.byTrack[track]
    let lo = 0
    let hi = list.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const inst = list[mid]
      if (row < inst.row) hi = mid - 1
      else if (row >= inst.row + ROWS_PER_PHRASE) lo = mid + 1
      else return inst
    }
    return null
  }
}

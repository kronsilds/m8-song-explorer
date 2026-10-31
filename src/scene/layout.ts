// Where everything goes. Time runs down the Y axis, one row per phrase step, song rows
// separated by a small gap. Each track is a column facing the viewer (chain and phrase
// labels, then the notes) and a "wall" hinged on its right edge that recedes into depth:
// first the rest of each step (velocity, instrument, three FX), then the panels of the
// instruments and tables the track uses, joined to the steps that use them.

import { fxColumn } from '../model/columns'
import type { ScaleMap } from '../model/music/harmony'
import type { Selection } from '../model/selection'
import { allFxCells, fxValues, ROWS_PER_PHRASE, ROWS_PER_TABLE, type SongModel, TRACKS } from '../model/song'
import type { SongContext } from '../model/songContext'
import { instanceAt, type PhraseInstance, type Timeline } from '../model/timeline'
import {
  BAND_GAP,
  DEFAULT_PANEL_COLS,
  HEADER_H,
  MAX_PANEL_COLS,
  PANEL_CHARS,
  PANEL_ROWS,
  PANEL_SPAN,
  PANEL_U0,
  type Panel,
  ROW_H,
  SIDE_FIELDS,
  tableContentRows,
  tableFaceRows,
  type UseSpan,
  wallLength,
} from './dimensions'
import { type InstrumentFace, layoutInstrumentFace } from './instrumentFace'
import { PanelStacks } from './panelStacks'

export * from './dimensions'

/** Panels a column is expected to show at once, to size the wall from how many are in use together. */
const PANELS_PER_COL      = 2
/** Rows around a panel's uses counted as "in view together" when sizing the wall. */
const PANEL_VIEW_PAD_ROWS = 24

/** Columns a wall has for panels that want `wanted` of them, with at most `limit`. */
const columnsWithin = (wanted: number, limit: number): number => Math.max(1, Math.min(wanted, limit))

/** What a panel keeps from an earlier layout of the same song (see SongLayout.adoptState); the rest follows from the song. */
const CARRIED_PANEL_STATE = ['visible', 'y', 'col', 'u', 'shownY', 'shownU', 'alpha', 'rows', 'chars', 'flip', 'flash', 'band', 'now', 'seq', 'folded', 'promoted'] as const satisfies readonly (keyof Panel)[]

/** Tables a TBX anywhere in the song starts as aux tables. */
function auxTables(model: SongModel): number[] {
  const tables = new Set<number>()
  for (const fx of allFxCells(model)) for (const table of fxValues(fx, 'TBX')) tables.add(table)
  return [...tables].sort((a, b) => a - b)
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
  track    : number
  instances: PhraseInstance[]
  panels   : Panel[]
  links    : Link[]
  /** Columns of panels its wall has room for (at most the limit asked for), and the wall's length for them (see SongLayout.setColumnLimit). */
  cols     : number
  /** Columns the panels would want, whatever the limit (at most MAX_PANEL_COLS). */
  wanted   : number
  wallLen  : number
  /** An instrument face can turn out of its wall (and stick out past its end). */
  hasFaces : boolean
}

/** A panel the layout would show for some rows (see SongLayout.probe): where (wall u, title line y) and how many rows. */
export interface ShownPanel {
  panel: Panel
  u    : number
  y    : number
  rows : number
}

export class SongLayout {
  /** What is laid out; model, timeline, effective and scales are its parts, kept at hand. */
  readonly song          : SongContext
  readonly model         : SongModel
  readonly timeline      : Timeline
  /** Top y of each song band. */
  readonly bandTop       : number[]
  readonly tracks        : TrackLayout[]
  /** The instrument each step plays, per instance key (see effectiveInstruments). */
  readonly effective     : SongContext['effective']
  /** The scale each track plays with along the song. */
  readonly scales        : ScaleMap
  readonly bottomY       : number
  private readonly faces = new Map<number, InstrumentFace>()

  /** Tables show only their rows down to the last with content (an empty one its title lines); false: all 16. */
  trimTables             : boolean
  /** Which panels each wall shows for the rows in view, and where they stick. */
  private readonly stacks: PanelStacks

  /** `columnLimits[track]`: the columns that track's wall may have (DEFAULT_PANEL_COLS when not given). */
  constructor(song: SongContext, trimTables = true, private readonly columnLimits: readonly number[] = []) {
    this.trimTables = trimTables
    this.song       = song
    this.model      = song.model
    this.timeline   = song.timeline
    this.effective  = song.effective
    this.scales     = song.scales
    this.bandTop    = this.timeline.bands.map((band, i) => -(band.row * ROW_H + i * BAND_GAP))
    const lastBand  = this.timeline.bands.length - 1
    let bottomY     = lastBand >= 0 ? this.bandTop[lastBand] - this.timeline.bands[lastBand].length * ROW_H : 0
    this.tracks     = Array.from({ length: TRACKS }, (_, track) => this.layoutTrack(track))
    // Panels can run below the last row; one more is allowed for a panel pushed down by its neighbours.
    for (const track of this.tracks) {
      for (const panel of track.panels) bottomY = Math.min(bottomY, panel.naturalY - PANEL_ROWS * ROW_H - PANEL_SPAN * 0.5)
    }
    this.bottomY = bottomY
    this.stacks  = new PanelStacks(this.tracks, (row) => this.rowY(row))
  }

  /**
   * Gives a track's wall room for up to `limit` columns, in place: the next stick() lays its
   * panels out afresh over them (they glide to their new places). True when it changed.
   */
  setColumnLimit(track: number, limit: number): boolean {
    const lanes = this.tracks[track]
    if (!lanes) return false
    const cols = columnsWithin(lanes.wanted, limit)
    if (cols === lanes.cols) return false
    lanes.cols    = cols
    lanes.wallLen = wallLength(cols)
    this.stacks.forget(track)
    return true
  }

  /**
   * Takes over the panels of an earlier layout of the same song (after an edit): where each one is
   * and is drawn, its fade, turn, column and place in it, and how each grid was packed, so nothing
   * that did not change moves or fades in again.
   */
  adoptState(previous: SongLayout): void {
    this.stacks.adopt(previous.stacks)
    for (const lanes of this.tracks) {
      const before = new Map((previous.tracks[lanes.track]?.panels ?? []).map((panel) => [panel.table, panel]))
      for (const panel of lanes.panels) {
        const old = before.get(panel.table)
        if (!old) continue
        for (const key of CARRIED_PANEL_STATE) (panel as unknown as Record<string, unknown>)[key] = old[key]
      }
    }
  }

  /**
   * What a track's view is drawn from: its phrase instances and where they are, the phrases,
   * chains, instruments, tables and scales they use, its panels and its wall. Two layouts with
   * the same signature for a track draw it alike.
   */
  trackSignature(track: number): string {
    const lanes = this.tracks[track]
    if (!lanes) return ''
    const { model }   = this
    const phrases     = new Set<number>()
    const chains      = new Set<number>()
    const instruments = new Set<number>()
    const instances   = lanes.instances.map((instance) => {
      phrases.add(instance.phrase)
      chains.add(instance.chain)
      const effective = this.effective.get(instance.key) ?? []
      for (const id of effective) if (id != null) instruments.add(id)
      return [instance.key, instance.row, this.rowY(instance.row), instance.phrase, instance.chain, instance.chainRow, instance.songRow, effective]
    })
    for (const panel of lanes.panels) if (panel.instrument != null) instruments.add(panel.instrument)
    const panels = lanes.panels.map((panel) => [panel.table, panel.instrument, panel.row, panel.lastRow, panel.contentRows, panel.spans, model.tables[panel.table] ?? null])
    return JSON.stringify([
      instances,
      [...phrases].map((id) => model.phrases[id] ?? null),
      [...chains].map((id) => model.chains[id] ?? null),
      [...instruments].map((id) => model.instruments[id] ?? null),
      panels,
      lanes.links.length,
      lanes.cols,
      lanes.wanted,
      lanes.hasFaces,
      this.scales.signature(track),
      model.scales ?? null,
      model.projectTranspose ?? null,
      auxTables(model),
      this.headerRestY,
    ])
  }

  /** Lays an instrument's face out again (its values changed). */
  forgetFace(id: number): void {
    this.faces.delete(id)
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

  /** Height of the song's title, over the headers. */
  get titleY(): number {
    return this.rowY(0) + HEADER_H + ROW_H * 1.5
  }

  /** The panel of a table on a track's wall. */
  panelOf(track: number, table: number): Panel | undefined {
    return this.tracks[track]?.panels.find((panel) => panel.table === table)
  }

  /** The same place in this layout as `selection` had in an earlier one (instances are recreated); null when it is gone. */
  resolve(selection: Selection): Selection | null {
    if (selection.kind === 'step' || selection.kind === 'chain') {
      const instance = this.instanceAt(selection.instance.track, selection.instance.row)
      return instance ? { ...selection, instance } : null
    }
    return this.panelOf(selection.track, selection.table) ? selection : null
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

    // An instrument face turned out of a one-column wall sticks out past it: the world makes room for it while it shows.
    const faces   = panels.some((panel) => this.instrumentFace(panel.instrument))
    const wanted  = this.columnsFor(panels)
    const cols    = columnsWithin(wanted, this.columnLimits[track] ?? DEFAULT_PANEL_COLS)
    const wallLen = wallLength(cols)
    return {
      track,
      instances,
      panels,
      links,
      cols,
      wanted,
      wallLen,
      hasFaces: faces
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

  /** Places the panels of a track's wall for the view [yBottom, yTop] (see PanelStacks.stick); true when anything moved. */
  stick(track: number, yTop: number, yBottom: number, viewHeight = yTop - yBottom): boolean {
    return this.stacks.stick(track, yTop, yBottom, viewHeight)
  }

  /** The panels stick() would show for the view [yBottom, yTop], without moving any (see PanelStacks.probe). */
  probe(track: number, yTop: number, yBottom: number, viewHeight = yTop - yBottom): ShownPanel[] {
    return this.stacks.probe(track, yTop, yBottom, viewHeight)
  }

  /** Top y of the stretch that uses a panel nearest to the view [yBottom, yTop]. */
  nearestUseY(panel: Panel, yTop: number, yBottom: number): number {
    return this.stacks.nearestUseY(panel, yTop, yBottom)
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

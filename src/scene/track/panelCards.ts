// The instrument and table panels of a track's wall, each a card in its own group that the sticky
// layout moves: it glides to its place, fades, opens or folds, turns out of the wall to show its
// instrument face (the table crossfading into it), glows when a note plays it, and lays its texts
// out only while it shows. After an edit, the view that replaces the track's takes them over.

import { Group, type InstancedMesh, Matrix4, type MeshBasicMaterial, type Object3D, Vector3 } from 'three'
import type { Text } from 'troika-three-text'
import { fxColumn } from '../../model/columns'
import type { Palette } from '../../model/palette'
import { FACE_CHARS, type InstrumentFace } from '../instrumentFace'
import {
  CHAR_W,
  PANEL_CHARS,
  PANEL_FIELDS,
  PANEL_U0,
  type Panel,
  panelSpan,
  ROW_H,
  type SongLayout,
  shownPanelRows,
  TITLE_ROWS,
  type TrackLayout,
} from '../layout'
import { type ColoredRect, easeFactor, rectangles, smoothstep } from '../shapes'
import { disposeText, makeText, RichText, showsRich } from '../text'
import { FACE_HEADER_WIDTH, FACE_WIDTH, InstrumentFaceView } from './instrumentFaceView'
import type { TrackTextBuilder } from './trackText'

const PANEL_BACKGROUND_OPACITY = 0.92
/** Bars sit inside a row, a little below its top. */
export const BAR_INSET         = ROW_H * 0.14
export const BAR_HEIGHT        = ROW_H * 0.72
/** Ease rates per second of a panel's fade and glide. */
const PANEL_FADE_RATE          = 3
const PANEL_GLIDE_RATE         = 15
/** How near (along the wall) a panel must be to its column to count as in it, and keep its gaps there. */
const COLUMN_SETTLED           = 0.5
/** Seconds a panel takes to turn to its other face, and its table card to open or fold. */
const FLIP_SECONDS             = 0.10
/** Part of the flip the turn off the wall takes, and where the crossfade of the faces starts (it overlaps the end of the turn). */
const TURN_END                 = 180.0
const FADE_START               = 0.0
/** The tab above a panel's top-right corner that turns it over: its width (characters) and height. */
const TAB_CHARS                = 8
const TAB_HEIGHT               = ROW_H * 0.95
/** A face's background reaches this far left of its first character and above its title line. */
export const FACE_PAD_LEFT     = 0.45
export const FACE_PAD_TOP      = 0.25
/** How far a panel's tab reaches above its title line: panels stick that much lower under the header. */
export const PANEL_TAB_ROOM    = FACE_PAD_TOP + TAB_HEIGHT
const TABLE_WIDTH              = PANEL_CHARS * CHAR_W + 0.9
/** Height of a table card showing `rows` rows (title lines included). */
const tableHeight              = (rows: number): number => rows * ROW_H + 0.5
/** A header's flash: seconds it takes to die out, its opacity at the note, and its height (the two title lines). */
const FLASH_SECONDS            = 0.4
const FLASH_OPACITY            = 0.3
const FLASH_HEIGHT             = ROW_H * 2 + 0.35

/** Smooth start and end (t clamped to 0..1). */
const easeInOut                = (t: number): number => {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

/**
 * Where a flip (0 the table, 1 the instrument face) is: how far the panel has turned from the
 * wall's plane to the front's (0..1), and how far the table has faded into the instrument face
 * (0..1). The faces swap once the panel faces the front, so turning back fades first, then turns.
 */
export function flipPose(flip: number): { turn: number; fade: number } {
  return {
    turn: easeInOut(flip / TURN_END),
    fade: easeInOut((flip - FADE_START) / (1 - FADE_START))
  }
}

export type PanelFace = 'table' | 'inst'

/**
 * An instrument / table panel of the wall, in its own group moved by the sticky layout. The
 * group's origin is the panel's left edge at its title line: it turns there, out of the wall
 * until it faces the front, and the table crossfades there into the instrument face. Each face
 * is drawn in a frame (x from its first character, y from its title line) that is scaled while
 * they crossfade, so both fill the same growing or shrinking card.
 */
interface PanelView {
  panel     : Panel
  group     : Group
  tableFrame: Group
  tableFace : Group
  instFrame : Group
  text      : Text | null
  /** Rows of the table the text was made for. */
  textRows  : number
  /** A text made for `nextRows` rows that takes over from `text` once it is laid out (the old one shows until then). */
  nextText  : Text | null
  nextRows  : number
  /** Rows of the table shown now (title lines included): fewer when it is folded or has empty rows at its end. */
  tableRows : number
  /** Rows the card eased from, and how far it is on its way to tableRows (0..1, over FLIP_SECONDS). */
  rowsFrom  : number
  resize    : number
  /** Rows the card's body was last drawn at. */
  bodyRows  : number
  /** The card's backgrounds: the body (instance 0, sized to the rows drawn) and the title band. */
  backdrop  : InstancedMesh
  background: MeshBasicMaterial
  bars      : MeshBasicMaterial
  /** The instrument face's layout (null for an aux table or an instrument not read) and its 3D view, made when first shown. */
  face      : InstrumentFace | null
  faceView  : InstrumentFaceView | null
  /** The instrument's values `faceView` was made from: it is made again when they change. */
  faceKey   : string
  /** A face made from older values: it shows until `faceView`'s text is laid out. */
  staleFace : InstrumentFaceView | null
  tab       : PanelTab | null
  /** The glow laid over the header when a playhead passes a note that plays the panel. */
  flash     : InstancedMesh
  /** Width of the card as last drawn. */
  width     : number
}

/** The tab that turns a panel over, labelled with the face it turns to. */
interface PanelTab {
  group     : Group
  background: MeshBasicMaterial
  text      : Text | null
  label     : string
}

/** What a panel's view hands over to the next view of the same panel (see PanelCards.handOver). */
export interface CarriedPanel {
  text    : Text | null
  textRows: number
  tabText : Text | null
  tabLabel: string
  faceView: InstrumentFaceView | null
  faceKey : string
}

/** What the cards read from their track's view each frame. */
export interface CardsFrame {
  /** How unfolded the panels are (0..1). */
  panelsAlpha : number
  /** How much the coloured bars show (they replace text that is too small to read). */
  barsAlpha   : number
  /** How far the wall is turned from the front (radians): turning back as much faces the front. */
  wallAngle   : number
  /** Highest y a visible panel is shown at while gliding: just under the stuck header. */
  panelCeiling: number
}

/** What the cards ask their track's view. */
export interface CardsHost {
  /** The face a panel should show (the world decides: the M8 view, a turn by hand). */
  faceGoal(panel: Panel): PanelFace
  /** A text finished laying out (to redraw). */
  onTextReady(): void
}

/** Rows of a table card as drawn now: they ease from rowsFrom to tableRows while it opens or folds. */
const cardTableRows            = (view: PanelView): number =>
  view.resize >= 1 ? view.tableRows : view.rowsFrom + (view.tableRows - view.rowsFrom) * easeInOut(view.resize)

/** 1 while a table shows every row with content (its FX bars are on those rows), else 0. */
const barsShown                = (view: PanelView): number => (Math.min(view.tableRows, cardTableRows(view)) >= TITLE_ROWS + view.panel.contentRows ? 1 : 0)

/** How opaque a panel's table content (text, bars) is: it leaves in the first part of the crossfade. */
const tableContentAlpha        = (panel: Panel): number => panel.alpha * (1 - smoothstep(0, 0.6, flipPose(panel.flip).fade))

/**
 * Scales a face's frame by (sx, sy) around the top-left corner of its background, which stays
 * on the panel's left edge (its group's origin) and just above its title line.
 */
function placeFrame(frame: Group, sx: number, sy: number): void {
  frame.scale.set(sx, sy, 1)
  frame.position.set(FACE_PAD_LEFT * sx, FACE_PAD_TOP - FACE_PAD_TOP * sy, 0)
}

/** The values an instrument face is drawn from. */
const faceKeyOf = (layout: SongLayout, instrument: number | null): string =>
  instrument == null ? '' : JSON.stringify(layout.model.instruments[instrument] ?? null)

export class PanelCards {
  private readonly views   : PanelView[] = []
  private readonly byPanel = new Map<Panel, PanelView>()
  private frame            : CardsFrame = {
    panelsAlpha : 0,
    barsAlpha   : 0,
    wallAngle   : 0,
    panelCeiling: Number.POSITIVE_INFINITY
  }

  /** Builds a card for each panel of the track, on `wall`; `carried`: what the view this one replaces handed over (see handOver). */
  constructor(
    private layout: SongLayout,
    private track: TrackLayout,
    private readonly palette: Palette,
    private readonly wall: Group,
    private text: TrackTextBuilder,
    private readonly host: CardsHost,
    carried: Map<number, CarriedPanel> | null = null,
  ) {
    for (const panel of track.panels) this.build(panel)
    if (carried) this.take(carried)
  }

  private build(panel: Panel): void {
    const { palette } = this
    const width       = PANEL_CHARS * CHAR_W + 0.9
    const backgrounds : ColoredRect[] = [{
      x    : PANEL_U0 - 0.45,
      y    : 0.25,
      w    : width,
      h    : tableHeight(this.layout.tableFaceRows(panel)),
      z    : -0.06,
      color: palette.panel
    }, {
      x    : PANEL_U0 - 0.45,
      y    : 0.25,
      w    : width,
      h    : ROW_H * 2 + 0.35,
      z    : -0.05,
      color: palette.panelHeader
    }]
    // A table with something in it has a strip down the left of its title lines; an empty one has none.
    if (panel.contentRows > 0) backgrounds.push({
      x    : PANEL_U0 - 0.45,
      y    : 0.25,
      w    : 0.24,
      h    : ROW_H * 2 + 0.35,
      z    : -0.04,
      color: palette.title
    })
    const bars        : ColoredRect[] = []
    this.layout.model.tables[panel.table]?.rows.forEach((row, r) => {
      row.fx.forEach((fx, lane) => {
        if (!fx.cmd) return
        const column = fxColumn(lane, 'cmd')
        const y      = -(r + 2) * ROW_H - BAR_INSET
        bars.push({
          x    : PANEL_U0 + PANEL_FIELDS[column][0] * CHAR_W,
          y,
          w    : 5 * CHAR_W,
          h    : BAR_HEIGHT,
          z    : 0.02,
          color: palette.table[column].filled
        })
      })
    })
    const background     = rectangles(backgrounds, PANEL_BACKGROUND_OPACITY)
    const barMesh        = rectangles(bars, 0)
    const group          = new Group()
    const tableFrame     = new Group()
    const tableFace      = new Group()
    const instFrame      = new Group()
    // The table is built at wall u PANEL_U0: its frame starts at its first character.
    tableFace.position.x = -PANEL_U0
    tableFace.add(background, barMesh)
    tableFrame.add(tableFace)
    const flash                       = rectangles([{
      x    : 0,
      y    : FACE_PAD_TOP,
      w    : 1,
      h    : FLASH_HEIGHT,
      z    : 0.03,
      color: palette.device
    }], 0)
    flash.visible                     = false
    // Only 0.03 above the panel: at a slant or a distance the depth buffer cannot tell them apart, so pull the flash toward the camera.
    const flashMaterial               = flash.material as MeshBasicMaterial
    flashMaterial.polygonOffset       = true
    flashMaterial.polygonOffsetFactor = -4
    flashMaterial.polygonOffsetUnits  = -4
    flash.renderOrder                 = 3
    group.add(tableFrame, instFrame, flash)
    placeFrame(tableFrame, 1, 1)
    placeFrame(instFrame, 1, 1)
    group.position.set(panel.shownU - FACE_PAD_LEFT, panel.shownY, 0)
    group.visible = false
    this.wall.add(group)
    const face = this.layout.instrumentFace(panel.instrument)
    const rows = this.layout.tableFaceRows(panel)
    const view : PanelView = {
      panel,
      group,
      tableFrame,
      tableFace,
      instFrame,
      text      : null,
      textRows  : 0,
      nextText  : null,
      nextRows  : 0,
      tableRows : rows,
      rowsFrom  : rows,
      resize    : 1,
      bodyRows  : rows,
      backdrop  : background,
      background: background.material as MeshBasicMaterial,
      bars      : barMesh.material as MeshBasicMaterial,
      face,
      faceView  : null,
      faceKey   : '',
      staleFace : null,
      tab       : face ? this.buildTab(group) : null,
      flash,
      width     : TABLE_WIDTH
    }
    this.views.push(view)
    this.byPanel.set(panel, view)
  }

  private buildTab(parent: Group): PanelTab {
    const background = rectangles([{
      x    : 0,
      y    : TAB_HEIGHT,
      w    : TAB_CHARS * CHAR_W,
      h    : TAB_HEIGHT,
      z    : -0.05,
      color: this.palette.panelHeader
    }], PANEL_BACKGROUND_OPACITY)
    const group      = new Group()
    group.add(background)
    parent.add(group)
    return {
      group,
      background: background.material as MeshBasicMaterial,
      text      : null,
      label     : ''
    }
  }

  // ---------------------------------------------------------------------------
  // What a card shows

  /** Width of the face a panel shows, in its frame's units. */
  panelWidth(panel: Panel): number {
    return this.shownFace(panel) === 'inst' ? FACE_WIDTH : TABLE_WIDTH
  }

  /** Rows of the face a panel shows (a table's as drawn now, while it opens or folds). */
  shownRows(panel: Panel): number {
    const view = this.byPanel.get(panel)
    if (this.shownFace(panel) === 'inst' && view?.face) return view.face.rows
    return view ? cardTableRows(view) : this.layout.tableFaceRows(panel)
  }

  /** The face a panel shows now (they swap half way through the crossfade). */
  shownFace(panel: Panel): PanelFace {
    return flipPose(panel.flip).fade >= 0.5 ? 'inst' : 'table'
  }

  /** The face a panel turns to (and then shows): its instrument face when the world wants it and it has one. */
  settledFace(panel: Panel): PanelFace {
    return this.byPanel.get(panel)?.face && this.host.faceGoal(panel) === 'inst' ? 'inst' : 'table'
  }

  /** Width of a panel's card once it has turned to the face it goes to, in its frame's units. */
  settledWidth(panel: Panel): number {
    return this.settledFace(panel) === 'inst' ? FACE_WIDTH : TABLE_WIDTH
  }

  /**
   * Gives the layout the size of the face each panel turns to, at once (the turn itself takes a
   * few frames): a framing done right after the world changed its mind sees where panels settle.
   */
  applyFaceGoals(): void {
    for (const view of this.views) this.sizeForFace(view)
  }

  /**
   * The frame a panel's face is drawn in (the shown face by default): x from its first
   * character, y from its title line. It turns with the panel and scales while the faces crossfade.
   */
  faceFrame(panel: Panel, face = this.shownFace(panel)): Object3D {
    const view = this.byPanel.get(panel)
    if (!view) return this.wall
    return face === 'inst' ? view.instFrame : view.tableFrame
  }

  /** The group a panel turns in: x from its left edge, y from its title line. */
  panelGroup(panel: Panel): Object3D {
    return this.byPanel.get(panel)?.group ?? this.wall
  }

  /** True when (x, y) in the panel's group is on its tab. */
  onTab(panel: Panel, x: number, y: number): boolean {
    const tab = this.byPanel.get(panel)?.tab
    if (!tab || panel.alpha < 0.5) return false
    const left = tab.group.position.x
    const top  = tab.group.position.y + TAB_HEIGHT
    return x >= left && x <= left + TAB_CHARS * CHAR_W && y <= top && y >= top - TAB_HEIGHT
  }

  /**
   * How far the panels are turned out of the wall to show an instrument face (0..1, the most
   * turned one): as drawn now, or with `settled` where it goes (for the panels in view).
   */
  faceAmount(settled = false): number {
    let amount = 0
    for (const view of this.views) {
      if (!view.face) continue
      const turned = settled ? (view.panel.visible && this.host.faceGoal(view.panel) === 'inst' ? 1 : 0) : view.panel.flip
      amount       = Math.max(amount, turned)
    }
    return amount
  }

  /** The FX bars of the tables: they show as text gets too small, with the panels, and leave as a card turns to its instrument face. */
  fadeBars(barsAlpha: number, panelsAlpha: number): void {
    for (const view of this.views) view.bars.opacity = barsAlpha * panelsAlpha * tableContentAlpha(view.panel) * barsShown(view)
  }

  // ---------------------------------------------------------------------------
  // Frame by frame

  /**
   * Eases each panel toward where the sticky layout wants it and fades it in or out; its
   * text exists only while it shows. Returns true while anything is still moving.
   */
  update(dt: number, textOn: boolean, frame: CardsFrame): boolean {
    this.frame  = frame
    let busy    = false
    const fade  = easeFactor(dt, PANEL_FADE_RATE)
    const glide = easeFactor(dt, PANEL_GLIDE_RATE)
    for (const view of this.views) {
      if (this.easePanel(view.panel, fade, glide)) busy = true
      if (this.turnPanel(view, dt)) busy = true
      if (this.sizeTable(view, dt)) busy = true
    }
    this.keepPanelGaps()
    for (const view of this.views) {
      const { panel } = view
      const alpha     = panel.alpha * frame.panelsAlpha
      const pose      = flipPose(panel.flip)
      view.group.position.set(panel.shownU - FACE_PAD_LEFT, panel.shownY, 0)
      // The wall is turned wallAngle from the front: turning back as much faces the front.
      view.group.rotation.y = -pose.turn * frame.wallAngle
      view.group.visible    = alpha > 0.01
      const width           = this.cardSize(view, pose.fade)
      view.width            = width
      this.updateTable(view, textOn, alpha, pose.fade)
      this.updateInstrument(view, textOn, alpha, pose.fade)
      this.updateTab(view, textOn, alpha, width)
      if (this.updateFlash(view, dt, alpha)) busy = true
    }
    return busy
  }

  /**
   * Keeps gliding panels apart: down each column, in the order stick() stacked them, a panel is
   * shown no higher than the one above it allows (its card as drawn now and the gap), so the lag
   * of the glide (the top one held under the header, the others catching up) never makes them
   * overlap, and a card opening, folding or turning pushes the ones below as it grows. A panel
   * still moving to another column is left out: it may cross the others on its way.
   */
  private keepPanelGaps(): void {
    const { cols, panels } = this.track
    const settled          = (panel: Panel) => panel.visible && Math.abs(panel.shownU - panel.u) < COLUMN_SETTLED
    const takes            = (panel: Panel, col: number) => panel.col === col || (panel.chars > PANEL_CHARS && cols > 1 && panel.col === col - 1)
    for (let col = 0; col < cols; col += 1) {
      let floor = Number.POSITIVE_INFINITY
      for (const panel of panels.filter((p) => settled(p) && takes(p, col)).sort((a, b) => b.y - a.y)) {
        panel.shownY = Math.min(panel.shownY, floor)
        floor        = panel.shownY - panelSpan(this.drawnRows(panel))
      }
    }
  }

  /** Rows of a panel's card as drawn now: its table's while it opens or folds, and toward its instrument face's while it turns. */
  private drawnRows(panel: Panel): number {
    const view = this.byPanel.get(panel)
    if (!view) return shownPanelRows(panel)
    const table = cardTableRows(view)
    return view.face ? table + (view.face.rows - table) * flipPose(panel.flip).fade : table
  }

  /** Fades the glow of a panel's header out after a note; returns true while it glows. */
  private updateFlash(view: PanelView, dt: number, alpha: number): boolean {
    const { panel } = view
    if (panel.flash > 0) panel.flash = Math.max(0, panel.flash - dt / FLASH_SECONDS)
    const opacity      = FLASH_OPACITY * panel.flash ** 2 * alpha
    view.flash.visible = opacity > 0.002
    if (view.flash.visible) {
      // On the instrument face the modulator cards stand right of the header: the flash covers the header band only.
      view.flash.scale.x                                 = this.shownFace(panel) === 'inst' ? Math.min(view.width, FACE_HEADER_WIDTH) : view.width
      ;(view.flash.material as MeshBasicMaterial).opacity = opacity
    }
    return panel.flash > 0
  }

  /**
   * Sizes both faces' frames to the card between the table's size and the instrument face's
   * (`fade` 0..1), so the two fill the same card while they crossfade. Returns its width.
   */
  private cardSize(view: PanelView, fade: number): number {
    const table      = tableHeight(cardTableRows(view))
    const faceHeight = view.face ? view.face.rows * ROW_H + 0.5 : table
    const width      = TABLE_WIDTH + (FACE_WIDTH - TABLE_WIDTH) * fade
    const height     = table + (faceHeight - table) * fade
    placeFrame(view.tableFrame, width / TABLE_WIDTH, height / table)
    placeFrame(view.instFrame, width / FACE_WIDTH, height / faceHeight)
    return view.face ? width : TABLE_WIDTH
  }

  /**
   * The table face. Its content leaves first in the crossfade; its background stays until the
   * instrument face's is in, so the card never thins out.
   */
  private updateTable(view: PanelView, textOn: boolean, alpha: number, fade: number): void {
    const back              = alpha * (1 - smoothstep(0.5, 1, fade))
    const content           = this.frame.panelsAlpha * tableContentAlpha(view.panel)
    view.tableFrame.visible = back > 0.01
    view.background.opacity = PANEL_BACKGROUND_OPACITY * back
    view.bars.opacity       = this.frame.barsAlpha * content * barsShown(view)
    this.updatePanelText(view, textOn && content > 0.01, content)
  }

  /**
   * The instrument face, made when first shown: its background comes in first, its content last.
   * A face made again for new values stays hidden until its text is laid out, the old one showing
   * meanwhile.
   */
  private updateInstrument(view: PanelView, textOn: boolean, alpha: number, fade: number): void {
    const back = alpha * smoothstep(0, 0.5, fade)
    if (back > 0.01 && view.face && !view.faceView) {
      view.faceView = new InstrumentFaceView(view.face, this.palette)
      view.faceKey  = faceKeyOf(this.layout, view.panel.instrument)
      view.instFrame.add(view.faceView.group)
    }
    const content = alpha * smoothstep(0.4, 1, fade)
    view.faceView?.setAlpha(content, back, textOn, () => this.host.onTextReady())
    const stale   = view.staleFace
    if (!stale) return
    if (!view.faceView || view.faceView.ready || !textOn || content <= 0.01) {
      stale.dispose()
      stale.group.removeFromParent()
      view.staleFace = null
      return
    }
    view.faceView.group.visible = false
    stale.setAlpha(content, back, textOn, () => this.host.onTextReady())
  }

  /**
   * Moves a panel's flip toward the face the world wants: it turns out of the wall to face the
   * front, then the faces crossfade; turning back runs the same way in reverse. Returns true while
   * it turns.
   */
  private turnPanel(view: PanelView, dt: number): boolean {
    const { panel } = view
    const goal      = this.sizeForFace(view)
    if (panel.flip === goal) return false
    const step = dt / FLIP_SECONDS
    panel.flip = goal > panel.flip ? Math.min(goal, panel.flip + step) : Math.max(goal, panel.flip - step)
    // A panel coming back from hidden shows its face at once.
    if (panel.alpha < 0.02) panel.flip = goal
    return panel.flip !== goal
  }

  /** The layout makes room for the face a panel turns to at once: its rows and characters. Returns the flip it goes to (1 the instrument face). */
  private sizeForFace(view: PanelView): number {
    const { panel } = view
    const goal      = this.settledFace(panel) === 'inst' ? 1 : 0
    panel.rows      = goal ? (view.face?.rows ?? this.layout.tableFaceRows(panel)) : this.layout.tableFaceRows(panel)
    panel.chars     = goal ? FACE_CHARS : PANEL_CHARS
    return goal
  }

  /** The tab over the card's top-right corner (`width` wide), named after the face a click turns to. */
  private updateTab(view: PanelView, textOn: boolean, alpha: number, width: number): void {
    const tab = view.tab
    if (!tab) return
    const label = this.shownFace(view.panel) === 'inst' ? '‹ TABLE' : 'INST ›'
    tab.group.position.set(width - TAB_CHARS * CHAR_W, FACE_PAD_TOP, 0)
    tab.background.opacity = PANEL_BACKGROUND_OPACITY * alpha
    const wanted           = textOn && alpha > 0.01
    if (tab.text && (!wanted || tab.label !== label)) {
      disposeText(tab.text)
      tab.text = null
    }
    if (wanted && !tab.text) {
      const text       = makeText(new RichText().add(label.padStart(TAB_CHARS - 1), this.palette.label))
      text.position.set(0, TAB_HEIGHT - 0.05, 0.01)
      text.renderOrder = 2
      tab.group.add(text)
      text.sync(() => this.host.onTextReady())
      tab.text  = text
      tab.label = label
    }
    if (tab.text) tab.text.fillOpacity = alpha
  }

  /** Moves a panel's shown place and opacity toward its goal; returns true while it still moves. */
  private easePanel(panel: Panel, fade: number, glide: number): boolean {
    const goalAlpha = panel.visible ? 1 : 0
    panel.alpha     += (goalAlpha - panel.alpha) * fade
    if (Math.abs(goalAlpha - panel.alpha) < 0.01) panel.alpha = goalAlpha
    if (panel.alpha < 0.02) {
      // A panel coming back from hidden appears where it belongs instead of flying in.
      panel.shownY = panel.y
      panel.shownU = panel.u
    } else {
      panel.shownY += (panel.y - panel.shownY) * glide
      panel.shownU += (panel.u - panel.shownU) * glide
      // A gliding panel never rises over the stuck header (the header moves at once, panels lag).
      if (panel.visible) panel.shownY = Math.min(panel.shownY, Math.max(panel.y, this.frame.panelCeiling))
    }
    if (Math.abs(panel.y - panel.shownY) < 0.01) panel.shownY = panel.y
    if (Math.abs(panel.u - panel.shownU) < 0.01) panel.shownU = panel.u
    return panel.alpha !== goalAlpha || panel.shownY !== panel.y || panel.shownU !== panel.u
  }

  /**
   * Eases the table card to the rows it shows now (folded: its title lines only) over
   * FLIP_SECONDS, as a flip resizes it; returns true while it does.
   */
  private sizeTable(view: PanelView, dt: number): boolean {
    const { panel } = view
    const rows      = panel.folded ? TITLE_ROWS : this.layout.tableFaceRows(panel)
    if (rows !== view.tableRows) {
      // From the rows drawn now: it may change again on its way.
      view.rowsFrom  = cardTableRows(view)
      view.tableRows = rows
      view.resize    = 0
    }
    // A hidden panel takes its size at once.
    view.resize = panel.alpha < 0.02 ? 1 : Math.min(1, view.resize + dt / FLIP_SECONDS)
    const drawn = cardTableRows(view)
    if (drawn !== view.bodyRows) {
      view.bodyRows = drawn
      const matrix  = new Matrix4()
      view.backdrop.getMatrixAt(0, matrix)
      const corner  = new Vector3().setFromMatrixPosition(matrix)
      view.backdrop.setMatrixAt(0, matrix.makeScale(TABLE_WIDTH, tableHeight(drawn), 1).setPosition(corner))
      view.backdrop.instanceMatrix.needsUpdate = true
    }
    return view.resize < 1
  }

  /**
   * The table's text, made for the rows it shows (while the card opens or folds, for the larger
   * of its old and new rows) and clipped to the card. A new text takes over once it is laid out,
   * so the old one shows until then and the title never blinks.
   */
  private updatePanelText(view: PanelView, wanted: boolean, alpha: number): void {
    const rows = view.resize < 1 ? Math.max(Math.ceil(view.rowsFrom - 1e-6), view.tableRows) : view.tableRows
    if (view.nextText && (!wanted || view.nextRows !== rows)) {
      disposeText(view.nextText)
      view.nextText = null
    }
    if (!wanted) {
      if (view.text) disposeText(view.text)
      view.text = null
      return
    }
    if (!view.nextText && (!view.text || view.textRows !== rows)) this.makePanelText(view, rows, alpha)
    if (view.text && Math.abs(view.text.fillOpacity - alpha) > 0.005) view.text.fillOpacity = alpha
    this.clipPanelText(view)
  }

  /** Lays out a table text for `rows` rows; it replaces the shown one when ready. */
  private makePanelText(view: PanelView, rows: number, alpha: number): void {
    const text       = makeText(this.text.panelText(view.panel, rows - TITLE_ROWS))
    text.position.set(PANEL_U0, 0, 0.01)
    text.renderOrder = 2
    text.fillOpacity = alpha
    text.visible     = false
    view.tableFace.add(text)
    view.nextText = text
    view.nextRows = rows
    text.sync(() => {
      if (view.nextText !== text) return
      if (view.text) disposeText(view.text)
      text.visible  = true
      view.text     = text
      view.textRows = rows
      view.nextText = null
      this.clipPanelText(view)
      this.host.onTextReady()
    })
  }

  /** Hides the rows of the table text below its card (while the card opens or folds). */
  private clipPanelText(view: PanelView): void {
    if (!view.text) return
    const drawn        = cardTableRows(view)
    view.text.clipRect = view.textRows > drawn + 1e-6 ? [-1, -drawn * ROW_H, PANEL_CHARS * CHAR_W + 1, 1] : null
  }

  // ---------------------------------------------------------------------------
  // Edits

  /** The same track in a new layout of the song (see TrackView.relink): each card keeps its view, now of the new layout's panel. */
  relink(layout: SongLayout, track: TrackLayout, text: TrackTextBuilder): void {
    this.layout   = layout
    this.track    = track
    this.text     = text
    const byTable = new Map(track.panels.map((panel) => [panel.table, panel]))
    this.byPanel.clear()
    for (const view of this.views) {
      const panel = byTable.get(view.panel.table)
      if (!panel) continue
      view.panel = panel
      this.byPanel.set(panel, view)
    }
  }

  /** Gives up each panel's texts and instrument face, for the view that replaces the track's (see TrackView.handOver). */
  handOver(): Map<number, CarriedPanel> {
    const panels = new Map<number, CarriedPanel>()
    for (const view of this.views) {
      panels.set(view.panel.table, {
        text    : view.text,
        textRows: view.textRows,
        tabText : view.tab?.text ?? null,
        tabLabel: view.tab?.label ?? '',
        faceView: view.faceView,
        faceKey : view.faceKey
      })
      if (view.nextText) disposeText(view.nextText)
      view.nextText = null
      view.text     = null
      if (view.tab) view.tab.text = null
      view.faceView = null
    }
    return panels
  }

  /**
   * Takes the texts and faces the view this one replaces handed over: a table text that no longer
   * shows the same is laid out again (it shows until then), a face drawn from older values is made
   * again (likewise). What no panel takes is disposed.
   */
  private take(carried: Map<number, CarriedPanel>): void {
    for (const view of this.views) {
      const old = carried.get(view.panel.table)
      if (!old) continue
      carried.delete(view.panel.table)
      if (old.text) {
        const rows    = old.textRows
        view.tableFace.add(old.text)
        view.text     = old.text
        view.textRows = showsRich(old.text, this.text.panelText(view.panel, rows - TITLE_ROWS)) ? rows : -1
      }
      if (old.tabText && view.tab) {
        view.tab.group.add(old.tabText)
        view.tab.text  = old.tabText
        view.tab.label = old.tabLabel
      } else if (old.tabText) disposeText(old.tabText)
      if (old.faceView) {
        view.instFrame.add(old.faceView.group)
        if (view.face && old.faceKey === faceKeyOf(this.layout, view.panel.instrument)) {
          view.faceView = old.faceView
          view.faceKey  = old.faceKey
        } else view.staleFace = old.faceView
      }
    }
    for (const old of carried.values()) {
      if (old.text) disposeText(old.text)
      if (old.tabText) disposeText(old.tabText)
      old.faceView?.dispose()
      old.faceView?.group.removeFromParent()
    }
  }

  /** A table changed (edited on the M8): its panels lay their text out again, the old one showing until then. */
  refreshTable(table: number): boolean {
    let any = false
    for (const view of this.views) {
      if (view.panel.table !== table) continue
      view.textRows = -1
      any           = true
    }
    return any
  }

  /**
   * An instrument changed (edited on the M8; the layout forgot its face): its panels lay their
   * title out again and make their instrument face again from its new values, each old one showing
   * until the new one is ready.
   */
  refreshInstrument(instrument: number): boolean {
    let any = false
    for (const view of this.views) {
      if (view.panel.instrument !== instrument) continue
      any           = true
      view.textRows = -1
      view.face     = this.layout.instrumentFace(instrument)
      if (!view.faceView) continue
      view.staleFace?.dispose()
      view.staleFace?.group.removeFromParent()
      view.staleFace = view.faceView
      view.faceView  = null
    }
    return any
  }

  /** Frees the cards' texts and instrument faces (their meshes go with the wall). */
  dispose(): void {
    for (const view of this.views) {
      view.text?.dispose()
      view.nextText?.dispose()
      view.nextText = null
      view.tab?.text?.dispose()
      view.faceView?.dispose()
      view.staleFace?.dispose()
    }
  }
}

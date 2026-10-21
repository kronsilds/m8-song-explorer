// One track in 3D: its front column (chain/phrase tree, notes), its wall (step details,
// instrument and table panels, links), its sticky header and the coloured bars shown when
// zoomed out.

import { Group, type InstancedMesh, type LineBasicMaterial, type LineSegments, type MeshBasicMaterial, type Object3D, Vector3 } from 'three'
import type { Text } from 'troika-three-text'
import type { TrackToggle } from '../../m8/midiControl'
import { fxColumn } from '../../model/columns'
import { transposeSemitones } from '../../model/music/harmony'
import { ROWS_PER_PHRASE, type SongModel } from '../../model/song'
import type { PhraseInstance } from '../../model/timeline'
import { FACE_CHARS, type InstrumentFace } from '../instrumentFace'
import {
  CHAIN_COL,
  CHAR_W,
  FRONT_W,
  NOTE_COL,
  PANEL_CHARS,
  PANEL_FIELDS,
  PANEL_ROWS,
  PANEL_U0,
  type Panel,
  PHRASE_COL,
  ROW_H,
  SIDE_CHARS,
  SIDE_FIELDS,
  SIDE_U0,
  type SongLayout,
  type TrackLayout,
  WALL_ANGLE,
  WALL_HINGE,
} from '../layout'
import { mix, type Palette } from '../palette'
import { type ColoredRect, easeFactor, lineSegments, rectangles, smoothstep } from '../shapes'
import { disposeText, makeText, RichText, type TextBlock } from '../text'
import { FACE_WIDTH, InstrumentFaceView } from './instrumentFaceView'
import { LinkLines } from './linkLines'
import { TrackHeader } from './trackHeader'
import { TrackTextBuilder } from './trackText'

const PHRASE_HEIGHT            = ROWS_PER_PHRASE * ROW_H
const SHADE_OPACITY            = 0.9
const PANEL_BACKGROUND_OPACITY = 0.92
/** Bars sit inside a row, a little below its top. */
const BAR_INSET                = ROW_H * 0.14
const BAR_HEIGHT               = ROW_H * 0.72
/** Ease rates per second of a panel's fade and glide. */
const PANEL_FADE_RATE          = 3
const PANEL_GLIDE_RATE         = 15
/** Seconds a panel takes to turn to its other face. */
const FLIP_SECONDS             = 0.10
/** Part of the flip the turn off the wall takes, and where the crossfade of the faces starts (it overlaps the end of the turn). */
const TURN_END                 = 90.0
const FADE_START               = 0.0
/** The tab above a panel's top-right corner that turns it over: its width (characters) and height. */
const TAB_CHARS                = 8
const TAB_HEIGHT               = ROW_H * 0.95
/** A face's background reaches this far left of its first character and above its title line. */
const FACE_PAD_LEFT            = 0.45
const FACE_PAD_TOP             = 0.25
/** How far a panel's tab reaches above its title line: panels stick that much lower under the header. */
export const PANEL_TAB_ROOM    = FACE_PAD_TOP + TAB_HEIGHT
const TABLE_WIDTH              = PANEL_CHARS * CHAR_W + 0.9
const TABLE_HEIGHT             = PANEL_ROWS * ROW_H + 0.5

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

/** The notes column of the front, with a little room around it. */
export const FRONT_NOTES_X = NOTE_COL * CHAR_W - 0.25
export const FRONT_NOTES_W = FRONT_W - NOTE_COL * CHAR_W + 0.4
/** The step details of the wall, with a little room around them. */
export const WALL_STEPS_U  = SIDE_U0 - 0.3
export const WALL_STEPS_W  = SIDE_CHARS * CHAR_W + 0.6

/** The bar colour of a note: louder notes in the hotter meter colours. */
function velocityColor(palette: Palette, velocity: number | null): string {
  const value = velocity ?? 0x64
  return value >= 0x70 ? palette.theme.meterPeak : value >= 0x48 ? palette.theme.meterMid : palette.theme.meterLow
}

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
  background: MeshBasicMaterial
  bars      : MeshBasicMaterial
  /** The instrument face's layout (null for an aux table or an instrument not read) and its 3D view, made when first shown. */
  face      : InstrumentFace | null
  faceView  : InstrumentFaceView | null
  tab       : PanelTab | null
}

/** The tab that turns a panel over, labelled with the face it turns to. */
interface PanelTab {
  group     : Group
  background: MeshBasicMaterial
  text      : Text | null
  label     : string
}

export type PanelFace = 'table' | 'inst'

/** A material whose opacity follows the front's or the wall's fade. */
interface FadingMaterial {
  material: { opacity: number }
  base    : number
}

export class TrackView {
  readonly group  = new Group()
  readonly front  = new Group()
  readonly wall   = new Group()
  readonly header : TrackHeader
  readonly blocks : TextBlock[] = []
  readonly panels : PanelView[] = []
  wallAlpha       = 0
  frontAlpha      = 1
  /** Highest y a visible panel is shown at while gliding: just under the stuck header. */
  panelCeiling    = Number.POSITIVE_INFINITY
  /** Called when a text finished laying out (to redraw). */
  onTextReady     : () => void = () => {}
  /** The face each panel should show (the world decides: the M8 view, a turn by hand). */
  faceGoal        : (panel: Panel) => PanelFace = () => 'table'

  private readonly text           : TrackTextBuilder
  private readonly panelViews     = new Map<Panel, PanelView>()
  private readonly links          : LinkLines
  private readonly frontMaterials : FadingMaterial[] = []
  private readonly wallMaterials  : FadingMaterial[] = []
  private frontBars!              : InstancedMesh
  private wallBars!               : InstancedMesh
  private barsAlpha               = 0

  constructor(
    readonly layout: SongLayout,
    readonly track: TrackLayout,
    readonly palette: Palette,
    playedNotes = true,
  ) {
    this.text = new TrackTextBuilder(layout, palette, playedNotes)
    this.group.add(this.front, this.wall)
    this.wall.position.set(WALL_HINGE, 0, 0)
    this.wall.rotation.y = WALL_ANGLE

    this.buildPhrases()
    for (const panel of track.panels) this.buildPanel(panel)

    // Links are drawn near the view only, fading with their panel and toward the edges (updateLinks).
    this.links = new LinkLines(layout, track, palette)
    this.wall.add(this.fadesWith(this.links.lines, true))

    const headerY           = layout.rowY(0) + ROW_H * 1.9
    this.header             = new TrackHeader(palette, track.track, headerY, track.wallLen)
    this.header.onTextReady = () => this.onTextReady()
    this.front.add(this.header.front)
    this.wall.add(this.header.wall)
    // A faint floor line along the hinge shows where the wall is when nothing is on it.
    this.wall.add(this.fadesWith(lineSegments([0, headerY, 0, track.wallLen, headerY, 0], palette.rule, 0.8), true))
  }

  /** Shaded phrase backgrounds, beat rows, the chain / phrase tree, note and FX bars, and the text blocks. */
  private buildPhrases(): void {
    const { layout, track, palette } = this
    const { model }                  = layout
    const frontShades                : ColoredRect[] = []
    const wallShades                 : ColoredRect[] = []
    const noteBars                   : ColoredRect[] = []
    const fxBars                     : ColoredRect[] = []
    const tree                       : number[] = []
    const shades                     = [palette.panel, mix(palette.panel, palette.background, 0.55)]
    const beat                       = mix(palette.panel, palette.label, 0.07)

    track.instances.forEach((instance, i) => {
      const y     = layout.rowY(instance.row)
      const shade = shades[i % 2]
      frontShades.push({
        x    : FRONT_NOTES_X,
        y    : y - 0.05,
        w    : FRONT_NOTES_W,
        h    : PHRASE_HEIGHT - 0.1,
        z    : -0.05,
        color: shade
      })
      wallShades.push({
        x    : WALL_STEPS_U,
        y    : y - 0.05,
        w    : WALL_STEPS_W,
        h    : PHRASE_HEIGHT - 0.1,
        z    : -0.05,
        color: shade
      })
      for (let s = 0; s < ROWS_PER_PHRASE; s += 4) {
        frontShades.push({
          x    : FRONT_NOTES_X,
          y    : y - s * ROW_H,
          w    : FRONT_NOTES_W,
          h    : ROW_H,
          z    : -0.04,
          color: beat
        })
        wallShades.push({
          x    : WALL_STEPS_U,
          y    : y - s * ROW_H,
          w    : WALL_STEPS_W,
          h    : ROW_H,
          z    : -0.04,
          color: beat
        })
      }
      tree.push(...this.treeBrackets(model, instance, y))

      const steps = model.phrases[instance.phrase]?.steps
      steps?.forEach((step, s) => {
        const barY = y - s * ROW_H - BAR_INSET
        if (step.note && step.note !== 'OFF') {
          noteBars.push({
            x    : NOTE_COL * CHAR_W,
            y    : barY,
            w    : 3 * CHAR_W,
            h    : BAR_HEIGHT,
            z    : 0.02,
            color: velocityColor(palette, step.vel)
          })
        }
        step.fx.forEach((fx, lane) => {
          if (!fx.cmd) return
          const column = fxColumn(lane, 'cmd')
          fxBars.push({
            x    : SIDE_U0 + SIDE_FIELDS[column][0] * CHAR_W,
            y    : barY,
            w    : 5 * CHAR_W,
            h    : BAR_HEIGHT,
            z    : 0.02,
            color: palette.phrase[column].filled
          })
        })
      })

      const block = {
        y,
        height: PHRASE_HEIGHT,
        track : track.track
      }
      this.blocks.push({
        ...block,
        key   : `f:${instance.key}`,
        parent: this.front,
        x     : 0,
        layer : 'front',
        build : () => this.text.frontText(instance)
      }, {
        ...block,
        key   : `w:${instance.key}`,
        parent: this.wall,
        x     : SIDE_U0,
        layer : 'wall',
        build : () => this.text.sideText(steps)
      })
    })

    this.front.add(this.fadesWith(rectangles(frontShades, SHADE_OPACITY), false))
    this.front.add(this.fadesWith(lineSegments(tree, palette.bracket, SHADE_OPACITY), false))
    this.wall.add(this.fadesWith(rectangles(wallShades, SHADE_OPACITY), true))
    this.frontBars = rectangles(noteBars, 0)
    this.wallBars  = rectangles(fxBars, 0)
    this.front.add(this.frontBars)
    this.wall.add(this.fadesWith(this.wallBars, true))
  }

  /**
   * Tree brackets of a phrase instance: the chain's bracket spans its phrases in this song row,
   * the phrase's spans its steps. A transposed phrase's bracket leaves its second row to the
   * transpose label.
   */
  private treeBrackets(model: SongModel, instance: PhraseInstance, y: number): number[] {
    const points     : number[] = []
    const top        = y - 0.3
    const bottom     = y - PHRASE_HEIGHT + 0.3
    const phraseX    = (PHRASE_COL + 2.45) * CHAR_W
    const transposed = transposeSemitones(model.chains[instance.chain]?.rows[instance.chainRow]?.transpose) !== 0
    if (transposed) points.push(phraseX, top, 0, phraseX, y - ROW_H, 0, phraseX, y - 2 * ROW_H, 0, phraseX, bottom, 0)
    else points.push(phraseX, top, 0, phraseX, bottom, 0)
    points.push(phraseX, top, 0, phraseX + 0.35, top, 0)
    if (instance.chainRow === 0) {
      const sameSongRow = this.track.instances.filter((other) => other.songRow === instance.songRow)
      const chainBottom = this.layout.rowY(sameSongRow[sameSongRow.length - 1].row) - PHRASE_HEIGHT + 0.3
      const chainX      = (CHAIN_COL + 2.45) * CHAR_W
      points.push(chainX, top, 0, chainX, chainBottom, 0, chainX, top, 0, chainX + 0.35, top, 0)
    }
    return points
  }

  private buildPanel(panel: Panel): void {
    const { palette } = this
    const height      = PANEL_ROWS * ROW_H
    const width       = PANEL_CHARS * CHAR_W + 0.9
    const backgrounds : ColoredRect[] = [{
      x    : PANEL_U0 - 0.45,
      y    : 0.25,
      w    : width,
      h    : height + 0.5,
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
    group.add(tableFrame, instFrame)
    placeFrame(tableFrame, 1, 1)
    placeFrame(instFrame, 1, 1)
    group.position.set(panel.shownU - FACE_PAD_LEFT, panel.shownY, 0)
    group.visible = false
    this.wall.add(group)
    const face = this.layout.instrumentFace(panel.instrument)
    const view : PanelView = {
      panel,
      group,
      tableFrame,
      tableFace,
      instFrame,
      text      : null,
      background: background.material as MeshBasicMaterial,
      bars      : barMesh.material as MeshBasicMaterial,
      face,
      faceView  : null,
      tab       : face ? this.buildTab(group) : null
    }
    this.panels.push(view)
    this.panelViews.set(panel, view)
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

  /** Width of the face a panel shows, in its frame's units. */
  panelWidth(panel: Panel): number {
    return this.shownFace(panel) === 'inst' ? FACE_WIDTH : TABLE_WIDTH
  }

  /** Rows of the face a panel shows. */
  shownRows(panel: Panel): number {
    const face = this.panelViews.get(panel)?.face
    return this.shownFace(panel) === 'inst' && face ? face.rows : PANEL_ROWS
  }

  /** The face a panel shows now (they swap half way through the crossfade). */
  shownFace(panel: Panel): PanelFace {
    return flipPose(panel.flip).fade >= 0.5 ? 'inst' : 'table'
  }

  /**
   * The frame a panel's face is drawn in (the shown face by default): x from its first
   * character, y from its title line. It turns with the panel and scales while the faces crossfade.
   */
  faceFrame(panel: Panel, face = this.shownFace(panel)): Object3D {
    const view = this.panelViews.get(panel)
    if (!view) return this.wall
    return face === 'inst' ? view.instFrame : view.tableFrame
  }

  /** The group a panel turns in: x from its left edge, y from its title line. */
  panelGroup(panel: Panel): Object3D {
    return this.panelViews.get(panel)?.group ?? this.wall
  }

  /** True when (x, y) in the panel's group is on its tab. */
  onTab(panel: Panel, x: number, y: number): boolean {
    const tab = this.panelViews.get(panel)?.tab
    if (!tab || panel.alpha < 0.5) return false
    const left = tab.group.position.x
    const top  = tab.group.position.y + TAB_HEIGHT
    return x >= left && x <= left + TAB_CHARS * CHAR_W && y <= top && y >= top - TAB_HEIGHT
  }

  /** Registers an object's material so its opacity follows the front's or the wall's fade. */
  private fadesWith<T extends LineSegments | InstancedMesh>(object: T, onWall: boolean): T {
    const material = object.material as LineBasicMaterial
    ;(onWall ? this.wallMaterials : this.frontMaterials).push({
      material,
      base: material.opacity
    })
    return object
  }

  /** Start (step cell) and end (panel title) of a link, in wall coordinates. */
  linkEnds(row: number, col: number, panelY: number, panelU: number): [Vector3, Vector3] {
    const y = this.layout.rowY(row) - ROW_H / 2
    return [new Vector3(SIDE_U0 + (col + 2) * CHAR_W, y, 0.05), new Vector3(panelU - 0.5, panelY - ROW_H * 0.5, 0.05)]
  }

  // ---------------------------------------------------------------------------
  // Fades

  setWallAlpha(alpha: number): void {
    this.wallAlpha    = alpha
    this.wall.visible = alpha > 0.01
    for (const { material, base } of this.wallMaterials) material.opacity = base * alpha
    this.applyFades()
  }

  /** The front column steps back while another track's wall is looked at. */
  setFrontAlpha(alpha: number): void {
    this.frontAlpha    = alpha
    this.front.visible = alpha > 0.01
    for (const { material, base } of this.frontMaterials) material.opacity = base * alpha
    this.applyFades()
  }

  /** Bars fade in as the text becomes too small to read. */
  setBarsAlpha(alpha: number): void {
    this.barsAlpha = alpha
    this.applyFades()
  }

  private applyFades(): void {
    ;(this.frontBars.material as MeshBasicMaterial).opacity = this.barsAlpha * this.frontAlpha
    ;(this.wallBars.material as MeshBasicMaterial).opacity  = this.barsAlpha * this.wallAlpha
    for (const view of this.panels) view.bars.opacity = this.barsAlpha * this.wallAlpha * tableContentAlpha(view.panel)
    this.header?.setFade(this.frontAlpha, this.wallAlpha)
  }

  // ---------------------------------------------------------------------------
  // Header

  /** Moves the sticky header to `y` (never above the song start). Returns true when it moved. */
  setHeaderY(y: number): boolean {
    return this.header.moveTo(y)
  }

  setTrackModes(muted: boolean, soloed: boolean): void {
    this.header.setTrackModes(muted, soloed)
  }

  buttonAt(x: number, y: number): TrackToggle | null {
    return this.header.buttonAt(x, y)
  }

  /** True when height y (front or wall coordinates) is under the header. */
  inHeader(y: number): boolean {
    return this.header.covers(y)
  }

  // ---------------------------------------------------------------------------
  // Panels and links

  /**
   * Eases each panel toward where the sticky layout wants it and fades it in or out; its
   * text exists only while it shows. Returns true while anything is still moving.
   */
  updatePanels(dt: number, textOn: boolean): boolean {
    let busy    = false
    const fade  = easeFactor(dt, PANEL_FADE_RATE)
    const glide = easeFactor(dt, PANEL_GLIDE_RATE)
    for (const view of this.panels) {
      const { panel } = view
      if (this.easePanel(panel, fade, glide)) busy = true
      if (this.turnPanel(view, dt)) busy = true
      const alpha = panel.alpha * this.wallAlpha
      const pose  = flipPose(panel.flip)
      view.group.position.set(panel.shownU - FACE_PAD_LEFT, panel.shownY, 0)
      // The wall is turned WALL_ANGLE from the front: turning back as much faces the front.
      view.group.rotation.y = -pose.turn * WALL_ANGLE
      view.group.visible    = alpha > 0.01
      const width           = this.cardSize(view, pose.fade)
      this.updateTable(view, textOn, alpha, pose.fade)
      this.updateInstrument(view, textOn, alpha, pose.fade)
      this.updateTab(view, textOn, alpha, width)
    }
    return busy
  }

  /**
   * Sizes both faces' frames to the card between the table's size and the instrument face's
   * (`fade` 0..1), so the two fill the same card while they crossfade. Returns its width.
   */
  private cardSize(view: PanelView, fade: number): number {
    const faceHeight = view.face ? view.face.rows * ROW_H + 0.5 : TABLE_HEIGHT
    const width      = TABLE_WIDTH + (FACE_WIDTH - TABLE_WIDTH) * fade
    const height     = TABLE_HEIGHT + (faceHeight - TABLE_HEIGHT) * fade
    placeFrame(view.tableFrame, width / TABLE_WIDTH, height / TABLE_HEIGHT)
    placeFrame(view.instFrame, width / FACE_WIDTH, height / faceHeight)
    return view.face ? width : TABLE_WIDTH
  }

  /**
   * The table face. Its content leaves first in the crossfade; its background stays until the
   * instrument face's is in, so the card never thins out.
   */
  private updateTable(view: PanelView, textOn: boolean, alpha: number, fade: number): void {
    const back              = alpha * (1 - smoothstep(0.5, 1, fade))
    const content           = this.wallAlpha * tableContentAlpha(view.panel)
    view.tableFrame.visible = back > 0.01
    view.background.opacity = PANEL_BACKGROUND_OPACITY * back
    view.bars.opacity       = this.barsAlpha * content
    this.updatePanelText(view, textOn && content > 0.01, content)
  }

  /** The instrument face, made when first shown: its background comes in first, its content last. */
  private updateInstrument(view: PanelView, textOn: boolean, alpha: number, fade: number): void {
    const back = alpha * smoothstep(0, 0.5, fade)
    if (back > 0.01 && view.face && !view.faceView) {
      view.faceView = new InstrumentFaceView(view.face, this.palette)
      view.instFrame.add(view.faceView.group)
    }
    view.faceView?.setAlpha(alpha * smoothstep(0.4, 1, fade), back, textOn, () => this.onTextReady())
  }

  /**
   * Moves a panel's flip toward the face the world wants: it turns out of the wall to face the
   * front, then the faces crossfade; turning back runs the same way in reverse. Returns true while
   * it turns.
   */
  private turnPanel(view: PanelView, dt: number): boolean {
    const { panel } = view
    const goal      = view.face && this.faceGoal(panel) === 'inst' ? 1 : 0
    // The layout makes room for the face it turns to at once.
    panel.rows      = goal ? (view.face?.rows ?? PANEL_ROWS) : PANEL_ROWS
    panel.chars     = goal ? FACE_CHARS : PANEL_CHARS
    if (panel.flip === goal) return false
    const step = dt / FLIP_SECONDS
    panel.flip = goal > panel.flip ? Math.min(goal, panel.flip + step) : Math.max(goal, panel.flip - step)
    // A panel coming back from hidden shows its face at once.
    if (panel.alpha < 0.02) panel.flip = goal
    return panel.flip !== goal
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
      text.sync(() => this.onTextReady())
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
      if (panel.visible) panel.shownY = Math.min(panel.shownY, Math.max(panel.y, this.panelCeiling))
    }
    if (Math.abs(panel.y - panel.shownY) < 0.01) panel.shownY = panel.y
    if (Math.abs(panel.u - panel.shownU) < 0.01) panel.shownU = panel.u
    return panel.alpha !== goalAlpha || panel.shownY !== panel.y || panel.shownU !== panel.u
  }

  private updatePanelText(view: PanelView, wanted: boolean, alpha: number): void {
    if (wanted && !view.text) {
      const text = makeText(this.text.panelText(view.panel))
      text.position.set(PANEL_U0, 0, 0.01)
      text.renderOrder = 2
      text.fillOpacity = alpha
      view.tableFace.add(text)
      text.sync(() => this.onTextReady())
      view.text = text
    } else if (!wanted && view.text) {
      disposeText(view.text)
      view.text = null
    }
    if (view.text && Math.abs(view.text.fillOpacity - alpha) > 0.005) view.text.fillOpacity = alpha
  }

  /** Redraws the thin links for the view [yBottom, yTop]; returns true when redrawn. */
  updateLinks(yTop: number, yBottom: number): boolean {
    return this.links.update(yTop, yBottom)
  }

  dispose(): void {
    for (const view of this.panels) {
      view.text?.dispose()
      view.tab?.text?.dispose()
      view.faceView?.dispose()
    }
    this.header.dispose()
    this.group.traverse((object) => {
      const mesh  = object as InstancedMesh
      const lines = object as LineSegments
      if (!mesh.isInstancedMesh && !lines.isLineSegments) return
      if (lines.isLineSegments) lines.geometry.dispose()
      ;(mesh.material as MeshBasicMaterial).dispose()
      if (mesh.isInstancedMesh) mesh.dispose()
    })
  }
}

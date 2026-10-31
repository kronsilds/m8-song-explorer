// One track in 3D: its front column (chain/phrase tree, notes), its wall (step details, the
// instrument and table panel cards, links), its sticky header and the coloured bars shown when
// zoomed out. The panel cards are their own module (panelCards); the view folds, fades and turns
// the wall they sit on.

import { Group, type InstancedMesh, type LineBasicMaterial, type LineSegments, type MeshBasicMaterial, Vector3 } from 'three'
import { fxColumn } from '../../model/columns'
import { transposeSemitones } from '../../model/music/harmony'
import { mix, type Palette } from '../../model/palette'
import { ROWS_PER_PHRASE, type SongModel } from '../../model/song'
import type { PhraseInstance } from '../../model/timeline'
import {
  CHAIN_COL,
  CHAR_W,
  DEFAULT_WALL_ANGLE,
  FRONT_W,
  NOTE_COL,
  PANEL_U0,
  type Panel,
  PHRASE_COL,
  ROW_H,
  SIDE_CHARS,
  SIDE_FIELDS,
  SIDE_U0,
  type SongLayout,
  type TrackLayout,
  WALL_HINGE,
} from '../layout'
import { type ColoredRect, lineSegments, rectangles } from '../shapes'
import type { TextBlock } from '../text'
import { LinkLines, linkStart, slideFor } from './linkLines'
import { BAR_HEIGHT, BAR_INSET, type CarriedPanel, PanelCards, type PanelFace } from './panelCards'
import { type ButtonState, type HeaderButtonKind, TrackHeader } from './trackHeader'
import { TrackTextBuilder } from './trackText'

const PHRASE_HEIGHT = ROWS_PER_PHRASE * ROW_H
const SHADE_OPACITY = 0.9

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

/** What a track's view hands over to the view that replaces it after an edit: its header, and its panels' texts and faces by table. */
export interface CarriedParts {
  header: TrackHeader
  panels: Map<number, CarriedPanel>
}

/** What a material's opacity follows: the front, the step details, the panels, or the links (between the step details and the panels). */
type FadeKind = 'front' | 'side' | 'panels' | 'links'

/** A material whose opacity follows a fade. */
interface FadingMaterial {
  material: { opacity: number }
  base    : number
  kind    : FadeKind
}

export class TrackView {
  readonly group  = new Group()
  readonly front  = new Group()
  /** The wall, hinged on the right edge of the front column and turned `wallAngle` from it. */
  readonly wall   = new Group()
  /** The step details of the wall (velocity, instrument, FX): they fold apart from the panels. */
  readonly side   = new Group()
  readonly header : TrackHeader
  readonly blocks : TextBlock[] = []
  /** The instrument and table panels on the wall. */
  readonly cards  : PanelCards
  /** How unfolded the step details and the panels are (0..1). */
  sideAlpha       = 0
  panelsAlpha     = 0
  /** How far the wall slid back along itself to bring the panels to the hinge (while the step details are folded). */
  slide           = 0
  frontAlpha      = 1
  /** Highest y a visible panel is shown at while gliding: just under the stuck header. */
  panelCeiling    = Number.POSITIVE_INFINITY
  /** Called when a text finished laying out (to redraw). */
  onTextReady     : () => void = () => {}
  /** The face each panel should show (the world decides: the M8 view, a turn by hand). */
  faceGoal        : (panel: Panel) => PanelFace = () => 'table'
  /** What the view was drawn from (see SongLayout.trackSignature). */
  signature       = ''

  private text                    : TrackTextBuilder
  private readonly links          : LinkLines
  private readonly frontMaterials : FadingMaterial[] = []
  private readonly wallMaterials  : FadingMaterial[] = []
  private frontBars!              : InstancedMesh
  private wallBars!               : InstancedMesh
  private barsAlpha               = 0
  /** How far the wall is turned from the front (radians). */
  private wallAngle               : number
  /** The floor line under the panels, one unit long, stretched to the wall's length. */
  private readonly panelsFloor    : LineSegments
  /** The header went to the view that replaced this one. */
  private headerHandedOver        = false

  /** `carried`: what the view this one replaces handed over (see handOver). */
  constructor(
    public layout: SongLayout,
    public track: TrackLayout,
    readonly palette: Palette,
    private readonly playedNotes = true,
    wallAngle = DEFAULT_WALL_ANGLE,
    carried: CarriedParts | null = null,
  ) {
    this.text      = new TrackTextBuilder(layout, palette, playedNotes)
    this.wallAngle = wallAngle
    this.group.add(this.front, this.wall)
    this.wall.add(this.side)
    this.placeWall()

    this.buildPhrases()
    this.cards = new PanelCards(layout, track, palette, this.wall, this.text, {
      faceGoal   : (panel) => this.faceGoal(panel),
      onTextReady: () => this.onTextReady()
    }, carried?.panels ?? null)

    // Links are drawn near the view only, fading with their panel and toward the edges (updateLinks).
    this.links = new LinkLines(layout, track, palette)
    this.wall.add(this.fadesWith(this.links.lines, 'links'))

    const headerY           = layout.headerRestY
    this.header             = carried?.header ?? new TrackHeader(palette, track.track, headerY, track.wallLen)
    this.header.onTextReady = () => this.onTextReady()
    this.header.setColumns(track.wanted, track.cols)
    this.front.add(this.header.front)
    this.wall.add(this.header.wall)
    // A faint floor line along the hinge shows where each part of the wall is when nothing is on it.
    this.wall.add(this.fadesWith(lineSegments([0, headerY, 0, PANEL_U0 - 0.35, headerY, 0], palette.rule, 0.8), 'side'))
    this.panelsFloor            = this.fadesWith(lineSegments([0, headerY, 0, 1, headerY, 0], palette.rule, 0.8), 'panels')
    this.panelsFloor.position.x = PANEL_U0 - 0.35
    this.wall.add(this.panelsFloor)
    this.setWallLength(track.wallLen)
  }

  /** Draws the wall `length` long: the header and the floor line of its panels (it eases to a new length when its columns change). */
  setWallLength(length: number): void {
    this.header.setWallLength(length)
    this.panelsFloor.scale.x = Math.max(0.01, length - (PANEL_U0 - 0.35))
  }

  /** The wall's columns changed (see SongLayout.setColumnLimit): the header's `+` / `-` follows. */
  refreshColumns(): void {
    this.header.setColumns(this.track.wanted, this.track.cols)
  }

  /** Something of the wall shows: its step details or its panels. */
  get wallAlpha(): number {
    return Math.max(this.sideAlpha, this.panelsAlpha)
  }

  /** The wall's place: hinged on the front's right edge, turned `wallAngle`, and slid back along itself by `slide`. */
  private placeWall(): void {
    this.wall.position.set(WALL_HINGE - this.slide * Math.cos(this.wallAngle), 0, this.slide * Math.sin(this.wallAngle))
    this.wall.rotation.y = this.wallAngle
  }

  /** Turns the wall `angle` radians from the front. */
  setWallAngle(angle: number): void {
    this.wallAngle = angle
    this.placeWall()
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
        parent: this.side,
        x     : SIDE_U0,
        layer : 'wall',
        build : () => this.text.sideText(this.layout.model.phrases[instance.phrase]?.steps)
      })
    })

    this.front.add(this.fadesWith(rectangles(frontShades, SHADE_OPACITY), 'front'))
    this.front.add(this.fadesWith(lineSegments(tree, palette.bracket, SHADE_OPACITY), 'front'))
    this.side.add(this.fadesWith(rectangles(wallShades, SHADE_OPACITY), 'side'))
    this.frontBars = rectangles(noteBars, 0)
    this.wallBars  = rectangles(fxBars, 0)
    this.front.add(this.frontBars)
    this.side.add(this.fadesWith(this.wallBars, 'side'))
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

  /** Registers an object's material so its opacity follows a fade. */
  private fadesWith<T extends LineSegments | InstancedMesh>(object: T, kind: FadeKind): T {
    const material = object.material as LineBasicMaterial
    ;(kind === 'front' ? this.frontMaterials : this.wallMaterials).push({
      material,
      base: material.opacity,
      kind
    })
    return object
  }

  /** Start (step cell) and end (panel title) of a link, in wall coordinates. */
  linkEnds(row: number, col: number, panelY: number, panelU: number, fx: number): [Vector3, Vector3] {
    const y        = this.layout.rowY(row) - ROW_H / 2
    const [u, out] = linkStart(col, fx, slideFor(fx), this.wallAngle)
    return [new Vector3(u, y, out + 0.05), new Vector3(panelU - 0.5, panelY - ROW_H * 0.5, 0.05)]
  }

  // ---------------------------------------------------------------------------
  // Fades

  /** Sets how unfolded the step details and the panels are (0..1) and how far the wall slid back (see PANELS_SLIDE). */
  setFolds(side: number, panels: number, slide: number): void {
    this.sideAlpha    = side
    this.panelsAlpha  = panels
    this.wall.visible = this.wallAlpha > 0.01
    this.side.visible = side > 0.01
    if (slide !== this.slide) {
      this.slide = slide
      this.placeWall()
    }
    const alphas: Record<FadeKind, number> = {
      front: this.frontAlpha,
      side,
      panels,
      links: panels
    }
    for (const { material, base, kind } of this.wallMaterials) material.opacity = base * alphas[kind]
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
    ;(this.wallBars.material as MeshBasicMaterial).opacity  = this.barsAlpha * this.sideAlpha
    this.cards.fadeBars(this.barsAlpha, this.panelsAlpha)
    this.header?.setFade(this.frontAlpha, this.sideAlpha, this.panelsAlpha)
  }

  // ---------------------------------------------------------------------------
  // Header

  /** Moves the sticky header to `y` (never above the song start). Returns true when it moved. */
  setHeaderY(y: number): boolean {
    return this.header.moveTo(y)
  }

  /** Height of the header's bottom edge (front coordinates). */
  get headerBottom(): number {
    return this.header.bottom
  }

  setTrackModes(muted: boolean, soloed: boolean): void {
    this.header.setTrackModes(muted, soloed)
  }

  /** Lights the fold buttons of the header. */
  setFoldButtons(fx: ButtonState, panels: ButtonState): void {
    this.header.setFolds(fx, panels)
  }

  buttonAt(x: number, y: number): HeaderButtonKind | null {
    return this.header.buttonAt(x, y)
  }

  /** True when height y (front or wall coordinates) is under the header. */
  inHeader(y: number): boolean {
    return this.header.covers(y)
  }

  // ---------------------------------------------------------------------------
  // Panels and links

  /** Eases the panel cards (see PanelCards.update); returns true while anything is still moving. */
  updatePanels(dt: number, textOn: boolean): boolean {
    return this.cards.update(dt, textOn, {
      panelsAlpha : this.panelsAlpha,
      barsAlpha   : this.barsAlpha,
      wallAngle   : this.wallAngle,
      panelCeiling: this.panelCeiling
    })
  }

  /** Redraws the thin links for the view [yBottom, yTop]; returns true when redrawn. */
  updateLinks(yTop: number, yBottom: number): boolean {
    return this.links.update(yTop, yBottom, this.sideAlpha, this.slide, this.wallAngle)
  }

  // ---------------------------------------------------------------------------
  // Edits

  /**
   * Draws the same track from a new layout of the song (after an edit that did not change it,
   * see SongLayout.trackSignature): its panels are the new layout's, nothing is built again.
   */
  relink(layout: SongLayout, track: TrackLayout): void {
    this.layout = layout
    this.track  = track
    this.text   = new TrackTextBuilder(layout, this.palette, this.playedNotes)
    this.cards.relink(layout, track, this.text)
    this.links.relink(layout, track)
  }

  /**
   * Gives up what a new view of the track (after an edit) takes over, so it does not lay its text
   * out again: the header, and each panel's texts and instrument face. Dispose this view after.
   */
  handOver(): CarriedParts {
    const panels          = this.cards.handOver()
    this.headerHandedOver = true
    return {
      header: this.header,
      panels
    }
  }

  dispose(): void {
    this.cards.dispose()
    if (!this.headerHandedOver) this.header.dispose()
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

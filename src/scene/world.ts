// The 3D view: builds a TrackView per track, frames the camera, unfolds the walls of the tracks
// the user opened (their step details and their panels, each apart), keeps text alive near the
// camera, and turns pointer input into selections. Picking, pointer input, markers and
// playheads live in their own modules.

import {
  Box3,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Fog,
  Group,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  type Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import type { TrackToggle } from '../m8/midiControl'
import type { TrackPlayhead } from '../m8/playback'
import type { ScreenEdit } from '../m8/screen/liveScreen'
import { PHRASE_COLUMNS, TABLE_COLUMNS } from '../model/columns'
import { hex2 } from '../model/hex'
import { TablePlayback } from '../model/music/tablePlayback'
import { isPanelSelection, isWallCell, type PanelSelection, type Selection, sameSelection, selectionTrack } from '../model/selection'
import { ROWS_PER_PHRASE, ROWS_PER_TABLE, type SongModel, TRACKS } from '../model/song'
import { phraseMoved, trackMoved } from '../model/stepMoves'
import type { PhraseInstance } from '../model/timeline'
import { FACING_FRONT_YAW, presetAngles, type TurnPreset, type ViewPreset } from './camera/cameraAngles'
import {
  type Align,
  cutAnchor,
  fitDistance,
  fitsAcross,
  holdOnScreen,
  type Lens,
  type Margins,
  rayMeets,
  rayThrough,
  screenPoint,
  screenX,
  shiftTarget,
  showAtHeight,
  sideShift,
  trackSlide,
} from './camera/framing'
import { CameraRig, placeCamera, type RigPose } from './camera/rig'
import { type SceneButton, ScenePicker } from './input/picker'
import { bindPointerControls, PAN_MIN_COS, type PointerTarget } from './input/pointerControls'
import { isTitlePlace, placeOf } from './instrumentFace'
import {
  BAND_GAP,
  DEFAULT_PANEL_COLS,
  DEFAULT_WALL_DEGREES,
  FRONT_W,
  HEADER_H,
  type Link,
  MAX_PANEL_COLS,
  PANEL_COL_W,
  PANEL_U0,
  PANELS_SLIDE,
  type Panel,
  panelU,
  ROW_H,
  SIDE_END,
  SongLayout,
  TRACK_GAP,
  TRACK_PITCH,
  type TrackLayout,
  WALL_HINGE,
} from './layout'
import { CellMarker, type CellRect } from './markers/cellMarker'
import { cellRects } from './markers/cellRects'
import { PlayheadView, type ViewEdges } from './markers/playheadView'
import { TablePlayheadView } from './markers/tablePlayheadView'
import type { Palette } from './palette'
import { easeFactor, linkCurve, smoothstep } from './shapes'
import { RichText, type TextBlock, TextPool } from './text'
import { FACE_WIDTH } from './track/instrumentFaceView'
import { type ButtonState, type FoldSection, HEADER_BOTTOM, HEADER_TOP } from './track/trackHeader'
import {
  type CarriedParts,
  FACE_PAD_LEFT,
  FACE_PAD_TOP,
  flipPose,
  PANEL_TAB_ROOM,
  type PanelFace,
  TrackView,
  WALL_STEPS_U,
  WALL_STEPS_W,
} from './track/trackView'

export type { ViewPreset } from './camera/cameraAngles'

/**
 * Room between the end of what a track unfolds (its step details, its wall of panels, or a panel
 * turned out of it) and the next track's column, along x: the same for every track, whatever it
 * unfolds and however deep its wall goes.
 */
const OPEN_GAP            = 4
/** Turned between these yaws, the view may reach a little further past the last track. */
const TURN_YAWS           = [MathUtils.degToRad(5), MathUtils.degToRad(24)] as const
/** Turned further than this, the track in the middle of the view guides the headers' height. */
const TURNED_YAW          = MathUtils.degToRad(15)
/** While a wall is unfolded, the tracks that are not leave between these yaws (looking along the wall). */
const OTHERS_LEAVE_YAWS   = [MathUtils.degToRad(34), MathUtils.degToRad(54)] as const
/** Text below this many pixels per row is not drawn; bars show instead. */
const MIN_TEXT_PX_PER_ROW = 5
const WALL_EASE_RATE      = 7
/** Frame intervals (ms): while playing (50 fps), other animation (~40 fps), the device marker pulse. */
const PLAYING_FRAME_MS    = 20
const MOVING_FRAME_MS     = 24
const PULSE_FRAME_MS      = 66
/** Full frame rate for this long after the user touches the view. */
const INTERACTION_MS      = 400
const MAX_DEVICE_MARKERS  = 64
const BAND_RULE_OPACITY   = 0.9
/** Room an automatic framing keeps free at each side of the screen (a fraction of the half width). */
const FRAME_MARGINS       = {
  left : 0.04,
  right: 0.04
}
/** An automatic framing stands back far enough for this many rows, and not so far that rows get shorter than this (pixels). */
const FRAME_MIN_ROWS      = 50
const FRAME_MIN_ROW_PX    = 12
/** What a pan by hand holds counts as no nearer or further than these multiples of the target's distance. */
const GRAB_DEPTH_LIMITS   = [0.3, 3] as const
/** Where a cell lands after the view scrolls to it, as a fraction of the visible stretch from the edge opposite to where it left (so a scroll is about 4/5 of a page). */
const SCROLL_LAND         = 0.2
/** Following the M8: a cell lands this many rows under the headers, and the view scrolls when fewer rows than LOOKAHEAD_ROWS are left under it. */
const LAND_TOP_ROWS       = 2
const LOOKAHEAD_ROWS      = 4
/** Screen height (normalized device y) under which rows count as out of view: just over the footer line. */
const VIEW_BOTTOM_NDC     = -0.92
/** Pixels between the HUD and the headers' top edge. */
const HEADER_GAP_PX       = 8
/** The headers never show lower on the screen than this (normalized height, -1 bottom to 1 top: a third of the way down). */
const HEADER_LOWEST_NDC   = 1 / 3
/** Pixels an automatic framing keeps between what it shows and a panel of the HUD over the view. */
const COVER_GAP_PX        = 12
/** An automatic framing keeps clear of the HUD's panels while that leaves it this much of the width (a fraction). */
const MIN_FREE_WIDTH      = 0.4
/** Following playback, the playhead shows at this screen height on its track (normalized, -1 bottom to 1 top: a third of the way down), whatever the angle. */
const PLAYHEAD_NDC_Y      = 0.35
/** Pixels above the bottom of the view where the halo of a playhead below it sits: just over the footer line. */
const HALO_BOTTOM_PX      = 26
/** Ease rate per second of the headers' glide to their height (the pose eases at 9). */
const HEADER_GLIDE_RATE   = 15.5

/** A part of the view a panel of the HUD covers, in pixels from the view's top-left corner. */
export interface CoveredArea {
  left  : number
  top   : number
  width : number
  height: number
}

/**
 * What a navigation shows (world points, where things settle): `box` whole when it fits on the
 * screen, else `core` (a panel's card) when there is one and it fits, else `cell` first.
 */
interface Focus {
  box  : Vector3[]
  core?: Vector3[]
  cell : Vector3[]
}

/**
 * Where a navigation to another track left from, taken before anything folded: the track, where
 * its column settled then, and the goal's x. The view pans by the distance between the two
 * tracks, so the new one shows where the old one was.
 */
interface Departure {
  to   : Selection
  track: number
  x    : number
  goalX: number
}

/** How the camera moves when a selection is made. */
export interface SelectOptions {
  /** Not reported through onSelect (and the followed M8 cursor keeps the focus). */
  silent? : boolean
  /** Moves the camera close to it. */
  focus?  : boolean
  /** Scrolls just enough for it to be on screen (default on). */
  reveal? : boolean
  /** Turns toward the wall for wall cells, back for front cells. */
  turn?   : boolean
  /** With `turn`: scrolls the cell just under the headers (the M8 cursor), rather than keeping the view where it is. */
  landTop?: boolean
}

export class World implements PointerTarget {
  readonly renderer            : WebGLRenderer
  readonly scene               = new Scene()
  readonly camera              = new PerspectiveCamera(34, 1, 0.5, 4000)
  readonly rig                 = new CameraRig()
  /** A camera put on other poses, to find where things would show. */
  private readonly probeCamera = new PerspectiveCamera()
  private readonly probePoint  = new Vector3()
  /** Pixels at the top of the view that the HUD covers. */
  private topInset             = 90
  /** Parts of the view the HUD's selection panel covers: automatic framings keep clear of them. */
  private covered              : CoveredArea[] = []
  /** Measures them now (the panel may just have changed its content), when given; else `covered` is used. */
  coverage                     : (() => CoveredArea[]) | null = null
  /** Where the headers' top stands above the view's centre now (gliding to where it belongs); null before the first frame. */
  private headerOffset         : number | null = null
  readonly pool                = new TextPool()
  layout                       : SongLayout | null = null
  palette                      : Palette
  onSelect                     : (selection: Selection | null) => void = () => {}
  onHover                      : (selection: Selection | null) => void = () => {}
  /** A track's mute or solo button was clicked. */
  onTrackButton                : (track: number, kind: TrackToggle) => void = () => {}
  /** A track unfolded or folded a part of its wall. */
  onFolds                      : () => void = () => {}
  /** Scroll with the playhead of the focused track while the song plays. */
  followPlayback               = false

  private readonly root                 = new Group()
  private readonly spine                = new Group()
  private readonly picker               : ScenePicker
  private readonly playheads            = new PlayheadView()
  private readonly tablePlayheads       = new TablePlayheadView()
  private tablePlayback                 : TablePlayback | null = null
  private trackViews                    : TrackView[] = []
  private trackModes                    = {
    muted : [] as boolean[],
    soloed: [] as boolean[]
  }
  /** Which parts of each track's wall its header buttons unfolded: they stay unfolded until the button folds them. */
  private folds                         : Record<FoldSection, boolean>[] = Array.from({ length: TRACKS }, () => ({
    fx    : false,
    panels: false
  }))
  /**
   * Parts unfolded by a navigation (the selection, or the followed M8 cursor, going to a cell on
   * them) and not by their button: they fold again once a navigation leaves the track.
   */
  private autoFolds                     : Record<FoldSection, boolean>[] = Array.from({ length: TRACKS }, () => ({
    fx    : false,
    panels: false
  }))
  /** How unfolded each part of each track's wall is (0..1), easing toward `folds`. */
  private unfolding                     : Record<FoldSection, number>[] = Array.from({ length: TRACKS }, () => ({
    fx    : 0,
    panels: 0
  }))
  /** How long each track's wall is drawn, easing toward its layout's length when its columns change. */
  private shownWallLen                  : number[] = []
  /** How far the wall is turned from the front (radians). */
  private wallAngle                     = MathUtils.degToRad(DEFAULT_WALL_DEGREES)
  /** Track the view is centred on and guided by when nothing is selected: the one in the middle of the view. */
  private focusedTrack                  = 0
  /** Track pressed by hand (a turn started on it); wins until the next selection, pan or cursor move. */
  private handTrack                     : number | null = null
  /** The turn by hand under way: the target and the yaw it started from, and where the centre of the track turned around was then. */
  private turning                       : { base: Vector3; pivot: Vector3; yaw: number } | null = null
  /** Track the M8 cursor is on while following it; wins over the selection. */
  private followedTrack                 : number | null = null
  /** The device place last followed: the same place again (a screen refresh) changes nothing, so a click wins until the cursor moves. */
  private followedSelection             : Selection | null = null
  /** A navigation to another track under way (see Departure), until the view goes to its place. */
  private departure                     : Departure | null = null
  /** Where each track's column settled at the start of this frame (see noteSettledColumns). */
  private readonly settledColumns       : number[] = []
  private selection                     : Selection | null = null
  private hovered                       : Selection | null = null
  private devicePlaces                  : Selection[] = []
  private readonly selectionMarkers     = [new CellMarker(), new CellMarker(), new CellMarker()]
  private readonly hoverMarker          = new CellMarker()
  private readonly deviceMarkers        : CellMarker[] = []
  private playheadSource                : (() => (TrackPlayhead | null)[]) | null = null
  /** Every cut to front, turn or side (by hand or by following) takes a skewed, tilted angle. */
  private dramatic                      = false
  /** Transposed phrases show the notes they play (else the notes written, as on the M8). */
  private playedNotes                   = true
  private trimTables                    = true
  /** Columns each track's wall may have, as its header button set them (see SongLayout). */
  private readonly panelColumns         : number[] = []
  /** Cuts taken so far: dramatic takes alternate low / high. */
  private cuts                          = 0
  /** The preset the view was last set to, until it is turned by hand. */
  private preset                        : ViewPreset | null = null
  /** The selection's links, drawn thick. */
  private selectedLinks                 : LineSegments2 | null = null
  private readonly selectedLinkMaterial = new LineMaterial({
    linewidth  : 2.2,
    transparent: true,
    depthWrite : false
  })
  /** The links of a selected phrase, all of them, faint. */
  private readonly faintLinkMaterial    = new LineMaterial({
    linewidth  : 1.2,
    opacity    : 0.5,
    transparent: true,
    depthWrite : false
  })
  private bandRules                     : LineSegments | null = null
  /** The instrument the M8 shows (Instrument or Inst. Mods view): its panels turn to their instrument face. */
  private deviceInstrument              : number | null = null
  /** Panels turned by hand ('track:table'), until the M8 moves to another instrument or leaves it. */
  private readonly facesByHand          = new Map<string, PanelFace>()
  private dirty                         = true
  private renderedAt                    = 0
  private interactedAt                  = 0
  private lastTickAt                    = performance.now()
  private animationFrame                = 0

  constructor(
    readonly container: HTMLElement,
    palette: Palette,
  ) {
    this.palette  = palette
    this.renderer = new WebGLRenderer({
      antialias      : true,
      alpha          : false,
      powerPreference: 'high-performance'
    })
    // 1.5x is sharp enough for SDF text and much lighter than 2x next to yam8d's own WebGL.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.domElement.className = 'world'
    container.appendChild(this.renderer.domElement)
    this.picker = new ScenePicker(this.camera, this.renderer.domElement)
    this.scene.add(this.root, this.spine)
    this.scene.fog    = new Fog(0x000000, 100, 400)
    this.pool.onReady = () => this.invalidate()
    this.applyPalette()
    new ResizeObserver(() => this.resize()).observe(container)
    this.resize()
    bindPointerControls(this.renderer.domElement, this)
    const loop = () => {
      this.animationFrame = requestAnimationFrame(loop)
      this.tick()
    }
    loop()
  }

  invalidate(): void {
    this.dirty = true
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame)
    this.pool.clear()
    for (const view of this.trackViews) view.dispose()
    this.renderer.dispose()
  }

  // ---------------------------------------------------------------------------
  // Content

  setModel(model: SongModel, keepView = false): void {
    const previous     = this.layout
    const hadLayout    = previous != null
    this.layout        = new SongLayout(model, this.trimTables, this.panelColumns)
    this.tablePlayback = new TablePlayback(model, this.layout.timeline, this.layout.effective)
    if (previous) {
      for (const track of this.layout.tracks) {
        for (const panel of track.panels) panel.flip = previous.tracks[track.track]?.panels.find((p) => p.table === panel.table)?.flip ?? 0
      }
    }
    this.rebuild()
    if (!keepView || !hadLayout) this.view('overview', true)
    // Keep the selection when its place still exists.
    if (this.selection) this.select(this.resolve(this.selection), { silent: true })
  }

  setPalette(palette: Palette): void {
    this.palette = palette
    this.applyPalette()
    this.rebuild()
  }

  /** Tables show only their rows down to the last with content (an empty one its title lines), or all 16. */
  setTrimTables(on: boolean): void {
    if (on === this.trimTables) return
    this.trimTables = on
    if (this.layout) this.layout.trimTables = on
    this.invalidate()
  }

  /** Switches the NOTE column of transposed phrases between the notes played and the notes written. */
  setPlayedNotes(on: boolean): void {
    if (on === this.playedNotes) return
    this.playedNotes = on
    this.rebuild()
  }

  private applyPalette(): void {
    const background              = new Color(this.palette.background)
    this.scene.background         = background
    ;(this.scene.fog as Fog).color = background
    this.selectedLinkMaterial.color.set(this.palette.hot)
    this.faintLinkMaterial.color.set(this.palette.hot)
    this.invalidate()
  }

  private rebuild(): void {
    for (const view of this.trackViews) {
      view.dispose()
      this.root.remove(view.group)
    }
    this.spine.clear()
    if (this.bandRules) this.scene.remove(this.bandRules)
    this.trackViews = []
    const layout    = this.layout
    if (!layout) {
      this.pool.setBlocks([])
      return
    }
    const blocks: TextBlock[] = []
    for (const track of layout.tracks) {
      const view                     = this.makeTrackView(layout, track)
      this.shownWallLen[track.track] = track.wallLen
      view.group.position.x          = this.settledX(track.track)
      this.trackViews.push(view)
      blocks.push(...view.blocks)
    }
    blocks.push(...this.buildSpine(layout))
    this.pool.setBlocks(blocks)
    this.setBounds(layout)
    this.removeSelectedLinks()
    this.refreshMarkers()
    this.invalidate()
  }

  /** A track's view, wired to the world (with `carried`, it takes over what the view it replaces handed over). */
  private makeTrackView(layout: SongLayout, track: TrackLayout, carried: CarriedParts | null = null): TrackView {
    const view       = new TrackView(layout, track, this.palette, this.playedNotes, this.wallAngle, carried)
    view.signature   = layout.trackSignature(track.track)
    view.onTextReady = () => this.invalidate()
    view.faceGoal    = (panel) => this.faceGoal(panel)
    view.setTrackModes(!!this.trackModes.muted[track.track], !!this.trackModes.soloed[track.track])
    view.setFoldButtons(this.foldState(track.track, 'fx'), this.foldState(track.track, 'panels'))
    this.root.add(view.group)
    return view
  }

  private setBounds(layout: SongLayout): void {
    this.rig.bounds = {
      minX: -10,
      maxX: this.songEnd() + 10,
      minY: layout.bottomY,
      maxY: layout.rowY(0) + HEADER_H
    }
  }

  /**
   * The same song after an edit made on the M8 (the model changed in place): only what changed is
   * drawn again. A track whose content is the same keeps its view; another gets a new view that
   * takes over the old one's header, panel texts and faces. Panels keep their place, fade and
   * turn; texts that show the same stay, changed ones swap in once laid out; the camera stays.
   */
  updateModel(model: SongModel): void {
    const previous = this.layout
    if (!previous || this.trackViews.length !== TRACKS) {
      this.setModel(model, true)
      return
    }
    const layout       = new SongLayout(model, this.trimTables, this.panelColumns)
    layout.adoptState(previous)
    this.layout        = layout
    this.tablePlayback = new TablePlayback(model, layout.timeline, layout.effective)
    const replaced     : TrackView[] = []
    this.trackViews    = this.trackViews.map((old, track) => {
      const lanes = layout.tracks[track]
      if (layout.trackSignature(track) === old.signature) {
        old.relink(layout, lanes)
        return old
      }
      const view            = this.makeTrackView(layout, lanes, old.handOver())
      view.group.position.x = old.group.position.x
      view.setWallLength(this.shownWallLen[track] ?? lanes.wallLen)
      // Unfolded as far as the old one: its panels are drawn before the walls ease, in the next frame.
      view.setFolds(old.sideAlpha, old.panelsAlpha, old.slide)
      view.setFrontAlpha(old.frontAlpha)
      replaced.push(old)
      return view
    })
    this.spine.clear()
    if (this.bandRules) {
      this.scene.remove(this.bandRules)
      this.bandRules.geometry.dispose()
    }
    const blocks       = [...this.trackViews.flatMap((view) => view.blocks), ...this.buildSpine(layout)]
    this.pool.setBlocks(blocks, true)
    this.setBounds(layout)
    // The places marked are the same places in the new layout.
    this.followedSelection = this.followedSelection && this.resolve(this.followedSelection)
    this.hovered           = this.hovered && this.resolve(this.hovered)
    this.devicePlaces      = this.devicePlaces.flatMap((place) => this.resolve(place) ?? [])
    this.removeSelectedLinks()
    this.select(this.selection && this.resolve(this.selection), {
      silent: true,
      reveal: false
    })
    for (const old of replaced) {
      this.root.remove(old.group)
      old.dispose()
    }
    this.invalidate()
  }

  /**
   * An item edited on the M8 shows its new values at once (the model holds them already): a
   * phrase's notes and step details, a table's panels, an instrument's panels and faces. Bars,
   * links and panels that come or go follow with updateModel. An edit that moves things (a song
   * cell, a chain's phrases) or changes many (the project, a scale, a groove) goes to it at once:
   * true then (the whole scene is up to date).
   */
  showEdit(edit: ScreenEdit): boolean {
    const layout = this.layout
    if (!layout) return false
    let whole = false
    if (edit.kind === 'phrase' && edit.id != null) {
      const keys = new Set((layout.timeline.byPhrase.get(edit.id) ?? []).flatMap((instance) => [`f:${instance.key}`, `w:${instance.key}`]))
      this.pool.refresh((block) => keys.has(block.key))
    } else if (edit.kind === 'table' && edit.id != null) {
      for (const view of this.trackViews) view.refreshTable(edit.id)
    } else if ((edit.kind === 'inst' || edit.kind === 'instmods') && edit.id != null) {
      layout.forgetFace(edit.id)
      for (const view of this.trackViews) view.refreshInstrument(edit.id)
    } else {
      this.updateModel(layout.model)
      whole = true
    }
    this.invalidate()
    return whole
  }

  /**
   * Song row numbers down the left edge, a rule between song rows across the tracks, and the song
   * title. The rules are one unit long: updateWalls stretches them to the end of the last track.
   */
  private buildSpine(layout: SongLayout): TextBlock[] {
    const blocks : TextBlock[] = []
    const rules  : number[] = []
    const spineX = -3.4
    layout.timeline.bands.forEach((band, b) => {
      const top   = layout.bandTop[b]
      const empty = band.chains.every((chain) => chain == null)
      blocks.push({
        key   : `s:${band.songRow}`,
        parent: this.spine,
        x     : spineX,
        y     : top,
        height: ROW_H,
        layer : 'static',
        track : -1,
        build : () => new RichText().add(hex2(band.songRow), empty ? this.palette.empty : this.palette.label)
      })
      const ruleY = top + BAND_GAP / 2
      rules.push(0, ruleY, -0.2, 1, ruleY, -0.2)
    })
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(rules, 3))
    this.bandRules               = new LineSegments(geometry, new LineBasicMaterial({
      color      : this.palette.rule,
      transparent: true,
      opacity    : BAND_RULE_OPACITY
    }))
    this.bandRules.frustumCulled = false
    this.scene.add(this.bandRules)
    blocks.push({
      key   : 'title',
      parent: this.spine,
      x     : spineX,
      y     : this.titleY(layout),
      height: ROW_H * 2,
      layer : 'static',
      track : -1,
      scale : 1.6,
      build : () => new RichText().add((layout.model.name ?? 'UNTITLED SONG').toUpperCase(), this.palette.title)
    })
    return blocks
  }

  private titleY(layout: SongLayout): number {
    return layout.rowY(0) + HEADER_H + ROW_H * 1.5
  }

  // ---------------------------------------------------------------------------
  // Camera

  private visibleHalfHeight(distance = this.rig.current.distance): number {
    return distance * Math.tan(MathUtils.degToRad(this.camera.fov) / 2)
  }

  unitsPerPixel(): number {
    return (2 * this.visibleHalfHeight(this.rig.goal.distance)) / this.renderer.domElement.clientHeight
  }

  /** The distance at which a width x height rectangle facing the camera fills the view. */
  private distanceToFit(width: number, height: number): number {
    const verticalFov   = MathUtils.degToRad(this.camera.fov)
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect)
    return Math.max(width / 2 / Math.tan(horizontalFov / 2), height / 2 / Math.tan(verticalFov / 2))
  }

  /** Width of the whole song as it stands once the walls settle, with a little room at its right. */
  private songWidth(): number {
    return this.songEnd() + 6
  }

  private overviewDistance(): number {
    return this.distanceToFit(this.songWidth() * 1.04, 40)
  }

  /** Left edge of a track's front column as drawn now (the walls may still be moving). */
  private frontX(track: number): number {
    return this.trackViews[track]?.group.position.x ?? track * TRACK_PITCH
  }

  /** Left edge of a track's front column once the walls settle. */
  private settledX(track: number): number {
    let x = 0
    for (let t = 0; t < track; t += 1) x += TRACK_PITCH + this.settledWidth(t)
    return x
  }

  /** Right edge of the last track's front column once the walls settle: where its open parts end is songEnd. */
  private songEnd(): number {
    const last = TRACKS - 1
    return this.settledX(last) + FRONT_W + this.settledWidth(last)
  }

  /** Extra room a track takes to the right of its column once its walls settle. */
  private settledWidth(track: number): number {
    const fold = this.opened(track)
    return this.openWidth(track, fold.fx ? 1 : 0, fold.panels ? 1 : 0, this.trackViews[track]?.faceAmount(true) ?? 0)
  }

  /**
   * Extra room a track takes to the right of its column for how far its step details (`fx`) and
   * its panels (`panels`) are unfolded (0..1): how far they reach along x at the wall's angle, the
   * panels turned out of the wall past its end (`face`: how far, 0..1), and OPEN_GAP to the next
   * column instead of TRACK_GAP; for a wall `wallLen` long (the layout's, or as drawn while it
   * eases to it). A fold's width follows the content and the angle, not the camera, so tracks
   * never slide as the view turns.
   */
  private openWidth(track: number, fx: number, panels: number, face: number, wallLen = this.layout?.tracks[track]?.wallLen ?? 0): number {
    const lanes = this.layout?.tracks[track]
    if (!lanes) return 0
    const reach = this.wallReach(fx, panels, wallLen)
    const open  = 1 - (1 - fx) * (1 - panels)
    const room  = OPEN_GAP + WALL_HINGE - FRONT_W - TRACK_GAP
    return reach * Math.cos(this.wallAngle) + this.turnedOvershoot(track, wallLen) * panels * face + open * room
  }

  /**
   * How far along the wall (from its hinge) its unfolded parts reach, for how far the step
   * details and the panels are unfolded: the details alone end at SIDE_END; the panels alone
   * start at the hinge (the wall slides back by PANELS_SLIDE); both reach the wall's end.
   */
  private wallReach(fx: number, panels: number, wallLen: number): number {
    const panelsAlone = wallLen - PANELS_SLIDE
    return fx * SIDE_END + panels * panelsAlone + fx * panels * (PANELS_SLIDE - SIDE_END)
  }

  /** How far the wall slid back along itself for how unfolded the step details are. */
  private wallSlide(fx: number): number {
    return (1 - fx) * PANELS_SLIDE
  }

  /**
   * How far past the wall's end (along x) an instrument face turned out of it reaches in the
   * worst case: at the last column that can hold one, where it stands face on to the front.
   */
  private turnedOvershoot(track: number, wallLen: number): number {
    const lanes = this.layout?.tracks[track]
    if (!lanes?.hasFaces) return 0
    const cos = Math.cos(this.wallAngle)
    return Math.max(0, panelU(Math.max(0, lanes.cols - 2)) * cos + FACE_WIDTH - wallLen * cos)
  }

  view(preset: ViewPreset, immediate = false): void {
    const goal   = this.rig.goal
    const layout = this.layout
    // Nothing chosen: the track in the middle of the view is the one the view centres on.
    if (preset !== 'overview' && this.handTrack == null && this.followedTrack == null && !this.selection) {
      this.focusedTrack = this.trackUnder(0) ?? this.focusedTrack
    }
    if (preset === 'overview') {
      const width   = this.songWidth()
      goal.yaw      = 0
      goal.pitch    = 0
      goal.roll     = 0
      goal.distance = this.overviewDistance()
      // Leave the title clear of the top bar.
      const titleY  = layout ? this.titleY(layout) : HEADER_H + ROW_H * 1.5
      goal.target.set(width / 2 - 4, titleY - this.visibleHalfHeight(goal.distance) * 0.6, 0)
    } else {
      this.aim(preset)
    }
    this.preset = preset
    if (preset === 'angle' || preset === 'side') goal.target.copy(this.trackCentre(goal, this.focusTrack(), this.isUnfolded(this.focusTrack()), true))
    else if (preset === 'front') this.frameFront()
    if (immediate) this.rig.jump()
    this.invalidate()
  }

  /** Turns the goal to a preset's angles (a new dramatic take each cut). */
  private aim(preset: TurnPreset): void {
    if (this.dramatic) this.cuts += 1
    Object.assign(this.rig.goal, presetAngles(preset, this.dramatic, this.cuts, MathUtils.radToDeg(this.wallAngle)))
  }

  /** Switches dramatic angles; the current preset is taken again the new way. */
  setDramatic(on: boolean): void {
    this.dramatic = on
    if (this.preset) this.view(this.preset)
    else if (!on) this.rig.goal.roll = 0
    this.invalidate()
  }

  // ---------------------------------------------------------------------------
  // Folds

  /** The parts of a track's wall that are unfolded (or unfolding): by its buttons, or by a navigation. */
  private opened(track: number): Record<FoldSection, boolean> {
    const fold = this.folds[track]
    const auto = this.autoFolds[track]
    return {
      fx    : fold.fx || auto.fx,
      panels: fold.panels || auto.panels
    }
  }

  /** Something of the track's wall is unfolded (or unfolding). */
  private isUnfolded(track: number): boolean {
    const opened = this.opened(track)
    return opened.fx || opened.panels
  }

  /** How a fold button is lit: on when it keeps its part unfolded, auto when a navigation unfolded it. */
  private foldState(track: number, section: FoldSection): ButtonState {
    if (this.folds[track][section]) return 'on'
    return this.autoFolds[track][section] ? 'auto' : 'off'
  }

  private showFoldButtons(track: number): void {
    this.trackViews[track]?.setFoldButtons(this.foldState(track, 'fx'), this.foldState(track, 'panels'))
  }

  /** Every part of every track's wall is unfolded by its button (or, with `section`, that part of every track's). */
  allUnfolded(section?: FoldSection): boolean {
    return this.folds.every((fold) => (section ? fold[section] : fold.fx && fold.panels))
  }

  /** How far a part is unfolded across the tracks: on every track by its button (all), on some (by a button or a navigation), or on none. */
  foldCoverage(section: FoldSection): 'off' | 'some' | 'all' {
    if (this.allUnfolded(section)) return 'all'
    return this.folds.some((_, track) => this.opened(track)[section]) ? 'some' : 'off'
  }

  /** The parts of a track's wall its buttons unfolded. */
  foldsOf(track: number): Record<FoldSection, boolean> {
    return { ...this.folds[track] }
  }

  /**
   * Unfolds every part of every track's wall (or, with `section`, that part of every track's), or
   * folds them all when they are all unfolded; returns true when they are unfolded.
   */
  toggleAllFolds(section?: FoldSection): boolean {
    const open = !this.allUnfolded(section)
    for (const track of this.folds.keys()) {
      for (const part of ['fx', 'panels'] as const) {
        if (section && section !== part) continue
        this.folds[track][part]     = open
        this.autoFolds[track][part] = false
      }
      this.showFoldButtons(track)
    }
    if (open) this.revealTrack(this.focusTrack())
    this.foldsChanged()
    return open
  }

  /**
   * A track's fold button: unfolds its part of the wall until the button is pressed again, and
   * brings it into view. A part a navigation unfolded stays unfolded, now for good.
   */
  toggleFold(track: number, section: FoldSection): void {
    const fold = this.folds[track]
    if (!fold) return
    const wasOpen                  = this.opened(track)[section]
    fold[section]                  = !fold[section]
    this.autoFolds[track][section] = false
    this.showFoldButtons(track)
    if (fold[section] && !wasOpen) this.revealTrack(track)
    this.foldsChanged()
  }

  private foldsChanged(): void {
    this.refreshSelectedLinks()
    this.invalidate()
    this.onFolds()
  }

  /**
   * A navigation went to `selection`: what navigations unfolded on other tracks folds again, and
   * the part of the wall its cell is on (its step details, or its panels) unfolds and comes into
   * view, until a navigation leaves the track. A cell of the front column unfolds nothing.
   */
  private unfoldFor(selection: Selection): void {
    const track = selectionTrack(selection)
    this.foldAutoExcept(track)
    if (!isWallCell(selection)) return
    // The instrument column is on the front too: going there leaves the step details folded.
    const section: FoldSection | null = selection.kind !== 'step' ? 'panels' : selection.column !== 'inst' ? 'fx' : null
    if (!section || this.opened(track)[section]) return
    this.autoFolds[track][section] = true
    this.showFoldButtons(track)
    this.revealTrack(track)
    this.foldsChanged()
  }

  /**
   * Folds again what navigations unfolded on every track but `keep` (on all of them when null),
   * and moves the view with `keep` (else the focused track) so its column stays where it is on
   * screen while the tracks on its left close up.
   */
  private foldAutoExcept(keep: number | null): void {
    const folding = [...this.autoFolds.keys()].filter((track) => track !== keep && (this.autoFolds[track].fx || this.autoFolds[track].panels))
    if (!folding.length) return
    const still  = keep ?? this.focusTrack()
    const before = this.settledX(still)
    for (const track of folding) {
      this.autoFolds[track] = {
        fx    : false,
        panels: false
      }
      this.showFoldButtons(track)
    }
    this.rig.goal.target.x += this.settledX(still) - before
    this.foldsChanged()
  }

  /** Slides the view sideways, no more than it takes, for a track's column and its unfolded wall to be on screen (its column first). */
  private revealTrack(track: number): void {
    const span = this.trackSpan(track, this.isUnfolded(track))
    this.slideGoal(span, span.slice(0, 2))
  }

  /**
   * Slides the goal sideways to frame `points` (see sideShift): along the tracks, so the camera
   * keeps its distance from them and the zoom stays as it is, as a pan by hand does (along the
   * view only when it looks almost along the tracks). The margins keep clear of the HUD's selection
   * panel at every height by default (see frameMargins).
   */
  private slideGoal(points: Vector3[], mustSee: Vector3[] = [], align: Align = 'least', margins = this.frameMargins()): void {
    const goal  = this.rig.goal
    const lens  = this.lens()
    const slide = trackSlide(goal, lens, margins)
    shiftTarget(goal, sideShift(goal, lens, points, margins, mustSee, align, slide), slide)
    this.clampGoal()
  }

  /**
   * The `cols` header button: a track's wall gets one more column of panels (up to the most they
   * want), or goes back to the usual number. Only that track changes: its wall eases to its new
   * length, its panels glide to their new columns and the tracks on its right slide along.
   */
  private cycleColumns(track: number): void {
    const lanes = this.layout?.tracks[track]
    if (!lanes || !this.layout) return
    const wider              = lanes.cols < lanes.wanted
    this.panelColumns[track] = wider ? Math.min(MAX_PANEL_COLS, lanes.cols + 1) : DEFAULT_PANEL_COLS
    if (!this.layout.setColumnLimit(track, this.panelColumns[track])) return
    this.trackViews[track]?.refreshColumns()
    if (wider) this.revealTrack(track)
    this.refreshSelectedLinks()
    this.invalidate()
  }

  /** Turns the wall `degrees` from the front (the Options panel's slider). */
  setWallDegrees(degrees: number): void {
    const angle = MathUtils.degToRad(degrees)
    if (Math.abs(angle - this.wallAngle) < 1e-4) return
    this.wallAngle = angle
    for (const view of this.trackViews) view.setWallAngle(angle)
    this.refreshSelectedLinks()
    this.invalidate()
  }

  zoom(factor: number): void {
    this.rig.goal.distance *= factor
    this.invalidate()
  }

  scrollRows(rows: number): void {
    this.rig.goal.target.y -= rows * ROW_H
    this.invalidate()
  }

  /** The track the view centres on: the one pressed by hand, else the followed one, else the selected one, else the one in the middle of the view. */
  focusTrack(): number {
    if (this.handTrack != null) return this.handTrack
    if (this.followedTrack != null) return this.followedTrack
    return this.selection ? selectionTrack(this.selection) : this.focusedTrack
  }

  private lens(): Lens {
    return {
      tanHalfFov: Math.tan(MathUtils.degToRad(this.camera.fov) / 2),
      aspect    : this.camera.aspect
    }
  }

  /** Distances an automatic framing may stand at: near enough for rows to read, far enough for a phrase and more. */
  private readableDistances(): [near: number, far: number] {
    const { tanHalfFov } = this.lens()
    const near           = (FRAME_MIN_ROWS * ROW_H) / (2 * tanHalfFov)
    const far            = (ROW_H * this.container.clientHeight) / (2 * tanHalfFov * FRAME_MIN_ROW_PX)
    return [Math.min(near, far), Math.max(near, far)]
  }

  /** Where the point `u` along the wall of a track whose column starts at `left` is (x, z), for the wall slid back by `slide`. */
  private onWall(left: number, u: number, slide: number): Vector3 {
    return new Vector3(left + WALL_HINGE + (u - slide) * Math.cos(this.wallAngle), 0, -(u - slide) * Math.sin(this.wallAngle))
  }

  /**
   * Points across what a framing shows of a track, where it settles, for the goal view: its
   * front column, and when `open` what it has unfolded: its step details, and its panels up to
   * the ones shown for the rows in view (at least its first panel column), each as wide as the
   * face it turns to (an instrument face reaches past the wall's end).
   */
  private trackSpan(track: number, open: boolean): Vector3[] {
    const goal  = this.rig.goal
    const y     = goal.target.y
    const left  = this.settledX(track)
    const front = [new Vector3(left, y, 0), new Vector3(left + FRONT_W, y, 0)]
    const fold  = this.opened(track)
    const lanes = this.layout?.tracks[track]
    if (!open || !this.layout || !lanes) return front
    const slide  = this.wallSlide(fold.fx ? 1 : 0)
    const onWall = (u: number) => this.onWall(left, u, slide).setY(y)
    if (!fold.panels) return [...front, onWall(SIDE_END)]
    // Which panels the rows in view would show, and in which columns (the panels themselves stay where they are).
    const range = this.stickRange(goal, true)
    const ends  = this.layout.probe(track, range.panelTop, range.bottom, range.view).map((shown) => this.cardCorners(track, shown).corners[1].setY(y))
    return [...front, onWall(Math.min(lanes.wallLen, PANEL_U0 + PANEL_COL_W)), ...ends]
  }

  /**
   * The corners of a panel's card where the layout puts it (wall u `u`, title line at `y`, `rows`
   * rows), as large as the face it turns to: top left, top right (the tab over it included),
   * bottom left, bottom right. With them, the card's left edge on the wall and the way it runs
   * from there (an instrument face may turn out of the wall toward the front, see flipPose).
   */
  private cardCorners(track: number, shown: { panel: Panel; u: number; y: number; rows: number }): { corners: Vector3[]; start: Vector3; along: Vector3 } {
    const view   = this.trackViews[track]
    const face   = view?.settledFace(shown.panel) ?? 'table'
    const width  = view?.settledWidth(shown.panel) ?? 0
    const angle  = this.wallAngle * (1 - flipPose(face === 'inst' ? 1 : 0).turn)
    const along  = new Vector3(Math.cos(angle), 0, -Math.sin(angle))
    const start  = this.onWall(this.settledX(track), shown.u - FACE_PAD_LEFT, this.wallSlide(this.opened(track).fx ? 1 : 0))
    const end    = start.clone().addScaledVector(along, width)
    const top    = shown.y + PANEL_TAB_ROOM
    const bottom = shown.y + FACE_PAD_TOP - (shown.rows * ROW_H + 0.5)
    return {
      corners: [start.clone().setY(top), end.clone().setY(top), start.clone().setY(bottom), end.setY(bottom)],
      start,
      along
    }
  }

  /**
   * Where the panel of a panel cell settles for the goal view: its card's corners (see
   * cardCorners) and the cell's centre on the face the panel turns to. Null when the layout would
   * not show the panel there (none of its uses is near the rows in view).
   */
  private settledCard(selection: PanelSelection): { corners: Vector3[]; cell: Vector3 } | null {
    const { layout } = this
    const track      = selection.track
    const view       = this.trackViews[track]
    const panel      = this.panelOf(track, selection.table)
    if (!layout || !view || !panel) return null
    const range = this.stickRange(this.rig.goal, true)
    const shown = layout.probe(track, range.panelTop, range.bottom, range.view).find((p) => p.panel === panel)
    if (!shown) return null
    const { corners, start, along } = this.cardCorners(track, shown)
    // Cells are placed in the frame of the face: x from its first character, y from its title line.
    const rect                      = cellRects(layout, view, selection, (table) => this.panelOf(track, table), true).at(-1)
    const cell                      = rect ? start.clone().addScaledVector(along, FACE_PAD_LEFT + rect.x + rect.w / 2).setY(shown.y + rect.y - rect.h / 2) : corners[0]
    return {
      corners,
      cell
    }
  }

  /** How far the bottom of a card (see cardCorners) reaches under the bottom of the view, where it stands; 0 or less when it is above it. */
  private cutBelow(corners: Vector3[]): number {
    const goal = this.rig.goal
    this.aimProbe(goal)
    return Math.max(...corners.slice(2).map((corner) => this.probedHeight(goal, corner.x, VIEW_BOTTOM_NDC, corner.z) - corner.y))
  }

  /**
   * The target that centres a track on screen for a pose's angles and distance: its front
   * column, or with `open` its column and open wall together. The same framing for every
   * track. `fit` also sets the pose's distance to the one at which they fill the screen
   * (within readable distances).
   */
  private trackCentre(pose: RigPose, track: number, open: boolean, fit = false): Vector3 {
    const lens    = this.lens()
    // Centred in what the HUD's selection panel leaves free.
    const margins = this.frameMargins()
    const probe   = {
      ...pose,
      target: pose.target.clone()
    }
    let points    = this.trackSpan(track, open)
    // Twice when fitting: standing elsewhere shows other rows, and so maybe other panels.
    for (let pass = 0; pass < (fit ? 2 : 1); pass += 1) {
      const box      = new Box3().setFromPoints(points)
      probe.target.x = (box.min.x + box.max.x) / 2
      probe.target.z = (box.min.z + box.max.z) / 2
      if (!fit) break
      const [near, far] = this.readableDistances()
      probe.distance    = fitDistance(probe, lens, points, margins, near, far)
      pose.distance     = probe.distance
      points            = this.trackSpan(track, open)
    }
    shiftTarget(probe, sideShift(probe, lens, points, margins, [], 'center'))
    return probe.target
  }

  /** Where the target goes to centre a track at the goal's yaw: its column, and what it has unfolded. */
  private trackPivot(track: number): Vector3 {
    return this.trackCentre(this.rig.goal, track, this.isUnfolded(track))
  }

  /**
   * Facing the front, a framing of the tracks as a whole: centred on all of them, then slid
   * no more than it takes for the focused track's column to be on screen. The target stands on
   * the tracks' plane, or `z` off it (a navigation keeps the camera's distance from the tracks).
   */
  private frameFront(z = 0): void {
    const goal = this.rig.goal
    const last = this.trackViews.length - 1
    if (last < 0) return
    const y   = goal.target.y
    const all = [new Vector3(0, y, 0), new Vector3(this.songEnd(), y, 0)]
    goal.target.set((all[0].x + all[1].x) / 2, y, z)
    this.slideGoal(all, [], 'center')
    this.slideGoal(this.trackSpan(this.focusTrack(), false))
  }

  /** Normalized device coordinates (-1..1, y up) of a pointer position. */
  private ndcAt(clientX: number, clientY: number): [x: number, y: number] {
    const rect = this.renderer.domElement.getBoundingClientRect()
    return [((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2]
  }

  /**
   * The track whose column (or open wall) the ray through a point of the screen meets first
   * (`ndcX` -1 left .. 1 right, `ndcY` -1 bottom .. 1 top), with the camera at `pose`; null
   * when it meets none.
   */
  private trackUnder(ndcX: number, ndcY = 0, pose = this.rig.goal): number | null {
    return this.hitUnder(ndcX, ndcY, pose)?.track ?? null
  }

  /** As trackUnder, with how deep along the view the ray meets it (its direction is one deep). */
  private hitUnder(ndcX: number, ndcY: number, pose: RigPose): { track: number; depth: number } | null {
    const ray        = rayThrough(pose, this.lens(), ndcX, ndcY)
    const meet       = (ax: number, az: number, bx: number, bz: number) => rayMeets(ray, new Vector3(ax, 0, az), new Vector3(bx, 0, bz))
    let nearest      : number | null = null
    let nearestAlong = Number.POSITIVE_INFINITY
    for (let track = 0; track < this.trackViews.length; track += 1) {
      const left = this.frontX(track)
      const hits = [meet(left - TRACK_GAP / 2, 0, left + FRONT_W + TRACK_GAP / 2, 0)]
      const wall = this.shownWall(track)
      if (wall) {
        const [from, to] = [this.onWall(left, wall[0], this.trackViews[track].slide), this.onWall(left, wall[1], this.trackViews[track].slide)]
        hits.push(meet(from.x, from.z, to.x, to.z))
      }
      for (const along of hits) if (along != null && along < nearestAlong) [nearest, nearestAlong] = [track, along]
    }
    return nearest == null ? null : {
      track: nearest,
      depth: nearestAlong
    }
  }

  /** The stretch of a track's wall (u from, u to) that shows enough to be grabbed, null when nothing of it does. */
  private shownWall(track: number): [from: number, to: number] | null {
    const view  = this.trackViews[track]
    const lanes = this.layout?.tracks[track]
    if (!view || !lanes) return null
    const side   = view.sideAlpha > 0.5
    const panels = view.panelsAlpha > 0.5
    if (!side && !panels) return null
    return [side ? 0 : PANELS_SLIDE, panels ? lanes.wallLen : SIDE_END]
  }

  /**
   * Follows the M8 cursor: its track becomes the focused one; a wall cell (velocity,
   * instrument, FX, a table, an instrument panel) unfolds the part of the wall it is on and
   * comes into view. Null stops following.
   */
  follow(selection: Selection | null, options: { scroll?: boolean } = {}): void {
    if (selection && sameSelection(selection, this.followedSelection)) return
    // With auto select, select() took the departure before it folded anything.
    if (selection && !(this.departure && sameSelection(this.departure.to, selection))) this.departure = this.departFrom(this.followedSelection, selection)
    this.followedSelection = selection
    if (!selection) {
      if (this.followedTrack != null) this.focusedTrack = this.followedTrack
      this.followedTrack = null
      this.invalidate()
      return
    }
    this.handTrack     = null
    this.followedTrack = selectionTrack(selection)
    this.reachCell(selection, options.scroll !== false, true)
    this.invalidate()
  }

  /**
   * Where each track's column settles, as of this frame: a navigation measures where it left from
   * with it, since the M8 may have turned a panel (widening a track) just before the selection moves.
   */
  private noteSettledColumns(): void {
    let x = 0
    for (let track = 0; track < this.trackViews.length; track += 1) {
      this.settledColumns[track] = x
      x                          += TRACK_PITCH + this.settledWidth(track)
    }
  }

  /** The departure of a navigation from `from` to `to` (see Departure), when they are on different tracks. */
  private departFrom(from: Selection | null, to: Selection): Departure | null {
    if (!from || selectionTrack(from) === selectionTrack(to)) return null
    const track = selectionTrack(from)
    return {
      to,
      track,
      x    : this.settledColumns[track] ?? this.settledX(track),
      goalX: this.rig.goal.target.x
    }
  }

  /**
   * After a navigation to another track (see Departure): the view pans along the tracks by the
   * distance between them, so the new track shows where the old one was, and a cell at the same
   * place in it (row and column) where the old cell was. The framing that follows moves only if
   * something it must show is still cut.
   */
  private panAcrossTracks(selection: Selection): void {
    const departure = this.departure
    this.departure  = null
    if (!departure || !sameSelection(departure.to, selection)) return
    const track = selectionTrack(selection)
    if (track === departure.track) return
    this.rig.goal.target.x = departure.goalX + this.settledX(track) - departure.x
    this.clampGoal()
  }

  /**
   * Unfolds the part of the wall a wall cell is on, then brings the selection into view (measured
   * where it will be once the walls have moved), clear of the HUD's selection panel: the view slides
   * along the tracks, keeping its distance from them, and scrolls, unless `scroll` is off (the
   * playheads scroll the view while the song plays), so that all it marks shows (the phrase of a
   * chain row, the chain of a song cell), or its top when that is taller than the view. The
   * camera does not turn.
   */
  private reachCell(selection: Selection, scroll = true, landTop = false): void {
    const before = this.rig.goal.target.clone()
    this.unfoldFor(selection)
    this.panAcrossTracks(selection)
    this.frameCell(selection, scroll, landTop)
    if (this.rig.goal.target.distanceTo(before) > 0.05) this.cutDramatic(selection, scroll, landTop)
    this.invalidate()
  }

  /** Frames a selection with the goal's angles (see reachCell): a panel cell's card, else the phrase of the cell. */
  private frameCell(selection: Selection, scroll: boolean, landTop: boolean): void {
    if (isPanelSelection(selection)) {
      this.reachPanel(selection, scroll)
      return
    }
    const found = this.focusOf(selection)
    if (!found) return
    // Following playback the playheads scroll the view: a cell far out of sight (even behind the
    // camera) would show at no sensible place across, so it is framed at the view's height.
    const focus = scroll ? found : this.atViewHeight(found)
    // Twice: a scroll moves things across a little (pitch, roll) or past a panel of the HUD, and a
    // slide brings them nearer or further, which moves them up or down the screen.
    for (let pass = 0; pass < 2; pass += 1) {
      if (scroll) this.scrollToShow(focus, landTop)
      this.slideToShow(selection, focus)
    }
  }

  /** A focus moved up or down to the height the view looks at, when its cell is out of sight (see cutAnchor). */
  private atViewHeight(focus: Focus): Focus {
    const cell   = focus.cell[0]
    const anchor = cell && cutAnchor(this.rig.goal, this.lens(), cell)
    if (!anchor || anchor === cell) return focus
    const dy    = anchor.y - cell.y
    const moved = (points: Vector3[]) => points.map((point) => point.clone().setY(point.y + dy))
    return {
      box : moved(focus.box),
      core: focus.core && moved(focus.core),
      cell: moved(focus.cell)
    }
  }

  /**
   * With dramatic angles, a navigation that moved the view is a cut: the preset (Front, Turn or
   * Side; not an angle turned by hand) takes a new take, and the camera swings around the cell, which
   * stays where the framing put it on screen. Following playback it swings around the playhead on
   * the cell's track instead, which keeps its place (the view scrolls with it); a cell out of sight
   * holds its track at the view's height (see cutAnchor). The framing then moves only if something is cut.
   */
  private cutDramatic(selection: Selection, scroll: boolean, landTop: boolean): void {
    const preset = this.preset
    if (!this.dramatic || !preset || preset === 'overview') return
    const goal   = this.rig.goal
    const cell   = isPanelSelection(selection) ? (this.settledCard(selection)?.cell ?? null) : this.settledPoint(selection)
    const anchor = (this.followPlayback ? this.playheadPoint(selectionTrack(selection)) : null) ?? (cell && cutAnchor(goal, this.lens(), cell))
    const shown  = anchor && screenPoint(goal, this.lens(), anchor)
    this.aim(preset)
    if (anchor && shown) {
      holdOnScreen(goal, this.lens(), anchor, shown)
      this.clampGoal()
    }
    this.frameCell(selection, scroll, landTop)
  }

  /**
   * What a navigation to a front or step cell shows, where things settle: the phrase it is in (a
   * Song view cell: its chain, every phrase of its song row) across the front column, and the step
   * details when they are unfolded; and the cell itself.
   */
  private focusOf(selection: Extract<Selection, { kind: 'step' | 'chain' }>): Focus | null {
    const layout = this.layout
    if (!layout) return null
    const { instance } = selection
    const track        = instance.track
    let rows           = ROWS_PER_PHRASE
    if (selection.kind === 'chain' && selection.view === 'song') {
      const last = layout.timeline.byTrack[track].filter((other) => other.songRow === instance.songRow).at(-1) ?? instance
      rows       = last.row - instance.row + ROWS_PER_PHRASE
    }
    const top    = layout.rowY(instance.row) + 0.1
    const bottom = layout.rowY(instance.row + rows - 1) - ROW_H - 0.1
    const left   = this.settledX(track)
    const across = [new Vector3(left - 0.2, 0, 0), new Vector3(left + FRONT_W, 0, 0)]
    // Unfolded, the step details stand on the wall where it settles (not slid back).
    if (this.opened(track).fx) across.push(this.onWall(left, WALL_STEPS_U + WALL_STEPS_W, 0))
    const cell   = this.settledCorners(selection)
    if (!cell.length) return null
    return {
      box: across.flatMap((point) => [point.clone().setY(top), point.clone().setY(bottom)]),
      cell
    }
  }

  /**
   * Scrolls for the whole focus box to show between the sticky headers and the bottom of the view
   * (measured where each of its points stands: seen at an angle, a nearer one shows larger), or,
   * when it is taller than that, its cell. Nothing moves while it shows. Else it lands with room
   * in the direction the view went: following the M8 (`landTop`), its top just under the headers
   * (what follows matters more), a cell left with LOOKAHEAD_ROWS under it; otherwise SCROLL_LAND
   * of the stretch from the edge it came in by.
   */
  private scrollToShow(focus: Focus, landTop: boolean): void {
    const goal = this.rig.goal
    this.aimProbe(goal)
    const range          = this.stickRange(goal, true)
    const viewTop        = Math.min(range.headerTop, this.layout?.headerRestY ?? Number.POSITIVE_INFINITY) - HEADER_BOTTOM
    // How far its top is under the headers, and its bottom under the view (the view moves up by
    // `above` to show the one, down by `below` to show the other).
    const outside        = (points: Vector3[]) => ({
      above: Math.max(...points.map((point) => point.y)) - viewTop,
      below: Math.max(...points.map((point) => this.probedHeight(goal, point.x, VIEW_BOTTOM_NDC, point.z) - point.y))
    })
    let { above, below } = outside(focus.box)
    let lookahead        = 0
    if (above + below > 0) {
      ;({ above, below } = outside(focus.cell))
      lookahead          = landTop ? LOOKAHEAD_ROWS * ROW_H : 0
    }
    if (above <= 0 && below + lookahead <= 0) return
    // Room left around it once shown, and the stretch the view shows (where its cell stands).
    const room    = Math.max(0, -(above + below))
    const cell    = focus.cell[0]
    const span    = viewTop - this.probedHeight(goal, cell.x, VIEW_BOTTOM_NDC, cell.z)
    const shift   = landTop
      ? above + Math.min(LAND_TOP_ROWS * ROW_H, room)
      : below > 0
        ? above + Math.min(span * SCROLL_LAND, room)
        : -below - Math.min(span * SCROLL_LAND, room)
    goal.target.y += shift
    this.clampGoal()
  }

  /**
   * Slides the view along the tracks when the focus box does not show whole between the margins
   * (clear of the HUD's selection panel at the heights it spans): its track, the box and as much of
   * its unfolded wall as fits, comes to the middle of the free room (turned, a track left at an
   * edge would stand far off and small); a box wider than the screen fills it, its cell in view.
   * Facing the front, a song that fits the screen whole for a front cell is framed whole instead.
   */
  private slideToShow(selection: Selection, focus: Focus): void {
    const goal    = this.rig.goal
    const margins = this.frameMargins(...this.screenHeights(focus.box))
    if (this.inFrame(focus.box, margins)) return
    if (goal.yaw < FACING_FRONT_YAW && !isWallCell(selection) && this.songFits(margins)) {
      this.frameFront(goal.target.z)
      if (this.inFrame(focus.box, margins)) return
    }
    const track = selectionTrack(selection)
    const slide = trackSlide(goal, this.lens(), margins)
    const fits  = (points: Vector3[]) => fitsAcross(goal, this.lens(), points, margins, slide)
    if (fits(focus.box)) this.slideGoal([...this.trackSpan(track, this.isUnfolded(track)), ...focus.box], focus.box, 'center', margins)
    else if (focus.core && fits(focus.core)) this.slideGoal(focus.box, focus.core, 'center', margins)
    else this.slideGoal(focus.core ?? focus.box, focus.cell, 'center', margins)
  }

  /** True when every point shows between the margins, seen from the goal view. */
  private inFrame(points: Vector3[], margins: Margins): boolean {
    const goal = this.rig.goal
    const lens = this.lens()
    return points.every((point) => {
      const x = screenX(goal, lens, point)
      return x >= margins.left - 1 - 1e-3 && x <= 1 - margins.right + 1e-3
    })
  }

  /** True when the whole song, where the tracks settle, fits across the screen at the goal's distance. */
  private songFits(margins: Margins): boolean {
    const y = this.rig.goal.target.y
    return fitsAcross(this.rig.goal, this.lens(), [new Vector3(0, y, 0), new Vector3(this.songEnd(), y, 0)], margins)
  }

  /**
   * Brings the whole card of a panel cell into view, where it settles and as large as the face it
   * turns to (an instrument face is wider and taller than its table), with its track's column
   * (chain, phrase and notes) beside it whichever side the view comes from: see slideToShow; the
   * card first when both do not fit, the cell when the card does not. Panels stick under the
   * headers while rows that use them are near, so the view scrolls only when none is (to the
   * nearest), or, unless `scroll` is off, when the card would be cut at the bottom (the headers
   * rest lower at the start of the song, and rise with the rows until they reach the top).
   */
  private reachPanel(selection: PanelSelection, scroll: boolean): void {
    const goal  = this.rig.goal
    let card    = this.settledCard(selection)
    const panel = this.panelOf(selection.track, selection.table)
    if (!card && scroll && panel && this.layout) {
      const range = this.stickRange(goal, true)
      const top   = this.layout.nearestUseY(panel, range.headerTop, range.bottom)
      this.scrollRowsInto(top, top - ROW_H, true)
      card = this.settledCard(selection)
    }
    if (!card) return
    this.slideToShow(selection, this.cardFocus(selection.track, card))
    if (!scroll) return
    let cut = this.cutBelow(card.corners)
    for (let pass = 0; pass < 3 && cut > 0.05; pass += 1) {
      const before  = goal.target.y
      goal.target.y -= cut
      this.clampGoal()
      const next = this.settledCard(selection)
      const left = next ? this.cutBelow(next.corners) : Number.POSITIVE_INFINITY
      // Scrolling no longer lifts it (it sticks under the headers at the top): the view stays.
      if (!next || left > cut - 0.05) {
        goal.target.y = before
        break
      }
      ;[card, cut] = [next, left]
    }
    this.slideToShow(selection, this.cardFocus(selection.track, card))
  }

  /** What a navigation to a panel cell shows: the card with its track's column at the card's heights, the card, the cell. */
  private cardFocus(track: number, card: { corners: Vector3[]; cell: Vector3 }): Focus {
    const left   = this.settledX(track)
    const top    = Math.max(...card.corners.map((corner) => corner.y))
    const bottom = Math.min(...card.corners.map((corner) => corner.y))
    const column = [left - 0.2, left + FRONT_W].flatMap((x) => [new Vector3(x, top, 0), new Vector3(x, bottom, 0)])
    return {
      box : [...column, ...card.corners],
      core: card.corners,
      cell: [card.cell]
    }
  }

  /** World centre of a selection's cell once the track positions and the wall have settled. */
  private settledPoint(selection: Selection): Vector3 | null {
    const corners = this.settledCorners(selection)
    if (!corners.length) return null
    return corners.reduce((sum, corner) => sum.add(corner), new Vector3()).multiplyScalar(1 / corners.length)
  }

  /** World corners of a selection's cell once the track positions and the wall have settled (none when it has no cell). */
  private settledCorners(selection: Selection): Vector3[] {
    const rect = this.rectsOf(selection).at(-1)
    if (!rect) return []
    const track   = selectionTrack(selection)
    const corners = [
      new Vector3(rect.x, rect.y, 0),
      new Vector3(rect.x + rect.w, rect.y, 0),
      new Vector3(rect.x, rect.y - rect.h, 0),
      new Vector3(rect.x + rect.w, rect.y - rect.h, 0),
    ]
    const view    = this.trackViews[track]
    // Into the track's group (the wall, or a panel turned out of it), whose x is then where it settles.
    let onWall    = false
    for (let object: Object3D | null = rect.parent; view && object && object !== view.group; object = object.parent) {
      onWall = onWall || object === view.wall
      object.updateMatrix()
      for (const corner of corners) corner.applyMatrix4(object.matrix)
    }
    // The wall may still have to slide into the place it settles at.
    const slid    = view && onWall ? this.wallSlide(this.opened(track).fx ? 1 : 0) - view.slide : 0
    for (const corner of corners) {
      corner.x += this.settledX(track) - slid * Math.cos(this.wallAngle)
      corner.z += slid * Math.sin(this.wallAngle)
    }
    return corners
  }

  /** Moves the camera so a selection is in view. */
  focusSelection(selection = this.selection): void {
    if (!selection) return
    this.unfoldFor(selection)
    const point = this.settledPoint(selection)
    if (!point) return
    const goal = this.rig.goal
    goal.target.set(point.x, point.y, isWallCell(selection) ? point.z : 0)
    goal.distance = Math.min(goal.distance, 70)
    this.invalidate()
  }

  /** Scrolls just enough for a selection to be on screen. */
  reveal(selection: Selection): void {
    this.scrollIntoView(selection)
    this.invalidate()
  }

  /**
   * Scrolls a cell (spanning heights bottom..top) into the stretch between the sticky headers
   * and the bottom of the view. A cell that left it at the bottom comes back near the top, one
   * that left at the top comes back near the bottom: SCROLL_LAND of the stretch from the far
   * edge, so the view moves most of a page and the next moves need no scrolling. The bottom of
   * the view is measured where the cell stands (`at`, else at the target): seen at an angle, a
   * cell nearer than the target shows larger, so fewer rows fit under it.
   */
  private scrollRowsInto(top: number, bottom: number, landTop = false, at?: Vector3): void {
    const goal = this.rig.goal
    this.aimProbe(goal)
    const range       = this.stickRange(goal, true)
    const viewTop     = range.headerTop - ROW_H - 0.4
    const viewBottom  = at ? this.probedHeight(goal, at.x, VIEW_BOTTOM_NDC, at.z) : range.bottom
    const span        = viewTop - viewBottom
    const aboveCentre = viewTop - goal.target.y
    const belowCentre = goal.target.y - viewBottom
    if (landTop) {
      // What follows a cell matters more than what precedes it: scroll when it sits too low, and land it just under the headers.
      if (bottom < viewBottom + LOOKAHEAD_ROWS * ROW_H || top > viewTop) goal.target.y = top - aboveCentre + LAND_TOP_ROWS * ROW_H
    } else if (bottom < viewBottom) goal.target.y = top - aboveCentre + span * SCROLL_LAND
    else if (top > viewTop) goal.target.y = bottom + belowCentre - span * SCROLL_LAND
    // Near the start of the song the view goes no higher than the headers allow.
    this.clampGoal()
  }

  private scrollIntoView(selection: Selection): void {
    const rect = this.rectsOf(selection).at(-1)
    if (!rect) return
    const world = rect.parent.localToWorld(new Vector3(rect.x, rect.y, 0))
    const goal  = this.rig.goal
    const half  = this.visibleHalfHeight(goal.distance) * 0.8
    this.scrollRowsInto(world.y, world.y - rect.h, false, world)
    const halfWidth = half * this.camera.aspect
    if (world.x > goal.target.x + halfWidth || world.x < goal.target.x - halfWidth) goal.target.x = world.x
  }

  // ---------------------------------------------------------------------------
  // Selection

  /** The same place in a rebuilt layout (instances are recreated). */
  private resolve(selection: Selection): Selection | null {
    if (!this.layout) return null
    if (selection.kind === 'step' || selection.kind === 'chain') {
      const instance = this.layout.instanceAt(selection.instance.track, selection.instance.row)
      return instance ? { ...selection, instance } : null
    }
    return this.panelOf(selection.track, selection.table) ? selection : null
  }

  private panelOf(track: number, table: number): Panel | undefined {
    return this.layout?.tracks[track]?.panels.find((panel) => panel.table === table)
  }

  // ---------------------------------------------------------------------------
  // Panel faces

  /** The face a panel turns to: as turned by hand, else the instrument face while the M8 shows that instrument. */
  private faceGoal(panel: Panel): PanelFace {
    const byHand = this.facesByHand.get(`${panel.track}:${panel.table}`)
    if (byHand) return byHand
    return panel.instrument != null && panel.instrument === this.deviceInstrument ? 'inst' : 'table'
  }

  /** The instrument the M8 shows (null on any other view); turns over its panels. */
  setDeviceInstrument(instrument: number | null): void {
    if (instrument === this.deviceInstrument) return
    this.deviceInstrument = instrument
    this.facesByHand.clear()
    this.facesChanged()
  }

  /** Turns a panel over by hand. */
  toggleFace(track: number, table: number): void {
    const panel = this.panelOf(track, table)
    if (!panel || panel.instrument == null || !this.layout?.instrumentFace(panel.instrument)) return
    this.facesByHand.set(`${track}:${table}`, this.faceGoal(panel) === 'inst' ? 'table' : 'inst')
    this.facesChanged()
  }

  /** The layout makes room for the faces panels turn to at once, so a framing made now sees where they settle. */
  private facesChanged(): void {
    for (const view of this.trackViews) view.applyFaceGoals()
    this.invalidate()
  }

  /**
   * Key I: turns over the panel of the selection (a panel cell, or the instrument a step
   * plays), turning the view to its wall first when needed.
   */
  toggleSelectedFace(): void {
    const { selection, layout } = this
    if (!selection || !layout) return
    if (selection.kind === 'table' || selection.kind === 'instrument' || selection.kind === 'instParam') {
      this.toggleFace(selection.track, selection.table)
      return
    }
    if (selection.kind !== 'step') return
    const track      = selection.instance.track
    const instrument = layout.effective.get(selection.instance.key)?.[selection.step]
    const panel      = layout.tracks[track].panels.find((p) => p.instrument === instrument)
    if (!panel || instrument == null) return
    this.select({
      kind : 'instrument',
      instrument,
      table: panel.table,
      track
    }, { turn: true })
    this.toggleFace(track, panel.table)
  }

  /** Arrows on the instrument face: the nearest value in that direction. */
  private movedOnFace(selection: Extract<Selection, { kind: 'instParam' }>, rowDelta: number, columnDelta: number): Selection | null {
    const face = this.layout?.instrumentFace(selection.instrument)
    const here = face && placeOf(face, selection.screen, selection.line, selection.x)
    if (!face || !here) return null
    const same    = (cell: typeof here.cell) => cell.screen === here.cell.screen && cell.line === here.cell.line && cell.x === here.cell.x
    let best      : typeof here | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const place of face.places) {
      if (same(place.cell) || isTitlePlace(place)) continue
      const rows    = place.row - here.row
      const columns = place.col - here.col
      if (rowDelta && Math.sign(rows) !== Math.sign(rowDelta)) continue
      if (!rowDelta && (place.row !== here.row || Math.sign(columns) !== Math.sign(columnDelta))) continue
      const score = Math.abs(rows) * 100 + Math.abs(columns)
      if (score < bestScore) [best, bestScore] = [place, score]
    }
    return best ? {
      ...selection,
      screen: best.cell.screen,
      line  : best.cell.line,
      x     : best.cell.x
    } : null
  }

  select(selection: Selection | null, options: SelectOptions = {}): void {
    const changed  = !sameSelection(selection, this.selection)
    // A navigation (the arrows, auto select) to another track pans by the distance between the tracks: where it left from, before anything folds.
    this.departure = selection && changed && (options.turn || options.silent) ? this.departFrom(this.selection, selection) : null
    if (!selection) this.focusedTrack = this.focusTrack()
    // A choice made here wins over the followed M8 cursor until the cursor moves, and over a track pressed by hand.
    if (!options.silent) {
      this.followedTrack = null
      this.handTrack     = null
    }
    this.selection = selection
    // Leaving a track folds what navigations unfolded on it (cleared, the followed M8 cursor's track keeps them).
    this.foldAutoExcept(selection ? selectionTrack(selection) : this.followedTrack)
    this.refreshMarkers()
    // The HUD first: its selection panel takes its new size, which the framing keeps clear of.
    if (changed && !options.silent) this.onSelect(selection)
    if (selection && options.turn) this.reachCell(selection, true, options.landTop)
    else if (selection && options.reveal !== false) this.scrollIntoView(selection)
    if (selection && options.focus) this.focusSelection(selection)
  }

  getSelection(): Selection | null {
    return this.selection
  }

  /** Where the M8 cursor is (every place the item under it appears). */
  setDevicePlaces(selections: Selection[]): void {
    this.devicePlaces = selections.slice(0, MAX_DEVICE_MARKERS)
    this.refreshMarkers()
  }

  /** Rectangles a selection covers: [row highlight..., cell]. The last one is the cell itself. */
  rectsOf(selection: Selection): CellRect[] {
    const view = this.trackViews[selectionTrack(selection)]
    if (!this.layout || !view) return []
    return cellRects(this.layout, view, selection, (table) => this.panelOf(selectionTrack(selection), table))
  }

  private refreshMarkers(): void {
    const { palette } = this
    this.markPanels()
    for (const marker of this.selectionMarkers) marker.hide()
    const rects = this.selection ? this.rectsOf(this.selection) : []
    rects.forEach((rect, i) => {
      const isCell = i === rects.length - 1
      this.selectionMarkers[i]?.show(rect, palette.hot, isCell ? 0.3 : 0.08, isCell ? 1 : 0.35)
    })

    this.hoverMarker.hide()
    if (this.hovered && !sameSelection(this.hovered, this.selection)) {
      const cell = this.rectsOf(this.hovered).at(-1)
      if (cell) this.hoverMarker.show(cell, palette.hover, 0.12, 0.8)
    }

    this.devicePlaces.forEach((place, i) => {
      const cell            = this.rectsOf(place).at(-1)
      this.deviceMarkers[i] ??= new CellMarker()
      if (cell) this.deviceMarkers[i].show(cell, palette.device, 0.18, 1)
      else this.deviceMarkers[i].hide()
    })
    for (let i = this.devicePlaces.length; i < this.deviceMarkers.length; i += 1) this.deviceMarkers[i].hide()
    this.refreshSelectedLinks()
    this.invalidate()
  }

  private removeSelectedLinks(): void {
    this.selectedLinks?.removeFromParent()
    this.selectedLinks?.geometry.dispose()
    this.selectedLinks = null
  }

  /** The links of a selection: a step's own, a phrase's (its chain labels) all of them, a panel's all of its panel's. */
  private selectionLinks(selection: Selection): Link[] {
    const layout = this.layout
    if (!layout) return []
    if (selection.kind !== 'step' && selection.kind !== 'chain') {
      return layout.tracks[selection.track]?.links.filter((link) => link.panel.table === selection.table) ?? []
    }
    const inRow = (link: Link) => selection.kind === 'chain' || link.step === selection.step
    const links = layout.instanceLinks(selection.instance).filter(inRow)
    // Each note also links to the instrument it plays (the last one set when its I column is empty).
    const drawn = new Set(links.map((link) => `${link.row}:${link.col}:${link.panel.table}`))
    for (const link of layout.noteInstrumentLinks(selection.instance).filter(inRow)) {
      if (!drawn.has(`${link.row}:${link.col}:${link.panel.table}`)) links.push(link)
    }
    return links
  }

  /**
   * Tells the sticky layout which panels matter now: the selected one and the one under the M8
   * cursor are pinned (whole on screen, their table down to the row pointed at), the ones the
   * selected step links to are kept open.
   */
  private markPanels(): void {
    const layout = this.layout
    if (!layout) return
    for (const track of layout.tracks) {
      for (const panel of track.panels) {
        panel.pinned      = false
        panel.linked      = false
        panel.selectedRow = null
      }
    }
    for (const place of [...this.devicePlaces, ...(this.selection ? [this.selection] : [])]) {
      if (place.kind === 'step' || place.kind === 'chain') continue
      const panel = this.panelOf(place.track, place.table)
      if (!panel) continue
      panel.pinned = true
      if (place.kind === 'table') panel.selectedRow = Math.max(panel.selectedRow ?? 0, place.row)
    }
    if (this.selection?.kind === 'step') for (const link of this.selectionLinks(this.selection)) link.panel.linked = true
  }

  /** The links of the selection, drawn thick. */
  private refreshSelectedLinks(): void {
    this.removeSelectedLinks()
    const { selection, layout } = this
    if (!selection || !layout) return
    const view  = this.trackViews[selectionTrack(selection)]
    const links = this.selectionLinks(selection)
    // A selected row draws its own links; the phrase draws all of them, faintly; a panel header draws all of its panel's.
    const faint = selection.kind === 'chain'
    if (!links.length || !view) return
    const positions: number[] = []
    for (const link of links) {
      if (link.panel.alpha < 0.05) continue
      const [from, to] = view.linkEnds(link.row, link.col, link.panel.shownY, link.panel.shownU, this.opened(view.track.track).fx ? 1 : 0)
      const points     = linkCurve(from, to)
      for (let i = 0; i < points.length - 1; i += 1) {
        const [a, b] = [points[i], points[i + 1]]
        positions.push(a.x, a.y, a.z + 0.02, b.x, b.y, b.z + 0.02)
      }
    }
    const geometry = new LineSegmentsGeometry()
    geometry.setPositions(positions)
    this.selectedLinks             = new LineSegments2(geometry, faint ? this.faintLinkMaterial : this.selectedLinkMaterial)
    this.selectedLinks.renderOrder = 4
    view.wall.add(this.selectedLinks)
  }

  /**
   * Arrow keys: rows down the song, columns across the step then the next track. Coarse
   * (Shift+arrows): up / down a whole phrase, left / right the same cell in the next track;
   * on a table, up / down go to its first or last row.
   */
  moveSelection(rowDelta: number, columnDelta: number, coarse = false): void {
    const layout = this.layout
    if (!layout) return
    let selection = this.selection
    if (!selection) {
      const instances = layout.tracks[this.focusTrack()].instances
      const instance  = instances.find((i) => layout.rowY(i.row) <= this.rig.goal.target.y + 5) ?? instances[0]
      if (instance) this.select({
        kind  : 'step',
        instance,
        step  : 0,
        column: 'note'
      }, { focus: false })
      return
    }
    if (selection.kind === 'chain') selection = {
      kind    : 'step',
      instance: selection.instance,
      step    : 0,
      column  : 'note'
    }
    if (selection.kind === 'instParam') {
      const moved = this.movedOnFace(selection, rowDelta, columnDelta)
      if (moved) this.select(moved, { turn: true })
      return
    }
    // From the header of a panel showing its instrument face: onto its first value.
    const headerPanel = selection.kind === 'instrument' ? this.panelOf(selection.track, selection.table) : undefined
    const headerShows = headerPanel && this.trackViews[headerPanel.track]?.shownFace(headerPanel) === 'inst'
    const headerFace  = headerShows && headerPanel.instrument != null ? this.layout?.instrumentFace(headerPanel.instrument) : null
    if (selection.kind === 'instrument' && headerFace && selection.instrument != null) {
      const first = headerFace.places.find((place) => place.row > 0)
      if (first) this.select({
        kind      : 'instParam',
        instrument: selection.instrument,
        screen    : first.cell.screen,
        line      : first.cell.line,
        x         : first.cell.x,
        table     : selection.table,
        track     : selection.track
      }, { turn: true })
      return
    }
    if (selection.kind === 'instrument') {
      selection = {
        kind      : 'table',
        table     : selection.table,
        row       : 0,
        column    : 'transpose',
        track     : selection.track,
        instrument: selection.instrument
      }
    }
    if (selection.kind === 'step') {
      const moved = coarse ? this.coarseStep(layout, selection, rowDelta, columnDelta) : this.movedStep(layout, selection, rowDelta, columnDelta)
      if (moved) this.select(moved, { turn: true })
      return
    }
    const column = coarse ? selection.column : TABLE_COLUMNS[MathUtils.clamp(TABLE_COLUMNS.indexOf(selection.column) + columnDelta, 0, TABLE_COLUMNS.length - 1)]
    const row    = MathUtils.clamp(selection.row + (coarse ? rowDelta * ROWS_PER_TABLE : rowDelta), 0, ROWS_PER_TABLE - 1)
    this.select({ ...selection, row, column }, { turn: true })
  }

  /** A step selection moved by Shift+arrows: a whole phrase up / down, or the same cell (row and column) in the next track. */
  private coarseStep(layout: SongLayout, selection: Extract<Selection, { kind: 'step' }>, rowDelta: number, columnDelta: number): Selection | null {
    const from = {
      instance: selection.instance,
      step    : selection.step
    }
    const to   = columnDelta ? trackMoved(layout.tracks.map((track) => track.instances), from, columnDelta) : phraseMoved(layout.tracks[from.instance.track].instances, from, rowDelta)
    return to ? {
      kind    : 'step',
      instance: to.instance,
      step    : to.step,
      column  : selection.column
    } : null
  }

  /** A step selection moved by the arrows: across the columns into the next track, down the rows past empty stretches. */
  private movedStep(layout: SongLayout, selection: Extract<Selection, { kind: 'step' }>, rowDelta: number, columnDelta: number): Selection | null {
    const lastColumn = PHRASE_COLUMNS.length - 1
    let track        = selection.instance.track
    let columnIndex  = PHRASE_COLUMNS.indexOf(selection.column) + columnDelta
    if (columnIndex < 0 || columnIndex > lastColumn) {
      track       = MathUtils.clamp(track + Math.sign(columnDelta), 0, TRACKS - 1)
      columnIndex = track === selection.instance.track ? MathUtils.clamp(columnIndex, 0, lastColumn) : columnDelta > 0 ? 0 : lastColumn
    }
    let row      = selection.instance.row + selection.step + rowDelta
    let instance : PhraseInstance | null = layout.instanceAt(track, row)
    // Skip the empty stretches of the track.
    if (!instance) {
      const instances = layout.tracks[track].instances
      const next      = rowDelta >= 0 ? instances.find((i) => i.row > row) : [...instances].reverse().find((i) => i.row + ROWS_PER_PHRASE <= row)
      const nearest   =
        next ?? instances.reduce<PhraseInstance | null>((best, i) => (!best || Math.abs(i.row - row) < Math.abs(best.row - row) ? i : best), null)
      if (!nearest) return null
      instance       = nearest
      const lastStep = nearest.row + ROWS_PER_PHRASE - 1
      row            = rowDelta >= 0 || !next ? Math.max(nearest.row, Math.min(row, lastStep)) : lastStep
      if (row < nearest.row || row > lastStep) row = nearest.row
    }
    return {
      kind  : 'step',
      instance,
      step  : row - instance.row,
      column: PHRASE_COLUMNS[columnIndex]
    }
  }

  /** Lights the mute and solo buttons of every track. */
  setTrackModes(muted: boolean[], soloed: boolean[]): void {
    this.trackModes = {
      muted : [...muted],
      soloed: [...soloed]
    }
    for (const [track, view] of this.trackViews.entries()) view.setTrackModes(!!muted[track], !!soloed[track])
    this.invalidate()
  }

  // ---------------------------------------------------------------------------
  // Pointer input (see pointerControls)

  /**
   * A pan by hand moved the pointer from one position to another: the view moves along the
   * tracks (and up or down them) so that what the pointer held there (a column or an open
   * wall, else the plane of the columns) is under it again. Nearer things move faster on
   * screen, and a thing gets nearer or further as the pan carries it across the screen (the
   * tracks are seen at an angle), so the step is solved for that point.
   */
  dragPan(fromX: number, fromY: number, toX: number, toY: number): void {
    const pose         = this.rig.current
    const lens         = this.lens()
    const [ndcX, ndcY] = this.ndcAt(fromX, fromY)
    const [toNX, toNY] = this.ndcAt(toX, toY)
    let depth          = this.hitUnder(ndcX, ndcY, pose)?.depth
    if (depth == null) {
      const ray = rayThrough(pose, lens, ndcX, ndcY)
      if (ray.direction.z < -1e-6) depth = -ray.origin.z / ray.direction.z
    }
    depth                  = MathUtils.clamp(depth ?? pose.distance, pose.distance * GRAB_DEPTH_LIMITS[0], pose.distance * GRAB_DEPTH_LIMITS[1])
    // The held point, `depth` deep at screen x `ndcX`, lands at `toNX` once the target moves by
    // `shift` along x, which brings it nearer by shift * sin(yaw) * cos(pitch).
    const across           = lens.tanHalfFov * lens.aspect
    const nearer           = Math.sin(pose.yaw) * Math.cos(pose.pitch)
    const shift            = (across * depth * (toNX - ndcX)) / Math.max(PAN_MIN_COS, Math.cos(pose.yaw) + toNX * across * nearer)
    this.rig.goal.target.x -= shift
    this.rig.goal.target.y -= lens.tanHalfFov * depth * (toNY - ndcY)
    this.panned()
  }

  /** After a pan step. With nothing selected, the track in the middle of the view is the one the view centres on (the one a turn goes around). */
  panned(): void {
    if (this.selection) return
    this.handTrack    = null
    this.focusedTrack = this.trackUnder(0) ?? this.focusedTrack
  }

  /** The track under a pointer position: the cell's there, else the column or unfolded wall shown there. */
  private trackAt(clientX: number, clientY: number): number | null {
    const cell = this.cellAt(clientX, clientY)
    if (cell) return selectionTrack(cell)
    const [ndcX, ndcY] = this.ndcAt(clientX, clientY)
    return this.trackUnder(ndcX, ndcY, this.rig.current)
  }

  /** A turn by hand goes around the track it started on. */
  turnStarted(clientX: number, clientY: number): void {
    const track = this.trackAt(clientX, clientY)
    if (track != null && track !== this.focusTrack()) this.handTrack = track
    this.turning = {
      base : this.rig.goal.target.clone(),
      pivot: this.trackPivot(this.focusTrack()),
      yaw  : this.rig.goal.yaw
    }
  }

  /**
   * While turning by hand the view turns around the track: the target's offset from the
   * track's centre turns with the view (so the camera orbits the track and the track stays where
   * it is on screen). The height is left alone, so scrolling (following playback) goes on while
   * turning.
   */
  turnedByHand(): void {
    this.preset   = null
    const turning = this.turning
    if (!turning) return
    const goal   = this.rig.goal
    const turned = goal.yaw - turning.yaw
    const dx     = turning.base.x - turning.pivot.x
    const dz     = turning.base.z - turning.pivot.z
    const pivot  = this.trackPivot(this.focusTrack())
    goal.target.set(
      pivot.x + dx * Math.cos(turned) + dz * Math.sin(turned),
      goal.target.y,
      pivot.z + dz * Math.cos(turned) - dx * Math.sin(turned),
    )
  }

  turnEnded(): void {
    this.turning = null
  }

  /**
   * Zooms toward the point under the pointer, which stays where it is on screen: the view
   * scales around where the pointer meets the plane through the target, parallel to the tracks.
   */
  zoomAt(clientX: number, clientY: number, factor: number): void {
    const goal         = this.rig.goal
    const distance     = MathUtils.clamp(goal.distance * factor, this.rig.minDistance, this.rig.maxDistance)
    const [ndcX, ndcY] = this.ndcAt(clientX, clientY)
    const ray          = rayThrough(goal, this.lens(), ndcX, ndcY)
    const along        = Math.abs(ray.direction.z) > 1e-6 ? (goal.target.z - ray.origin.z) / ray.direction.z : -1
    if (along > 0) {
      const aim = ray.origin.clone().addScaledVector(ray.direction, along)
      goal.target.sub(aim).multiplyScalar(distance / goal.distance).add(aim)
    }
    goal.distance = distance
    this.invalidate()
  }

  interacted(): void {
    this.interactedAt = performance.now()
  }

  buttonAt(clientX: number, clientY: number): SceneButton | null {
    return this.picker.pickButton(this.trackViews, clientX, clientY)
  }

  cellAt(clientX: number, clientY: number): Selection | null {
    return this.layout ? this.picker.pickCell(this.layout, this.trackViews, clientX, clientY) : null
  }

  hover(selection: Selection | null): void {
    if (sameSelection(selection, this.hovered)) return
    this.hovered = selection
    this.refreshMarkers()
    this.onHover(selection)
  }

  click(selection: Selection | null): void {
    this.select(selection, { reveal: false })
  }

  doubleClick(selection: Selection): void {
    this.select(selection, { focus: true })
  }

  pressButton(button: SceneButton): void {
    if (button.kind === 'flip') this.toggleFace(button.track, button.table)
    else if (button.kind === 'fold') this.toggleFold(button.track, button.section)
    else if (button.kind === 'cols') this.cycleColumns(button.track)
    else this.onTrackButton(button.track, button.kind)
  }

  // ---------------------------------------------------------------------------
  // Frame

  private resize(): void {
    const width  = this.container.clientWidth
    const height = this.container.clientHeight
    if (width === 0 || height === 0) return
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.selectedLinkMaterial.resolution.set(width, height)
    this.faintLinkMaterial.resolution.set(width, height)
    this.invalidate()
  }

  /** The M8's Table view shows table `table` on these rows (see TablePlayback.observeTableView). */
  observeTableView(table: number, main: number | null, lanes: (number | null)[], track: number | null): void {
    this.tablePlayback?.observeTableView(table, main, lanes, track)
  }

  /** Where the song plays, read each frame (null stops it). */
  setPlayheadSource(source: (() => (TrackPlayhead | null)[]) | null): void {
    this.playheadSource = source
    this.invalidate()
  }

  /**
   * Places the playheads, with a halo at the top or bottom of a track whose playhead is out of
   * sight, and, when following playback, scrolls with the one furthest down the song (a track
   * looping a chain of its own stays behind, under its halo); returns true while anything plays.
   */
  private updatePlayheads(dt: number): boolean {
    const heads   = this.playheadSource?.() ?? []
    const pose    = this.rig.current
    const height  = this.container.clientHeight
    const bottom  = height > 0 ? -1 + (2 * HALO_BOTTOM_PX) / height : -0.97
    let aimed     = false
    const edges   = (track: number): ViewEdges | null => {
      const view = this.trackViews[track]
      if (!view) return null
      if (!aimed) this.aimProbe(pose)
      aimed      = true
      return {
        top   : view.headerBottom,
        bottom: this.probedHeight(pose, this.frontX(track) + FRONT_W / 2, bottom)
      }
    }
    const playing = this.playheads.update(heads, this.layout, this.trackViews, this.palette, dt, edges)
    this.tablePlayheads.update(this.tablePlayback, this.layout, this.trackViews, this.palette, heads, performance.now())
    if (playing && this.followPlayback) this.aimAtPlayhead()
    return playing
  }

  /**
   * Scrolls the view for the playhead furthest down the song to show at PLAYHEAD_NDC_Y on the
   * focused track's column, whatever the angle; false when nothing plays.
   */
  private aimAtPlayhead(): boolean {
    const point = this.playheadPoint(this.focusTrack())
    if (!point) return false
    showAtHeight(this.rig.goal, this.lens(), point, PLAYHEAD_NDC_Y)
    // Within the view's limits at once, so a navigation does not take the clamp for a move of its own.
    this.rig.clampGoal()
    return true
  }

  /** The playhead furthest down the song, on a track's front column; null when nothing plays. */
  private playheadPoint(track: number): Vector3 | null {
    const position = this.playheads.leadPosition()
    if (position == null || !this.layout) return null
    const row = Math.floor(position)
    return new Vector3(this.settledX(track) + FRONT_W / 2, PlayheadView.rowY(this.layout, row, position - row), 0)
  }

  /** Scrolls once to where the song plays (the playhead furthest down); false when it does not play. */
  jumpToPlayhead(): boolean {
    const jumped = this.aimAtPlayhead()
    if (jumped) this.invalidate()
    return jumped
  }

  /**
   * Keeps the last track in view: the view may not go further right than the middle of its
   * column (or along its wall when it is unfolded), measured where the tracks settle, so folding
   * a wall pulls the view back with it. Turned, a little more, as the target stands off the
   * wall in depth. Nor may it rise so far above the start of the song that the headers, resting
   * over its first row, show lower than HEADER_LOWEST_NDC.
   */
  private limitPan(): void {
    const last = this.trackViews.length - 1
    if (last < 0) return
    const goal           = this.rig.goal
    const turn           = smoothstep(TURN_YAWS[0], TURN_YAWS[1], goal.yaw)
    this.rig.bounds.maxX = this.settledX(last) + FRONT_W / 2 + this.settledWidth(last) + turn * (FRONT_W + OPEN_GAP)
    const restTop        = this.layout ? this.layout.headerRestY + HEADER_TOP : null
    if (restTop == null || this.container.clientHeight <= 0) return
    // Scrolling moves everything alike: the highest target puts the resting headers' top edge on that line of the screen.
    this.aimProbe(goal)
    const tracks = this.guideTracks(goal)
    let shown    = 0
    for (const track of tracks) shown += this.probedHeight(goal, this.settledX(track) + FRONT_W / 2, HEADER_LOWEST_NDC)
    this.rig.bounds.maxY = goal.target.y + restTop - shown / tracks.length
    // A song shorter than the view: its top wins.
    this.rig.bounds.minY = Math.min(this.layout?.bottomY ?? this.rig.bounds.minY, this.rig.bounds.maxY)
  }

  /** Applies the view's limits (see limitPan) to the goal at once, so a framing measures where the view will be. */
  private clampGoal(): void {
    this.limitPan()
    this.rig.clampGoal()
  }

  /** Tells the view how many pixels at its top the HUD covers: the track headers stick right under them. */
  setTopInset(pixels: number): void {
    if (Math.abs(pixels - this.topInset) < 1) return
    this.topInset = pixels
    this.invalidate()
  }

  /** Tells the view which parts of it the HUD's selection panel covers (see frameMargins). */
  setCoveredAreas(areas: CoveredArea[]): void {
    this.covered = areas.map((area) => ({ ...area }))
  }

  /**
   * The margins of an automatic framing of things that span the screen heights low..high
   * (normalized, -1 bottom to 1 top; the whole height by default): wider on a side where a panel
   * of the HUD covers some of those heights, so they stay clear of it, as long as that leaves
   * MIN_FREE_WIDTH of the view.
   */
  private frameMargins(low = -1, high = 1): Margins {
    const width  = this.container.clientWidth
    const height = this.container.clientHeight
    let left     = FRAME_MARGINS.left
    let right    = FRAME_MARGINS.right
    if (width <= 0 || height <= 0) return FRAME_MARGINS
    for (const area of this.coverage?.() ?? this.covered) {
      const top    = 1 - (2 * (area.top - COVER_GAP_PX)) / height
      const bottom = 1 - (2 * (area.top + area.height + COVER_GAP_PX)) / height
      if (high < bottom || low > top) continue
      // Margins are fractions of the half width, from each edge to the panel's inner edge and the gap.
      if (area.left + area.width / 2 > width / 2) right = Math.max(right, (2 * (width - area.left + COVER_GAP_PX)) / width)
      else left = Math.max(left, (2 * (area.left + area.width + COVER_GAP_PX)) / width)
    }
    if (left + right > 2 * (1 - MIN_FREE_WIDTH)) return FRAME_MARGINS
    return {
      left,
      right
    }
  }

  /** The screen heights (normalized, -1 bottom to 1 top) that points span from the goal view. */
  private screenHeights(points: Vector3[]): [low: number, high: number] {
    this.aimProbe(this.rig.goal)
    const heights = points.map((point) => this.probePoint.copy(point).project(this.probeCamera).y)
    return [Math.min(...heights), Math.max(...heights)]
  }

  /** The tracks that guide the header height: the focused one (chosen, followed, selected or turned to), else all of them. */
  private guideTracks(pose: RigPose): number[] {
    const focused = this.handTrack != null || this.followedTrack != null || this.selection != null || pose.yaw > TURNED_YAW
    return focused ? [this.focusTrack()] : this.trackViews.map((_, track) => track)
  }

  /**
   * World height of the headers' top edge for a pose: the one at which the guide track's
   * header shows right under the HUD (the other tracks share its height). With no track
   * focused, the mean over every track. `settled` places the tracks where their columns will
   * be once the walls have moved.
   */
  private headerTopEdge(pose: RigPose, settled: boolean): number {
    const height = this.container.clientHeight
    const ndcTop = height > 0 ? 1 - (2 * (this.topInset + HEADER_GAP_PX)) / height : 0.82
    this.aimProbe(pose)
    const tracks = this.guideTracks(pose)
    let sum      = 0
    for (const track of tracks) sum += this.probedHeight(pose, (settled ? this.settledX(track) : this.frontX(track)) + FRONT_W / 2, ndcTop)
    return sum / tracks.length
  }

  /** Puts the probe camera at `pose`, for probedHeight. */
  private aimProbe(pose: RigPose): void {
    const probe = this.probeCamera
    placeCamera(pose, probe)
    probe.projectionMatrix.copy(this.camera.projectionMatrix)
    probe.updateMatrixWorld()
  }

  /** The height at `x` on the tracks' plane (or `z` off it) that the probe camera (aimed at `pose`) shows at screen height `ndcY`, -1 bottom to 1 top. */
  private probedHeight(pose: RigPose, x: number, ndcY: number, z = 0): number {
    const miss = (y: number) => this.probePoint.set(x, y, z).project(this.probeCamera).y - ndcY
    // Perspective bends the height a little with depth: a few secant steps from the flat estimate.
    let y      = pose.target.y + this.visibleHalfHeight(pose.distance) * ndcY
    for (let step = 0; step < 3; step += 1) {
      const here  = miss(y)
      const slope = (miss(y + 0.5) - here) / 0.5
      if (Math.abs(slope) < 1e-6) break
      y -= here / slope
    }
    return y
  }

  /**
   * Where things stick for a pose: headers right under the HUD, panels a little below them
   * (low enough for the tab over their corner to stay clear of the header) and down to `bottom`.
   * Headers rest lower at the start of the song (see SongLayout.headerRestY), and panels stay
   * below them; `view` is the panels' height when the headers are stuck (it tells the zoom).
   */
  private stickRange(pose: RigPose, settled = false, glidedOffset: number | null = null): { headerTop: number; panelTop: number; bottom: number; view: number } {
    const centerY   = pose.target.y
    const half      = this.visibleHalfHeight(pose.distance)
    const headerTop = glidedOffset != null ? centerY + glidedOffset : this.headerTopEdge(pose, settled) - HEADER_TOP
    const below     = ROW_H + 0.95 + PANEL_TAB_ROOM
    const bottom    = centerY + half * VIEW_BOTTOM_NDC
    const restY     = this.layout?.headerRestY ?? Number.POSITIVE_INFINITY
    return {
      headerTop,
      panelTop: Math.min(headerTop, restY) - below,
      bottom,
      view    : headerTop - below - bottom
    }
  }

  /** Sticky headers and panels, panel glides and links; returns true while anything moves. */
  private updateStickyParts(dt: number, textOn: boolean): boolean {
    const layout = this.layout
    if (!layout) return false
    let busy          = false
    let panelsMoved   = false
    const half        = this.visibleHalfHeight()
    const centerY     = this.rig.current.target.y
    // The headers glide to where they belong (another guide track, a wrapped top bar), as an offset from the view's centre so scrolling stays exact.
    const aimed       = this.stickRange(this.rig.current).headerTop - centerY
    this.headerOffset = this.headerOffset == null ? aimed : this.headerOffset + (aimed - this.headerOffset) * easeFactor(dt, HEADER_GLIDE_RATE)
    if (Math.abs(aimed - this.headerOffset) > 1e-3) busy = true
    else this.headerOffset = aimed
    const { headerTop, panelTop, bottom, view: viewHeight } = this.stickRange(this.rig.current, false, this.headerOffset)
    for (const view of this.trackViews) {
      if (view.setHeaderY(headerTop)) busy = true
      if ((view.panelsAlpha > 0.01 || this.opened(view.track.track).panels) && layout.stick(view.track.track, panelTop, bottom, viewHeight)) panelsMoved = true
      view.panelCeiling = panelTop
      if (view.updatePanels(dt, textOn)) panelsMoved = true
      if (view.panelsAlpha > 0.01 && view.updateLinks(centerY + half * 1.05, centerY - half * 1.05)) busy = true
    }
    // Markers and thick links attached to a panel follow it, frame by frame.
    if (panelsMoved && this.selection) this.refreshMarkers()
    return busy || panelsMoved
  }

  /**
   * Eases the unfolding of every track's wall and places the tracks along x as they open. While a
   * wall is unfolded and the view looks along it, the tracks that are folded leave.
   */
  private updateWalls(dt: number): boolean {
    let busy      = false
    const yaw     = this.rig.current.yaw
    const anyOpen = this.folds.some((_, track) => this.isUnfolded(track))
    const staying = anyOpen ? 1 - smoothstep(OTHERS_LEAVE_YAWS[0], OTHERS_LEAVE_YAWS[1], yaw) : 1
    const ease    = easeFactor(dt, WALL_EASE_RATE)
    let x         = 0
    for (let track = 0; track < this.trackViews.length; track += 1) {
      const view    = this.trackViews[track]
      const fold    = this.opened(track)
      const amounts = this.unfolding[track]
      for (const section of ['fx', 'panels'] as const) {
        const goal       = fold[section] ? 1 : 0
        const before     = amounts[section]
        amounts[section] += (goal - before) * ease
        if (Math.abs(goal - amounts[section]) < 0.001) amounts[section] = goal
        if (amounts[section] !== before) busy = true
      }
      const frontAlpha = this.isUnfolded(track) ? 1 : staying
      const slide      = this.wallSlide(amounts.fx)
      const wallLen    = this.layout?.tracks[track]?.wallLen ?? 0
      const before     = this.shownWallLen[track] ?? wallLen
      let shownLen     = before + (wallLen - before) * ease
      if (Math.abs(wallLen - shownLen) < 0.01) shownLen = wallLen
      if (shownLen !== before) {
        this.shownWallLen[track] = shownLen
        view.setWallLength(shownLen)
        busy = true
      }
      const changed    =
        Math.abs(view.group.position.x - x) > 1e-4 || Math.abs(view.frontAlpha - frontAlpha) > 1e-4 || view.sideAlpha !== amounts.fx || view.panelsAlpha !== amounts.panels
      if (changed) busy = true
      view.group.position.x = x
      view.setFolds(amounts.fx, amounts.panels, slide)
      view.setFrontAlpha(frontAlpha)
      x += TRACK_PITCH + this.openWidth(track, amounts.fx, amounts.panels, view.faceAmount(), shownLen)
    }
    // The thick links of the selection go with the details or the panels they join.
    if (this.selectedLinks && this.selection) {
      const view                 = this.trackViews[selectionTrack(this.selection)]
      this.selectedLinks.visible = !!view && view.panelsAlpha > 0.05
    }
    // The rules between song rows cross every track, to the end of the last: they leave with the folded tracks, or they would cut across the view along the wall.
    const rules = this.bandRules
    if (rules) {
      const material = rules.material as LineBasicMaterial
      const width    = x + 4
      if (Math.abs(material.opacity - BAND_RULE_OPACITY * staying) > 1e-4 || Math.abs(rules.scale.x - width) > 1e-3) busy = true
      material.opacity = BAND_RULE_OPACITY * staying
      rules.position.x = -4
      rules.scale.x    = width
    }
    return busy
  }

  private tick(): void {
    const now       = performance.now()
    const dt        = Math.min(0.05, (now - this.lastTickAt) / 1000)
    this.lastTickAt = now
    this.noteSettledColumns()
    this.limitPan()
    let busy       = this.rig.update(dt)
    const pxPerRow = (ROW_H / (2 * this.visibleHalfHeight())) * this.container.clientHeight
    const textOn   = pxPerRow > MIN_TEXT_PX_PER_ROW
    if (this.updateStickyParts(dt, textOn)) busy = true
    if (this.updateWalls(dt)) busy = true
    const playing = this.updatePlayheads(dt)

    this.rig.apply(this.camera)
    const camera    = this.rig.current
    const half      = this.visibleHalfHeight()
    const barsAlpha = 0.08 + 0.82 * (1 - smoothstep(5, 10, pxPerRow))
    for (const view of this.trackViews) view.setBarsAlpha(barsAlpha)
    const fog = this.scene.fog as Fog
    fog.near  = camera.distance * 1.05 + 10
    fog.far   = camera.distance * 2.2 + 160

    const reach       = half * (1.25 + Math.abs(Math.sin(camera.pitch)) * 2)
    const textChanged = this.pool.update(camera.target.y + reach, camera.target.y - reach, camera.target.y, (block) => {
      if (!textOn && block.layer !== 'static') return 0
      if (block.layer === 'wall') return this.trackViews[block.track]?.sideAlpha ?? 0
      return block.track < 0 ? 1 : (this.trackViews[block.track]?.frontAlpha ?? 1)
    })

    const pulsing     = this.devicePlaces.length > 0
    if (pulsing) {
      const opacity = 0.55 + 0.45 * Math.sin(now / 180)
      for (const marker of this.deviceMarkers) marker.outlineOpacity = opacity
    }
    this.renderAtCadence(now, {
      moving: this.dirty || busy || textChanged,
      playing,
      pulsing
    })
  }

  /**
   * yam8d draws the M8 screen next to this page: full frame rate only while the view is
   * being handled, 50 fps while the song plays (the glide and the beat flashes), at most
   * ~40 fps for other animations, nothing when still.
   */
  private renderAtCadence(now: number, state: { moving: boolean; playing: boolean; pulsing: boolean }): void {
    const interacting = now - this.interactedAt < INTERACTION_MS
    const interval    = interacting
      ? 0
      : state.playing
        ? PLAYING_FRAME_MS
        : state.moving
          ? MOVING_FRAME_MS
          : state.pulsing
            ? PULSE_FRAME_MS
            : Number.POSITIVE_INFINITY
    const sinceRender = now - this.renderedAt
    // 2 ms of slack for frame timing jitter.
    if (sinceRender < interval - 2) return
    this.renderer.render(this.scene, this.camera)
    // Keep the cadence (50 fps on a 60 Hz screen skips one frame in six, evenly) unless far behind.
    this.renderedAt = interval > 0 && sinceRender < interval * 2 ? this.renderedAt + interval : now
    this.dirty      = false
  }
}

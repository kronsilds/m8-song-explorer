// The 3D view: builds a TrackView per track, frames the camera, opens the wall of the focused
// track as the view turns, keeps text alive near the camera, and turns pointer input into
// selections. Picking, pointer input, markers and playheads live in their own modules.

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
import { PHRASE_COLUMNS, TABLE_COLUMNS } from '../model/columns'
import { hex2 } from '../model/hex'
import { TablePlayback } from '../model/music/tablePlayback'
import { isWallCell, type Selection, sameSelection, selectionTrack } from '../model/selection'
import { ROWS_PER_PHRASE, ROWS_PER_TABLE, type SongModel, TRACKS } from '../model/song'
import { phraseMoved, trackMoved } from '../model/stepMoves'
import type { PhraseInstance } from '../model/timeline'
import { FACING_FRONT_YAW, presetAngles, type TurnPreset, type ViewPreset } from './camera/cameraAngles'
import { fitDistance, type Lens, rayMeets, rayThrough, screenX, shiftTarget, sideShift } from './camera/framing'
import { CameraRig, placeCamera, type RigPose } from './camera/rig'
import { type SceneButton, ScenePicker } from './input/picker'
import { bindPointerControls, PAN_MIN_COS, type PointerTarget } from './input/pointerControls'
import { isTitlePlace, placeOf } from './instrumentFace'
import {
  BAND_GAP,
  CHAR_W,
  FRONT_W,
  HEADER_H,
  type Link,
  PANEL_CHARS,
  PANEL_COL_W,
  PANEL_U0,
  type Panel,
  ROW_H,
  SongLayout,
  TRACK_GAP,
  TRACK_PITCH,
  WALL_ANGLE,
  WALL_HINGE,
} from './layout'
import { CellMarker, type CellRect } from './markers/cellMarker'
import { cellRects } from './markers/cellRects'
import { PlayheadView, type ViewEdges } from './markers/playheadView'
import { TablePlayheadView } from './markers/tablePlayheadView'
import type { Palette } from './palette'
import { easeFactor, linkCurve, smoothstep } from './shapes'
import { RichText, type TextBlock, TextPool } from './text'
import { HEADER_TOP } from './track/trackHeader'
import { PANEL_TAB_ROOM, type PanelFace, TrackView } from './track/trackView'

export type { ViewPreset } from './camera/cameraAngles'

/** Room between an open wall's far end and the next track's column. */
const OPEN_GAP            = 12
/** Walls open as the view turns between these yaws, and other tracks leave between the second pair. */
const WALL_OPEN_YAWS      = [MathUtils.degToRad(5), MathUtils.degToRad(24)] as const
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
/** Turned toward the walls, a pan opens the next track this far (world x) past the halfway mark, either way. */
const PAN_SLACK           = TRACK_PITCH / 4
/** Where a cell lands after the view scrolls to it, as a fraction of the visible stretch from the edge opposite to where it left (so a scroll is about 4/5 of a page). */
const SCROLL_LAND         = 0.2
/** Following the M8: a cell lands this many rows under the headers, and the view scrolls when fewer rows than LOOKAHEAD_ROWS are left under it. */
const LAND_TOP_ROWS       = 2
const LOOKAHEAD_ROWS      = 4
/** Pixels between the HUD and the headers' top edge. */
const HEADER_GAP_PX       = 8
/** Pixels above the bottom of the view where the halo of a playhead below it sits: just over the footer line. */
const HALO_BOTTOM_PX      = 26
/** Ease rate per second of the headers' glide to their height (the pose eases at 9). */
const HEADER_GLIDE_RATE   = 15.5
/** A turn by hand brings the open track to the middle of the view over this much turn. */
const CENTRE_TURN         = MathUtils.degToRad(25)

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
  /** Where the headers' top stands above the view's centre now (gliding to where it belongs); null before the first frame. */
  private headerOffset         : number | null = null
  readonly pool                = new TextPool()
  layout                       : SongLayout | null = null
  palette                      : Palette
  onSelect                     : (selection: Selection | null) => void = () => {}
  onHover                      : (selection: Selection | null) => void = () => {}
  /** A track's mute or solo button was clicked. */
  onTrackButton                : (track: number, kind: TrackToggle) => void = () => {}
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
  /** How open each track's wall is (0..1), easing toward its goal. */
  private wallOpenness                  : number[] = Array(TRACKS).fill(0)
  private allWallsOpen                  = false
  /** Track whose wall opens when nothing is selected. */
  private focusedTrack                  = 0
  /** Track opened by hand (a turn started on it, or panned to while turned); wins until the next selection or cursor move. */
  private handTrack                     : number | null = null
  /** The turn by hand under way: the target and the yaw it started from, and where the open track was centred then. */
  private turning                       : { base: Vector3; pivot: Vector3; yaw: number } | null = null
  /** Track the M8 cursor is on while following it; wins over the selection. */
  private followedTrack                 : number | null = null
  /** The device place last followed: the same place again (a screen refresh) changes nothing, so a click wins until the cursor moves. */
  private followedSelection             : Selection | null = null
  /** The view was turned by following, so following a front cell turns it back. */
  private turnedByFollowing             = false
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
    this.layout        = new SongLayout(model, this.trimTables)
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
      const view       = new TrackView(layout, track, this.palette, this.playedNotes)
      view.onTextReady = () => this.invalidate()
      view.faceGoal    = (panel) => this.faceGoal(panel)
      view.setTrackModes(!!this.trackModes.muted[track.track], !!this.trackModes.soloed[track.track])
      view.group.position.x = track.track * TRACK_PITCH
      this.root.add(view.group)
      this.trackViews.push(view)
      blocks.push(...view.blocks)
    }
    const rightEdge = layout.tracks.reduce((x, track) => x + TRACK_PITCH + track.wallExtent + OPEN_GAP, 0) + 10
    blocks.push(...this.buildSpine(layout, rightEdge))
    this.pool.setBlocks(blocks)
    this.rig.bounds = {
      minX: -10,
      maxX: rightEdge,
      minY: layout.bottomY,
      maxY: layout.rowY(0) + HEADER_H
    }
    this.removeSelectedLinks()
    this.refreshMarkers()
    this.invalidate()
  }

  /** Song row numbers down the left edge, a rule between song rows across the tracks, and the song title. */
  private buildSpine(layout: SongLayout, rightEdge: number): TextBlock[] {
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
      rules.push(-4, ruleY, -0.2, rightEdge, ruleY, -0.2)
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

  private overviewDistance(): number {
    return this.distanceToFit((TRACKS * TRACK_PITCH + 6) * 1.04, 40)
  }

  /**
   * Left edge of a track's front column; `settled` gives where it will be once the walls
   * finish moving, for a view turned `turn` (0 facing the front, walls closed .. 1 turned).
   */
  private frontX(track: number, settled = false, turn = 1): number {
    if (!settled) return this.trackViews[track]?.group.position.x ?? track * TRACK_PITCH
    return this.frontXWith(track, this.focusTrack(), turn)
  }

  /** Left edge of a track's front column once the walls settle with `focus` the open track. */
  private frontXWith(track: number, focus: number, turn: number): number {
    let x = 0
    for (let t = 0; t < track; t += 1) x += TRACK_PITCH + (this.allWallsOpen || t === focus ? turn * (this.wallExtent(t) + OPEN_GAP) : 0)
    return x
  }

  /** How far a track's open wall reaches along x. */
  private wallExtent(track: number): number {
    return this.layout?.tracks[track]?.wallExtent ?? 0
  }

  view(preset: ViewPreset, immediate = false): void {
    const goal   = this.rig.goal
    const layout = this.layout
    // Nothing chosen: the track in the middle of the view is the one that opens.
    if (preset !== 'overview' && this.handTrack == null && this.followedTrack == null && !this.selection) {
      this.focusedTrack = this.trackUnder(0) ?? this.focusedTrack
    }
    if (preset === 'overview') {
      const width   = TRACKS * TRACK_PITCH + 6
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
    if (preset === 'angle' || preset === 'side') goal.target.copy(this.trackCentre(goal, this.focusTrack(), true, true))
    else if (preset === 'front') this.frameFront()
    if (immediate) this.rig.jump()
    this.invalidate()
  }

  /** Turns the goal to a preset's angles (a new dramatic take each cut). */
  private aim(preset: TurnPreset): void {
    if (this.dramatic) this.cuts += 1
    Object.assign(this.rig.goal, presetAngles(preset, this.dramatic, this.cuts))
  }

  /** Switches dramatic angles; the current preset is taken again the new way. */
  setDramatic(on: boolean): void {
    this.dramatic = on
    if (this.preset) this.view(this.preset)
    else if (!on) this.rig.goal.roll = 0
    this.invalidate()
  }

  toggleAllWalls(): boolean {
    this.allWallsOpen = !this.allWallsOpen
    this.invalidate()
    return this.allWallsOpen
  }

  zoom(factor: number): void {
    this.rig.goal.distance *= factor
    this.invalidate()
  }

  scrollRows(rows: number): void {
    this.rig.goal.target.y -= rows * ROW_H
    this.invalidate()
  }

  /** The track whose wall opens: the one opened by hand, else the followed one, else the selected one, else the one in the middle of the view. */
  focusTrack(): number {
    if (this.handTrack != null) return this.handTrack
    if (this.followedTrack != null) return this.followedTrack
    return this.selection ? selectionTrack(this.selection) : this.focusedTrack
  }

  /** The track whose wall is open now, and where its column will settle. */
  private focusAnchor(): { track: number; left: number } {
    const track = this.focusTrack()
    return {
      track,
      left: this.frontX(track, true)
    }
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

  /**
   * Points across what a framing shows of a track, where it settles, for the goal view: its
   * front column, and when `open` its wall up to the panels shown for the rows in view (at
   * least its first panel column), and the panels turned out of it.
   */
  private trackSpan(track: number, open: boolean): Vector3[] {
    const goal  = this.rig.goal
    const y     = goal.target.y
    const left  = this.frontX(track, true, open ? 1 : 0)
    const front = [new Vector3(left, y, 0), new Vector3(left + FRONT_W, y, 0)]
    const lanes = this.layout?.tracks[track]
    if (!open || !this.layout || !lanes) return front
    const onWall = (u: number) => new Vector3(left + WALL_HINGE + u * Math.cos(WALL_ANGLE), y, -u * Math.sin(WALL_ANGLE))
    // Which panels the rows in view would show, and in which columns (the panels themselves stay where they are).
    const range  = this.stickRange(goal, true)
    let end      = Math.min(lanes.wallLen, PANEL_U0 + PANEL_COL_W)
    for (const { panel, u } of this.layout.probe(track, range.panelTop, range.bottom, range.view)) {
      if (panel.flip < 0.05) end = Math.max(end, Math.min(lanes.wallLen, u + PANEL_CHARS * CHAR_W + 1))
    }
    const turned = (this.trackViews[track]?.turnedPanelEnds() ?? []).map((point) => new Vector3(point.x + left, y, point.z))
    return [...front, onWall(end), ...turned]
  }

  /**
   * The target that centres a track on screen for a pose's angles and distance: its front
   * column, or with `open` its column and open wall together. The same framing for every
   * track. `fit` also sets the pose's distance to the one at which they fill the screen
   * (within readable distances).
   */
  private trackCentre(pose: RigPose, track: number, open: boolean, fit = false): Vector3 {
    const lens  = this.lens()
    const probe = {
      ...pose,
      target: pose.target.clone()
    }
    let points  = this.trackSpan(track, open)
    // Twice when fitting: standing elsewhere shows other rows, and so maybe other panels.
    for (let pass = 0; pass < (fit ? 2 : 1); pass += 1) {
      const box      = new Box3().setFromPoints(points)
      probe.target.x = (box.min.x + box.max.x) / 2
      probe.target.z = (box.min.z + box.max.z) / 2
      if (!fit) break
      const [near, far] = this.readableDistances()
      probe.distance    = fitDistance(probe, lens, points, FRAME_MARGINS, near, far)
      pose.distance     = probe.distance
      points            = this.trackSpan(track, open)
    }
    shiftTarget(probe, sideShift(probe, lens, points, FRAME_MARGINS, [], 'center'))
    return probe.target
  }

  /** Where the target goes to centre the focused track at the goal's yaw: its column facing the front, blending to its column and wall as the wall opens. */
  private trackPivot(): Vector3 {
    const goal  = this.rig.goal
    const track = this.focusTrack()
    const turn  = this.wallTurn(goal.yaw)
    const front = this.trackCentre(goal, track, false)
    return turn > 0 ? front.lerp(this.trackCentre(goal, track, true), turn) : front
  }

  /**
   * Facing the front, a framing of the tracks as a whole: centred on all of them, then slid
   * no more than it takes for the focused track's column to be on screen.
   */
  private frameFront(): void {
    const goal = this.rig.goal
    const last = this.trackViews.length - 1
    if (last < 0) return
    const y    = goal.target.y
    const lens = this.lens()
    const all  = [new Vector3(0, y, 0), new Vector3(this.frontX(last, true, 0) + FRONT_W, y, 0)]
    goal.target.set((all[0].x + all[1].x) / 2, y, 0)
    shiftTarget(goal, sideShift(goal, lens, all, FRAME_MARGINS, [], 'center'))
    shiftTarget(goal, sideShift(goal, lens, this.trackSpan(this.focusTrack(), false), FRAME_MARGINS))
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
    const ray        = rayThrough(pose, this.lens(), ndcX, ndcY)
    const meet       = (ax: number, az: number, bx: number, bz: number) => rayMeets(ray, new Vector3(ax, 0, az), new Vector3(bx, 0, bz))
    let nearest      : number | null = null
    let nearestAlong = Number.POSITIVE_INFINITY
    for (let track = 0; track < this.trackViews.length; track += 1) {
      const left = this.frontX(track)
      const hits = [meet(left - TRACK_GAP / 2, 0, left + FRONT_W + TRACK_GAP / 2, 0)]
      const wall = this.trackViews[track].wallAlpha > 0.5 ? this.layout?.tracks[track]?.wallLen : undefined
      if (wall) hits.push(meet(left + WALL_HINGE, 0, left + WALL_HINGE + wall * Math.cos(WALL_ANGLE), -wall * Math.sin(WALL_ANGLE)))
      for (const along of hits) if (along != null && along < nearestAlong) [nearest, nearestAlong] = [track, along]
    }
    return nearest
  }

  /** Opens another track's wall by hand; the view moves with that track's column, so it stays where it is on screen. */
  private openByHand(track: number): void {
    const turn             = this.wallTurn(this.rig.goal.yaw)
    const before           = this.frontX(track, true, turn)
    this.handTrack         = track
    const moved            = this.frontX(track, true, turn) - before
    this.rig.goal.target.x += moved
    this.invalidate()
  }

  /**
   * Follows the M8 cursor: its track becomes the focused one; a wall cell (velocity,
   * instrument, FX, a table, an instrument panel) turns the view and opens the wall, a
   * note, chain or song cell turns it back to the front. Null stops following.
   */
  follow(selection: Selection | null, options: { scroll?: boolean } = {}): void {
    if (selection && sameSelection(selection, this.followedSelection)) return
    this.followedSelection = selection
    if (!selection) {
      if (this.followedTrack != null) this.focusedTrack = this.followedTrack
      this.followedTrack     = null
      this.turnedByFollowing = false
      this.invalidate()
      return
    }
    const from         = this.focusAnchor()
    this.handTrack     = null
    this.followedTrack = selectionTrack(selection)
    this.turnFor(selection, from, options.scroll !== false, true)
    this.invalidate()
  }

  /**
   * A wall cell turns the view and opens the wall; a note, chain or song cell turns it back
   * to the front when it was turned that way. Then scrolls the cell into view, unless
   * `scroll` is off (the playheads scroll the view while the song plays).
   */
  private turnFor(selection: Selection, from: { track: number; left: number }, scroll = true, landTop = false): void {
    const goal         = this.rig.goal
    const trackChanged = from.track !== selectionTrack(selection)
    const onWall       = isWallCell(selection)
    if (onWall && (goal.yaw < FACING_FRONT_YAW || trackChanged)) {
      this.view('angle')
      this.turnedByFollowing = true
    }
    const turnedBack = !onWall && this.turnedByFollowing
    if (turnedBack) {
      this.aim('front')
      this.preset            = 'front'
      goal.target.z          = 0
      this.turnedByFollowing = false
    }
    // Keep the cell in view, measured where it will be once the walls have moved.
    const point = this.settledPoint(selection)
    const half  = this.visibleHalfHeight(goal.distance) * 0.7
    if (point && scroll) this.scrollRowsInto(point.y + ROW_H / 2, point.y - ROW_H / 2, landTop)
    if (goal.yaw >= FACING_FRONT_YAW) {
      // Turned: another track takes the same framing, at the same distance; the cell stays on screen.
      if (trackChanged) goal.target.copy(this.trackCentre(goal, selectionTrack(selection), true))
      if (point) shiftTarget(goal, sideShift(goal, this.lens(), [point], FRAME_MARGINS))
    } else if (point && (scroll || turnedBack) && (turnedBack || Math.abs(point.x - goal.target.x) > half * this.camera.aspect)) {
      this.frameFront()
    }
    this.invalidate()
  }

  /** World centre of a selection's cell once the track positions have settled. */
  private settledPoint(selection: Selection): Vector3 | null {
    const rect = this.rectsOf(selection).at(-1)
    if (!rect) return null
    const track = selectionTrack(selection)
    const point = new Vector3(rect.x + rect.w / 2, rect.y - rect.h / 2, 0)
    const view  = this.trackViews[track]
    // Into the track's group (the wall, or a panel turned out of it), whose x is then where it settles.
    for (let object: Object3D | null = rect.parent; view && object && object !== view.group; object = object.parent) {
      object.updateMatrix()
      point.applyMatrix4(object.matrix)
    }
    point.x += this.frontX(track, true)
    return point
  }

  /** Moves the camera so a selection is in view (turning toward the wall for wall cells). */
  focusSelection(selection = this.selection): void {
    if (!selection) return
    const rect = this.rectsOf(selection).at(-1)
    if (!rect) return
    const world  = rect.parent.localToWorld(new Vector3(rect.x + rect.w / 2, rect.y - rect.h / 2, 0))
    const goal   = this.rig.goal
    const onWall = rect.parent !== this.trackViews[selectionTrack(selection)]?.front
    if (onWall && goal.yaw < FACING_FRONT_YAW) {
      this.aim('angle')
      this.preset = null
    }
    goal.target.set(world.x, world.y, onWall ? world.z : 0)
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
   * edge, so the view moves most of a page and the next moves need no scrolling.
   */
  private scrollRowsInto(top: number, bottom: number, landTop = false): void {
    const goal        = this.rig.goal
    const range       = this.stickRange(goal, true)
    const viewTop     = range.headerTop - ROW_H - 0.4
    const span        = viewTop - range.bottom
    const aboveCentre = viewTop - goal.target.y
    const belowCentre = goal.target.y - range.bottom
    if (landTop) {
      // What follows a cell matters more than what precedes it: scroll when it sits too low, and land it just under the headers.
      if (bottom < range.bottom + LOOKAHEAD_ROWS * ROW_H || top > viewTop) goal.target.y = top - aboveCentre + LAND_TOP_ROWS * ROW_H
      return
    }
    if (bottom < range.bottom) goal.target.y = top - aboveCentre + span * SCROLL_LAND
    else if (top > viewTop) goal.target.y = bottom + belowCentre - span * SCROLL_LAND
  }

  private scrollIntoView(selection: Selection): void {
    const rect = this.rectsOf(selection).at(-1)
    if (!rect) return
    const world = rect.parent.localToWorld(new Vector3(rect.x, rect.y, 0))
    const goal  = this.rig.goal
    const half  = this.visibleHalfHeight(goal.distance) * 0.8
    this.scrollRowsInto(world.y, world.y - rect.h)
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
    this.invalidate()
  }

  /** Turns a panel over by hand. */
  toggleFace(track: number, table: number): void {
    const panel = this.panelOf(track, table)
    if (!panel || panel.instrument == null || !this.layout?.instrumentFace(panel.instrument)) return
    this.facesByHand.set(`${track}:${table}`, this.faceGoal(panel) === 'inst' ? 'table' : 'inst')
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
    const changed = !sameSelection(selection, this.selection)
    const from    = this.focusAnchor()
    if (!selection) this.focusedTrack = from.track
    // A choice made here wins over the followed M8 cursor until the cursor moves, and over a track opened by hand.
    if (!options.silent) {
      this.followedTrack = null
      this.handTrack     = null
    }
    this.selection = selection
    this.refreshMarkers()
    if (selection && options.turn) this.turnFor(selection, from, true, options.landTop)
    else if (selection && options.reveal !== false) this.scrollIntoView(selection)
    if (selection && options.focus) this.focusSelection(selection)
    if (changed && !options.silent) this.onSelect(selection)
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
      const [from, to] = view.linkEnds(link.row, link.col, link.panel.shownY, link.panel.shownU)
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
   * After a pan. Turned toward the walls, the neighbour opens once the view leaves the open
   * track's stretch of the pan (see panNeighbour); the camera stays where it is, the walls
   * fold and unfold around it. Facing the front with nothing selected, the track in the middle
   * is the one a turn opens.
   */
  panned(): void {
    if (this.wallTurn(this.rig.goal.yaw) > 0.5) {
      for (let moves = 0; moves < TRACKS; moves += 1) {
        const next = this.panNeighbour()
        if (next == null) break
        this.handTrack = next
      }
      this.invalidate()
      return
    }
    if (this.selection) return
    this.handTrack    = null
    this.focusedTrack = this.trackUnder(0) ?? this.focusedTrack
  }

  /**
   * Turned: the neighbour to open when the view has left the open track's stretch of the pan,
   * else null. The stretch is measured along the pan (the target's x): from where the track is
   * centred, halfway to where its neighbour would be centred once open, plus the part of the
   * track still off screen that side (so a pan can run along a long wall), plus a little slack.
   * The same rule both ways, and the neighbour's stretch starts beyond the slack, so the
   * open track does not flip back and forth.
   */
  private panNeighbour(): number | null {
    const goal      = this.rig.goal
    const focus     = this.focusTrack()
    const turn      = this.wallTurn(goal.yaw)
    const lens      = this.lens()
    const centred   = this.trackCentre(goal, focus, true)
    // Along the line of sight to the goal's depth: the same view, as a pan (which keeps the depth) reaches it.
    const centre    = centred.x + (goal.target.z - centred.z) * Math.tan(goal.yaw)
    const probe     = {
      ...goal,
      target: new Vector3(centre, goal.target.y, goal.target.z)
    }
    const points    = this.trackSpan(focus, true)
    const across    = points.map((point) => screenX(probe, lens, point))
    const leftmost  = points[across.indexOf(Math.min(...across))]
    const rightmost = points[across.indexOf(Math.max(...across))]
    // Shifts along the camera's right, turned into pan x (see pointerControls).
    const perX      = Math.max(PAN_MIN_COS, Math.cos(goal.yaw))
    const offRight  = Math.max(0, sideShift(probe, lens, [rightmost], FRAME_MARGINS)) / perX
    const offLeft   = Math.max(0, -sideShift(probe, lens, [leftmost], FRAME_MARGINS)) / perX
    const own       = (track: number) => this.frontXWith(track, track, turn)
    const x         = goal.target.x
    if (focus + 1 < this.trackViews.length && x > centre + (own(focus + 1) - own(focus)) / 2 + offRight + PAN_SLACK) return focus + 1
    if (focus > 0 && x < centre - (own(focus) - own(focus - 1)) / 2 - offLeft - PAN_SLACK) return focus - 1
    return null
  }

  /** A turn by hand opens the track it started on, and turns around it. */
  turnStarted(clientX: number, clientY: number): void {
    const cell         = this.cellAt(clientX, clientY)
    const [ndcX, ndcY] = this.ndcAt(clientX, clientY)
    const track        = cell ? selectionTrack(cell) : this.trackUnder(ndcX, ndcY, this.rig.current)
    if (track != null && track !== this.focusTrack()) this.openByHand(track)
    this.turning = {
      base : this.rig.goal.target.clone(),
      pivot: this.trackPivot(),
      yaw  : this.rig.goal.yaw
    }
  }

  /**
   * While turning by hand the view turns around the open track: the target's offset from the
   * track's centre turns with the view (so the camera orbits the track), and shrinks as the turn
   * goes on, bringing the track to the middle. The track's centre follows the wall as it opens.
   * The height is left alone, so scrolling (following playback) goes on while turning.
   */
  turnedByHand(): void {
    this.preset   = null
    const turning = this.turning
    if (!turning) return
    const goal   = this.rig.goal
    const turned = goal.yaw - turning.yaw
    const keep   = Math.max(0, 1 - Math.abs(turned) / CENTRE_TURN)
    const dx     = turning.base.x - turning.pivot.x
    const dz     = turning.base.z - turning.pivot.z
    const pivot  = this.trackPivot()
    goal.target.set(
      pivot.x + keep * (dx * Math.cos(turned) + dz * Math.sin(turned)),
      goal.target.y,
      pivot.z + keep * (dz * Math.cos(turned) - dx * Math.sin(turned)),
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

  /** Moves the view to the playhead furthest down the song, a third of the way down the view; false when nothing plays. */
  private aimAtPlayhead(): boolean {
    const position = this.playheads.leadPosition()
    if (position == null || !this.layout) return false
    const row              = Math.floor(position)
    this.rig.goal.target.y = PlayheadView.rowY(this.layout, row, position - row) - this.visibleHalfHeight(this.rig.goal.distance) * 0.35
    return true
  }

  /** Scrolls once to where the song plays (the playhead furthest down); false when it does not play. */
  jumpToPlayhead(): boolean {
    const jumped = this.aimAtPlayhead()
    if (jumped) this.invalidate()
    return jumped
  }

  /** How far the walls open for a yaw (0 facing the front, 1 turned). */
  private wallTurn(yaw: number): number {
    return smoothstep(WALL_OPEN_YAWS[0], WALL_OPEN_YAWS[1], yaw)
  }

  /**
   * Keeps the last track in view: the view may not go further right than the middle of
   * its column (or along its wall when it is open), measured where the tracks settle for
   * the yaw being turned to, so closing the walls pulls the view back with them. Turned, a
   * little more: the target stands off the wall in depth, and the pan must reach past the
   * last track's halfway mark to open it.
   */
  private limitPan(): void {
    const last = this.trackViews.length - 1
    if (last < 0) return
    const turn     = this.wallTurn(this.rig.goal.yaw)
    const focus    = this.focusTrack()
    const openness = (track: number) => (this.allWallsOpen || track === focus ? turn : 0)
    let x          = 0
    for (let track = 0; track < last; track += 1) x += TRACK_PITCH + openness(track) * (this.wallExtent(track) + OPEN_GAP)
    this.rig.bounds.maxX = x + FRONT_W / 2 + openness(last) * this.wallExtent(last) + turn * (FRONT_W + OPEN_GAP)
  }

  /** Tells the view how many pixels at its top the HUD covers: the track headers stick right under them. */
  setTopInset(pixels: number): void {
    if (Math.abs(pixels - this.topInset) < 1) return
    this.topInset = pixels
    this.invalidate()
  }

  /** The tracks that guide the header height: the opened one (chosen, followed, selected or turned to), else all of them. */
  private guideTracks(pose: RigPose): number[] {
    const opened = this.handTrack != null || this.followedTrack != null || this.selection != null || this.wallTurn(pose.yaw) > 0.5
    return opened ? [this.focusTrack()] : this.trackViews.map((_, track) => track)
  }

  /**
   * World height of the headers' top edge for a pose: the one at which the guide track's
   * header shows right under the HUD (the other tracks share its height). With no track
   * opened, the mean over every track. `settled` places the tracks where their columns will
   * be once the walls have moved.
   */
  private headerTopEdge(pose: RigPose, settled: boolean): number {
    const height = this.container.clientHeight
    const ndcTop = height > 0 ? 1 - (2 * (this.topInset + HEADER_GAP_PX)) / height : 0.82
    this.aimProbe(pose)
    const turn   = this.wallTurn(pose.yaw)
    const tracks = this.guideTracks(pose)
    let sum      = 0
    for (const track of tracks) sum += this.probedHeight(pose, (settled ? this.frontX(track, true, turn) : this.frontX(track)) + FRONT_W / 2, ndcTop)
    return sum / tracks.length
  }

  /** Puts the probe camera at `pose`, for probedHeight. */
  private aimProbe(pose: RigPose): void {
    const probe = this.probeCamera
    placeCamera(pose, probe)
    probe.projectionMatrix.copy(this.camera.projectionMatrix)
    probe.updateMatrixWorld()
  }

  /** The height at `x` on the tracks' plane that the probe camera (aimed at `pose`) shows at screen height `ndcY`, -1 bottom to 1 top. */
  private probedHeight(pose: RigPose, x: number, ndcY: number): number {
    const miss = (y: number) => this.probePoint.set(x, y, 0).project(this.probeCamera).y - ndcY
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
    const bottom    = centerY - half * 0.92
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
      if ((view.wallAlpha > 0.01 || this.allWallsOpen) && layout.stick(view.track.track, panelTop, bottom, viewHeight)) panelsMoved = true
      view.panelCeiling = panelTop
      if (view.updatePanels(dt, textOn)) panelsMoved = true
      if (view.wallAlpha > 0.01 && view.updateLinks(centerY + half * 1.05, centerY - half * 1.05)) busy = true
    }
    // Markers and thick links attached to a panel follow it, frame by frame.
    if (panelsMoved && this.selection) this.refreshMarkers()
    return busy || panelsMoved
  }

  /** Walls open as the view turns (the focused track's, or all of them); the other tracks step back, and leave once looking along a wall. */
  private updateWalls(dt: number): boolean {
    let busy          = false
    const yaw         = this.rig.current.yaw
    const turn        = this.wallTurn(yaw)
    const staying     = 1 - smoothstep(OTHERS_LEAVE_YAWS[0], OTHERS_LEAVE_YAWS[1], yaw)
    const othersAlpha = (1 - 0.65 * turn) * staying
    const focus       = this.focusTrack()
    const ease        = easeFactor(dt, WALL_EASE_RATE)
    let x             = 0
    for (let track = 0; track < this.trackViews.length; track += 1) {
      const opens              = this.allWallsOpen || track === focus
      const goal               = opens ? 1 : 0
      const before             = this.wallOpenness[track]
      this.wallOpenness[track] += (goal - before) * ease
      if (Math.abs(goal - this.wallOpenness[track]) < 0.001) this.wallOpenness[track] = goal
      if (this.wallOpenness[track] !== before) busy = true
      const wallAlpha  = this.wallOpenness[track] * turn
      const frontAlpha = opens ? 1 : othersAlpha
      const view       = this.trackViews[track]
      const changed    =
        Math.abs(view.group.position.x - x) > 1e-4 || Math.abs(view.wallAlpha - wallAlpha) > 1e-4 || Math.abs(view.frontAlpha - frontAlpha) > 1e-4
      if (changed) busy = true
      view.group.position.x = x
      view.setWallAlpha(wallAlpha)
      view.setFrontAlpha(frontAlpha)
      x += TRACK_PITCH + wallAlpha * (this.wallExtent(track) + OPEN_GAP)
    }
    // The rules between song rows cross every track: they leave with the other tracks, or they would cut across the view along the wall.
    const rules = this.bandRules?.material as LineBasicMaterial | undefined
    if (rules && Math.abs(rules.opacity - BAND_RULE_OPACITY * staying) > 1e-4) {
      rules.opacity = BAND_RULE_OPACITY * staying
      busy          = true
    }
    return busy
  }

  private tick(): void {
    const now       = performance.now()
    const dt        = Math.min(0.05, (now - this.lastTickAt) / 1000)
    this.lastTickAt = now
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
      if (block.layer === 'wall') return this.trackViews[block.track]?.wallAlpha ?? 0
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

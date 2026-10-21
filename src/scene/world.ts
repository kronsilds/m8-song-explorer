// The 3D view: builds a TrackView per track, frames the camera, opens the wall of the focused
// track as the view turns, keeps text alive near the camera, and turns pointer input into
// selections. Picking, pointer input, markers and playheads live in their own modules.

import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Fog,
  Group,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
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
import { isWallCell, type Selection, sameSelection, selectionTrack } from '../model/selection'
import { ROWS_PER_PHRASE, ROWS_PER_TABLE, type SongModel, TRACKS } from '../model/song'
import type { PhraseInstance } from '../model/timeline'
import { FACING_FRONT_YAW, presetAngles, type TurnPreset, type ViewPreset } from './camera/cameraAngles'
import { CameraRig } from './camera/rig'
import { ScenePicker } from './input/picker'
import { bindPointerControls, type PointerTarget } from './input/pointerControls'
import { BAND_GAP, FRONT_W, HEADER_H, type Panel, ROW_H, SongLayout, TRACK_PITCH, WALL_ANGLE } from './layout'
import { CellMarker, type CellRect } from './markers/cellMarker'
import { cellRects } from './markers/cellRects'
import { PlayheadView } from './markers/playheadView'
import type { Palette } from './palette'
import { easeFactor, linkCurve, smoothstep } from './shapes'
import { RichText, type TextBlock, TextPool } from './text'
import { HEADER_TOP } from './track/trackHeader'
import { TrackView } from './track/trackView'

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

/** How the camera moves when a selection is made. */
export interface SelectOptions {
  /** Not reported through onSelect (and the followed M8 cursor keeps the focus). */
  silent?: boolean
  /** Moves the camera close to it. */
  focus? : boolean
  /** Scrolls just enough for it to be on screen (default on). */
  reveal?: boolean
  /** Turns toward the wall for wall cells, back for front cells. */
  turn?  : boolean
}

export class World implements PointerTarget {
  readonly renderer : WebGLRenderer
  readonly scene    = new Scene()
  readonly camera   = new PerspectiveCamera(34, 1, 0.5, 4000)
  readonly rig      = new CameraRig()
  readonly pool     = new TextPool()
  layout            : SongLayout | null = null
  palette           : Palette
  onSelect          : (selection: Selection | null) => void = () => {}
  onHover           : (selection: Selection | null) => void = () => {}
  /** A track's mute or solo button was clicked. */
  onTrackButton     : (track: number, kind: TrackToggle) => void = () => {}
  /** Scroll with the playhead of the focused track while the song plays. */
  followPlayback    = false

  private readonly root                 = new Group()
  private readonly spine                = new Group()
  private readonly picker               : ScenePicker
  private readonly playheads            = new PlayheadView()
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
  private bandRules                     : LineSegments | null = null
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
    const hadLayout = this.layout != null
    this.layout     = new SongLayout(model)
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
      opacity    : 0.9
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

  private fitDistance(width: number, height: number): number {
    const verticalFov   = MathUtils.degToRad(this.camera.fov)
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect)
    return Math.max(width / 2 / Math.tan(horizontalFov / 2), height / 2 / Math.tan(verticalFov / 2))
  }

  private overviewDistance(): number {
    return this.fitDistance((TRACKS * TRACK_PITCH + 6) * 1.04, 40)
  }

  /**
   * Screen height of the headers' top edge in the overview, as a fraction of the half view
   * height above the centre: the height they stick at in every view.
   */
  private headerFraction(): number {
    const half = this.visibleHalfHeight(this.overviewDistance())
    return 0.82 + (ROW_H * 1.9 + HEADER_TOP - HEADER_H - ROW_H * 1.5) / half
  }

  /** Left edge of a track's front column; `settled` gives where it will be once walls finish opening. */
  private frontX(track: number, settled = false): number {
    if (!settled) return this.trackViews[track]?.group.position.x ?? track * TRACK_PITCH
    const focus = this.focusTrack()
    let x       = 0
    for (let t = 0; t < track; t += 1) x += TRACK_PITCH + (this.allWallsOpen || t === focus ? this.wallExtent(t) + OPEN_GAP : 0)
    return x
  }

  /** How far a track's open wall reaches along x. */
  private wallExtent(track: number): number {
    return this.layout?.tracks[track]?.wallExtent ?? 0
  }

  view(preset: ViewPreset, immediate = false): void {
    const goal   = this.rig.goal
    const layout = this.layout
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
    if (preset === 'angle' || preset === 'side') {
      const track      = this.focusTrack()
      const alongWall  = preset === 'side'
      const wallLength = layout?.tracks[track]?.wallLen ?? 0
      const extent     = this.wallExtent(track)
      goal.target.x    = this.frontX(track, true) + FRONT_W + extent * (alongWall ? 0.62 : 0.55) + 10
      goal.target.z    = alongWall ? -wallLength * 0.5 * Math.sin(WALL_ANGLE) : -6
      // Far enough back to see a few panel columns and the front column beside the wall.
      goal.distance    = alongWall ? this.fitDistance(wallLength * 1.3 + 20, 44) : this.fitDistance(extent * 3.2 + 34, 44)
      if (this.dramatic) goal.distance *= 0.86
    } else {
      goal.target.z = 0
    }
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

  /** The track whose wall opens: the followed one, else the selected one, else the one in the middle of the view. */
  focusTrack(): number {
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
    this.followedTrack = selectionTrack(selection)
    this.turnFor(selection, from, options.scroll !== false)
    this.invalidate()
  }

  /**
   * Turned toward a wall when another track opens: moves the view by as much as the walls
   * move, so it looks at the new track's wall from where it looked at the old one's.
   */
  private keepWallInView(from: { track: number; left: number }): boolean {
    const goal  = this.rig.goal
    const track = this.focusTrack()
    if (track === from.track || goal.yaw < FACING_FRONT_YAW) return false
    goal.target.x += this.frontX(track, true) - from.left
    return true
  }

  /**
   * A wall cell turns the view and opens the wall; a note, chain or song cell turns it back
   * to the front when it was turned that way. Then scrolls the cell into view, unless
   * `scroll` is off (the playheads scroll the view while the song plays).
   */
  private turnFor(selection: Selection, from: { track: number; left: number }, scroll = true): void {
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
    const shifted = !onWall && !turnedBack && this.keepWallInView(from)
    // Keep the cell in view, measured where it will be once the walls have moved.
    const point   = this.settledPoint(selection)
    if (point) {
      const half = this.visibleHalfHeight(goal.distance) * 0.7
      if (scroll && Math.abs(point.y - goal.target.y) > half) goal.target.y = point.y
      if (!scroll && !turnedBack) {
        this.invalidate()
        return
      }
      if (turnedBack || (!onWall && !shifted && Math.abs(point.x - goal.target.x) > half * this.camera.aspect)) goal.target.x = point.x
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
    if (view && rect.parent === view.wall) {
      view.wall.updateMatrix()
      point.applyMatrix4(view.wall.matrix)
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

  private scrollIntoView(selection: Selection): void {
    const rect = this.rectsOf(selection).at(-1)
    if (!rect) return
    const world = rect.parent.localToWorld(new Vector3(rect.x, rect.y, 0))
    const goal  = this.rig.goal
    const half  = this.visibleHalfHeight(goal.distance) * 0.8
    if (world.y > goal.target.y + half) goal.target.y = world.y - half * 0.5
    if (world.y < goal.target.y - half) goal.target.y = world.y + half * 0.5
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

  select(selection: Selection | null, options: SelectOptions = {}): void {
    const changed = !sameSelection(selection, this.selection)
    const from    = this.focusAnchor()
    if (!selection && (this.selection || this.followedTrack != null)) this.focusedTrack = from.track
    // A choice made here wins over the followed M8 cursor until the cursor moves.
    if (!options.silent) this.followedTrack = null
    this.selection = selection
    this.refreshMarkers()
    if (selection && options.turn) this.turnFor(selection, from)
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

  /** The links of the selection, drawn thick. */
  private refreshSelectedLinks(): void {
    this.removeSelectedLinks()
    const { selection, layout } = this
    if (!selection || !layout) return
    const track = selectionTrack(selection)
    const view  = this.trackViews[track]
    const links =
      selection.kind === 'step' || selection.kind === 'chain'
        ? layout
            .instanceLinks(selection.instance)
            .filter((link) => selection.kind === 'chain' || link.step === selection.step || selection.column === 'note')
        : layout.tracks[track].links.filter((link) => link.panel.table === selection.table)
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
    this.selectedLinks             = new LineSegments2(geometry, this.selectedLinkMaterial)
    this.selectedLinks.renderOrder = 4
    view.wall.add(this.selectedLinks)
  }

  /** Arrow keys: rows down the song, columns across the step then the next track. */
  moveSelection(rowDelta: number, columnDelta: number): void {
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
      const moved = this.movedStep(layout, selection, rowDelta, columnDelta)
      if (moved) this.select(moved, { turn: true })
      return
    }
    const column = TABLE_COLUMNS[MathUtils.clamp(TABLE_COLUMNS.indexOf(selection.column) + columnDelta, 0, TABLE_COLUMNS.length - 1)]
    const row    = MathUtils.clamp(selection.row + rowDelta, 0, ROWS_PER_TABLE - 1)
    this.select({ ...selection, row, column }, { turn: true })
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

  /** After a pan: the track whose column (and open wall) is under the middle of the view. */
  panned(): void {
    if (this.selection) return
    const x             = this.rig.goal.target.x
    let nearest         = 0
    let nearestDistance = Number.POSITIVE_INFINITY
    for (let track = 0; track < this.trackViews.length; track += 1) {
      const left     = this.frontX(track)
      const right    = left + FRONT_W + (this.trackViews[track].wallAlpha > 0.5 ? this.wallExtent(track) : 0)
      const distance = x < left ? left - x : x > right ? x - right : 0
      if (distance < nearestDistance) [nearest, nearestDistance] = [track, distance]
    }
    this.focusedTrack = nearest
  }

  turnedByHand(): void {
    this.preset = null
  }

  interacted(): void {
    this.interactedAt = performance.now()
  }

  buttonAt(clientX: number, clientY: number): { track: number; kind: TrackToggle } | null {
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

  pressButton(track: number, kind: TrackToggle): void {
    this.onTrackButton(track, kind)
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
    this.invalidate()
  }

  /** Where the song plays, read each frame (null stops it). */
  setPlayheadSource(source: (() => (TrackPlayhead | null)[]) | null): void {
    this.playheadSource = source
    this.invalidate()
  }

  /** Places the playheads and, when following playback, scrolls with the focused track's; returns true while anything plays. */
  private updatePlayheads(dt: number): boolean {
    const heads   = this.playheadSource?.() ?? []
    const playing = this.playheads.update(heads, this.layout, this.trackViews, this.palette, dt)
    if (!playing || !this.followPlayback || !this.layout) return playing
    const focus    = this.focusTrack()
    const track    = heads[focus]?.row != null ? focus : heads.findIndex((head) => head?.row != null)
    const position = this.playheads.shownPosition(track)
    if (position != null) {
      // Keep the playhead a third of the way down the view, gliding with it.
      const row              = Math.floor(position)
      this.rig.goal.target.y = PlayheadView.rowY(this.layout, row, position - row) - this.visibleHalfHeight(this.rig.goal.distance) * 0.35
    }
    return playing
  }

  /** How far the walls open for a yaw (0 facing the front, 1 turned). */
  private wallTurn(yaw: number): number {
    return smoothstep(WALL_OPEN_YAWS[0], WALL_OPEN_YAWS[1], yaw)
  }

  /**
   * Keeps the last track in view: the view may not go further right than the middle of
   * its column (or along its wall when it is open), measured where the tracks settle for
   * the yaw being turned to, so closing the walls pulls the view back with them.
   */
  private limitPan(): void {
    const last = this.trackViews.length - 1
    if (last < 0) return
    const turn     = this.wallTurn(this.rig.goal.yaw)
    const focus    = this.focusTrack()
    const openness = (track: number) => (this.allWallsOpen || track === focus ? turn : 0)
    let x          = 0
    for (let track = 0; track < last; track += 1) x += TRACK_PITCH + openness(track) * (this.wallExtent(track) + OPEN_GAP)
    this.rig.bounds.maxX = x + FRONT_W / 2 + openness(last) * this.wallExtent(last)
  }

  /** Sticky headers and panels, panel glides and links; returns true while anything moves. */
  private updateStickyParts(dt: number, textOn: boolean): boolean {
    const layout = this.layout
    if (!layout) return false
    let busy        = false
    let panelsMoved = false
    const half      = this.visibleHalfHeight()
    const centerY   = this.rig.current.target.y
    // Headers stick at the screen height they have in the overview; panels stick a little below them.
    const headerTop = centerY + half * this.headerFraction() - HEADER_TOP
    const panelTop  = headerTop - ROW_H - 1.2
    for (const view of this.trackViews) {
      if (view.setHeaderY(headerTop)) busy = true
      if ((view.wallAlpha > 0.01 || this.allWallsOpen) && layout.stick(view.track.track, panelTop, centerY - half * 0.92)) panelsMoved = true
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
    const othersAlpha = (1 - 0.65 * turn) * (1 - smoothstep(OTHERS_LEAVE_YAWS[0], OTHERS_LEAVE_YAWS[1], yaw))
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

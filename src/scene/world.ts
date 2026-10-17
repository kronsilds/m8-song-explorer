// The 3D view: builds a TrackView per track, eases the camera, opens the wall of the
// focused track as the view turns, keeps text alive near the camera, and turns pointer
// and keyboard input into selections.

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Fog,
  Group,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Ray,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import type { PhraseColumn, TableColumn } from '../m8/device'
import type { TrackPlayhead } from '../m8/playback'
import { PHRASE_COLUMNS, type Selection, sameSelection, TABLE_COLUMNS } from '../model/selection'
import { hex2, type PhraseInstance, ROWS_PER_PHRASE, type SongModel, TRACKS } from '../model/song'
import {
  BAND_GAP,
  CHAR_W,
  FRONT_W,
  HEADER_H,
  INST_COL,
  NOTE_COL,
  PANEL_CHARS,
  PANEL_FIELDS,
  PANEL_ROWS,
  PANEL_U0,
  type Panel,
  ROW_H,
  SIDE_CHARS,
  SIDE_FIELDS,
  SIDE_U0,
  SongLayout,
  TRACK_PITCH,
  WALL_ANGLE,
} from './layout'
import type { Palette } from './palette'
import { CameraRig } from './rig'
import { Rich, type TextBlock, TextPool } from './text'
import { linkCurve, TrackView } from './trackView'

const QUAD = new PlaneGeometry(1, 1).translate(0.5, -0.5, 0)
/** Room between an open wall's far end and the next track's column. */
const OPEN_GAP = 7
const smoothstep = (a: number, b: number, x: number) => {
  const t = MathUtils.clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export type ViewPreset = 'front' | 'angle' | 'side' | 'overview'

const deg = MathUtils.degToRad
/** Yaw and pitch of each turned preset, in degrees. */
const PRESET_ANGLES = { front: [0, 0], angle: [40, 5], side: [64, 3] } as const

interface Rect {
  parent: Object3D
  x: number
  y: number
  w: number
  h: number
}

/** A highlighted cell: a soft fill and a crisp outline. */
class CellMarker {
  readonly fill = new Mesh(QUAD, new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide }))
  readonly outline: LineSegments

  constructor() {
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, -1, 0, 1, -1, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0], 3))
    this.outline = new LineSegments(g, new LineBasicMaterial({ transparent: true, depthWrite: false }))
    this.fill.renderOrder = 1
    this.outline.renderOrder = 3
    this.hide()
  }

  show(rect: Rect, color: string, fill: number, line: number): void {
    for (const o of [this.fill, this.outline]) {
      if (o.parent !== rect.parent) rect.parent.add(o)
      o.position.set(rect.x, rect.y, 0.03)
      o.scale.set(rect.w, rect.h, 1)
      o.visible = true
    }
    ;(this.fill.material as MeshBasicMaterial).color.set(color)
    ;(this.fill.material as MeshBasicMaterial).opacity = fill
    ;(this.outline.material as LineBasicMaterial).color.set(color)
    ;(this.outline.material as LineBasicMaterial).opacity = line
  }

  hide(): void {
    this.fill.visible = false
    this.outline.visible = false
  }
}

export class World {
  readonly renderer: WebGLRenderer
  readonly scene = new Scene()
  readonly camera = new PerspectiveCamera(34, 1, 0.5, 4000)
  readonly rig = new CameraRig()
  readonly pool = new TextPool()
  layout: SongLayout | null = null
  palette: Palette
  onSelect: (sel: Selection | null) => void = () => {}
  onHover: (sel: Selection | null) => void = () => {}

  private readonly root = new Group()
  private readonly spine = new Group()
  private tracks: TrackView[] = []
  private open: number[] = Array(TRACKS).fill(0)
  private expandAll = false
  /** Track whose wall opens when nothing is selected. */
  private focused = 0
  /** Track the M8 cursor is on while following it; wins over the selection. */
  private followed: number | null = null
  /** The device place last followed: the same place again (a screen refresh) changes nothing, so a click wins until the cursor moves. */
  private followSel: Selection | null = null
  /** The view was turned by following, so following a front cell turns it back. */
  private autoTurned = false
  private selection: Selection | null = null
  private hover: Selection | null = null
  private device: Selection[] = []
  private readonly cursorMarkers = [new CellMarker(), new CellMarker(), new CellMarker()]
  private readonly hoverMarker = new CellMarker()
  private readonly deviceMarkers: CellMarker[] = []
  /** One playhead per track: across the front column and across the wall's step row. */
  private readonly playMarkers = Array.from({ length: TRACKS }, () => [new CellMarker(), new CellMarker()])
  private playSource: (() => (TrackPlayhead | null)[]) | null = null
  /**
   * Where each playhead is drawn, in timeline rows (row + phase), and how fast it moves.
   * It runs at the tracker's speed and absorbs the tracker's small corrections (each screen
   * read or clock message nudges it) over a few frames, so it glides without lagging.
   */
  private readonly playShown: ({ pos: number; rate: number; target: number } | null)[] = Array(TRACKS).fill(null)
  /** Scroll with the playhead of the focused track while the song plays. */
  followPlayback = false
  /** Every cut to front, turn or side (by hand or by following) takes a skewed, tilted angle. */
  private dramatic = false
  /** Transposed phrases show the notes they play (else the notes written, as on the M8). */
  private playedNotes = true
  /** Cuts taken so far: dramatic takes alternate low / high and lean either way. */
  private cuts = 0
  /** The preset the view was last set to, until it is turned by hand. */
  private preset: ViewPreset | null = null
  private hotLinks: LineSegments2 | null = null
  private readonly hotMaterial = new LineMaterial({ linewidth: 2.2, transparent: true, depthWrite: false })
  private rules: LineSegments | null = null
  private dirty = true
  private renderedAt = 0
  private interactedAt = 0
  private last = performance.now()
  private frame = 0
  private readonly raycaster = new Raycaster()
  private readonly size = new Vector2()

  constructor(
    readonly container: HTMLElement,
    palette: Palette,
  ) {
    this.palette = palette
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    // 1.5x is sharp enough for SDF text and much lighter than 2x next to yam8d's own WebGL.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.domElement.className = 'world'
    container.appendChild(this.renderer.domElement)
    this.scene.add(this.root, this.spine)
    this.scene.fog = new Fog(0x000000, 100, 400)
    this.pool.onReady = () => this.invalidate()
    this.applyPalette()
    new ResizeObserver(() => this.resize()).observe(container)
    this.resize()
    this.bindInput()
    const loop = () => {
      this.frame = requestAnimationFrame(loop)
      this.tick()
    }
    loop()
  }

  invalidate(): void {
    this.dirty = true
  }

  dispose(): void {
    cancelAnimationFrame(this.frame)
    this.pool.clear()
    for (const t of this.tracks) t.dispose()
    this.renderer.dispose()
  }

  // ---------------------------------------------------------------------------
  // Content

  setModel(model: SongModel, keepView = false): void {
    const hadLayout = this.layout != null
    this.layout = new SongLayout(model)
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

  private applyPalette(): void {
    const bg = new Color(this.palette.background)
    this.scene.background = bg
    ;(this.scene.fog as Fog).color = bg
    this.hotMaterial.color.set(this.palette.hot)
    this.invalidate()
  }

  private rebuild(): void {
    for (const t of this.tracks) {
      t.dispose()
      this.root.remove(t.group)
    }
    this.spine.clear()
    if (this.rules) this.scene.remove(this.rules)
    this.tracks = []
    const layout = this.layout
    if (!layout) {
      this.pool.setBlocks([])
      return
    }
    const blocks: TextBlock[] = []
    for (const track of layout.tracks) {
      const view = new TrackView(layout, track, this.palette, this.playedNotes)
      view.onTextReady = () => this.invalidate()
      view.group.position.x = track.track * TRACK_PITCH
      this.root.add(view.group)
      this.tracks.push(view)
      blocks.push(...view.blocks)
    }
    // Song rows down the left edge, and a rule between them across the tracks.
    const right = layout.tracks.reduce((x, t) => x + TRACK_PITCH + t.wallExtent + OPEN_GAP, 0) + 10
    const rules: number[] = []
    layout.timeline.bands.forEach((band, b) => {
      const top = layout.bandTop[b]
      const empty = band.chains.every((c) => c == null)
      blocks.push({
        key: `s:${band.songRow}`,
        parent: this.spine,
        x: -3.4,
        y: top,
        height: ROW_H,
        layer: 'static',
        track: -1,
        build: () => new Rich().add(hex2(band.songRow), empty ? this.palette.empty : this.palette.label),
      })
      const y = top + BAND_GAP / 2
      rules.push(-4, y, -0.2, right, y, -0.2)
    })
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(rules, 3))
    this.rules = new LineSegments(g, new LineBasicMaterial({ color: this.palette.rule, transparent: true, opacity: 0.9 }))
    this.rules.frustumCulled = false
    this.scene.add(this.rules)
    blocks.push({
      key: 'title',
      parent: this.spine,
      x: -3.4,
      y: layout.rowY(0) + HEADER_H + ROW_H * 1.5,
      height: ROW_H * 2,
      layer: 'static',
      track: -1,
      scale: 1.6,
      build: () => new Rich().add((layout.model.name ?? 'UNTITLED SONG').toUpperCase(), this.palette.title),
    })
    this.pool.setBlocks(blocks)
    this.rig.bounds = { minX: -10, maxX: right, minY: layout.bottomY, maxY: layout.rowY(0) + HEADER_H }
    this.hotLinks?.removeFromParent()
    this.hotLinks?.geometry.dispose()
    this.hotLinks = null
    this.refreshMarkers()
    this.invalidate()
  }

  // ---------------------------------------------------------------------------
  // Camera

  /** Left edge of a track's front column; `settled` gives where it will be once walls finish opening. */
  private frontX(t: number, settled = false): number {
    if (!settled) return this.tracks[t]?.group.position.x ?? t * TRACK_PITCH
    const focus = this.focusTrack()
    let x = 0
    for (let k = 0; k < t; k += 1) x += TRACK_PITCH + (this.expandAll || k === focus ? this.wallExtent(k) + OPEN_GAP : 0)
    return x
  }

  /** How far a track's open wall reaches along x. */
  private wallExtent(t: number): number {
    return this.layout?.tracks[t]?.wallExtent ?? 0
  }

  /** After a pan: the track whose column (and open wall) is under the middle of the view. */
  private refocusFromTarget(): void {
    if (this.selection) return
    const x = this.rig.goal.target.x
    let best = 0
    let bestDist = Number.POSITIVE_INFINITY
    for (let t = 0; t < this.tracks.length; t += 1) {
      const left = this.frontX(t)
      const right = left + FRONT_W + (this.tracks[t].wallAlpha > 0.5 ? this.wallExtent(t) : 0)
      const d = x < left ? left - x : x > right ? x - right : 0
      if (d < bestDist) [best, bestDist] = [t, d]
    }
    this.focused = best
  }

  private fitDistance(width: number, height: number): number {
    const vfov = MathUtils.degToRad(this.camera.fov)
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect)
    return Math.max(width / 2 / Math.tan(hfov / 2), height / 2 / Math.tan(vfov / 2))
  }

  view(preset: ViewPreset, immediate = false): void {
    const g = this.rig.goal
    const layout = this.layout
    const top = layout ? layout.rowY(0) : 0
    switch (preset) {
      case 'overview': {
        const width = TRACKS * TRACK_PITCH + 6
        g.yaw = 0
        g.pitch = 0
        g.distance = this.fitDistance(width * 1.04, 40)
        g.target.set(width / 2 - 4, 0, 0)
        // Leave the title clear of the top bar.
        g.target.y = top + HEADER_H + ROW_H * 1.5 - this.visibleHalfHeight(g.distance) * 0.6
        break
      }
      case 'front':
      case 'angle':
      case 'side':
        this.aim(preset)
        break
    }
    if (preset === 'overview') g.roll = 0
    this.preset = preset
    if (preset === 'angle' || preset === 'side') {
      const t = this.focusTrack()
      const side = preset === 'side'
      const wallLen = layout?.tracks[t]?.wallLen ?? 0
      const extent = this.wallExtent(t)
      g.target.x = this.frontX(t, true) + FRONT_W + extent * (side ? 0.62 : 0.55)
      g.target.z = side ? -wallLen * 0.5 * Math.sin(WALL_ANGLE) : -6
      g.distance = side ? this.fitDistance(wallLen + 8, 30) : this.fitDistance(extent * 2.4 + 18, 30)
      if (this.dramatic) g.distance *= 0.86
    } else {
      g.target.z = 0
    }
    if (immediate) this.rig.jump()
    this.invalidate()
  }

  /**
   * Turns the goal to a preset's yaw and pitch. Dramatic takes swing off to one side, look
   * up from below or down from above in turn, and lean a few degrees, a new take each cut.
   * The front take swings left only (a positive yaw would open the walls).
   */
  private aim(preset: 'front' | 'angle' | 'side'): void {
    const g = this.rig.goal
    const [yaw, pitch] = PRESET_ANGLES[preset]
    if (!this.dramatic) {
      g.yaw = deg(yaw)
      g.pitch = deg(pitch)
      g.roll = 0
      return
    }
    this.cuts += 1
    const flip = this.cuts % 2 ? 1 : -1
    const some = (a: number, b: number) => a + (b - a) * Math.random()
    switch (preset) {
      case 'front':
        g.yaw = deg(-some(9, 15))
        g.pitch = deg(flip * some(8, 13))
        break
      case 'angle':
        g.yaw = deg(yaw + flip * some(5, 8))
        g.pitch = deg(flip > 0 ? -some(10, 15) : some(14, 19))
        break
      case 'side':
        g.yaw = deg(yaw - some(3, 8))
        g.pitch = deg(flip * some(10, 15))
        break
    }
    g.roll = deg((Math.random() < 0.5 ? 1 : -1) * some(2.5, 4.5))
  }

  /** Switches dramatic angles; the current preset is taken again the new way. */
  setDramatic(on: boolean): void {
    this.dramatic = on
    if (this.preset) this.view(this.preset)
    else if (!on) this.rig.goal.roll = 0
    this.invalidate()
  }

  /** Switches the NOTE column of transposed phrases between the notes played and the notes written. */
  setPlayedNotes(on: boolean): void {
    if (on === this.playedNotes) return
    this.playedNotes = on
    this.rebuild()
  }

  private visibleHalfHeight(distance = this.rig.current.distance): number {
    return distance * Math.tan(MathUtils.degToRad(this.camera.fov) / 2)
  }

  toggleExpandAll(): boolean {
    this.expandAll = !this.expandAll
    this.invalidate()
    return this.expandAll
  }

  /** The track whose wall opens: the selected one, else the one in the middle of the view. */
  focusTrack(): number {
    if (this.followed != null) return this.followed
    const sel = this.selection
    return sel ? this.trackOf(sel) : this.focused
  }

  /**
   * Follows the M8 cursor: its track becomes the focused one; a wall cell (velocity,
   * instrument, FX, a table, an instrument panel) turns the view and opens the wall, a
   * note, chain or song cell turns it back to the front. Null stops following.
   */
  follow(sel: Selection | null, options: { scroll?: boolean } = {}): void {
    if (sel && sameSelection(sel, this.followSel)) return
    this.followSel = sel
    if (!sel) {
      if (this.followed != null) this.focused = this.followed
      this.followed = null
      this.autoTurned = false
      this.invalidate()
      return
    }
    const from = this.focusAnchor()
    this.followed = this.trackOf(sel)
    this.turnFor(sel, from, options.scroll !== false)
    this.invalidate()
  }

  /** The track whose wall is open now, and where its column will settle. */
  private focusAnchor(): { track: number; left: number } {
    const track = this.focusTrack()
    return { track, left: this.frontX(track, true) }
  }

  /**
   * Turned toward a wall when another track opens: moves the view by as much as the walls
   * move, so it looks at the new track's wall from where it looked at the old one's.
   */
  private keepWallInView(from: { track: number; left: number }): boolean {
    const g = this.rig.goal
    const t = this.focusTrack()
    if (t === from.track || g.yaw < MathUtils.degToRad(25)) return false
    g.target.x += this.frontX(t, true) - from.left
    return true
  }

  /**
   * A wall cell (velocity, instrument, FX, a table, an instrument panel) turns the view
   * and opens the wall; a note, chain or song cell turns it back to the front when it was
   * turned that way. Then scrolls the cell into view, unless `scroll` is off (the playheads
   * scroll the view while the song plays).
   */
  private turnFor(sel: Selection, from: { track: number; left: number }, scroll = true): void {
    const g = this.rig.goal
    const trackChanged = from.track !== this.trackOf(sel)
    // The instrument column is on the front and on the wall: the wall shows it with the rest of the step.
    const onWall = sel.kind === 'table' || sel.kind === 'instrument' || (sel.kind === 'step' && sel.column !== 'note')
    if (onWall && (g.yaw < MathUtils.degToRad(25) || trackChanged)) {
      this.view('angle')
      this.autoTurned = true
    }
    const turnedBack = !onWall && this.autoTurned
    if (turnedBack) {
      this.aim('front')
      this.preset = 'front'
      g.target.z = 0
      this.autoTurned = false
    }
    const shifted = !onWall && !turnedBack && this.keepWallInView(from)
    // Keep the cell in view, measured where it will be once the walls have moved.
    const point = this.settledPoint(sel)
    if (point) {
      const half = this.visibleHalfHeight(g.distance) * 0.7
      if (scroll && Math.abs(point.y - g.target.y) > half) g.target.y = point.y
      if (!scroll && !turnedBack) return this.invalidate()
      if (turnedBack || (!onWall && !shifted && Math.abs(point.x - g.target.x) > half * this.camera.aspect)) g.target.x = point.x
    }
    this.invalidate()
  }

  /** World centre of a selection's cell once the track positions have settled. */
  private settledPoint(sel: Selection): Vector3 | null {
    const rect = this.rectsOf(sel).at(-1)
    if (!rect) return null
    const t = this.trackOf(sel)
    const point = new Vector3(rect.x + rect.w / 2, rect.y - rect.h / 2, 0)
    const view = this.tracks[t]
    if (view && rect.parent === view.wall) {
      view.wall.updateMatrix()
      point.applyMatrix4(view.wall.matrix)
    }
    point.x += this.frontX(t, true)
    return point
  }

  /** Moves the camera so a selection is in view (turning toward the wall for wall cells). */
  focusSelection(sel = this.selection): void {
    if (!sel) return
    const rects = this.rectsOf(sel)
    const rect = rects.at(-1)
    if (!rect) return
    const world = rect.parent.localToWorld(new Vector3(rect.x + rect.w / 2, rect.y - rect.h / 2, 0))
    const g = this.rig.goal
    const onWall = rect.parent !== this.tracks[this.trackOf(sel)]?.front
    if (onWall && g.yaw < MathUtils.degToRad(25)) {
      this.aim('angle')
      this.preset = null
    }
    g.target.set(world.x, world.y, onWall ? world.z : 0)
    g.distance = Math.min(g.distance, 70)
    this.invalidate()
  }

  /** Scrolls just enough for a selection to be on screen. */
  reveal(sel: Selection): void {
    this.ensureVisible(sel)
    this.invalidate()
  }

  private ensureVisible(sel: Selection): void {
    const rect = this.rectsOf(sel).at(-1)
    if (!rect) return
    const world = rect.parent.localToWorld(new Vector3(rect.x, rect.y, 0))
    const g = this.rig.goal
    const half = this.visibleHalfHeight(g.distance) * 0.8
    if (world.y > g.target.y + half) g.target.y = world.y - half * 0.5
    if (world.y < g.target.y - half) g.target.y = world.y + half * 0.5
    const halfW = half * this.camera.aspect
    if (world.x > g.target.x + halfW || world.x < g.target.x - halfW) g.target.x = world.x
  }

  // ---------------------------------------------------------------------------
  // Selection

  private trackOf(sel: Selection): number {
    return sel.kind === 'step' || sel.kind === 'chain' ? sel.instance.track : sel.track
  }

  /** The same place in a rebuilt layout (instances are recreated). */
  private resolve(sel: Selection): Selection | null {
    if (!this.layout) return null
    if (sel.kind === 'step' || sel.kind === 'chain') {
      const inst = this.layout.instanceAt(sel.instance.track, sel.instance.row)
      if (!inst) return null
      return { ...sel, instance: inst }
    }
    return this.panelOf(sel.track, sel.table) ? sel : null
  }

  private panelOf(track: number, table: number): Panel | undefined {
    return this.layout?.tracks[track]?.panels.find((p) => p.table === table)
  }

  select(sel: Selection | null, options: { silent?: boolean; focus?: boolean; reveal?: boolean; turn?: boolean } = {}): void {
    const changed = !sameSelection(sel, this.selection)
    const from = this.focusAnchor()
    if (!sel && (this.selection || this.followed != null)) this.focused = from.track
    // A choice made here wins over the followed M8 cursor until the cursor moves.
    if (!options.silent) this.followed = null
    this.selection = sel
    this.refreshMarkers()
    if (sel && options.turn) this.turnFor(sel, from)
    else if (sel && options.reveal !== false) this.ensureVisible(sel)
    if (sel && options.focus) this.focusSelection(sel)
    if (changed && !options.silent) this.onSelect(sel)
  }

  getSelection(): Selection | null {
    return this.selection
  }

  /** Where the M8 cursor is (every place the item under it appears). */
  setDevice(selections: Selection[]): void {
    this.device = selections
    this.refreshMarkers()
  }

  /** Rectangles a selection covers: [row highlight..., cell]. The last one is the cell itself. */
  rectsOf(sel: Selection): Rect[] {
    const layout = this.layout
    if (!layout) return []
    const track = this.tracks[this.trackOf(sel)]
    if (!track) return []
    switch (sel.kind) {
      case 'chain': {
        const y = layout.rowY(sel.instance.row)
        return [
          { parent: track.front, x: NOTE_COL * CHAR_W - 0.25, y, w: FRONT_W - NOTE_COL * CHAR_W + 0.4, h: ROWS_PER_PHRASE * ROW_H },
          { parent: track.front, x: -0.15, y, w: (NOTE_COL - 0.6) * CHAR_W, h: ROW_H },
        ]
      }
      case 'step': {
        const y = layout.rowY(sel.instance.row + sel.step)
        const row: Rect = { parent: track.front, x: NOTE_COL * CHAR_W - 0.25, y, w: FRONT_W - NOTE_COL * CHAR_W + 0.4, h: ROW_H }
        if (sel.column === 'note' || (sel.column === 'inst' && track.wallAlpha < 0.5)) {
          const x = (sel.column === 'note' ? NOTE_COL : INST_COL) * CHAR_W
          return [row, { parent: track.front, x: x - 0.12, y, w: (sel.column === 'note' ? 3 : 2) * CHAR_W + 0.24, h: ROW_H }]
        }
        const [start, width] = SIDE_FIELDS[sel.column as Exclude<PhraseColumn, 'note'>]
        return [
          row,
          { parent: track.wall, x: SIDE_U0 - 0.3, y, w: SIDE_CHARS * CHAR_W + 0.6, h: ROW_H },
          { parent: track.wall, x: SIDE_U0 + start * CHAR_W - 0.12, y, w: width * CHAR_W + 0.24, h: ROW_H },
        ]
      }
      case 'table': {
        const panel = this.panelOf(sel.track, sel.table)
        if (!panel) return []
        const y = panel.shownY - (sel.row + 2) * ROW_H
        const [start, width] = PANEL_FIELDS[sel.column]
        return [
          { parent: track.wall, x: panel.shownU - 0.3, y, w: PANEL_CHARS * CHAR_W + 0.6, h: ROW_H },
          { parent: track.wall, x: panel.shownU + start * CHAR_W - 0.12, y, w: width * CHAR_W + 0.24, h: ROW_H },
        ]
      }
      case 'instrument': {
        const panel = this.panelOf(sel.track, sel.table)
        if (!panel) return []
        return [{ parent: track.wall, x: panel.shownU - 0.45, y: panel.shownY + 0.25, w: PANEL_CHARS * CHAR_W + 0.9, h: ROW_H * 2 + 0.35 }]
      }
    }
  }

  private refreshMarkers(): void {
    const p = this.palette
    for (const m of this.cursorMarkers) m.hide()
    const rects = this.selection ? this.rectsOf(this.selection) : []
    rects.forEach((rect, i) => {
      const isCell = i === rects.length - 1
      this.cursorMarkers[i]?.show(rect, p.hot, isCell ? 0.3 : 0.08, isCell ? 1 : 0.35)
    })

    this.hoverMarker.hide()
    if (this.hover && !sameSelection(this.hover, this.selection)) {
      const cell = this.rectsOf(this.hover).at(-1)
      if (cell) this.hoverMarker.show(cell, p.hover, 0.12, 0.8)
    }

    this.device.forEach((sel, i) => {
      const cell = this.rectsOf(sel).at(-1)
      this.deviceMarkers[i] ??= new CellMarker()
      if (cell) this.deviceMarkers[i].show(cell, p.device, 0.18, 1)
      else this.deviceMarkers[i].hide()
    })
    for (let i = this.device.length; i < this.deviceMarkers.length; i += 1) this.deviceMarkers[i].hide()
    this.refreshHotLinks()
    this.invalidate()
  }

  /** The links of the selection, drawn thick. */
  private refreshHotLinks(): void {
    this.hotLinks?.removeFromParent()
    this.hotLinks?.geometry.dispose()
    this.hotLinks = null
    const sel = this.selection
    const layout = this.layout
    if (!sel || !layout) return
    const t = this.trackOf(sel)
    const track = layout.tracks[t]
    const view = this.tracks[t]
    const links =
      sel.kind === 'step' || sel.kind === 'chain'
        ? layout.instanceLinks(sel.instance).filter((l) => sel.kind === 'chain' || l.step === sel.step || sel.column === 'note')
        : track.links.filter((l) => l.panel.table === sel.table)
    if (!links.length || !view) return
    const positions: number[] = []
    for (const link of links) {
      if (link.panel.alpha < 0.05) continue
      const [from, to] = view.linkEnds(link.row, link.col, link.panel.shownY, link.panel.shownU)
      const pts = linkCurve(from, to)
      for (let i = 0; i < pts.length - 1; i += 1) positions.push(pts[i].x, pts[i].y, pts[i].z + 0.02, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z + 0.02)
    }
    const geometry = new LineSegmentsGeometry()
    geometry.setPositions(positions)
    this.hotLinks = new LineSegments2(geometry, this.hotMaterial)
    this.hotLinks.renderOrder = 4
    view.wall.add(this.hotLinks)
  }

  /** Arrow keys: rows down the song, columns across the step then the next track. */
  moveSelection(dRow: number, dCol: number): void {
    const layout = this.layout
    if (!layout) return
    let sel = this.selection
    if (!sel) {
      const t = this.focusTrack()
      const inst = layout.tracks[t].instances.find((i) => layout.rowY(i.row) <= this.rig.goal.target.y + 5) ?? layout.tracks[t].instances[0]
      if (inst) this.select({ kind: 'step', instance: inst, step: 0, column: 'note' }, { focus: false })
      return
    }
    if (sel.kind === 'chain') sel = { kind: 'step', instance: sel.instance, step: 0, column: 'note' }
    if (sel.kind === 'instrument') sel = { kind: 'table', table: sel.table, row: 0, column: 'transpose', track: sel.track, inst: sel.inst }
    if (sel.kind === 'step') {
      let track = sel.instance.track
      let colIndex = PHRASE_COLUMNS.indexOf(sel.column) + dCol
      if (colIndex < 0 || colIndex >= PHRASE_COLUMNS.length) {
        track = MathUtils.clamp(track + Math.sign(dCol), 0, TRACKS - 1)
        colIndex = track === sel.instance.track ? MathUtils.clamp(colIndex, 0, PHRASE_COLUMNS.length - 1) : dCol > 0 ? 0 : PHRASE_COLUMNS.length - 1
      }
      let row = sel.instance.row + sel.step + dRow
      let inst: PhraseInstance | null = layout.instanceAt(track, row)
      // Skip the empty stretches of the track.
      if (!inst) {
        const list = layout.tracks[track].instances
        const next = dRow >= 0 ? list.find((i) => i.row > row) : [...list].reverse().find((i) => i.row + ROWS_PER_PHRASE <= row)
        const nearest = next ?? list.reduce<PhraseInstance | null>((best, i) => (!best || Math.abs(i.row - row) < Math.abs(best.row - row) ? i : best), null)
        if (!nearest) return
        inst = nearest
        row = dRow >= 0 || !next ? Math.max(nearest.row, Math.min(row, nearest.row + 15)) : nearest.row + ROWS_PER_PHRASE - 1
        if (row < nearest.row || row >= nearest.row + ROWS_PER_PHRASE) row = nearest.row
      }
      this.select({ kind: 'step', instance: inst, step: row - inst.row, column: PHRASE_COLUMNS[colIndex] }, { turn: true })
      return
    }
    // table
    const colIndex = MathUtils.clamp(TABLE_COLUMNS.indexOf(sel.column) + dCol, 0, TABLE_COLUMNS.length - 1)
    const row = MathUtils.clamp(sel.row + dRow, 0, 15)
    this.select({ ...sel, row, column: TABLE_COLUMNS[colIndex] as TableColumn }, { turn: true })
  }

  // ---------------------------------------------------------------------------
  // Picking

  private localHit(object: Object3D, ray: Ray): { point: Vector3; distance: number } | null {
    const inverse = new Matrix4().copy(object.matrixWorld).invert()
    const local = ray.clone().applyMatrix4(inverse)
    if (Math.abs(local.direction.z) < 1e-6) return null
    const t = -local.origin.z / local.direction.z
    if (t <= 0) return null
    const point = local.origin.clone().addScaledVector(local.direction, t)
    const world = point.clone().applyMatrix4(object.matrixWorld)
    return { point, distance: world.distanceTo(ray.origin) }
  }

  pick(clientX: number, clientY: number): Selection | null {
    const layout = this.layout
    if (!layout) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const ray = this.raycaster.ray
    let best: { sel: Selection; distance: number } | null = null
    // Columns that stepped back for an open wall let the pointer through to it: they are
    // picked only when nothing else is under the pointer.
    let behind: { sel: Selection; distance: number } | null = null
    const consider = (sel: Selection | null, distance: number, through = false) => {
      if (!sel) return
      if (through) {
        if (!behind || distance < behind.distance) behind = { sel, distance }
      } else if (!best || distance < best.distance) best = { sel, distance }
    }
    for (const view of this.tracks) {
      const t = view.track.track
      const front = this.localHit(view.front, ray)
      if (front && front.point.x > -0.3 && front.point.x < FRONT_W + 0.2) {
        const row = layout.rowAtY(front.point.y)
        const inst = row == null ? null : layout.instanceAt(t, row)
        if (inst && row != null) {
          const col = front.point.x / CHAR_W
          consider(
            col < NOTE_COL - 0.5
              ? { kind: 'chain', instance: inst }
              : { kind: 'step', instance: inst, step: row - inst.row, column: col >= INST_COL - 0.5 ? 'inst' : 'note' },
            front.distance,
            view.frontAlpha < 0.99,
          )
        }
      }
      if (view.wallAlpha < 0.35) continue
      const wall = this.localHit(view.wall, ray)
      if (!wall) continue
      const { x: u, y } = wall.point
      if (u >= SIDE_U0 - 0.3 && u <= SIDE_U0 + SIDE_CHARS * CHAR_W + 0.3) {
        const row = layout.rowAtY(y)
        const inst = row == null ? null : layout.instanceAt(t, row)
        if (inst && row != null) {
          const ch = Math.floor((u - SIDE_U0) / CHAR_W)
          const column = (Object.entries(SIDE_FIELDS).find(([, [s, w]]) => ch >= s && ch < s + w + 1)?.[0] ?? 'vel') as PhraseColumn
          consider({ kind: 'step', instance: inst, step: row - inst.row, column }, wall.distance)
        }
      } else if (u >= PANEL_U0 - 0.5) {
        const panel = layout.tracks[t].panels.find(
          (p) => p.alpha > 0.5 && u >= p.shownU - 0.5 && u <= p.shownU + PANEL_CHARS * CHAR_W + 0.5 && y <= p.shownY + 0.3 && y > p.shownY - PANEL_ROWS * ROW_H,
        )
        if (panel) {
          const line = Math.floor((panel.shownY - y) / ROW_H)
          if (line < 2) consider({ kind: 'instrument', inst: panel.inst, table: panel.table, track: t }, wall.distance)
          else {
            const ch = Math.floor((u - panel.shownU) / CHAR_W)
            const column = (Object.entries(PANEL_FIELDS).find(([, [s, w]]) => ch >= s && ch < s + w + 1)?.[0] ?? 'transpose') as TableColumn
            consider({ kind: 'table', table: panel.table, row: Math.min(15, line - 2), column, track: t, inst: panel.inst }, wall.distance)
          }
        }
      }
    }
    return ((best ?? behind) as { sel: Selection } | null)?.sel ?? null
  }

  // ---------------------------------------------------------------------------
  // Input

  private bindInput(): void {
    const el = this.renderer.domElement
    let drag: { x: number; y: number; button: number; moved: boolean; pan: boolean } | null = null
    let hoverQueued: { x: number; y: number } | null = null

    el.addEventListener('contextmenu', (e) => e.preventDefault())
    for (const type of ['pointerdown', 'pointermove', 'wheel'] as const) el.addEventListener(type, () => (this.interactedAt = performance.now()), { passive: true })
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId)
      drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false, pan: e.button !== 0 || e.shiftKey }
    })
    el.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = e.clientX - drag.x
        const dy = e.clientY - drag.y
        if (!drag.moved && Math.hypot(dx, dy) < 4) return
        drag.moved = true
        drag.x = e.clientX
        drag.y = e.clientY
        const g = this.rig.goal
        if (drag.pan) {
          const scale = (2 * this.visibleHalfHeight(g.distance)) / el.clientHeight
          g.target.x -= dx * scale * Math.cos(g.yaw)
          g.target.z += dx * scale * Math.sin(g.yaw)
          g.target.y += dy * scale
          this.refocusFromTarget()
        } else {
          g.yaw -= dx * 0.0055
          g.pitch += dy * 0.004
          this.preset = null
        }
        this.invalidate()
        return
      }
      if (!hoverQueued) {
        requestAnimationFrame(() => {
          if (!hoverQueued) return
          const sel = this.pick(hoverQueued.x, hoverQueued.y)
          hoverQueued = null
          if (!sameSelection(sel, this.hover)) {
            this.hover = sel
            this.refreshMarkers()
            this.onHover(sel)
          }
        })
      }
      hoverQueued = { x: e.clientX, y: e.clientY }
    })
    el.addEventListener('pointerup', (e) => {
      const d = drag
      drag = null
      if (d && !d.moved && d.button === 0) this.select(this.pick(e.clientX, e.clientY), { reveal: false })
    })
    el.addEventListener('pointerleave', () => {
      if (this.hover) {
        this.hover = null
        this.refreshMarkers()
        this.onHover(null)
      }
    })
    el.addEventListener('dblclick', (e) => {
      const sel = this.pick(e.clientX, e.clientY)
      if (sel) this.select(sel, { focus: true })
    })
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const g = this.rig.goal
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
        if (e.ctrlKey || e.metaKey || e.altKey) {
          g.distance *= Math.exp(e.deltaY * unit * 0.0022)
        } else {
          const scale = (2 * this.visibleHalfHeight(g.distance)) / el.clientHeight
          g.target.y -= e.deltaY * unit * scale * 0.9
          g.target.x += (e.shiftKey ? e.deltaY : e.deltaX) * unit * scale * 0.9
          if (e.shiftKey || e.deltaX) this.refocusFromTarget()
        }
        this.invalidate()
      },
      { passive: false },
    )
  }

  zoom(factor: number): void {
    this.rig.goal.distance *= factor
    this.invalidate()
  }

  scrollRows(rows: number): void {
    this.rig.goal.target.y -= rows * ROW_H
    this.invalidate()
  }

  // ---------------------------------------------------------------------------
  // Frame

  private resize(): void {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.getDrawingBufferSize(this.size)
    this.hotMaterial.resolution.set(w, h)
    this.invalidate()
  }

  /** Where the song plays, read each frame (null stops it). */
  setPlayheadSource(source: (() => (TrackPlayhead | null)[]) | null): void {
    this.playSource = source
    this.invalidate()
  }

  /** Top of the playhead `phase` of the way from a row to the next (across a song row gap too). */
  private playY(row: number, phase: number): number {
    const layout = this.layout as SongLayout
    const from = layout.rowY(row)
    return from + (layout.rowY(row + 1) - from) * phase
  }

  /** Moves a track's drawn playhead toward the tracker's `target` (row + phase); a jump (a new chain, a seek) is taken at once. */
  private smoothPlayhead(t: number, target: number, headRow: number, headStep: number, dt: number): { row: number; phase: number; step: number } {
    let s = this.playShown[t]
    if (!s || Math.abs(target - s.pos) > 1.5 || target < s.target - 1.5) {
      s = this.playShown[t] = { pos: target, rate: s?.rate ?? 0, target }
    } else if (dt > 0) {
      // The tracker's own speed (rows per second), averaged so its nudges do not show.
      const moved = target - s.target
      if (moved >= 0 && moved < 1) s.rate += (moved / dt - s.rate) * (1 - Math.exp(-dt * 3))
      s.target = target
      s.pos += s.rate * dt
      s.pos += (target - s.pos) * (1 - Math.exp(-dt * 7))
    }
    const row = Math.floor(s.pos)
    return { row, phase: s.pos - row, step: headStep + row - headRow }
  }

  /** Places the playheads; returns true while anything plays. */
  private updatePlayheads(dt: number): boolean {
    const heads = this.playSource?.() ?? []
    const layout = this.layout
    let any = false
    this.playMarkers.forEach(([front, wall], t) => {
      const head = heads[t]
      const view = this.tracks[t]
      if (!head || head.row == null || !layout || !view) {
        front.hide()
        wall.hide()
        this.playShown[t] = null
        return
      }
      any = true
      const { row, phase, step } = this.smoothPlayhead(t, head.row + head.phase, head.row, head.step, dt)
      const y = this.playY(row, phase)
      // A flash on each beat (every 4 steps): full at the beat, gone by the middle of it.
      const beat = (((step % 4) + 4) % 4 + phase) / 4
      const flash = (1 - smoothstep(0, 0.5, beat)) ** 2
      const fill = (head.exact ? 0.2 : 0.12) + flash * 0.4
      const line = Math.min(1, (head.exact ? 0.6 : 0.35) + flash * 0.6)
      front.show({ parent: view.front, x: NOTE_COL * CHAR_W - 0.3, y, w: FRONT_W - NOTE_COL * CHAR_W + 0.5, h: ROW_H }, this.palette.device, fill, line)
      if (view.wallAlpha > 0.05) wall.show({ parent: view.wall, x: SIDE_U0 - 0.35, y, w: SIDE_CHARS * CHAR_W + 0.7, h: ROW_H }, this.palette.device, fill, line)
      else wall.hide()
    })
    if (any && this.followPlayback) {
      const focus = this.focusTrack()
      const t = heads[focus]?.row != null ? focus : heads.findIndex((h) => h?.row != null)
      const shown = this.playShown[t]
      if (shown && layout) {
        // Keep the playhead a third of the way down the view, gliding with it.
        const half = this.visibleHalfHeight(this.rig.goal.distance)
        const row = Math.floor(shown.pos)
        this.rig.goal.target.y = this.playY(row, shown.pos - row) - half * 0.35
      }
    }
    return any
  }

  /**
   * Keeps the last track in view: the view may not go further right than the middle of
   * its column (or along its wall when it is open), measured where the tracks settle for
   * the yaw being turned to, so closing the walls pulls the view back with them.
   */
  private limitPan(): void {
    const last = this.tracks.length - 1
    if (last < 0) return
    const turn = smoothstep(MathUtils.degToRad(5), MathUtils.degToRad(24), this.rig.goal.yaw)
    const focus = this.focusTrack()
    const open = (t: number) => (this.expandAll || t === focus ? turn : 0)
    let x = 0
    for (let t = 0; t < last; t += 1) x += TRACK_PITCH + open(t) * (this.wallExtent(t) + OPEN_GAP)
    this.rig.bounds.maxX = x + FRONT_W / 2 + open(last) * this.wallExtent(last)
  }

  private tick(): void {
    const now = performance.now()
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    this.limitPan()
    let busy = this.rig.update(dt)

    // Walls open as the view turns: the focused track's, or all of them.
    const turn = smoothstep(MathUtils.degToRad(5), MathUtils.degToRad(24), this.rig.current.yaw)
    // Panels follow the view (sticky) on the open walls, gliding and fading; links are
    // drawn near the view only.
    if (this.layout) {
      const half = this.visibleHalfHeight()
      const cy = this.rig.current.target.y
      // Panels stick a little below the top of the view, clear of the headers and the top bar.
      const stickTop = cy + half * 0.58
      const textOn = (ROW_H / (2 * half)) * this.container.clientHeight > 5
      let moved = false
      for (const view of this.tracks) {
        if (view.wallAlpha > 0.01 || this.expandAll) {
          if (this.layout.stick(view.track.track, stickTop, cy - half * 0.92)) moved = true
        }
        if (view.updatePanels(dt, textOn)) moved = true
        if (view.wallAlpha > 0.01 && view.updateLinks(cy + half * 1.05, cy - half * 1.05)) busy = true
      }
      if (moved) {
        busy = true
        // Markers and thick links attached to a panel follow it, frame by frame.
        if (this.selection) this.refreshMarkers()
      }
    }

    // Turned toward a wall, the other tracks step back, and leave once looking along it.
    const others = (1 - 0.65 * turn) * (1 - smoothstep(MathUtils.degToRad(34), MathUtils.degToRad(54), this.rig.current.yaw))
    const focus = this.focusTrack()
    const k = 1 - Math.exp(-dt * 7)
    let x = 0
    for (let t = 0; t < this.tracks.length; t += 1) {
      const goal = this.expandAll || t === focus ? 1 : 0
      const before = this.open[t]
      this.open[t] += (goal - this.open[t]) * k
      if (Math.abs(goal - this.open[t]) < 0.001) this.open[t] = goal
      if (this.open[t] !== before) busy = true
      const alpha = this.open[t] * turn
      const view = this.tracks[t]
      const front = this.expandAll || t === focus ? 1 : others
      if (Math.abs(view.group.position.x - x) > 1e-4 || Math.abs(view.wallAlpha - alpha) > 1e-4 || Math.abs(view.frontAlpha - front) > 1e-4) busy = true
      view.group.position.x = x
      view.setWallAlpha(alpha)
      view.setFrontAlpha(front)
      x += TRACK_PITCH + alpha * (this.wallExtent(t) + OPEN_GAP)
    }

    const playing = this.updatePlayheads(dt)

    this.rig.apply(this.camera)
    const c = this.rig.current
    const half = this.visibleHalfHeight()
    const pxPerRow = (ROW_H / (2 * half)) * this.container.clientHeight
    const textOn = pxPerRow > 5
    const barsAlpha = 0.08 + 0.82 * (1 - smoothstep(5, 10, pxPerRow))
    for (const view of this.tracks) view.setBarsAlpha(barsAlpha)
    const fog = this.scene.fog as Fog
    fog.near = c.distance * 1.05 + 10
    fog.far = c.distance * 2.2 + 160

    const reach = half * (1.25 + Math.abs(Math.sin(c.pitch)) * 2)
    const created = this.pool.update(c.target.y + reach, c.target.y - reach, c.target.y, (block) => {
      if (!textOn && block.layer !== 'static') return 0
      if (block.layer === 'wall') return this.tracks[block.track]?.wallAlpha ?? 0
      return block.track < 0 ? 1 : (this.tracks[block.track]?.frontAlpha ?? 1)
    })

    const pulse = this.device.length > 0
    if (pulse) {
      const a = 0.55 + 0.45 * Math.sin(now / 180)
      for (const m of this.deviceMarkers) (m.outline.material as LineBasicMaterial).opacity = a
    }
    // yam8d draws the M8 screen next to this page: full frame rate only while the view is
    // being handled, 50 fps while the song plays (the glide and the beat flashes), at most
    // ~40 fps for other animations, nothing when still.
    const moving = this.dirty || busy || created
    const interacting = now - this.interactedAt < 400
    const interval = interacting ? 0 : playing ? 20 : moving ? 24 : pulse ? 66 : Number.POSITIVE_INFINITY
    const since = now - this.renderedAt
    // 2 ms of slack for frame timing jitter.
    if (since >= interval - 2) {
      this.renderer.render(this.scene, this.camera)
      // Keep the cadence (50 fps on a 60 Hz screen skips one frame in six, evenly) unless far behind.
      this.renderedAt = interval > 0 && since < interval * 2 ? this.renderedAt + interval : now
      this.dirty = false
    }
  }
}

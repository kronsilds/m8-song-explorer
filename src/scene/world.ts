// The 3D view: builds a TrackView per track, keeps text alive near the camera, runs the frame
// loop, and is what the app and the pointer talk to. Its parts do the rest: which parts of the
// walls are unfolded (track/wallFolds) and where the tracks stand (track/placement), the camera's
// framings (camera/navigator) and moves by hand (camera/handCamera), where headers stick and how
// far the view goes (camera/stickyHeaders), what is marked (markers/highlights,
// markers/playbackMarks), which face each panel shows (track/panelFaces) and where the arrow keys
// go (input/selectionMoves).

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
  WebGLRenderer,
} from 'three'
import { hex2 } from '../model/hex'
import type { DeviceEdit, TrackPlayhead, TrackToggle } from '../model/live'
import type { Palette } from '../model/palette'
import { type Selection, sameSelection, selectionTrack } from '../model/selection'
import { TRACKS } from '../model/song'
import type { SongContext } from '../model/songContext'
import { DEFAULT_WALL_DEGREES } from '../model/viewOptions'
import type { ViewPreset } from './camera/cameraAngles'
import { HandCamera } from './camera/handCamera'
import { type CoveredArea, Navigator } from './camera/navigator'
import { CameraRig } from './camera/rig'
import { StickyHeaders } from './camera/stickyHeaders'
import { ViewFocus } from './camera/viewFocus'
import { ViewProbe } from './camera/viewProbe'
import type { SceneContent } from './content'
import { type SceneButton, ScenePicker } from './input/picker'
import { bindPointerControls, type PointerTarget } from './input/pointerControls'
import { firstStepNear, movedSelection } from './input/selectionMoves'
import { BAND_GAP, DEFAULT_PANEL_COLS, HEADER_H, MAX_PANEL_COLS, type Panel, ROW_H, SongLayout, type TrackLayout } from './layout'
import { Highlights } from './markers/highlights'
import { PlaybackMarks } from './markers/playbackMarks'
import { smoothstep } from './shapes'
import { RichText, type TextBlock, TextPool } from './text'
import { PanelFaces } from './track/panelFaces'
import { TrackPlacement } from './track/placement'
import type { FoldSection } from './track/trackHeader'
import { type CarriedParts, TrackView } from './track/trackView'
import { WallFolds } from './track/wallFolds'

export type { ViewPreset } from './camera/cameraAngles'
export type { CoveredArea } from './camera/navigator'

/** Text below this many pixels per row is not drawn; bars show instead. */
const MIN_TEXT_PX_PER_ROW = 5
/** Frame intervals (ms): while playing (50 fps), other animation (~40 fps), the device marker pulse. */
const PLAYING_FRAME_MS    = 20
const MOVING_FRAME_MS     = 24
const PULSE_FRAME_MS      = 66
/** Full frame rate for this long after the user touches the view. */
const INTERACTION_MS      = 400
const BAND_RULE_OPACITY   = 0.9

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
  readonly renderer : WebGLRenderer
  readonly scene    = new Scene()
  readonly camera   = new PerspectiveCamera(34, 1, 0.5, 4000)
  readonly rig      = new CameraRig()
  readonly pool     = new TextPool()
  palette           : Palette
  onSelect          : (selection: Selection | null) => void = () => {}
  onHover           : (selection: Selection | null) => void = () => {}
  /** A track's mute or solo button was clicked. */
  onTrackButton     : (track: number, kind: TrackToggle) => void = () => {}
  /** A track unfolded or folded a part of its wall. */
  onFolds           : () => void = () => {}

  private readonly content      : SceneContent = {
    layout    : null,
    trackViews: [],
    wallAngle : MathUtils.degToRad(DEFAULT_WALL_DEGREES)
  }
  private readonly folds        = new WallFolds()
  private readonly faces        = new PanelFaces()
  private readonly focus        = new ViewFocus()
  private readonly probe        : ViewProbe
  private readonly placement    : TrackPlacement
  private readonly sticky       : StickyHeaders
  private readonly highlights   : Highlights
  private readonly marks        : PlaybackMarks
  private readonly navigator    : Navigator
  private readonly hand         : HandCamera
  private readonly root         = new Group()
  private readonly spine        = new Group()
  private readonly picker       : ScenePicker
  private trackModes            = {
    muted : [] as boolean[],
    soloed: [] as boolean[]
  }
  /** Transposed phrases show the notes they play (else the notes written, as on the M8). */
  private playedNotes           = true
  private trimTables            = true
  /** Columns each track's wall may have, as its header button set them (see SongLayout). */
  private readonly panelColumns : number[] = []
  private bandRules             : LineSegments | null = null
  private dirty                 = true
  private renderedAt            = 0
  private interactedAt          = 0
  private lastTickAt            = performance.now()
  private animationFrame        = 0

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
    this.picker                          = new ScenePicker(this.camera, this.renderer.domElement)
    const { content, rig, folds, focus } = this
    this.probe                           = new ViewProbe(this.camera, this.renderer.domElement, container)
    this.placement                       = new TrackPlacement(content, folds)
    this.sticky                          = new StickyHeaders(content, rig, this.probe, this.placement, folds, focus)
    this.highlights                      = new Highlights(content, this.placement, folds)
    this.marks                           = new PlaybackMarks(content, this.placement, this.probe)
    this.navigator                       = new Navigator(content, rig, this.probe, this.placement, folds, focus, this.sticky, this.marks, {
      invalidate  : () => this.invalidate(),
      foldsChanged: (tracks) => {
        for (const track of tracks) this.showFoldButtons(track)
        this.foldsChanged()
      }
    })
    this.hand                            = new HandCamera(rig, this.probe, this.placement, focus, this.navigator)
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

  /** The song as laid out now; null before the first song. */
  get layout(): SongLayout | null {
    return this.content.layout
  }

  /** Scroll with the playhead of the focused track while the song plays. */
  get followPlayback(): boolean {
    return this.navigator.followPlayback
  }

  set followPlayback(on: boolean) {
    this.navigator.followPlayback = on
  }

  /** Measures the parts of the view the HUD's selection panel covers now, when given (see setCoveredAreas). */
  get coverage(): (() => CoveredArea[]) | null {
    return this.navigator.coverage
  }

  set coverage(measure: (() => CoveredArea[]) | null) {
    this.navigator.coverage = measure
  }

  invalidate(): void {
    this.dirty = true
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame)
    this.pool.clear()
    for (const view of this.content.trackViews) view.dispose()
    this.renderer.dispose()
  }

  // ---------------------------------------------------------------------------
  // Content

  /** Shows a song (another one, or the same one read again): the whole scene is built afresh. */
  setSong(song: SongContext, keepView = false): void {
    const previous      = this.content.layout
    const hadLayout     = previous != null
    const layout        = new SongLayout(song, this.trimTables, this.panelColumns)
    this.content.layout = layout
    this.marks.setSong(song)
    if (previous) {
      for (const track of layout.tracks) {
        for (const panel of track.panels) panel.flip = previous.tracks[track.track]?.panels.find((p) => p.table === panel.table)?.flip ?? 0
      }
    }
    this.rebuild()
    if (!keepView || !hadLayout) this.view('overview', true)
    // Keep the selection when its place still exists.
    if (this.focus.selection) this.select(layout.resolve(this.focus.selection), { silent: true })
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
    if (this.content.layout) this.content.layout.trimTables = on
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
    this.highlights.applyPalette(this.palette)
    this.invalidate()
  }

  private rebuild(): void {
    for (const view of this.content.trackViews) {
      view.dispose()
      this.root.remove(view.group)
    }
    this.spine.clear()
    if (this.bandRules) this.scene.remove(this.bandRules)
    this.content.trackViews = []
    const layout            = this.content.layout
    if (!layout) {
      this.pool.setBlocks([])
      return
    }
    const blocks: TextBlock[] = []
    for (const track of layout.tracks) {
      const view            = this.makeTrackView(layout, track)
      this.placement.setShownWallLength(track.track, track.wallLen)
      view.group.position.x = this.placement.settledX(track.track)
      this.content.trackViews.push(view)
      blocks.push(...view.blocks)
    }
    blocks.push(...this.buildSpine(layout))
    this.pool.setBlocks(blocks)
    this.setBounds(layout)
    this.highlights.removeLinks()
    this.refreshMarkers()
    this.invalidate()
  }

  /** A track's view, wired to the world (with `carried`, it takes over what the view it replaces handed over). */
  private makeTrackView(layout: SongLayout, track: TrackLayout, carried: CarriedParts | null = null): TrackView {
    const view       = new TrackView(layout, track, this.palette, this.playedNotes, this.content.wallAngle, carried)
    view.signature   = layout.trackSignature(track.track)
    view.onTextReady = () => this.invalidate()
    view.faceGoal    = (panel) => this.faces.goal(panel)
    view.setTrackModes(!!this.trackModes.muted[track.track], !!this.trackModes.soloed[track.track])
    view.setFoldButtons(this.folds.buttonState(track.track, 'fx'), this.folds.buttonState(track.track, 'panels'))
    this.root.add(view.group)
    return view
  }

  private setBounds(layout: SongLayout): void {
    this.rig.bounds = {
      minX: -10,
      maxX: this.placement.songEnd() + 10,
      minY: layout.bottomY,
      maxY: layout.rowY(0) + HEADER_H
    }
  }

  /**
   * The same song after an edit made on the M8 (the model changed in place; `song` is worked out
   * from it again): only what changed is drawn again. A track whose content is the same keeps its
   * view; another gets a new view that takes over the old one's header, panel texts and faces.
   * Panels keep their place, fade and turn; texts that show the same stay, changed ones swap in
   * once laid out; the camera stays.
   */
  updateSong(song: SongContext): void {
    const previous = this.content.layout
    if (!previous || this.content.trackViews.length !== TRACKS) {
      this.setSong(song, true)
      return
    }
    const layout            = new SongLayout(song, this.trimTables, this.panelColumns)
    layout.adoptState(previous)
    this.content.layout     = layout
    this.marks.setSong(song)
    const replaced          : TrackView[] = []
    this.content.trackViews = this.content.trackViews.map((old, track) => {
      const lanes = layout.tracks[track]
      if (layout.trackSignature(track) === old.signature) {
        old.relink(layout, lanes)
        return old
      }
      const view            = this.makeTrackView(layout, lanes, old.handOver())
      view.group.position.x = old.group.position.x
      view.setWallLength(this.placement.shownWallLength(track) ?? lanes.wallLen)
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
    const blocks            = [...this.content.trackViews.flatMap((view) => view.blocks), ...this.buildSpine(layout)]
    this.pool.setBlocks(blocks, true)
    this.setBounds(layout)
    // The places marked are the same places in the new layout.
    const resolve                = (selection: Selection) => layout.resolve(selection)
    this.focus.followedSelection = this.focus.followedSelection && resolve(this.focus.followedSelection)
    this.highlights.resolve(resolve)
    this.highlights.removeLinks()
    this.select(this.focus.selection && resolve(this.focus.selection), {
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
   * links and panels that come or go follow with updateSong. False for an edit that moves things
   * (a song cell, a chain's phrases) or changes many (the project, a scale, a groove): nothing is
   * shown, the scene needs the new song now (updateSong).
   */
  showEditInPlace(edit: DeviceEdit): boolean {
    const layout = this.content.layout
    // No scene yet: the next updateSong draws it.
    if (!layout) return true
    const views = this.content.trackViews
    if (edit.kind === 'phrase' && edit.id != null) {
      const keys = new Set((layout.timeline.byPhrase.get(edit.id) ?? []).flatMap((instance) => [`f:${instance.key}`, `w:${instance.key}`]))
      this.pool.refresh((block) => keys.has(block.key))
    } else if (edit.kind === 'table' && edit.id != null) {
      for (const view of views) view.cards.refreshTable(edit.id)
    } else if ((edit.kind === 'inst' || edit.kind === 'instmods') && edit.id != null) {
      layout.forgetFace(edit.id)
      for (const view of views) view.cards.refreshInstrument(edit.id)
    } else {
      return false
    }
    this.invalidate()
    return true
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
      y     : layout.titleY,
      height: ROW_H * 2,
      layer : 'static',
      track : -1,
      scale : 1.6,
      build : () => new RichText().add((layout.model.name ?? 'UNTITLED SONG').toUpperCase(), this.palette.title)
    })
    return blocks
  }

  // ---------------------------------------------------------------------------
  // Camera

  /** World units per screen pixel at the goal distance. */
  unitsPerPixel(): number {
    return this.probe.unitsPerPixel(this.rig.goal.distance)
  }

  view(preset: ViewPreset, immediate = false): void {
    this.navigator.view(preset, immediate)
  }

  /** Switches dramatic angles; the current preset is taken again the new way. */
  setDramatic(on: boolean): void {
    this.navigator.setDramatic(on)
  }

  zoom(factor: number): void {
    this.rig.goal.distance *= factor
    this.invalidate()
  }

  scrollRows(rows: number): void {
    this.rig.goal.target.y -= rows * ROW_H
    this.invalidate()
  }

  /**
   * Follows the M8 cursor: its track becomes the focused one; a wall cell (velocity,
   * instrument, FX, a table, an instrument panel) unfolds the part of the wall it is on and
   * comes into view (it scrolls there unless `scroll` is off). Null stops following.
   */
  follow(selection: Selection | null, options: { scroll?: boolean } = {}): void {
    this.navigator.follow(selection, options.scroll !== false)
  }

  /** Moves the camera so a selection (the current one by default) is in view, closer. */
  focusSelection(selection = this.focus.selection): void {
    if (selection) this.navigator.focusSelection(selection)
  }

  /** Scrolls once to where the song plays (the playhead furthest down); false when it does not play. */
  jumpToPlayhead(): boolean {
    const jumped = this.navigator.aimAtPlayhead()
    if (jumped) this.invalidate()
    return jumped
  }

  /** Tells the view how many pixels at its top the HUD covers: the track headers stick right under them. */
  setTopInset(pixels: number): void {
    if (this.sticky.setTopInset(pixels)) this.invalidate()
  }

  /** Tells the view which parts of it the HUD's selection panel covers: automatic framings keep clear of them. */
  setCoveredAreas(areas: CoveredArea[]): void {
    this.navigator.setCoveredAreas(areas)
  }

  // ---------------------------------------------------------------------------
  // Walls

  /** How far a part is unfolded across the tracks: on every track by its button (all), on some (by a button or a navigation), or on none. */
  foldCoverage(section: FoldSection): 'off' | 'some' | 'all' {
    return this.folds.coverage(section)
  }

  /**
   * Unfolds every part of every track's wall (or, with `section`, that part of every track's), or
   * folds them all when they are all unfolded; returns true when they are unfolded.
   */
  toggleAllFolds(section?: FoldSection): boolean {
    const open = !this.folds.allByButton(section)
    this.folds.setAll(open, section)
    for (let track = 0; track < TRACKS; track += 1) this.showFoldButtons(track)
    if (open) this.navigator.revealTrack(this.focus.track())
    this.foldsChanged()
    return open
  }

  /**
   * A track's fold button: unfolds its part of the wall until the button is pressed again, and
   * brings it into view. A part a navigation unfolded stays unfolded, now for good.
   */
  toggleFold(track: number, section: FoldSection): void {
    const toggled = this.folds.toggle(track, section)
    if (!toggled) return
    this.showFoldButtons(track)
    if (toggled.opened && !toggled.wasOpen) this.navigator.revealTrack(track)
    this.foldsChanged()
  }

  private showFoldButtons(track: number): void {
    this.content.trackViews[track]?.setFoldButtons(this.folds.buttonState(track, 'fx'), this.folds.buttonState(track, 'panels'))
  }

  private foldsChanged(): void {
    this.highlights.refreshLinks(this.focus.selection)
    this.invalidate()
    this.onFolds()
  }

  /**
   * The `cols` header button: a track's wall gets one more column of panels (up to the most they
   * want), or goes back to the usual number. Only that track changes: its wall eases to its new
   * length, its panels glide to their new columns and the tracks on its right slide along.
   */
  private cycleColumns(track: number): void {
    const layout = this.content.layout
    const lanes  = layout?.tracks[track]
    if (!lanes || !layout) return
    const wider              = lanes.cols < lanes.wanted
    this.panelColumns[track] = wider ? Math.min(MAX_PANEL_COLS, lanes.cols + 1) : DEFAULT_PANEL_COLS
    if (!layout.setColumnLimit(track, this.panelColumns[track])) return
    this.content.trackViews[track]?.refreshColumns()
    if (wider) this.navigator.revealTrack(track)
    this.highlights.refreshLinks(this.focus.selection)
    this.invalidate()
  }

  /** Turns the wall `degrees` from the front (the Options panel's slider). */
  setWallDegrees(degrees: number): void {
    const angle = MathUtils.degToRad(degrees)
    if (Math.abs(angle - this.content.wallAngle) < 1e-4) return
    this.content.wallAngle = angle
    for (const view of this.content.trackViews) view.setWallAngle(angle)
    this.highlights.refreshLinks(this.focus.selection)
    this.invalidate()
  }

  /** Lights the mute and solo buttons of every track. */
  setTrackModes(muted: boolean[], soloed: boolean[]): void {
    this.trackModes = {
      muted : [...muted],
      soloed: [...soloed]
    }
    for (const [track, view] of this.content.trackViews.entries()) view.setTrackModes(!!muted[track], !!soloed[track])
    this.invalidate()
  }

  // ---------------------------------------------------------------------------
  // Panel faces

  /** The instrument the M8 shows (null on any other view); turns over its panels. */
  setDeviceInstrument(instrument: number | null): void {
    if (this.faces.setDeviceInstrument(instrument)) this.facesChanged()
  }

  /** Turns a panel over by hand. */
  toggleFace(track: number, table: number): void {
    const layout = this.content.layout
    const panel  = layout?.panelOf(track, table)
    if (!panel || panel.instrument == null || !layout?.instrumentFace(panel.instrument)) return
    this.faces.toggle(panel)
    this.facesChanged()
  }

  /** The layout makes room for the faces panels turn to at once, so a framing made now sees where they settle. */
  private facesChanged(): void {
    for (const view of this.content.trackViews) view.cards.applyFaceGoals()
    this.invalidate()
  }

  /**
   * Key I: turns over the panel of the selection (a panel cell, or the instrument a step
   * plays), turning the view to its wall first when needed.
   */
  toggleSelectedFace(): void {
    const { selection } = this.focus
    const layout        = this.content.layout
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

  // ---------------------------------------------------------------------------
  // Selection

  select(selection: Selection | null, options: SelectOptions = {}): void {
    const { focus, navigator } = this
    const changed              = !sameSelection(selection, focus.selection)
    // A navigation (the arrows, auto select) to another track pans by the distance between the tracks: where it left from, before anything folds.
    navigator.prepareDeparture(focus.selection, selection && changed && (options.turn || options.silent) ? selection : null)
    if (!selection) focus.middleTrack = focus.track()
    // A choice made here wins over the followed M8 cursor until the cursor moves, and over a track pressed by hand.
    if (!options.silent) {
      focus.followedTrack = null
      focus.handTrack     = null
    }
    focus.selection = selection
    // Leaving a track folds what navigations unfolded on it (cleared, the followed M8 cursor's track keeps them).
    navigator.foldAutoExcept(selection ? selectionTrack(selection) : focus.followedTrack)
    this.refreshMarkers()
    // The HUD first: its selection panel takes its new size, which the framing keeps clear of.
    if (changed && !options.silent) this.onSelect(selection)
    if (selection && options.turn) navigator.reachCell(selection, true, options.landTop)
    else if (selection && options.reveal !== false) navigator.scrollIntoView(selection)
    if (selection && options.focus) navigator.focusSelection(selection)
  }

  getSelection(): Selection | null {
    return this.focus.selection
  }

  /** Where the M8 cursor is (every place the item under it appears). */
  setDevicePlaces(selections: Selection[]): void {
    this.highlights.devicePlaces = selections
    this.refreshMarkers()
  }

  private refreshMarkers(): void {
    this.highlights.refresh(this.focus.selection, this.palette)
    this.invalidate()
  }

  /**
   * Arrow keys: rows down the song, columns across the step then the next track. Coarse
   * (Shift+arrows): up / down a whole phrase, left / right the same cell in the next track;
   * on a table, up / down go to its first or last row. See selectionMoves.
   */
  moveSelection(rowDelta: number, columnDelta: number, coarse = false): void {
    const layout = this.content.layout
    if (!layout) return
    const { selection } = this.focus
    if (!selection) {
      const start = firstStepNear(layout, this.focus.track(), this.rig.goal.target.y)
      if (start) this.select(start, { focus: false })
      return
    }
    const showsFace = (panel: Panel) => this.content.trackViews[panel.track]?.cards.shownFace(panel) === 'inst'
    const moved     = movedSelection(layout, selection, rowDelta, columnDelta, coarse, showsFace)
    if (moved) this.select(moved, { turn: true })
  }

  // ---------------------------------------------------------------------------
  // Pointer input (see pointerControls)

  dragPan(fromX: number, fromY: number, toX: number, toY: number): void {
    this.hand.dragPan(fromX, fromY, toX, toY)
  }

  panned(): void {
    this.hand.panned()
  }

  turnStarted(clientX: number, clientY: number): void {
    this.hand.turnStarted(this.trackAt(clientX, clientY))
  }

  turnedByHand(): void {
    this.hand.turnedByHand()
  }

  turnEnded(): void {
    this.hand.turnEnded()
  }

  zoomAt(clientX: number, clientY: number, factor: number): void {
    this.hand.zoomAt(clientX, clientY, factor)
    this.invalidate()
  }

  /** The track under a pointer position: the cell's there, else the column or unfolded wall shown there. */
  private trackAt(clientX: number, clientY: number): number | null {
    const cell = this.cellAt(clientX, clientY)
    if (cell) return selectionTrack(cell)
    const [ndcX, ndcY] = this.probe.ndcAt(clientX, clientY)
    return this.placement.trackUnder(this.probe.lens(), this.rig.current, ndcX, ndcY)
  }

  interacted(): void {
    this.interactedAt = performance.now()
  }

  buttonAt(clientX: number, clientY: number): SceneButton | null {
    return this.picker.pickButton(this.content.trackViews, clientX, clientY)
  }

  cellAt(clientX: number, clientY: number): Selection | null {
    const { layout, trackViews } = this.content
    return layout ? this.picker.pickCell(layout, trackViews, clientX, clientY) : null
  }

  hover(selection: Selection | null): void {
    if (sameSelection(selection, this.highlights.hovered)) return
    this.highlights.hovered = selection
    this.refreshMarkers()
    this.onHover(selection)
  }

  /** A click selects (nothing: clears) and opens the wall of the track pressed until a click goes to another track, unless its buttons keep it open. */
  click(selection: Selection | null, clientX: number, clientY: number): void {
    this.select(selection, { reveal: false })
    const track = selection ? selectionTrack(selection) : this.trackAt(clientX, clientY)
    if (track != null) this.navigator.openTrack(track)
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
  // Playback

  /** The M8's Table view shows table `table` on these rows (see TablePlayback.observeTableView). */
  observeTableView(table: number, main: number | null, lanes: (number | null)[], track: number | null): void {
    this.marks.observeTableView(table, main, lanes, track)
  }

  /** Where the song plays, read each frame (null stops it). */
  setPlayheadSource(source: (() => (TrackPlayhead | null)[]) | null): void {
    this.marks.source = source
    this.invalidate()
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
    this.highlights.resize(width, height)
    this.invalidate()
  }

  /**
   * Places the playheads, and, when following playback, scrolls with the one furthest down the
   * song (a track looping a chain of its own stays behind, under its halo); returns true while
   * anything plays.
   */
  private updatePlayheads(dt: number): boolean {
    const playing = this.marks.update(dt, this.rig.current, this.palette)
    if (playing && this.navigator.followPlayback) this.navigator.aimAtPlayhead()
    return playing
  }

  /** Sticky headers and panels, panel glides and links; returns true while anything moves. */
  private updateStickyParts(dt: number, textOn: boolean): boolean {
    const { busy, panelsMoved } = this.sticky.update(dt, textOn)
    // Markers and thick links attached to a panel follow it, frame by frame.
    if (panelsMoved && this.focus.selection) this.refreshMarkers()
    return busy || panelsMoved
  }

  /** Eases the walls and places the tracks (see TrackPlacement.update); the rules between song rows follow. */
  private updateWalls(dt: number): boolean {
    const walls = this.placement.update(dt, this.rig.current.yaw)
    let busy    = walls.busy
    this.highlights.followWalls(this.focus.selection)
    // The rules between song rows cross every track, to the end of the last: they leave with the folded tracks, or they would cut across the view along the wall.
    const rules = this.bandRules
    if (rules) {
      const material = rules.material as LineBasicMaterial
      const width    = walls.end + 4
      if (Math.abs(material.opacity - BAND_RULE_OPACITY * walls.staying) > 1e-4 || Math.abs(rules.scale.x - width) > 1e-3) busy = true
      material.opacity = BAND_RULE_OPACITY * walls.staying
      rules.position.x = -4
      rules.scale.x    = width
    }
    return busy
  }

  private tick(): void {
    const now       = performance.now()
    const dt        = Math.min(0.05, (now - this.lastTickAt) / 1000)
    this.lastTickAt = now
    this.placement.noteSettledColumns()
    this.sticky.limitPan()
    let busy       = this.rig.update(dt)
    const pxPerRow = (ROW_H / (2 * this.probe.visibleHalfHeight(this.rig.current.distance))) * this.container.clientHeight
    const textOn   = pxPerRow > MIN_TEXT_PX_PER_ROW
    if (this.updateStickyParts(dt, textOn)) busy = true
    if (this.updateWalls(dt)) busy = true
    const playing = this.updatePlayheads(dt)

    this.rig.apply(this.camera)
    const camera    = this.rig.current
    const half      = this.probe.visibleHalfHeight(camera.distance)
    const barsAlpha = 0.08 + 0.82 * (1 - smoothstep(5, 10, pxPerRow))
    for (const view of this.content.trackViews) view.setBarsAlpha(barsAlpha)
    const fog = this.scene.fog as Fog
    fog.near  = camera.distance * 1.05 + 10
    fog.far   = camera.distance * 2.2 + 160

    const views       = this.content.trackViews
    const reach       = half * (1.25 + Math.abs(Math.sin(camera.pitch)) * 2)
    const textChanged = this.pool.update(camera.target.y + reach, camera.target.y - reach, camera.target.y, (block) => {
      if (!textOn && block.layer !== 'static') return 0
      if (block.layer === 'wall') return views[block.track]?.sideAlpha ?? 0
      return block.track < 0 ? 1 : (views[block.track]?.frontAlpha ?? 1)
    })

    const pulsing     = this.highlights.pulse(now)
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

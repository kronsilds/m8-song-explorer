// Automatic framing of the 3D view: the Overview / Front / Turn / Side presets (a new dramatic take
// at each cut when asked), and every navigation (a selection made with the arrows or by auto select,
// the followed M8 cursor, the playhead): what it unfolds, then where the view pans, scrolls and
// slides, measured where things will be once the walls settle, clear of the HUD.

import { Box3, MathUtils, Vector3 } from 'three'
import { isPanelSelection, isWallCell, type PanelSelection, type Selection, sameSelection, selectionTrack } from '../../model/selection'
import { ROWS_PER_PHRASE } from '../../model/song'
import type { SceneContent } from '../content'
import { FRONT_W, HEADER_H, PANEL_COL_W, PANEL_U0, ROW_H, SIDE_END } from '../layout'
import type { PlaybackMarks } from '../markers/playbackMarks'
import { FACE_PAD_LEFT } from '../track/panelCards'
import type { TrackPlacement } from '../track/placement'
import type { FoldSection } from '../track/trackHeader'
import { HEADER_BOTTOM } from '../track/trackHeader'
import { WALL_STEPS_U, WALL_STEPS_W } from '../track/trackView'
import { FOLD_SECTIONS, type WallFolds } from '../track/wallFolds'
import { FACING_FRONT_YAW, presetAngles, type TurnPreset, type ViewPreset } from './cameraAngles'
import {
  type Align,
  cutAnchor,
  fitDistance,
  fitsAcross,
  holdOnScreen,
  type Margins,
  screenPoint,
  screenX,
  shiftTarget,
  showAtHeight,
  sideShift,
  trackSlide,
} from './framing'
import type { CameraRig, RigPose } from './rig'
import { type StickyHeaders, VIEW_BOTTOM_NDC } from './stickyHeaders'
import type { ViewFocus } from './viewFocus'
import type { ViewProbe } from './viewProbe'

/** Room an automatic framing keeps free at each side of the screen (a fraction of the half width). */
const FRAME_MARGINS  = {
  left : 0.04,
  right: 0.04
}
/** Pixels an automatic framing keeps between what it shows and a panel of the HUD over the view. */
const COVER_GAP_PX   = 12
/** An automatic framing keeps clear of the HUD's panels while that leaves it this much of the width (a fraction). */
const MIN_FREE_WIDTH = 0.4
/** Where a cell lands after the view scrolls to it, as a fraction of the visible stretch from the edge opposite to where it left (so a scroll is about 4/5 of a page). */
const SCROLL_LAND    = 0.2
/** Following the M8: a cell lands this many rows under the headers, and the view scrolls when fewer rows than LOOKAHEAD_ROWS are left under it. */
const LAND_TOP_ROWS  = 2
const LOOKAHEAD_ROWS = 4
/** Following playback, the playhead shows at this screen height on its track (normalized, -1 bottom to 1 top: a third of the way down), whatever the angle. */
const PLAYHEAD_NDC_Y = 0.35

/** A part of the view a panel of the HUD covers, in pixels from the view's top-left corner (the HUD measures it). */
export type CoveredArea = Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>

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

/** What the navigator tells the world about. */
export interface NavigatorHooks {
  invalidate(): void
  /** Navigations unfolded or folded parts of these tracks' walls. */
  foldsChanged(tracks: number[]): void
}

export class Navigator {
  /** Scroll with the playhead of the focused track while the song plays. */
  followPlayback    = false
  /** Measures the parts of the view the HUD's selection panel covers now (it may just have changed its content), when given; else the areas last set are used. */
  coverage          : (() => CoveredArea[]) | null = null
  /** Parts of the view the HUD's selection panel covers: automatic framings keep clear of them. */
  private covered   : CoveredArea[] = []
  /** Every cut to front, turn or side (by hand or by following) takes a skewed, tilted angle. */
  private dramatic  = false
  /** Cuts taken so far: dramatic takes alternate low / high. */
  private cuts      = 0
  /** The preset the view was last set to, until it is turned by hand. */
  private preset    : ViewPreset | null = null
  /** A navigation to another track under way (see Departure), until the view goes to its place. */
  private departure : Departure | null = null

  constructor(
    private readonly content: Readonly<SceneContent>,
    private readonly rig: CameraRig,
    private readonly probe: ViewProbe,
    private readonly placement: TrackPlacement,
    private readonly folds: WallFolds,
    private readonly focus: ViewFocus,
    private readonly sticky: StickyHeaders,
    private readonly marks: PlaybackMarks,
    private readonly hooks: NavigatorHooks,
  ) {}

  // ---------------------------------------------------------------------------
  // Presets

  view(preset: ViewPreset, immediate = false): void {
    const { rig, focus, placement, probe } = this
    const goal                             = rig.goal
    const layout                           = this.content.layout
    // Nothing chosen: the track in the middle of the view is the one the view centres on.
    if (preset !== 'overview' && !focus.chosen()) focus.middleTrack = placement.trackUnder(probe.lens(), goal, 0) ?? focus.middleTrack
    if (preset === 'overview') {
      const width   = placement.songWidth()
      goal.yaw      = 0
      goal.pitch    = 0
      goal.roll     = 0
      goal.distance = probe.distanceToFit(width * 1.04, 40)
      // Leave the title clear of the top bar.
      const titleY  = layout ? layout.titleY : HEADER_H + ROW_H * 1.5
      goal.target.set(width / 2 - 4, titleY - probe.visibleHalfHeight(goal.distance) * 0.6, 0)
    } else {
      this.aim(preset)
    }
    this.preset = preset
    if (preset === 'angle' || preset === 'side') goal.target.copy(this.trackCentre(goal, focus.track(), this.folds.isUnfolded(focus.track()), true))
    else if (preset === 'front') this.frameFront()
    if (immediate) rig.jump()
    this.hooks.invalidate()
  }

  /** Turns the goal to a preset's angles (a new dramatic take each cut). */
  private aim(preset: TurnPreset): void {
    if (this.dramatic) this.cuts += 1
    Object.assign(this.rig.goal, presetAngles(preset, this.dramatic, this.cuts, MathUtils.radToDeg(this.content.wallAngle)))
  }

  /** Switches dramatic angles; the current preset is taken again the new way. */
  setDramatic(on: boolean): void {
    this.dramatic = on
    if (this.preset) this.view(this.preset)
    else if (!on) this.rig.goal.roll = 0
    this.hooks.invalidate()
  }

  /** The view was turned by hand, away from any preset. */
  leavePreset(): void {
    this.preset = null
  }

  /**
   * The target that centres a track on screen for a pose's angles and distance: its front
   * column, or with `open` its column and open wall together. The same framing for every
   * track. `fit` also sets the pose's distance to the one at which they fill the screen
   * (within readable distances).
   */
  private trackCentre(pose: RigPose, track: number, open: boolean, fit = false): Vector3 {
    const lens    = this.probe.lens()
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
      const [near, far] = this.probe.readableDistances(ROW_H)
      probe.distance    = fitDistance(probe, lens, points, margins, near, far)
      pose.distance     = probe.distance
      points            = this.trackSpan(track, open)
    }
    shiftTarget(probe, sideShift(probe, lens, points, margins, [], 'center'))
    return probe.target
  }

  /** Where the target goes to centre a track at the goal's yaw: its column, and what it has unfolded. */
  trackPivot(track: number): Vector3 {
    return this.trackCentre(this.rig.goal, track, this.folds.isUnfolded(track))
  }

  /**
   * Facing the front, a framing of the tracks as a whole: centred on all of them, then slid
   * no more than it takes for the focused track's column to be on screen. The target stands on
   * the tracks' plane, or `z` off it (a navigation keeps the camera's distance from the tracks).
   */
  private frameFront(z = 0): void {
    const goal = this.rig.goal
    if (this.content.trackViews.length === 0) return
    const y   = goal.target.y
    const all = [new Vector3(0, y, 0), new Vector3(this.placement.songEnd(), y, 0)]
    goal.target.set((all[0].x + all[1].x) / 2, y, z)
    this.slideGoal(all, [], 'center')
    this.slideGoal(this.trackSpan(this.focus.track(), false))
  }

  // ---------------------------------------------------------------------------
  // Folds a navigation opens

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
    if (!section || this.folds.opened(track)[section]) return
    this.folds.unfoldByNavigation(track, section)
    this.revealTrack(track)
    this.hooks.foldsChanged([track])
  }

  /**
   * A click on a track: its whole wall (step details and panels) unfolds until a navigation or a
   * click goes to another track, and comes into view. Parts its buttons keep unfolded stay so.
   */
  openTrack(track: number): void {
    this.foldAutoExcept(track)
    const opened = this.folds.opened(track)
    const closed = FOLD_SECTIONS.filter((section) => !opened[section])
    if (!closed.length) return
    for (const section of closed) this.folds.unfoldByNavigation(track, section)
    this.revealTrack(track)
    this.hooks.foldsChanged([track])
  }

  /**
   * Folds again what navigations unfolded on every track but `keep` (on all of them when null),
   * and moves the view with `keep` (else the focused track) so its column stays where it is on
   * screen while the tracks on its left close up.
   */
  foldAutoExcept(keep: number | null): void {
    const folding = this.folds.unfoldedByNavigation(keep)
    if (!folding.length) return
    const still  = keep ?? this.focus.track()
    const before = this.placement.settledX(still)
    this.folds.foldNavigation(folding)
    this.rig.goal.target.x       += this.placement.settledX(still) - before
    this.hooks.foldsChanged(folding)
  }

  /** Slides the view sideways, no more than it takes, for a track's column and its unfolded wall to be on screen (its column first). */
  revealTrack(track: number): void {
    const span = this.trackSpan(track, this.folds.isUnfolded(track))
    this.slideGoal(span, span.slice(0, 2))
  }

  // ---------------------------------------------------------------------------
  // Navigations

  /**
   * Follows the M8 cursor: its track becomes the focused one; a wall cell (velocity,
   * instrument, FX, a table, an instrument panel) unfolds the part of the wall it is on and
   * comes into view. Null stops following.
   */
  follow(selection: Selection | null, scroll: boolean): void {
    const { focus } = this
    if (selection && sameSelection(selection, focus.followedSelection)) return
    // With auto select, select() took the departure before it folded anything.
    if (selection && !(this.departure && sameSelection(this.departure.to, selection))) this.departure = this.departFrom(focus.followedSelection, selection)
    focus.followedSelection = selection
    if (!selection) {
      if (focus.followedTrack != null) focus.middleTrack = focus.followedTrack
      focus.followedTrack = null
      this.hooks.invalidate()
      return
    }
    focus.handTrack     = null
    focus.followedTrack = selectionTrack(selection)
    this.reachCell(selection, scroll, true)
    this.hooks.invalidate()
  }

  /** A navigation from `from` to `to` may begin (null: none): where it leaves from, taken before anything folds (see Departure). */
  prepareDeparture(from: Selection | null, to: Selection | null): void {
    this.departure = to ? this.departFrom(from, to) : null
  }

  /** The departure of a navigation from `from` to `to` (see Departure), when they are on different tracks. */
  private departFrom(from: Selection | null, to: Selection): Departure | null {
    if (!from || selectionTrack(from) === selectionTrack(to)) return null
    const track = selectionTrack(from)
    return {
      to,
      track,
      x    : this.placement.settledColumn(track),
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
    this.rig.goal.target.x = departure.goalX + this.placement.settledX(track) - departure.x
    this.sticky.clampGoal()
  }

  /**
   * Unfolds the part of the wall a wall cell is on, then brings the selection into view (measured
   * where it will be once the walls have moved), clear of the HUD's selection panel: the view slides
   * along the tracks, keeping its distance from them, and scrolls, unless `scroll` is off (the
   * playheads scroll the view while the song plays), so that all it marks shows (the phrase of a
   * chain row, the chain of a song cell), or its top when that is taller than the view. The
   * camera does not turn.
   */
  reachCell(selection: Selection, scroll = true, landTop = false): void {
    const before = this.rig.goal.target.clone()
    this.unfoldFor(selection)
    this.panAcrossTracks(selection)
    this.frameCell(selection, scroll, landTop)
    if (this.rig.goal.target.distanceTo(before) > 0.05) this.cutDramatic(selection, scroll, landTop)
    this.hooks.invalidate()
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
    const anchor = cell && cutAnchor(this.rig.goal, this.probe.lens(), cell)
    if (!anchor || anchor === cell) return focus
    const dy      = anchor.y - cell.y
    const moved   = (points: Vector3[]) => points.map((point) => point.clone().setY(point.y + dy))
    const shifted : Focus = {
      box : moved(focus.box),
      cell: moved(focus.cell)
    }
    if (focus.core) shifted.core = moved(focus.core)
    return shifted
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
    const lens   = this.probe.lens()
    const cell   = isPanelSelection(selection) ? (this.settledCard(selection)?.cell ?? null) : this.placement.settledPoint(selection)
    const anchor = (this.followPlayback ? this.marks.leadPoint(selectionTrack(selection)) : null) ?? (cell && cutAnchor(goal, lens, cell))
    const shown  = anchor && screenPoint(goal, lens, anchor)
    this.aim(preset)
    if (anchor && shown) {
      holdOnScreen(goal, lens, anchor, shown)
      this.sticky.clampGoal()
    }
    this.frameCell(selection, scroll, landTop)
  }

  /** Moves the camera so a selection is in view, closer. */
  focusSelection(selection: Selection): void {
    this.unfoldFor(selection)
    const point = this.placement.settledPoint(selection)
    if (!point) return
    const goal = this.rig.goal
    goal.target.set(point.x, point.y, isWallCell(selection) ? point.z : 0)
    goal.distance = Math.min(goal.distance, 70)
    this.hooks.invalidate()
  }

  /** Scrolls the playhead furthest down the song to show at PLAYHEAD_NDC_Y on the focused track's column, whatever the angle; false when nothing plays. */
  aimAtPlayhead(): boolean {
    const point = this.marks.leadPoint(this.focus.track())
    if (!point) return false
    showAtHeight(this.rig.goal, this.probe.lens(), point, PLAYHEAD_NDC_Y)
    // Within the view's limits at once, so a navigation does not take the clamp for a move of its own.
    this.rig.clampGoal()
    return true
  }

  // ---------------------------------------------------------------------------
  // What a navigation shows

  /**
   * Points across what a framing shows of a track, where it settles, for the goal view: its
   * front column, and when `open` what it has unfolded: its step details, and its panels up to
   * the ones shown for the rows in view (at least its first panel column), each as wide as the
   * face it turns to (an instrument face reaches past the wall's end).
   */
  private trackSpan(track: number, open: boolean): Vector3[] {
    const { placement } = this
    const layout        = this.content.layout
    const goal          = this.rig.goal
    const y             = goal.target.y
    const left          = placement.settledX(track)
    const front         = [new Vector3(left, y, 0), new Vector3(left + FRONT_W, y, 0)]
    const fold          = this.folds.opened(track)
    const lanes         = layout?.tracks[track]
    if (!open || !layout || !lanes) return front
    const slide  = placement.wallSlide(fold.fx ? 1 : 0)
    const onWall = (u: number) => placement.onWall(left, u, slide).setY(y)
    if (!fold.panels) return [...front, onWall(SIDE_END)]
    // Which panels the rows in view would show, and in which columns (the panels themselves stay where they are).
    const range = this.sticky.range(goal, true)
    const ends  = layout.probe(track, range.panelTop, range.bottom, range.view).map((shown) => placement.cardCorners(track, shown).corners[1].setY(y))
    return [...front, onWall(Math.min(lanes.wallLen, PANEL_U0 + PANEL_COL_W)), ...ends]
  }

  /**
   * Where the panel of a panel cell settles for the goal view: its card's corners (see
   * TrackPlacement.cardCorners) and the cell's centre on the face the panel turns to. Null when
   * the layout would not show the panel there (none of its uses is near the rows in view).
   */
  private settledCard(selection: PanelSelection): { corners: Vector3[]; cell: Vector3 } | null {
    const { layout } = this.content
    const track      = selection.track
    const view       = this.content.trackViews[track]
    const panel      = layout?.panelOf(track, selection.table)
    if (!layout || !view || !panel) return null
    const range = this.sticky.range(this.rig.goal, true)
    const shown = layout.probe(track, range.panelTop, range.bottom, range.view).find((p) => p.panel === panel)
    if (!shown) return null
    const { corners, start, along } = this.placement.cardCorners(track, shown)
    // Cells are placed in the frame of the face: x from its first character, y from its title line.
    const rect                      = this.placement.rectsOf(selection, true).at(-1)
    const cell                      = rect ? start.clone().addScaledVector(along, FACE_PAD_LEFT + rect.x + rect.w / 2).setY(shown.y + rect.y - rect.h / 2) : corners[0]
    return {
      corners,
      cell
    }
  }

  /** How far the bottom of a card (see TrackPlacement.cardCorners) reaches under the bottom of the view, where it stands; 0 or less when it is above it. */
  private cutBelow(corners: Vector3[]): number {
    const goal = this.rig.goal
    this.probe.aim(goal)
    return Math.max(...corners.slice(2).map((corner) => this.probe.heightAt(goal, corner.x, VIEW_BOTTOM_NDC, corner.z) - corner.y))
  }

  /**
   * What a navigation to a front or step cell shows, where things settle: the phrase it is in (a
   * Song view cell: its chain, every phrase of its song row) across the front column, and the step
   * details when they are unfolded; and the cell itself.
   */
  private focusOf(selection: Extract<Selection, { kind: 'step' | 'chain' }>): Focus | null {
    const layout = this.content.layout
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
    const left   = this.placement.settledX(track)
    const across = [new Vector3(left - 0.2, 0, 0), new Vector3(left + FRONT_W, 0, 0)]
    // Unfolded, the step details stand on the wall where it settles (not slid back).
    if (this.folds.opened(track).fx) across.push(this.placement.onWall(left, WALL_STEPS_U + WALL_STEPS_W, 0))
    const cell   = this.placement.settledCorners(selection)
    if (!cell.length) return null
    return {
      box: across.flatMap((point) => [point.clone().setY(top), point.clone().setY(bottom)]),
      cell
    }
  }

  /** What a navigation to a panel cell shows: the card with its track's column at the card's heights, the card, the cell. */
  private cardFocus(track: number, card: { corners: Vector3[]; cell: Vector3 }): Focus {
    const left   = this.placement.settledX(track)
    const top    = Math.max(...card.corners.map((corner) => corner.y))
    const bottom = Math.min(...card.corners.map((corner) => corner.y))
    const column = [left - 0.2, left + FRONT_W].flatMap((x) => [new Vector3(x, top, 0), new Vector3(x, bottom, 0)])
    return {
      box : [...column, ...card.corners],
      core: card.corners,
      cell: [card.cell]
    }
  }

  // ---------------------------------------------------------------------------
  // Scrolling and sliding

  /**
   * Scrolls for the whole focus box to show between the sticky headers and the bottom of the view
   * (measured where each of its points stands: seen at an angle, a nearer one shows larger), or,
   * when it is taller than that, its cell. Nothing moves while it shows. Else it lands with room
   * in the direction the view went: following the M8 (`landTop`), its top just under the headers
   * (what follows matters more), a cell left with LOOKAHEAD_ROWS under it; otherwise SCROLL_LAND
   * of the stretch from the edge it came in by.
   */
  private scrollToShow(focus: Focus, landTop: boolean): void {
    const { probe } = this
    const goal      = this.rig.goal
    probe.aim(goal)
    const range          = this.sticky.range(goal, true)
    const viewTop        = Math.min(range.headerTop, this.content.layout?.headerRestY ?? Number.POSITIVE_INFINITY) - HEADER_BOTTOM
    // How far its top is under the headers, and its bottom under the view (the view moves up by
    // `above` to show the one, down by `below` to show the other).
    const outside        = (points: Vector3[]) => ({
      above: Math.max(...points.map((point) => point.y)) - viewTop,
      below: Math.max(...points.map((point) => probe.heightAt(goal, point.x, VIEW_BOTTOM_NDC, point.z) - point.y))
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
    const span    = viewTop - probe.heightAt(goal, cell.x, VIEW_BOTTOM_NDC, cell.z)
    const shift   = landTop
      ? above + Math.min(LAND_TOP_ROWS * ROW_H, room)
      : below > 0
        ? above + Math.min(span * SCROLL_LAND, room)
        : -below - Math.min(span * SCROLL_LAND, room)
    goal.target.y += shift
    this.sticky.clampGoal()
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
    const lens    = this.probe.lens()
    const margins = this.frameMargins(...this.probe.screenHeights(goal, focus.box))
    if (this.inFrame(focus.box, margins)) return
    if (goal.yaw < FACING_FRONT_YAW && !isWallCell(selection) && this.songFits(margins)) {
      this.frameFront(goal.target.z)
      if (this.inFrame(focus.box, margins)) return
    }
    const track = selectionTrack(selection)
    const slide = trackSlide(goal, lens, margins)
    const fits  = (points: Vector3[]) => fitsAcross(goal, lens, points, margins, slide)
    if (fits(focus.box)) this.slideGoal([...this.trackSpan(track, this.folds.isUnfolded(track)), ...focus.box], focus.box, 'center', margins)
    else if (focus.core && fits(focus.core)) this.slideGoal(focus.box, focus.core, 'center', margins)
    else this.slideGoal(focus.core ?? focus.box, focus.cell, 'center', margins)
  }

  /** True when every point shows between the margins, seen from the goal view. */
  private inFrame(points: Vector3[], margins: Margins): boolean {
    const goal = this.rig.goal
    const lens = this.probe.lens()
    return points.every((point) => {
      const x = screenX(goal, lens, point)
      return x >= margins.left - 1 - 1e-3 && x <= 1 - margins.right + 1e-3
    })
  }

  /** True when the whole song, where the tracks settle, fits across the screen at the goal's distance. */
  private songFits(margins: Margins): boolean {
    const y = this.rig.goal.target.y
    return fitsAcross(this.rig.goal, this.probe.lens(), [new Vector3(0, y, 0), new Vector3(this.placement.songEnd(), y, 0)], margins)
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
    const goal   = this.rig.goal
    const layout = this.content.layout
    let card     = this.settledCard(selection)
    const panel  = layout?.panelOf(selection.track, selection.table)
    if (!card && scroll && panel && layout) {
      const range = this.sticky.range(goal, true)
      const top   = layout.nearestUseY(panel, range.headerTop, range.bottom)
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
      this.sticky.clampGoal()
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
    this.probe.aim(goal)
    const range       = this.sticky.range(goal, true)
    const viewTop     = range.headerTop - ROW_H - 0.4
    const viewBottom  = at ? this.probe.heightAt(goal, at.x, VIEW_BOTTOM_NDC, at.z) : range.bottom
    const span        = viewTop - viewBottom
    const aboveCentre = viewTop - goal.target.y
    const belowCentre = goal.target.y - viewBottom
    if (landTop) {
      // What follows a cell matters more than what precedes it: scroll when it sits too low, and land it just under the headers.
      if (bottom < viewBottom + LOOKAHEAD_ROWS * ROW_H || top > viewTop) goal.target.y = top - aboveCentre + LAND_TOP_ROWS * ROW_H
    } else if (bottom < viewBottom) goal.target.y = top - aboveCentre + span * SCROLL_LAND
    else if (top > viewTop) goal.target.y = bottom + belowCentre - span * SCROLL_LAND
    // Near the start of the song the view goes no higher than the headers allow.
    this.sticky.clampGoal()
  }

  /** Scrolls just enough for a selection's cell to be on screen (and slides to it when it is off to a side). */
  scrollIntoView(selection: Selection): void {
    const rect = this.placement.rectsOf(selection).at(-1)
    if (!rect) return
    const world = rect.parent.localToWorld(new Vector3(rect.x, rect.y, 0))
    const goal  = this.rig.goal
    const half  = this.probe.visibleHalfHeight(goal.distance) * 0.8
    this.scrollRowsInto(world.y, world.y - rect.h, false, world)
    const halfWidth = half * this.probe.lens().aspect
    if (world.x > goal.target.x + halfWidth || world.x < goal.target.x - halfWidth) goal.target.x = world.x
  }

  /**
   * Slides the goal sideways to frame `points` (see sideShift): along the tracks, so the camera
   * keeps its distance from them and the zoom stays as it is, as a pan by hand does (along the
   * view only when it looks almost along the tracks). The margins keep clear of the HUD's selection
   * panel at every height by default (see frameMargins).
   */
  private slideGoal(points: Vector3[], mustSee: Vector3[] = [], align: Align = 'least', margins = this.frameMargins()): void {
    const goal  = this.rig.goal
    const lens  = this.probe.lens()
    const slide = trackSlide(goal, lens, margins)
    shiftTarget(goal, sideShift(goal, lens, points, margins, mustSee, align, slide), slide)
    this.sticky.clampGoal()
  }

  // ---------------------------------------------------------------------------
  // Room the HUD leaves

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
    const width  = this.probe.width
    const height = this.probe.height
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
}

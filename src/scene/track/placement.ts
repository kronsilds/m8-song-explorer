// Where the tracks stand along x: each track's front column, then the room its unfolded wall
// takes (how far it reaches at the wall's angle, the instrument faces turned out of it), then the
// next column. Measured as drawn now (the walls may still be moving) and where they settle, which
// is what the framings use. Also eases the walls toward their folds, frame by frame.

import { MathUtils, type Object3D, Vector3 } from 'three'
import { type Selection, selectionTrack } from '../../model/selection'
import { TRACKS } from '../../model/song'
import { type Lens, rayMeets, rayThrough } from '../camera/framing'
import type { RigPose } from '../camera/rig'
import type { SceneContent } from '../content'
import { FRONT_W, PANELS_SLIDE, panelU, ROW_H, type ShownPanel, SIDE_END, TRACK_GAP, TRACK_PITCH, WALL_HINGE } from '../layout'
import type { CellRect } from '../markers/cellMarker'
import { cellRects } from '../markers/cellRects'
import { easeFactor, smoothstep } from '../shapes'
import { FACE_WIDTH } from './instrumentFaceView'
import { FACE_PAD_LEFT, FACE_PAD_TOP, flipPose, PANEL_TAB_ROOM } from './panelCards'
import type { FoldSection } from './trackHeader'
import { FOLD_SECTIONS, type Folds, type WallFolds } from './wallFolds'

/**
 * Room between the end of what a track unfolds (its step details, its wall of panels, or a panel
 * turned out of it) and the next track's column, along x: the same for every track, whatever it
 * unfolds and however deep its wall goes.
 */
export const OPEN_GAP   = 4
/** While a wall is unfolded, the tracks that are not leave between these yaws (looking along the wall). */
const OTHERS_LEAVE_YAWS = [MathUtils.degToRad(34), MathUtils.degToRad(54)] as const
const WALL_EASE_RATE    = 7
/** A part unfolded this far or less counts as not shown, and one this far or more as unfolded. */
const FADE_MIN          = 0.05
const PANELS_STEADY     = 0.95

export class TrackPlacement {
  /** How unfolded each part of each track's wall is (0..1), easing toward the folds. */
  private readonly unfolding     : Record<FoldSection, number>[] = Array.from({ length: TRACKS }, () => ({
    fx    : 0,
    panels: 0
  }))
  /** How long each track's wall is drawn, easing toward its layout's length when its columns change. */
  private readonly shownWallLen  : number[] = []
  /** Where each track's column settled at the start of this frame (see noteSettledColumns). */
  private readonly settledColumns: number[] = []

  constructor(
    private readonly content: Readonly<SceneContent>,
    private readonly folds: WallFolds,
  ) {}

  /** Left edge of a track's front column as drawn now (the walls may still be moving). */
  frontX(track: number): number {
    return this.content.trackViews[track]?.group.position.x ?? track * TRACK_PITCH
  }

  /** Left edge of a track's front column once the walls settle. */
  settledX(track: number): number {
    let x = 0
    for (let t = 0; t < track; t += 1) x += TRACK_PITCH + this.settledWidth(t)
    return x
  }

  /** Right edge of the last track's front column once the walls settle: where its open parts end is songEnd. */
  songEnd(): number {
    const last = TRACKS - 1
    return this.settledX(last) + FRONT_W + this.settledWidth(last)
  }

  /** Width of the whole song as it stands once the walls settle, with a little room at its right. */
  songWidth(): number {
    return this.songEnd() + 6
  }

  /** Extra room a track takes to the right of its column once its walls settle. */
  settledWidth(track: number): number {
    const fold = this.folds.opened(track)
    return this.openWidth(track, fold.fx ? 1 : 0, fold.panels ? 1 : 0, this.content.trackViews[track]?.cards.faceAmount(true) ?? 0)
  }

  /**
   * Extra room a track takes to the right of its column for how far its step details (`fx`) and
   * its panels (`panels`) are unfolded (0..1): how far they reach along x at the wall's angle, the
   * panels turned out of the wall past its end (`face`: how far, 0..1), and OPEN_GAP to the next
   * column instead of TRACK_GAP; for a wall `wallLen` long (the layout's, or as drawn while it
   * eases to it). A fold's width follows the content and the angle, not the camera, so tracks
   * never slide as the view turns.
   */
  private openWidth(track: number, fx: number, panels: number, face: number, wallLen = this.content.layout?.tracks[track]?.wallLen ?? 0): number {
    const lanes = this.content.layout?.tracks[track]
    if (!lanes) return 0
    const reach = this.wallReach(fx, panels, wallLen)
    const open  = 1 - (1 - fx) * (1 - panels)
    const room  = OPEN_GAP + WALL_HINGE - FRONT_W - TRACK_GAP
    return reach * Math.cos(this.content.wallAngle) + this.turnedOvershoot(track, wallLen) * panels * face + open * room
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
  wallSlide(fx: number): number {
    return (1 - fx) * PANELS_SLIDE
  }

  /** How far a track's wall slides back once it settles. */
  settledSlide(track: number): number {
    return this.wallSlide(this.folds.opened(track).fx ? 1 : 0)
  }

  /**
   * How far the wall is slid back this frame, `shown` being last frame's. A part that unfolds fades
   * in at the place it settles at (the gap beside it widens meanwhile), and one that folds fades out
   * where it stands. The wall only glides when panels stay in view while the step details unfold or
   * fold: they move along with it.
   */
  private slideShown(shown: number, fold: Folds, amounts: Record<FoldSection, number>, ease: number): number {
    const target         = this.wallSlide(fold.fx ? 1 : 0)
    const panelsFadingIn = fold.panels && amounts.panels < PANELS_STEADY
    if (amounts.panels > FADE_MIN && !panelsFadingIn) {
      const next = shown + (target - shown) * ease
      return Math.abs(target - next) < 0.01 ? target : next
    }
    return !fold.fx && amounts.fx > FADE_MIN ? shown : target
  }

  /**
   * How far past the wall's end (along x) an instrument face turned out of it reaches in the
   * worst case: at the last column that can hold one, where it stands face on to the front.
   */
  private turnedOvershoot(track: number, wallLen: number): number {
    const lanes = this.content.layout?.tracks[track]
    if (!lanes?.hasFaces) return 0
    const cos = Math.cos(this.content.wallAngle)
    return Math.max(0, panelU(Math.max(0, lanes.cols - 2)) * cos + FACE_WIDTH - wallLen * cos)
  }

  /** Where the point `u` along the wall of a track whose column starts at `left` is (x, z), for the wall slid back by `slide`. */
  onWall(left: number, u: number, slide: number): Vector3 {
    const angle = this.content.wallAngle
    return new Vector3(left + WALL_HINGE + (u - slide) * Math.cos(angle), 0, -(u - slide) * Math.sin(angle))
  }

  /**
   * The corners of a panel's card where the layout puts it (wall u `u`, title line at `y`, `rows`
   * rows), as large as the face it turns to: top left, top right (the tab over it included),
   * bottom left, bottom right. With them, the card's left edge on the wall and the way it runs
   * from there (an instrument face may turn out of the wall toward the front, see flipPose).
   */
  cardCorners(track: number, shown: ShownPanel): { corners: Vector3[]; start: Vector3; along: Vector3 } {
    const view   = this.content.trackViews[track]
    const face   = view?.cards.settledFace(shown.panel) ?? 'table'
    const width  = view?.cards.settledWidth(shown.panel) ?? 0
    const angle  = this.content.wallAngle * (1 - flipPose(face === 'inst' ? 1 : 0).turn)
    const along  = new Vector3(Math.cos(angle), 0, -Math.sin(angle))
    const start  = this.onWall(this.settledX(track), shown.u - FACE_PAD_LEFT, this.settledSlide(track))
    const end    = start.clone().addScaledVector(along, width)
    const top    = shown.y + PANEL_TAB_ROOM
    const bottom = shown.y + FACE_PAD_TOP - (shown.rows * ROW_H + 0.5)
    return {
      corners: [start.clone().setY(top), end.clone().setY(top), start.clone().setY(bottom), end.setY(bottom)],
      start,
      along
    }
  }

  /** Rectangles a selection covers as drawn now: [row highlight..., cell]. The last one is the cell itself. */
  rectsOf(selection: Selection, settled = false): CellRect[] {
    const { layout } = this.content
    const track      = selectionTrack(selection)
    const view       = this.content.trackViews[track]
    if (!layout || !view) return []
    return cellRects(layout, view, selection, (table) => layout.panelOf(track, table), settled)
  }

  /** World centre of a selection's cell once the track positions and the wall have settled. */
  settledPoint(selection: Selection): Vector3 | null {
    const corners = this.settledCorners(selection)
    if (!corners.length) return null
    return corners.reduce((sum, corner) => sum.add(corner), new Vector3()).multiplyScalar(1 / corners.length)
  }

  /** World corners of a selection's cell once the track positions and the wall have settled (none when it has no cell). */
  settledCorners(selection: Selection): Vector3[] {
    const rect = this.rectsOf(selection).at(-1)
    if (!rect) return []
    const track   = selectionTrack(selection)
    const corners = [
      new Vector3(rect.x, rect.y, 0),
      new Vector3(rect.x + rect.w, rect.y, 0),
      new Vector3(rect.x, rect.y - rect.h, 0),
      new Vector3(rect.x + rect.w, rect.y - rect.h, 0),
    ]
    const view    = this.content.trackViews[track]
    // Into the track's group (the wall, or a panel turned out of it), whose x is then where it settles.
    let onWall    = false
    for (let object: Object3D | null = rect.parent; view && object && object !== view.group; object = object.parent) {
      onWall = onWall || object === view.wall
      object.updateMatrix()
      for (const corner of corners) corner.applyMatrix4(object.matrix)
    }
    // The wall may still have to slide into the place it settles at.
    const slid  = view && onWall ? this.settledSlide(track) - view.slide : 0
    const angle = this.content.wallAngle
    for (const corner of corners) {
      corner.x += this.settledX(track) - slid * Math.cos(angle)
      corner.z += slid * Math.sin(angle)
    }
    return corners
  }

  /**
   * The track whose column (or open wall) the ray through a point of the screen meets first
   * (`ndcX` -1 left .. 1 right, `ndcY` -1 bottom .. 1 top), with the camera at `pose`; null
   * when it meets none.
   */
  trackUnder(lens: Lens, pose: RigPose, ndcX: number, ndcY = 0): number | null {
    return this.hitUnder(lens, pose, ndcX, ndcY)?.track ?? null
  }

  /** As trackUnder, with how deep along the view the ray meets it (its direction is one deep). */
  hitUnder(lens: Lens, pose: RigPose, ndcX: number, ndcY: number): { track: number; depth: number } | null {
    const ray        = rayThrough(pose, lens, ndcX, ndcY)
    const meet       = (ax: number, az: number, bx: number, bz: number) => rayMeets(ray, new Vector3(ax, 0, az), new Vector3(bx, 0, bz))
    const views      = this.content.trackViews
    let nearest      : number | null = null
    let nearestAlong = Number.POSITIVE_INFINITY
    for (let track = 0; track < views.length; track += 1) {
      const left = this.frontX(track)
      const hits = [meet(left - TRACK_GAP / 2, 0, left + FRONT_W + TRACK_GAP / 2, 0)]
      const wall = this.shownWall(track)
      if (wall) {
        const [from, to] = [this.onWall(left, wall[0], views[track].slide), this.onWall(left, wall[1], views[track].slide)]
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
    const view  = this.content.trackViews[track]
    const lanes = this.content.layout?.tracks[track]
    if (!view || !lanes) return null
    const side   = view.sideAlpha > 0.5
    const panels = view.panelsAlpha > 0.5
    if (!side && !panels) return null
    return [side ? 0 : PANELS_SLIDE, panels ? lanes.wallLen : SIDE_END]
  }

  /**
   * Notes where each track's column settles, as of this frame: a navigation measures where it left
   * from with it, since the M8 may have turned a panel (widening a track) just before the selection moves.
   */
  noteSettledColumns(): void {
    let x = 0
    for (let track = 0; track < this.content.trackViews.length; track += 1) {
      this.settledColumns[track] = x
      x                          += TRACK_PITCH + this.settledWidth(track)
    }
  }

  /** Where a track's column settled at the start of this frame (see noteSettledColumns). */
  settledColumn(track: number): number {
    return this.settledColumns[track] ?? this.settledX(track)
  }

  /** How long a track's wall is drawn now, undefined before its first frame. */
  shownWallLength(track: number): number | undefined {
    return this.shownWallLen[track]
  }

  /** A track's wall is drawn this long from now on (a view built afresh). */
  setShownWallLength(track: number, length: number): void {
    this.shownWallLen[track] = length
  }

  /**
   * Eases the unfolding of every track's wall and places the tracks along x as they open. While a
   * wall is unfolded and the view looks along it (`yaw`), the tracks that are folded leave.
   * Returns whether anything moved, where the last track ends, and how much the folded tracks stay (1 all, 0 gone).
   */
  update(dt: number, yaw: number): { busy: boolean; end: number; staying: number } {
    let busy      = false
    const staying = this.folds.anyUnfolded() ? 1 - smoothstep(OTHERS_LEAVE_YAWS[0], OTHERS_LEAVE_YAWS[1], yaw) : 1
    const ease    = easeFactor(dt, WALL_EASE_RATE)
    const views   = this.content.trackViews
    let x         = 0
    for (let track = 0; track < views.length; track += 1) {
      const view    = views[track]
      const fold    = this.folds.opened(track)
      const amounts = this.unfolding[track]
      for (const section of FOLD_SECTIONS) {
        const goal       = fold[section] ? 1 : 0
        const before     = amounts[section]
        amounts[section] += (goal - before) * ease
        if (Math.abs(goal - amounts[section]) < 0.001) amounts[section] = goal
        if (amounts[section] !== before) busy = true
      }
      const frontAlpha = this.folds.isUnfolded(track) ? 1 : staying
      const slide      = this.slideShown(view.slide, fold, amounts, ease)
      const wallLen    = this.content.layout?.tracks[track]?.wallLen ?? 0
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
      x += TRACK_PITCH + this.openWidth(track, amounts.fx, amounts.panels, view.cards.faceAmount(), shownLen)
    }
    return {
      busy,
      end: x,
      staying
    }
  }
}

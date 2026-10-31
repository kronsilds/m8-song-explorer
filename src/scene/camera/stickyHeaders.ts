// Where things stick on screen: the track headers right under the HUD (gliding there when the
// track that guides them changes), the panels a little below them down to the bottom of the view;
// and how far the view may go: no further right than the last track, no higher than the headers
// resting over the first song row allow.

import { MathUtils } from 'three'
import type { SceneContent } from '../content'
import { FRONT_W, ROW_H } from '../layout'
import { easeFactor, smoothstep } from '../shapes'
import { PANEL_TAB_ROOM } from '../track/panelCards'
import { OPEN_GAP, type TrackPlacement } from '../track/placement'
import { HEADER_TOP } from '../track/trackHeader'
import type { WallFolds } from '../track/wallFolds'
import type { CameraRig, RigPose } from './rig'
import type { ViewFocus } from './viewFocus'
import type { ViewProbe } from './viewProbe'

/** Screen height (normalized device y) under which rows count as out of view: just over the footer line. */
export const VIEW_BOTTOM_NDC = -0.92
/** Turned between these yaws, the view may reach a little further past the last track. */
const TURN_YAWS              = [MathUtils.degToRad(5), MathUtils.degToRad(24)] as const
/** Turned further than this, the track in the middle of the view guides the headers' height. */
const TURNED_YAW             = MathUtils.degToRad(15)
/** Pixels between the HUD and the headers' top edge. */
const HEADER_GAP_PX          = 8
/** The headers never show lower on the screen than this (normalized height, -1 bottom to 1 top: a third of the way down). */
const HEADER_LOWEST_NDC      = 1 / 3
/** Ease rate per second of the headers' glide to their height (the pose eases at 9). */
const HEADER_GLIDE_RATE      = 15.5

/**
 * Where things stick for a pose: the headers' top, the panels' top (low enough for the tab over
 * their corner to stay clear of the header) and the bottom of the view; `view` is the panels'
 * height when the headers are stuck (it tells the zoom).
 */
export interface StickRange {
  headerTop: number
  panelTop : number
  bottom   : number
  view     : number
}

export class StickyHeaders {
  /** Pixels at the top of the view that the HUD covers. */
  private topInset     = 90
  /** Where the headers' top stands above the view's centre now (gliding to where it belongs); null before the first frame. */
  private headerOffset : number | null = null

  constructor(
    private readonly content: Readonly<SceneContent>,
    private readonly rig: CameraRig,
    private readonly probe: ViewProbe,
    private readonly placement: TrackPlacement,
    private readonly folds: WallFolds,
    private readonly focus: ViewFocus,
  ) {}

  /** Pixels at the top of the view that the HUD covers: the track headers stick right under them. True when it changed. */
  setTopInset(pixels: number): boolean {
    if (Math.abs(pixels - this.topInset) < 1) return false
    this.topInset = pixels
    return true
  }

  /** The tracks that guide the header height: the focused one (chosen, followed, selected or turned to), else all of them. */
  private guideTracks(pose: RigPose): number[] {
    const focused = this.focus.chosen() || pose.yaw > TURNED_YAW
    return focused ? [this.focus.track()] : this.content.trackViews.map((_, track) => track)
  }

  /**
   * World height of the headers' top edge for a pose: the one at which the guide track's
   * header shows right under the HUD (the other tracks share its height). With no track
   * focused, the mean over every track. `settled` places the tracks where their columns will
   * be once the walls have moved.
   */
  private headerTopEdge(pose: RigPose, settled: boolean): number {
    const height = this.probe.height
    const ndcTop = height > 0 ? 1 - (2 * (this.topInset + HEADER_GAP_PX)) / height : 0.82
    this.probe.aim(pose)
    const tracks = this.guideTracks(pose)
    let sum      = 0
    for (const track of tracks) {
      sum += this.probe.heightAt(pose, (settled ? this.placement.settledX(track) : this.placement.frontX(track)) + FRONT_W / 2, ndcTop)
    }
    return sum / tracks.length
  }

  /**
   * Where things stick for a pose (see StickRange). Headers rest lower at the start of the song (see
   * SongLayout.headerRestY), and panels stay below them. `settled` measures where the tracks
   * settle; `glidedOffset` puts the headers there (above the pose's target) instead.
   */
  range(pose: RigPose, settled = false, glidedOffset: number | null = null): StickRange {
    const centerY   = pose.target.y
    const half      = this.probe.visibleHalfHeight(pose.distance)
    const headerTop = glidedOffset != null ? centerY + glidedOffset : this.headerTopEdge(pose, settled) - HEADER_TOP
    const below     = ROW_H + 0.95 + PANEL_TAB_ROOM
    const bottom    = centerY + half * VIEW_BOTTOM_NDC
    const restY     = this.content.layout?.headerRestY ?? Number.POSITIVE_INFINITY
    return {
      headerTop,
      panelTop: Math.min(headerTop, restY) - below,
      bottom,
      view    : headerTop - below - bottom
    }
  }

  /**
   * Keeps the last track in view: the view may not go further right than the middle of its
   * column (or along its wall when it is unfolded), measured where the tracks settle, so folding
   * a wall pulls the view back with it. Turned, a little more, as the target stands off the
   * wall in depth. Nor may it rise so far above the start of the song that the headers, resting
   * over its first row, show lower than HEADER_LOWEST_NDC.
   */
  limitPan(): void {
    const last = this.content.trackViews.length - 1
    if (last < 0) return
    const { rig, placement, probe } = this
    const { layout }                = this.content
    const goal                      = rig.goal
    const turn                      = smoothstep(TURN_YAWS[0], TURN_YAWS[1], goal.yaw)
    rig.bounds.maxX                 = placement.settledX(last) + FRONT_W / 2 + placement.settledWidth(last) + turn * (FRONT_W + OPEN_GAP)
    const restTop                   = layout ? layout.headerRestY + HEADER_TOP : null
    if (restTop == null || probe.height <= 0) return
    // Scrolling moves everything alike: the highest target puts the resting headers' top edge on that line of the screen.
    probe.aim(goal)
    const tracks = this.guideTracks(goal)
    let shown    = 0
    for (const track of tracks) shown += probe.heightAt(goal, placement.settledX(track) + FRONT_W / 2, HEADER_LOWEST_NDC)
    rig.bounds.maxY = goal.target.y + restTop - shown / tracks.length
    // A song shorter than the view: its top wins.
    rig.bounds.minY = Math.min(layout?.bottomY ?? rig.bounds.minY, rig.bounds.maxY)
  }

  /** Applies the view's limits (see limitPan) to the goal at once, so a framing measures where the view will be. */
  clampGoal(): void {
    this.limitPan()
    this.rig.clampGoal()
  }

  /**
   * Sticky headers and panels, panel glides and links, for this frame (`textOn`: rows are tall
   * enough for text). Returns whether anything moves, and whether the panels did (what is marked
   * on them follows).
   */
  update(dt: number, textOn: boolean): { busy: boolean; panelsMoved: boolean } {
    const layout = this.content.layout
    if (!layout) return {
      busy       : false,
      panelsMoved: false
    }
    let busy          = false
    let panelsMoved   = false
    const current     = this.rig.current
    const half        = this.probe.visibleHalfHeight(current.distance)
    const centerY     = current.target.y
    // The headers glide to where they belong (another guide track, a wrapped top bar), as an offset from the view's centre so scrolling stays exact.
    const aimed       = this.range(current).headerTop - centerY
    this.headerOffset = this.headerOffset == null ? aimed : this.headerOffset + (aimed - this.headerOffset) * easeFactor(dt, HEADER_GLIDE_RATE)
    if (Math.abs(aimed - this.headerOffset) > 1e-3) busy = true
    else this.headerOffset = aimed
    const { headerTop, panelTop, bottom, view: viewHeight } = this.range(current, false, this.headerOffset)
    for (const view of this.content.trackViews) {
      if (view.setHeaderY(headerTop)) busy = true
      if ((view.panelsAlpha > 0.01 || this.folds.opened(view.track.track).panels) && layout.stick(view.track.track, panelTop, bottom, viewHeight)) panelsMoved = true
      view.panelCeiling = panelTop
      if (view.updatePanels(dt, textOn)) panelsMoved = true
      if (view.panelsAlpha > 0.01 && view.updateLinks(centerY + half * 1.05, centerY - half * 1.05)) busy = true
    }
    return {
      busy,
      panelsMoved
    }
  }
}

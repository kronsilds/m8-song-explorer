// The view moved by hand (see pointerControls): a pan keeps what the pointer held under it, a
// turn goes around the track it started on, the wheel zooms toward the point under the pointer.

import { MathUtils, type Vector3 } from 'three'
import { PAN_MIN_COS } from '../input/pointerControls'
import type { TrackPlacement } from '../track/placement'
import { rayThrough } from './framing'
import type { Navigator } from './navigator'
import type { CameraRig } from './rig'
import type { ViewFocus } from './viewFocus'
import type { ViewProbe } from './viewProbe'

/** What a pan by hand holds counts as no nearer or further than these multiples of the target's distance. */
const GRAB_DEPTH_LIMITS = [0.3, 3] as const

export class HandCamera {
  /** The turn by hand under way: the target and the yaw it started from, and where the centre of the track turned around was then. */
  private turning : { base: Vector3; pivot: Vector3; yaw: number } | null = null

  constructor(
    private readonly rig: CameraRig,
    private readonly probe: ViewProbe,
    private readonly placement: TrackPlacement,
    private readonly focus: ViewFocus,
    private readonly navigator: Navigator,
  ) {}

  /**
   * A pan by hand moved the pointer from one position to another: the view moves along the
   * tracks (and up or down them) so that what the pointer held there (a column or an open
   * wall, else the plane of the columns) is under it again. Nearer things move faster on
   * screen, and a thing gets nearer or further as the pan carries it across the screen (the
   * tracks are seen at an angle), so the step is solved for that point.
   */
  dragPan(fromX: number, fromY: number, toX: number, toY: number): void {
    const pose         = this.rig.current
    const lens         = this.probe.lens()
    const [ndcX, ndcY] = this.probe.ndcAt(fromX, fromY)
    const [toNX, toNY] = this.probe.ndcAt(toX, toY)
    let depth          = this.placement.hitUnder(lens, pose, ndcX, ndcY)?.depth
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
    const { focus } = this
    if (focus.selection) return
    focus.handTrack   = null
    focus.middleTrack = this.placement.trackUnder(this.probe.lens(), this.rig.goal, 0) ?? focus.middleTrack
  }

  /** A turn by hand goes around the track it started on (`track`, the one under the pointer; null for none). */
  turnStarted(track: number | null): void {
    const { focus, rig } = this
    if (track != null && track !== focus.track()) focus.handTrack = track
    this.turning = {
      base : rig.goal.target.clone(),
      pivot: this.navigator.trackPivot(focus.track()),
      yaw  : rig.goal.yaw
    }
  }

  /**
   * While turning by hand the view turns around the track: the target's offset from the
   * track's centre turns with the view (so the camera orbits the track and the track stays where
   * it is on screen). The height is left alone, so scrolling (following playback) goes on while
   * turning.
   */
  turnedByHand(): void {
    this.navigator.leavePreset()
    const turning = this.turning
    if (!turning) return
    const goal   = this.rig.goal
    const turned = goal.yaw - turning.yaw
    const dx     = turning.base.x - turning.pivot.x
    const dz     = turning.base.z - turning.pivot.z
    const pivot  = this.navigator.trackPivot(this.focus.track())
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
    const [ndcX, ndcY] = this.probe.ndcAt(clientX, clientY)
    const ray          = rayThrough(goal, this.probe.lens(), ndcX, ndcY)
    const along        = Math.abs(ray.direction.z) > 1e-6 ? (goal.target.z - ray.origin.z) / ray.direction.z : -1
    if (along > 0) {
      const aim = ray.origin.clone().addScaledVector(ray.direction, along)
      goal.target.sub(aim).multiplyScalar(distance / goal.distance).add(aim)
    }
    goal.distance = distance
  }
}

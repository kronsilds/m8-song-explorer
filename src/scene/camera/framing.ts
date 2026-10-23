// Screen-space framing for the orbit camera: how far to slide the view sideways, and how far
// back to stand, for some world points to fill the screen without empty room beside them.
// Only the horizontal is framed: rows scroll on their own.

import { Vector3 } from 'three'
import type { RigPose } from './rig'

/** What the camera sees: tan of half the vertical field of view, and width / height. */
export interface Lens {
  tanHalfFov: number
  aspect    : number
}

/** Free room kept at each side of the screen, as a fraction of the half width (0.05 = 2.5% of the width). */
export interface Margins {
  left : number
  right: number
}

/** The camera's right and back axes for a yaw and pitch (the roll is left out). */
export function cameraAxes(yaw: number, pitch: number): { right: Vector3; back: Vector3 } {
  return {
    right: new Vector3(Math.cos(yaw), 0, -Math.sin(yaw)),
    back : new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
  }
}

/**
 * The range of sideways target shifts (along the camera's right) between "the leftmost point
 * sits on the left margin" and "the rightmost point sits on the right margin". A point at
 * `side` (target-relative, along right) and `depth` lands on the left margin for a shift of
 * side + (1 - left) * depth * tanH, on the right margin for side - (1 - right) * depth * tanH.
 */
function shiftRange(pose: RigPose, lens: Lens, points: Vector3[], margins: Margins): { toLeft: number; toRight: number } {
  const { right, back } = cameraAxes(pose.yaw, pose.pitch)
  const tanH            = lens.tanHalfFov * lens.aspect
  const relative        = new Vector3()
  // toLeft: the largest shift that keeps every point right of the left margin; toRight: the smallest that keeps every point left of the right one.
  let toLeft            = Number.POSITIVE_INFINITY
  let toRight           = Number.NEGATIVE_INFINITY
  for (const point of points) {
    relative.subVectors(point, pose.target)
    const side  = relative.dot(right)
    const depth = Math.max(1e-3, pose.distance - relative.dot(back))
    toLeft      = Math.min(toLeft, side + (1 - margins.left) * depth * tanH)
    toRight     = Math.max(toRight, side - (1 - margins.right) * depth * tanH)
  }
  return {
    toLeft,
    toRight
  }
}

/** Where framed points that leave room to spare go: moved as little as can be, or centred. */
export type Align = 'least' | 'center'

/**
 * The sideways shift that frames `points`: when they fit across the screen, it moves them
 * inside the margins (placed by `align`); when they do not, it leaves no empty room on either
 * side. `mustSee` (a part of them) is then kept in view first, so the view never slides off it.
 */
export function sideShift(pose: RigPose, lens: Lens, points: Vector3[], margins: Margins, mustSee: Vector3[] = [], align: Align = 'least'): number {
  if (!points.length) return 0
  const all = shiftRange(pose, lens, points, margins)
  // Fits: shift into [toRight, toLeft]. Too wide: into [toLeft, toRight], so both sides are full.
  let low   = Math.min(all.toLeft, all.toRight)
  let high  = Math.max(all.toLeft, all.toRight)
  if (mustSee.length) {
    const must     = shiftRange(pose, lens, mustSee, margins)
    const mustLow  = Math.min(must.toLeft, must.toRight)
    const mustHigh = Math.max(must.toLeft, must.toRight)
    // Where the two disagree, the part that must be seen wins.
    low            = Math.max(low, mustLow)
    high           = Math.min(high, mustHigh)
    if (low > high) [low, high] = must.toRight <= must.toLeft ? [mustLow, mustHigh] : [must.toLeft, must.toLeft]
  }
  const wanted = align === 'center' ? (all.toLeft + all.toRight) / 2 : 0
  return Math.min(Math.max(wanted, low), high)
}

/** True when `points` fit between the margins at the pose's distance (after a sideways shift). */
function fits(pose: RigPose, lens: Lens, points: Vector3[], margins: Margins): boolean {
  const { toLeft, toRight } = shiftRange(pose, lens, points, margins)
  return toRight <= toLeft
}

/**
 * The nearest distance, within [near, far], at which `points` fit across the screen at the
 * pose's angles (`far` when they never do). The target keeps its place; slide it after with
 * sideShift.
 */
export function fitDistance(pose: RigPose, lens: Lens, points: Vector3[], margins: Margins, near: number, far: number): number {
  const probe = {
    ...pose,
    distance: far
  }
  if (!points.length || !fits(probe, lens, points, margins)) return far
  probe.distance = near
  if (fits(probe, lens, points, margins)) return near
  let low  = near
  let high = far
  for (let i = 0; i < 32; i += 1) {
    probe.distance = (low + high) / 2
    if (fits(probe, lens, points, margins)) high = probe.distance
    else low = probe.distance
  }
  return high
}

/** Moves a pose's target sideways (along the camera's right) by `shift`. */
export function shiftTarget(pose: RigPose, shift: number): void {
  if (!shift) return
  pose.target.addScaledVector(cameraAxes(pose.yaw, pose.pitch).right, shift)
}

/** The ray from the camera through a point of the screen (normalized device coordinates, -1..1). */
export function rayThrough(pose: RigPose, lens: Lens, ndcX: number, ndcY: number): { origin: Vector3; direction: Vector3 } {
  const { right, back } = cameraAxes(pose.yaw, pose.pitch)
  const up              = new Vector3().crossVectors(back, right)
  return {
    origin   : pose.target.clone().addScaledVector(back, pose.distance),
    direction: back
      .clone()
      .negate()
      .addScaledVector(right, ndcX * lens.tanHalfFov * lens.aspect)
      .addScaledVector(up, ndcY * lens.tanHalfFov)
  }
}

/** Where a world point shows across the screen, in normalized device x (-1 left .. 1 right). */
export function screenX(pose: RigPose, lens: Lens, point: Vector3): number {
  const { right, back } = cameraAxes(pose.yaw, pose.pitch)
  const relative        = new Vector3().subVectors(point, pose.target)
  const depth           = Math.max(1e-3, pose.distance - relative.dot(back))
  return relative.dot(right) / (depth * lens.tanHalfFov * lens.aspect)
}

/**
 * Seen from above (x, z): how far along a ray (in lengths of its direction) it meets the
 * upright segment a..b, null when it passes by or meets it behind its origin.
 */
export function rayMeets(ray: { origin: Vector3; direction: Vector3 }, a: Vector3, b: Vector3): number | null {
  const { origin, direction } = ray
  const ex                    = b.x - a.x
  const ez                    = b.z - a.z
  const cross                 = direction.x * ez - direction.z * ex
  if (Math.abs(cross) < 1e-9) return null
  const qx    = a.x - origin.x
  const qz    = a.z - origin.z
  const along = (qx * ez - qz * ex) / cross
  const s     = (qx * direction.z - qz * direction.x) / cross
  return along > 0 && s >= 0 && s <= 1 ? along : null
}

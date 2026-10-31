// Screen-space framing for the orbit camera: how far to slide the view sideways, and how far
// back to stand, for some world points to fill the screen without empty room beside them.
// Only the horizontal is framed: rows scroll on their own. A slide goes along the camera's right
// (everything keeps its depth) or along the tracks (the camera keeps its distance from them).
// A cut to a new camera angle holds one point where it showed (cutAnchor, holdOnScreen); the
// playhead the view follows shows at one screen height whatever the angle (showAtHeight).

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

/**
 * Which way a sideways slide moves the target: 'view' along the camera's right, level (the roll
 * left out), so everything keeps its depth; 'tracks' along x, parallel to the tracks, so the
 * camera keeps its distance from their plane, as a pan by hand does (turned, things then get
 * nearer or further as they cross the screen).
 */
export type Slide = 'view' | 'tracks'

/** Looking this close to along the tracks, a slide along them would move the view more in depth than across: it slides along the view instead. */
const MIN_ACROSS = 0.25

/** The camera's right and back axes for a yaw and pitch; with `roll`, the right axis leans with the roll (it is then the screen's x). */
export function cameraAxes(yaw: number, pitch: number, roll = 0): { right: Vector3; back: Vector3 } {
  const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw))
  const back  = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
  if (roll) {
    const up = new Vector3().crossVectors(back, right)
    right.multiplyScalar(Math.cos(roll)).addScaledVector(up, Math.sin(roll))
  }
  return {
    right,
    back
  }
}

/** The direction a slide moves the target in. */
function slideAxis(pose: RigPose, slide: Slide): Vector3 {
  return slide === 'tracks' ? new Vector3(1, 0, 0) : cameraAxes(pose.yaw, pose.pitch).right
}

/** How far a unit slide moves things along the screen's x (`across`, as a distance at their depth) and how much deeper it puts them. */
function slideRates(pose: RigPose, slide: Slide): { across: number; deeper: number } {
  const { right, back } = cameraAxes(pose.yaw, pose.pitch, pose.roll)
  const axis            = slideAxis(pose, slide)
  return {
    across: axis.dot(right),
    deeper: axis.dot(back)
  }
}

/**
 * The slide that keeps the camera's distance from the tracks ('tracks'), unless the view looks
 * so far along them that it would move a point at a margin more in depth than across the screen.
 */
export function trackSlide(pose: RigPose, lens: Lens, margins: Margins): Slide {
  const { across, deeper } = slideRates(pose, 'tracks')
  const tanH               = lens.tanHalfFov * lens.aspect
  const atLeft             = across - (1 - margins.left) * tanH * deeper
  const atRight            = across + (1 - margins.right) * tanH * deeper
  return Math.min(atLeft, atRight) >= MIN_ACROSS ? 'tracks' : 'view'
}

/**
 * The range of sideways target shifts (along `slide`) between "the leftmost point sits on the
 * left margin" and "the rightmost point sits on the right margin". After a shift s, a point at
 * `side` (target-relative, along the screen's x) and `depth` is at side - s * across, depth +
 * s * deeper: on the left margin (screen x -(1 - left)) for
 * s = (side + (1 - left) * tanH * depth) / (across - (1 - left) * tanH * deeper), on the right
 * one for s = (side - (1 - right) * tanH * depth) / (across + (1 - right) * tanH * deeper). Along
 * the view without roll (across 1, deeper 0) that is the side gap itself.
 */
function shiftRange(pose: RigPose, lens: Lens, points: Vector3[], margins: Margins, slide: Slide): { toLeft: number; toRight: number } {
  const { right, back }    = cameraAxes(pose.yaw, pose.pitch, pose.roll)
  const { across, deeper } = slideRates(pose, slide)
  const tanH               = lens.tanHalfFov * lens.aspect
  const leftEdge           = (1 - margins.left) * tanH
  const rightEdge          = (1 - margins.right) * tanH
  const relative           = new Vector3()
  // toLeft: the largest shift that keeps every point right of the left margin; toRight: the smallest that keeps every point left of the right one.
  let toLeft               = Number.POSITIVE_INFINITY
  let toRight              = Number.NEGATIVE_INFINITY
  for (const point of points) {
    relative.subVectors(point, pose.target)
    const side  = relative.dot(right)
    const depth = Math.max(1e-3, pose.distance - relative.dot(back))
    toLeft      = Math.min(toLeft, (side + leftEdge * depth) / Math.max(1e-6, across - leftEdge * deeper))
    toRight     = Math.max(toRight, (side - rightEdge * depth) / Math.max(1e-6, across + rightEdge * deeper))
  }
  return {
    toLeft,
    toRight
  }
}

/** Where framed points that leave room to spare go: moved as little as can be, or centred. */
export type Align = 'least' | 'center'

/**
 * The sideways shift (along `slide`, see shiftTarget) that frames `points`: when they fit across
 * the screen, it moves them inside the margins (placed by `align`); when they do not, it leaves
 * no empty room on either side. `mustSee` (a part of them) is then kept in view first, so the
 * view never slides off it.
 */
export function sideShift(
  pose: RigPose,
  lens: Lens,
  points: Vector3[],
  margins: Margins,
  mustSee: Vector3[] = [],
  align: Align = 'least',
  slide: Slide = 'view',
): number {
  if (!points.length) return 0
  const all = shiftRange(pose, lens, points, margins, slide)
  // Fits: shift into [toRight, toLeft]. Too wide: into [toLeft, toRight], so both sides are full.
  let low   = Math.min(all.toLeft, all.toRight)
  let high  = Math.max(all.toLeft, all.toRight)
  if (mustSee.length) {
    const must     = shiftRange(pose, lens, mustSee, margins, slide)
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

/** True when `points` fit between the margins at the pose's distance, after a sideways shift along `slide`. */
export function fitsAcross(pose: RigPose, lens: Lens, points: Vector3[], margins: Margins, slide: Slide = 'view'): boolean {
  const { toLeft, toRight } = shiftRange(pose, lens, points, margins, slide)
  return toRight <= toLeft
}

const fits = (pose: RigPose, lens: Lens, points: Vector3[], margins: Margins): boolean => fitsAcross(pose, lens, points, margins)

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

/** Moves a pose's target sideways by `shift`: along the camera's right, or with 'tracks' along x. */
export function shiftTarget(pose: RigPose, shift: number, slide: Slide = 'view'): void {
  if (!shift) return
  pose.target.addScaledVector(slideAxis(pose, slide), shift)
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

/** Where a world point shows across the screen, in normalized device x (-1 left .. 1 right), the roll included. */
export function screenX(pose: RigPose, lens: Lens, point: Vector3): number {
  const { right, back } = cameraAxes(pose.yaw, pose.pitch, pose.roll)
  const relative        = new Vector3().subVectors(point, pose.target)
  const depth           = Math.max(1e-3, pose.distance - relative.dot(back))
  return relative.dot(right) / (depth * lens.tanHalfFov * lens.aspect)
}

/** Where a world point shows on screen, in normalized device coordinates (x -1 left .. 1 right, y -1 bottom .. 1 top), the roll included. */
export function screenPoint(pose: RigPose, lens: Lens, point: Vector3): { x: number; y: number } {
  const { right, back } = cameraAxes(pose.yaw, pose.pitch, pose.roll)
  const up              = new Vector3().crossVectors(back, right)
  const relative        = new Vector3().subVectors(point, pose.target)
  const depth           = Math.max(1e-3, pose.distance - relative.dot(back))
  return {
    x: relative.dot(right) / (depth * lens.tanHalfFov * lens.aspect),
    y: relative.dot(up) / (depth * lens.tanHalfFov)
  }
}

/**
 * Moves a pose's target along x and y (along the tracks and up or down: the angles, the distance
 * and the depth stay) until `point` shows at `ndc`. Exact: showing at a place of the screen is
 * two linear conditions on the target.
 */
export function holdOnScreen(pose: RigPose, lens: Lens, point: Vector3, ndc: { x: number; y: number }): void {
  const { right, back } = cameraAxes(pose.yaw, pose.pitch, pose.roll)
  const up              = new Vector3().crossVectors(back, right)
  const kx              = ndc.x * lens.tanHalfFov * lens.aspect
  const ky              = ndc.y * lens.tanHalfFov
  // Offset from the target r: r·right = kx (distance - r·back), r·up = ky (distance - r·back); moving the target by s takes s off r.
  const across          = right.addScaledVector(back, kx)
  const upward          = up.addScaledVector(back, ky)
  const relative        = new Vector3().subVectors(point, pose.target)
  const b1              = relative.dot(across) - kx * pose.distance
  const b2              = relative.dot(upward) - ky * pose.distance
  const det             = across.x * upward.y - across.y * upward.x
  if (Math.abs(det) < 1e-9) return
  pose.target.x += (b1 * upward.y - across.y * b2) / det
  pose.target.y += (across.x * b2 - b1 * upward.x) / det
}

/**
 * Moves a pose's target up or down until `point` shows at the screen height `ndcY` (-1 bottom ..
 * 1 top), whatever the angles. Exact: one linear condition on the target's height.
 */
export function showAtHeight(pose: RigPose, lens: Lens, point: Vector3, ndcY: number): void {
  const { right, back } = cameraAxes(pose.yaw, pose.pitch, pose.roll)
  const ky              = ndcY * lens.tanHalfFov
  // r·up = ky (distance - r·back) for the offset r from the target; raising the target by s takes s off r.y.
  const upward          = new Vector3().crossVectors(back, right).addScaledVector(back, ky)
  if (Math.abs(upward.y) < 1e-9) return
  const relative = new Vector3().subVectors(point, pose.target)
  pose.target.y  += (relative.dot(upward) - ky * pose.distance) / upward.y
}

/**
 * The point a cut to a new camera angle holds where it shows: the cell when it is in sight; else
 * (while the song plays the playheads scroll the view, not the cursor) the cell's place across
 * the tracks at the height the view looks at, so its track keeps its place on screen.
 */
export function cutAnchor(pose: RigPose, lens: Lens, cell: Vector3): Vector3 {
  const { x, y } = screenPoint(pose, lens, cell)
  if (Math.abs(x) <= 1 && Math.abs(y) <= 1) return cell
  return cell.clone().setY(pose.target.y)
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

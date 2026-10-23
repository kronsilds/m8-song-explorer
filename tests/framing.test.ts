// The camera framing maths: sideways shifts that leave no empty room, fitting distances, rays.

import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { fitDistance, type Lens, rayMeets, rayThrough, screenX, shiftTarget, sideShift } from '../src/scene/camera/framing'
import type { RigPose } from '../src/scene/camera/rig'

const lens      : Lens = {
  tanHalfFov: Math.tan((34 * Math.PI) / 360),
  aspect    : 1.6
}
const margins   = {
  left : 0.04,
  right: 0.04
}
const halfWidth = (distance: number) => distance * lens.tanHalfFov * lens.aspect

const pose = (x: number, distance: number, yaw = 0): RigPose => ({
  target: new Vector3(x, 0, 0),
  yaw,
  pitch : 0,
  distance,
  roll  : 0
})

/** Screen x of the points once the pose is shifted. */
function placed(start: RigPose, points: Vector3[], shift: number): number[] {
  shiftTarget(start, shift)
  return points.map((point) => screenX(start, lens, point))
}

describe('sideShift', () => {
  test('content wider than the screen leaves no empty room on the left', () => {
    // 100 units of tracks, a view 2 * halfWidth(40) = 64 wide centred left of them.
    const points = [new Vector3(0, 0, 0), new Vector3(100, 0, 0)]
    const view   = pose(10, 40)
    const [left] = placed(view, points, sideShift(view, lens, points, margins))
    expect(left).toBeCloseTo(-(1 - margins.left), 6)
  })

  test('content wider than the screen is not moved when both sides are full', () => {
    const points = [new Vector3(0, 0, 0), new Vector3(100, 0, 0)]
    expect(sideShift(pose(50, 40), lens, points, margins)).toBe(0)
  })

  test('content that fits is moved just inside the margins', () => {
    const points        = [new Vector3(0, 0, 0), new Vector3(20, 0, 0)]
    const view          = pose(-30, 40)
    const [left, right] = placed(view, points, sideShift(view, lens, points, margins))
    expect(right).toBeCloseTo(1 - margins.right, 6)
    expect(left).toBeGreaterThan(-1)
  })

  test('center places content in the middle, whether it fits or not', () => {
    for (const right of [20, 200]) {
      const points = [new Vector3(0, 0, 0), new Vector3(right, 0, 0)]
      const view   = pose(-15, 40)
      const ends   = placed(view, points, sideShift(view, lens, points, margins, [], 'center'))
      expect(ends[0] + ends[1]).toBeCloseTo(0, 6)
    }
  })

  test('mustSee wins over filling the screen', () => {
    // Too wide: filling would allow any shift in a range; the part that must be seen picks it.
    const points = [new Vector3(0, 0, 0), new Vector3(200, 0, 0)]
    const must   = [new Vector3(150, 0, 0), new Vector3(160, 0, 0)]
    const view   = pose(30, 40)
    const shown  = placed(view, must, sideShift(view, lens, points, margins, must))
    for (const x of shown) expect(Math.abs(x)).toBeLessThanOrEqual(1 - margins.left + 1e-9)
  })

  test('works turned: points in depth are framed in screen space', () => {
    const yaw    = (40 * Math.PI) / 180
    const points = [new Vector3(0, 0, 0), new Vector3(30, 0, -40)]
    const view   = pose(60, 60, yaw)
    const shown  = placed(view, points, sideShift(view, lens, points, margins))
    for (const x of shown) expect(Math.abs(x)).toBeLessThanOrEqual(1 - margins.left + 1e-9)
  })
})

describe('fitDistance', () => {
  test('is the distance at which the points just fit', () => {
    const points   = [new Vector3(-20, 0, 0), new Vector3(20, 0, 0)]
    const distance = fitDistance(pose(0, 10), lens, points, margins, 1, 500)
    expect(halfWidth(distance) * (1 - margins.left)).toBeCloseTo(20, 3)
  })

  test('stays within its limits', () => {
    const points = [new Vector3(-20, 0, 0), new Vector3(20, 0, 0)]
    expect(fitDistance(pose(0, 10), lens, points, margins, 80, 500)).toBe(80)
    expect(fitDistance(pose(0, 10), lens, points, margins, 1, 30)).toBe(30)
  })
})

describe('rays', () => {
  test('the middle of the screen looks at the target', () => {
    const view                  = pose(12, 50, 0.6)
    const { origin, direction } = rayThrough(view, lens, 0, 0)
    const hit                   = origin.clone().addScaledVector(direction, view.distance)
    expect(hit.distanceTo(view.target)).toBeCloseTo(0, 6)
  })

  test('a screen point maps back to its screen x', () => {
    const view  = pose(5, 50, 0.5)
    const ray   = rayThrough(view, lens, -0.4, 0)
    const along = rayMeets(ray, new Vector3(-100, 0, 0), new Vector3(100, 0, 0))
    expect(along).not.toBeNull()
    const point = ray.origin.clone().addScaledVector(ray.direction, along ?? 0)
    expect(point.z).toBeCloseTo(0, 6)
    expect(screenX(view, lens, point)).toBeCloseTo(-0.4, 6)
  })

  test('rayMeets misses a segment beside the ray', () => {
    const ray = rayThrough(pose(0, 50), lens, 0, 0)
    expect(rayMeets(ray, new Vector3(10, 0, 0), new Vector3(20, 0, 0))).toBeNull()
  })
})

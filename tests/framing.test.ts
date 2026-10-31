// The camera framing maths: sideways shifts that leave no empty room, fitting distances, rays,
// the point a cut to a new angle holds on screen, and the height the followed playhead shows at.

import { describe, expect, test } from 'bun:test'
import { PerspectiveCamera, Vector3 } from 'three'
import {
  cutAnchor,
  fitDistance,
  holdOnScreen,
  type Lens,
  rayMeets,
  rayThrough,
  type Slide,
  screenPoint,
  screenX,
  shiftTarget,
  showAtHeight,
  sideShift,
  trackSlide,
} from '../src/scene/camera/framing'
import { placeCamera, type RigPose } from '../src/scene/camera/rig'

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
function placed(start: RigPose, points: Vector3[], shift: number, slide: Slide = 'view'): number[] {
  shiftTarget(start, shift, slide)
  return points.map((point) => screenX(start, lens, point))
}

/** How far the camera stands in front of the tracks' plane (z = 0). */
const cameraZ = (view: RigPose) => view.target.z + Math.cos(view.yaw) * Math.cos(view.pitch) * view.distance

/** Where a point shows as three.js projects it, through a camera placed as the rig places it. */
function projected(view: RigPose, point: Vector3): { x: number; y: number } {
  const camera = new PerspectiveCamera(34, lens.aspect, 0.5, 4000)
  placeCamera(view, camera)
  camera.updateMatrixWorld()
  const { x, y } = point.clone().project(camera)
  return {
    x,
    y
  }
}

/** Screen x of a point as three.js projects it. */
const projectedX = (view: RigPose, point: Vector3): number => projected(view, point).x

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

  test('turned, a slide along the tracks frames a point and keeps the distance from the tracks', () => {
    const yaw = (37 * Math.PI) / 180
    // Cells far right and far left of the view, on the tracks' plane and deep on a wall.
    for (const point of [new Vector3(160, -20, 0), new Vector3(-90, 5, 0), new Vector3(120, 0, -30)]) {
      const view   = pose(40, 110, yaw)
      view.pitch   = 0.09
      const before = cameraZ(view)
      expect(Math.abs(screenX(view, lens, point))).toBeGreaterThan(1)
      placed(view, [point], sideShift(view, lens, [point], margins, [], 'least', 'tracks'), 'tracks')
      expect(Math.abs(projectedX(view, point))).toBeCloseTo(1 - margins.left, 6)
      expect(cameraZ(view)).toBeCloseTo(before, 9)
      expect(view.target.z).toBe(0)
    }
  })

  test('a slide along the view brings the camera nearer the tracks when turned', () => {
    const view   = pose(40, 110, (37 * Math.PI) / 180)
    const before = cameraZ(view)
    const point  = new Vector3(200, 0, 0)
    placed(view, [point], sideShift(view, lens, [point], margins))
    expect(cameraZ(view)).toBeLessThan(before - 50)
  })

  test('the roll is counted: a low cell in a tilted view lands on the margin', () => {
    const view = pose(40, 110, 0.6)
    view.roll  = 0.07
    // A cell far down the left side: the tilt pushes it further out than a level framing thinks.
    const cell = new Vector3(-60, -30, 0)
    expect(projectedX(view, cell)).toBeLessThan(-1)
    expect(screenX(view, lens, cell)).toBeCloseTo(projectedX(view, cell), 9)
    for (const slide of ['view', 'tracks'] as const) {
      const start = {
        ...view,
        target: view.target.clone()
      }
      placed(start, [cell], sideShift(start, lens, [cell], margins, [], 'least', slide), slide)
      expect(projectedX(start, cell)).toBeCloseTo(-(1 - margins.left), 6)
    }
  })
})

describe('trackSlide', () => {
  test('slides along the tracks unless the view looks almost along them', () => {
    expect(trackSlide(pose(0, 100, 0), lens, margins)).toBe('tracks')
    expect(trackSlide(pose(0, 100, (44 * Math.PI) / 180), lens, margins)).toBe('tracks')
    expect(trackSlide(pose(0, 100, (80 * Math.PI) / 180), lens, margins)).toBe('view')
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

describe('cuts to a new angle', () => {
  /** A dramatic Turn take following playback (angles and places as logged on the device). */
  const take     = (): RigPose => ({
    target  : new Vector3(82, -1130, -1),
    yaw     : 0.4,
    pitch   : 0.3,
    distance: 95,
    roll    : 0.044
  })
  const nextTake = {
    yaw  : 0.66,
    pitch: -0.21,
    roll : -0.063
  }

  test('screenPoint is where three.js shows the point, the roll included', () => {
    const view  = take()
    const point = new Vector3(70, -1125, 0)
    const shown = screenPoint(view, lens, point)
    expect(shown.x).toBeCloseTo(projected(view, point).x, 9)
    expect(shown.y).toBeCloseTo(projected(view, point).y, 9)
  })

  test('holdOnScreen keeps a point on its pixel across a new take', () => {
    const view  = take()
    const point = new Vector3(84, -1120, 0)
    const shown = screenPoint(view, lens, point)
    Object.assign(view, nextTake)
    holdOnScreen(view, lens, point, shown)
    expect(projected(view, point).x).toBeCloseTo(shown.x, 9)
    expect(projected(view, point).y).toBeCloseTo(shown.y, 9)
    expect(view.target.z).toBe(-1)
  })

  test('a cell in sight is the anchor itself', () => {
    const cell = new Vector3(84, -1120, 0)
    expect(cutAnchor(take(), lens, cell)).toBe(cell)
  })

  test('the M8 cell far above the playheads: its track keeps its place, the view stays near', () => {
    // While the song plays the view follows the playheads; the M8 cursor sits 250 units higher.
    const view   = take()
    const cell   = new Vector3(83, -880, 0)
    const anchor = cutAnchor(view, lens, cell)
    expect([anchor.x, anchor.y, anchor.z]).toEqual([83, -1130, 0])
    const shown  = screenPoint(view, lens, anchor)
    expect(Math.abs(shown.x)).toBeLessThan(1)
    expect(Math.abs(shown.y)).toBeLessThan(1)
    Object.assign(view, nextTake)
    holdOnScreen(view, lens, anchor, shown)
    expect(projected(view, anchor).x).toBeCloseTo(shown.x, 9)
    expect(Math.abs(view.target.x - 82)).toBeLessThan(5)
    // Holding the far cell itself is what threw the view to the end of the song.
    const thrown = take()
    const far    = screenPoint(thrown, lens, cell)
    Object.assign(thrown, nextTake)
    holdOnScreen(thrown, lens, cell, far)
    expect(Math.abs(thrown.target.x - 82)).toBeGreaterThan(50)
  })
})

describe('following the playhead', () => {
  const tilted = (): RigPose => ({
    target  : new Vector3(82, -1130, -1),
    yaw     : 0.66,
    pitch   : -0.21,
    distance: 95,
    roll    : -0.063
  })

  test('the playhead shows at the asked height whatever the angle', () => {
    const view     = tilted()
    const playhead = new Vector3(84, -1100, 0)
    showAtHeight(view, lens, playhead, 0.35)
    expect(projected(view, playhead).y).toBeCloseTo(0.35, 9)
    expect([view.target.x, view.target.z]).toEqual([82, -1])
  })

  test('as the song plays the view scrolls with the playhead, which keeps its place', () => {
    const view     = tilted()
    const playhead = new Vector3(84, -1100, 0)
    showAtHeight(view, lens, playhead, 0.35)
    const shown  = projected(view, playhead)
    const before = view.target.y
    playhead.y   -= 12.5
    showAtHeight(view, lens, playhead, 0.35)
    expect(view.target.y).toBeCloseTo(before - 12.5, 9)
    expect(projected(view, playhead).x).toBeCloseTo(shown.x, 9)
  })

  test('facing the front straight, a third of the view above the target as before', () => {
    const view     = pose(40, 95)
    const playhead = new Vector3(42, -500, 0)
    showAtHeight(view, lens, playhead, 0.35)
    expect(view.target.y).toBeCloseTo(-500 - 95 * lens.tanHalfFov * 0.35, 9)
  })
})

// Small drawing helpers shared by the scene: batched rectangles, line segments, easing, and
// the curve of a link from a step cell to a panel.

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
} from 'three'

/** A unit quad with its origin at the top-left corner. */
export const UNIT_QUAD = new PlaneGeometry(1, 1).translate(0.5, -0.5, 0)

/** A coloured rectangle hanging down from its top-left corner (x, y). */
export interface ColoredRect {
  x    : number
  y    : number
  w    : number
  h    : number
  z?   : number
  color: string
}

/** Many rectangles in one draw call. */
export function rectangles(rects: ColoredRect[], opacity: number): InstancedMesh {
  const material = new MeshBasicMaterial({
    transparent: true,
    opacity,
    depthWrite : false,
    side       : DoubleSide
  })
  const mesh     = new InstancedMesh(UNIT_QUAD, material, Math.max(1, rects.length))
  const matrix   = new Matrix4()
  const color    = new Color()
  rects.forEach((rect, i) => {
    matrix.makeScale(rect.w, rect.h, 1).setPosition(rect.x, rect.y, rect.z ?? 0)
    mesh.setMatrixAt(i, matrix)
    mesh.setColorAt(i, color.set(rect.color))
  })
  mesh.count         = rects.length
  mesh.frustumCulled = false
  return mesh
}

/** Line segments from a flat list of point pairs (x, y, z, x, y, z, ...). */
export function lineSegments(points: number[], color: string, opacity: number): LineSegments {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(points, 3))
  const lines         = new LineSegments(geometry, new LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite : false
  }))
  lines.frustumCulled = false
  return lines
}

/** 0 below `from`, 1 above `to`, eased in between. */
export function smoothstep(from: number, to: number, x: number): number {
  const t = MathUtils.clamp((x - from) / (to - from), 0, 1)
  return t * t * (3 - 2 * t)
}

/** The share of the way toward a goal to move this frame, for an ease at `rate` per second. */
export const easeFactor = (dt: number, rate: number): number => 1 - Math.exp(-dt * rate)

/** The four weights of a cubic Bézier curve at t (0..1). */
export function bezierWeights(t: number): [number, number, number, number] {
  const u = 1 - t
  return [u ** 3, 3 * u ** 2 * t, 3 * u * t ** 2, t ** 3]
}

/**
 * Control points of a link from a step cell to a panel title: out of the wall toward the
 * viewer, then into the panel's title from the left.
 */
export function linkControlPoints(from: Vector3, to: Vector3): [Vector3, Vector3, Vector3, Vector3] {
  const lift = 1.2 + Math.min(from.distanceTo(to) * 0.05, 3)
  return [from, new Vector3(from.x + (to.x - from.x) * 0.45, from.y, lift), new Vector3(to.x - 2.5, to.y, lift * 0.6), to]
}

/** The link curve as `segments` + 1 points. */
export function linkCurve(from: Vector3, to: Vector3, segments = 24): Vector3[] {
  const controls = linkControlPoints(from, to)
  const points   : Vector3[] = []
  for (let i = 0; i <= segments; i += 1) {
    const weights = bezierWeights(i / segments)
    const point   = new Vector3()
    for (const [k, control] of controls.entries()) point.addScaledVector(control, weights[k])
    points.push(point)
  }
  return points
}

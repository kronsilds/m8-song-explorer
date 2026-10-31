// Measures of the 3D view's camera: its lens, how much of the world it shows at a distance, where
// a pointer position lands on the screen, and, with a second camera put on any pose, at which
// height a point of the tracks would show (the framings measure where the view will be, not where
// it is now).

import { MathUtils, PerspectiveCamera, Vector3 } from 'three'
import type { Lens } from './framing'
import { placeCamera, type RigPose } from './rig'

/** An automatic framing stands back far enough for this many rows, and not so far that rows get shorter than this (pixels). */
const FRAME_MIN_ROWS   = 50
const FRAME_MIN_ROW_PX = 12

export class ViewProbe {
  /** A camera put on other poses, to find where things would show. */
  private readonly probeCamera = new PerspectiveCamera()
  private readonly probePoint  = new Vector3()

  /**
   * @param camera the view's camera (its field of view, aspect and projection)
   * @param canvas the element the view is drawn on (pointer positions are measured on it)
   * @param container the element holding it (its size is the view's)
   */
  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly canvas: HTMLElement,
    private readonly container: HTMLElement,
  ) {}

  /** The view's size in pixels. */
  get width(): number {
    return this.container.clientWidth
  }

  get height(): number {
    return this.container.clientHeight
  }

  lens(): Lens {
    return {
      tanHalfFov: Math.tan(MathUtils.degToRad(this.camera.fov) / 2),
      aspect    : this.camera.aspect
    }
  }

  /** Half the height of the world the camera shows at `distance` from its target. */
  visibleHalfHeight(distance: number): number {
    return distance * Math.tan(MathUtils.degToRad(this.camera.fov) / 2)
  }

  /** World units per pixel of the canvas at `distance`. */
  unitsPerPixel(distance: number): number {
    return (2 * this.visibleHalfHeight(distance)) / this.canvas.clientHeight
  }

  /** The distance at which a width x height rectangle facing the camera fills the view. */
  distanceToFit(width: number, height: number): number {
    const verticalFov   = MathUtils.degToRad(this.camera.fov)
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect)
    return Math.max(width / 2 / Math.tan(horizontalFov / 2), height / 2 / Math.tan(verticalFov / 2))
  }

  /** Distances an automatic framing may stand at: near enough for rows to read, far enough for a phrase and more. */
  readableDistances(rowHeight: number): [near: number, far: number] {
    const { tanHalfFov } = this.lens()
    const near           = (FRAME_MIN_ROWS * rowHeight) / (2 * tanHalfFov)
    const far            = (rowHeight * this.container.clientHeight) / (2 * tanHalfFov * FRAME_MIN_ROW_PX)
    return [Math.min(near, far), Math.max(near, far)]
  }

  /** Normalized device coordinates (-1..1, y up) of a pointer position. */
  ndcAt(clientX: number, clientY: number): [x: number, y: number] {
    const rect = this.canvas.getBoundingClientRect()
    return [((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2]
  }

  /** Puts the probe camera at `pose`, for heightAt. */
  aim(pose: RigPose): void {
    const probe = this.probeCamera
    placeCamera(pose, probe)
    probe.projectionMatrix.copy(this.camera.projectionMatrix)
    probe.updateMatrixWorld()
  }

  /** The height at `x` on the tracks' plane (or `z` off it) that the probe camera (aimed at `pose`) shows at screen height `ndcY`, -1 bottom to 1 top. */
  heightAt(pose: RigPose, x: number, ndcY: number, z = 0): number {
    const miss = (y: number) => this.probePoint.set(x, y, z).project(this.probeCamera).y - ndcY
    // Perspective bends the height a little with depth: a few secant steps from the flat estimate.
    let y      = pose.target.y + this.visibleHalfHeight(pose.distance) * ndcY
    for (let step = 0; step < 3; step += 1) {
      const here  = miss(y)
      const slope = (miss(y + 0.5) - here) / 0.5
      if (Math.abs(slope) < 1e-6) break
      y -= here / slope
    }
    return y
  }

  /** The screen heights (normalized, -1 bottom to 1 top) that points span from `pose`. */
  screenHeights(pose: RigPose, points: Vector3[]): [low: number, high: number] {
    this.aim(pose)
    const heights = points.map((point) => this.probePoint.copy(point).project(this.probeCamera).y)
    return [Math.min(...heights), Math.max(...heights)]
  }
}

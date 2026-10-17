// An orbit camera with goals: input moves the goals, the camera eases toward them.

import { MathUtils, type PerspectiveCamera, Vector3 } from 'three'

export interface RigPose {
  target: Vector3
  yaw: number
  pitch: number
  distance: number
  /** Tilt around the line of sight (a dramatic angle), radians. */
  roll: number
}

export const YAW_LIMITS = [MathUtils.degToRad(-25), MathUtils.degToRad(82)] as const
export const PITCH_LIMITS = [MathUtils.degToRad(-30), MathUtils.degToRad(30)] as const

export class CameraRig {
  readonly current: RigPose = { target: new Vector3(), yaw: 0, pitch: 0, distance: 80, roll: 0 }
  readonly goal: RigPose = { target: new Vector3(), yaw: 0, pitch: 0, distance: 80, roll: 0 }
  minDistance = 8
  maxDistance = 900
  /** Allowed target box (y range follows the song). */
  bounds = { minX: -20, maxX: 200, minY: -1000, maxY: 20 }

  clampGoal(): void {
    const g = this.goal
    g.yaw = MathUtils.clamp(g.yaw, YAW_LIMITS[0], YAW_LIMITS[1])
    g.pitch = MathUtils.clamp(g.pitch, PITCH_LIMITS[0], PITCH_LIMITS[1])
    g.distance = MathUtils.clamp(g.distance, this.minDistance, this.maxDistance)
    g.target.x = MathUtils.clamp(g.target.x, this.bounds.minX, this.bounds.maxX)
    g.target.y = MathUtils.clamp(g.target.y, this.bounds.minY, this.bounds.maxY)
  }

  jump(): void {
    this.clampGoal()
    this.current.target.copy(this.goal.target)
    this.current.yaw = this.goal.yaw
    this.current.pitch = this.goal.pitch
    this.current.distance = this.goal.distance
    this.current.roll = this.goal.roll
  }

  /** Eases toward the goal; returns true while still moving. */
  update(dt: number): boolean {
    this.clampGoal()
    const k = 1 - Math.exp(-dt * 9)
    const c = this.current
    const g = this.goal
    c.target.lerp(g.target, k)
    c.yaw += (g.yaw - c.yaw) * k
    c.pitch += (g.pitch - c.pitch) * k
    c.distance *= (g.distance / c.distance) ** k
    // A cut to another angle eases more slowly, like a camera move.
    c.roll += (g.roll - c.roll) * (1 - Math.exp(-dt * 4))
    return (
      Math.abs(g.roll - c.roll) > 1e-4 ||
      c.target.distanceToSquared(g.target) > 1e-4 ||
      Math.abs(g.yaw - c.yaw) > 1e-4 ||
      Math.abs(g.pitch - c.pitch) > 1e-4 ||
      Math.abs(g.distance - c.distance) > 1e-3
    )
  }

  apply(camera: PerspectiveCamera): void {
    const { target, yaw, pitch, distance } = this.current
    camera.position.set(
      target.x + Math.sin(yaw) * Math.cos(pitch) * distance,
      target.y + Math.sin(pitch) * distance,
      target.z + Math.cos(yaw) * Math.cos(pitch) * distance,
    )
    camera.lookAt(target)
    if (this.current.roll) camera.rotateZ(this.current.roll)
  }
}

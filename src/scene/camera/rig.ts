// An orbit camera with goals: input moves the goals, the camera eases toward them.

import { MathUtils, type PerspectiveCamera, Vector3 } from 'three'
import { easeFactor } from '../shapes'

export interface RigPose {
  target  : Vector3
  yaw     : number
  pitch   : number
  distance: number
  /** Tilt around the line of sight (a dramatic angle), radians. */
  roll    : number
}

const YAW_LIMITS     = [MathUtils.degToRad(-25), MathUtils.degToRad(82)] as const
const PITCH_LIMITS   = [MathUtils.degToRad(-30), MathUtils.degToRad(30)] as const
/** Ease rates per second: the pose, and a slower roll so a cut to another angle feels like a camera move. */
const POSE_EASE_RATE = 9
const ROLL_EASE_RATE = 4
const SETTLED        = 1e-4

const newPose        = (): RigPose => ({
  target  : new Vector3(),
  yaw     : 0,
  pitch   : 0,
  distance: 80,
  roll    : 0
})

export class CameraRig {
  readonly current = newPose()
  readonly goal    = newPose()
  minDistance      = 8
  maxDistance      = 900
  /** Allowed target box (y range follows the song). */
  bounds           = {
    minX: -20,
    maxX: 200,
    minY: -1000,
    maxY: 20
  }

  clampGoal(): void {
    const { goal, bounds } = this
    goal.yaw               = MathUtils.clamp(goal.yaw, YAW_LIMITS[0], YAW_LIMITS[1])
    goal.pitch             = MathUtils.clamp(goal.pitch, PITCH_LIMITS[0], PITCH_LIMITS[1])
    goal.distance          = MathUtils.clamp(goal.distance, this.minDistance, this.maxDistance)
    goal.target.y          = MathUtils.clamp(goal.target.y, bounds.minY, bounds.maxY)
    goal.target.x          = MathUtils.clamp(goal.target.x, bounds.minX, bounds.maxX)
  }

  /** Puts the camera on its goal at once. */
  jump(): void {
    this.clampGoal()
    const { current, goal } = this
    current.target.copy(goal.target)
    current.yaw      = goal.yaw
    current.pitch    = goal.pitch
    current.distance = goal.distance
    current.roll     = goal.roll
  }

  /** Eases toward the goal; returns true while still moving. */
  update(dt: number): boolean {
    this.clampGoal()
    const { current, goal } = this
    const ease              = easeFactor(dt, POSE_EASE_RATE)
    current.target.lerp(goal.target, ease)
    current.yaw      += (goal.yaw - current.yaw) * ease
    current.pitch    += (goal.pitch - current.pitch) * ease
    current.distance *= (goal.distance / current.distance) ** ease
    current.roll     += (goal.roll - current.roll) * easeFactor(dt, ROLL_EASE_RATE)
    return (
      Math.abs(goal.roll - current.roll) > SETTLED ||
      current.target.distanceToSquared(goal.target) > SETTLED ||
      Math.abs(goal.yaw - current.yaw) > SETTLED ||
      Math.abs(goal.pitch - current.pitch) > SETTLED ||
      Math.abs(goal.distance - current.distance) > 1e-3
    )
  }

  apply(camera: PerspectiveCamera): void {
    placeCamera(this.current, camera)
  }
}

/** Puts a camera where a pose looks from. */
export function placeCamera(pose: RigPose, camera: PerspectiveCamera): void {
  const { target, yaw, pitch, distance, roll } = pose
  camera.position.set(
    target.x + Math.sin(yaw) * Math.cos(pitch) * distance,
    target.y + Math.sin(pitch) * distance,
    target.z + Math.cos(yaw) * Math.cos(pitch) * distance,
  )
  camera.lookAt(target)
  if (roll) camera.rotateZ(roll)
}

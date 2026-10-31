// The camera angles of the view presets. Plain angles look straight; dramatic takes swing off
// to one side, look up from below or down from above in turn, and lean a few degrees, a new
// take each cut.

import { MathUtils } from 'three'

export type ViewPreset = 'front' | 'angle' | 'side' | 'overview'
export type TurnPreset = Exclude<ViewPreset, 'overview'>

export interface CameraAngles {
  yaw  : number
  pitch: number
  roll : number
}

const degrees                 = MathUtils.degToRad

/** Yaw and pitch of each preset, in degrees. Side looks square at an open wall: a few degrees past its turn from the front (`wallDegrees`). */
const presetDegrees           = (preset: TurnPreset, wallDegrees: number): [yaw: number, pitch: number] => {
  switch (preset) {
    case 'front':
      return [0, 0]
    case 'angle':
      return [30, 5]
    case 'side':
      return [wallDegrees + 4, 3]
  }
}

/** Below this yaw the view counts as facing the front. */
export const FACING_FRONT_YAW = degrees(25)

const between                 = (low: number, high: number): number => low + (high - low) * Math.random()

/**
 * The angles of a preset. `cut` numbers the dramatic takes: odd and even ones alternate low
 * and high. The front take swings left only, away from the walls. `wallDegrees` is how far the
 * wall is turned from the front.
 */
export function presetAngles(preset: TurnPreset, dramatic: boolean, cut: number, wallDegrees: number): CameraAngles {
  const [yaw, pitch] = presetDegrees(preset, wallDegrees)
  if (!dramatic) return {
    yaw  : degrees(yaw),
    pitch: degrees(pitch),
    roll : 0
  }
  const flip = cut % 2 ? 1 : -1
  const roll = degrees((Math.random() < 0.5 ? 1 : -1) * between(2.5, 4.5))
  switch (preset) {
    case 'front':
      return {
        yaw  : degrees(-between(9, 15)),
        pitch: degrees(flip * between(8, 13)),
        roll
      }
    case 'angle':
      return {
        yaw  : degrees(yaw + flip * between(5, 8)),
        pitch: degrees(flip > 0 ? -between(10, 15) : between(14, 19)),
        roll
      }
    case 'side':
      return {
        yaw  : degrees(yaw - between(3, 8)),
        pitch: degrees(flip * between(10, 15)),
        roll
      }
  }
}

// Mouse and touch input over the 3D view: a left drag pans, a right (or Shift + left) drag turns
// (around the track pressed; Shift flips the drag while it goes on), the wheel scrolls (Shift:
// sideways only; Ctrl / pinch zooms), click selects, double click focuses, hover highlights.

import type { Selection } from '../../model/selection'
import type { CameraRig } from '../camera/rig'
import type { SceneButton } from './picker'

/** What the controls drive: the world implements it. */
export interface PointerTarget {
  readonly rig: CameraRig
  /** World units per screen pixel at the goal distance. */
  unitsPerPixel(): number
  /** Zooms by `factor` (distance) toward the point under the pointer. */
  zoomAt(clientX: number, clientY: number, factor: number): void
  /** A pan by hand moved the pointer between these positions: what it held stays under it. */
  dragPan(fromX: number, fromY: number, toX: number, toY: number): void
  /** The view was panned sideways: the track in focus may have changed. */
  panned(): void
  /** A turn by hand starts from a press at this pointer position. */
  turnStarted(clientX: number, clientY: number): void
  /** The view was turned by hand, away from any preset. */
  turnedByHand(): void
  /** The turn by hand ended. */
  turnEnded(): void
  invalidate(): void
  interacted(): void
  buttonAt(clientX: number, clientY: number): SceneButton | null
  cellAt(clientX: number, clientY: number): Selection | null
  hover(selection: Selection | null): void
  click(selection: Selection | null, clientX: number, clientY: number): void
  doubleClick(selection: Selection): void
  pressButton(button: SceneButton): void
}

/** Pixels the pointer must move before a press becomes a drag. */
const DRAG_THRESHOLD_PX     = 4
const YAW_PER_PX            = 0.0055
const PITCH_PER_PX          = 0.004
const ZOOM_PER_WHEEL_UNIT   = 0.0022
/** Nearest to the target, a wheel step zooms this share of what it does from furthest. */
const ZOOM_NEAR_SHARE       = 0.3
const SCROLL_PER_WHEEL_UNIT = 0.9
/** Looking almost along the tracks, a pan speeds up no more than this allows. */
export const PAN_MIN_COS    = 0.35
/** Wheel delta units: pixels, lines, pages. */
const WHEEL_UNIT_PX         = [1, 16, 400]

interface Drag {
  x     : number
  y     : number
  /** Where the press was. */
  startX: number
  startY: number
  button: number
  moved : boolean
  /** What the drag does now (Shift flips it); null before it has moved. */
  mode  : DragMode | null
}

type DragMode = 'pan' | 'turn'

/** The right button turns and the others pan; Shift flips that. */
const modeOf = (button: number, shift: boolean): DragMode => ((button === 2) !== shift ? 'turn' : 'pan')

export function bindPointerControls(element: HTMLElement, target: PointerTarget): void {
  /**
   * World x per pixel of a sideways pan. A pan moves along the tracks (parallel to their plane),
   * so the distance to them and the zoom never change; turned, it goes further per pixel so the
   * view still keeps up with the pointer.
   */
  const alongTracks = (yaw: number) => target.unitsPerPixel() / Math.max(PAN_MIN_COS, Math.cos(yaw))

  /** Zoom per wheel unit: finer the nearer the view is to what it looks at (by the log of the distance). */
  const zoomRate = () => {
    const { goal, minDistance, maxDistance } = target.rig
    const far                                = Math.log(goal.distance / minDistance) / Math.log(maxDistance / minDistance)
    return ZOOM_PER_WHEEL_UNIT * (ZOOM_NEAR_SHARE + (1 - ZOOM_NEAR_SHARE) * Math.min(1, Math.max(0, far)))
  }

  let drag        : Drag | null = null
  let pendingHover: { x: number; y: number } | null = null

  element.addEventListener('contextmenu', (event) => event.preventDefault())
  for (const type of ['pointerdown', 'pointermove', 'wheel'] as const) element.addEventListener(type, () => target.interacted(), { passive: true })

  element.addEventListener('pointerdown', (event) => {
    element.setPointerCapture(event.pointerId)
    drag = {
      x     : event.clientX,
      y     : event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      button: event.button,
      moved : false,
      mode  : null
    }
  })

  element.addEventListener('pointermove', (event) => {
    if (drag) return dragTo(drag, event)
    // Hover is picked once per frame, at the latest pointer position.
    if (!pendingHover) {
      requestAnimationFrame(() => {
        if (!pendingHover) return
        const { x, y }       = pendingHover
        pendingHover         = null
        element.style.cursor = target.buttonAt(x, y) ? 'pointer' : ''
        target.hover(target.cellAt(x, y))
      })
    }
    pendingHover = {
      x: event.clientX,
      y: event.clientY
    }
  })

  function dragTo(current: Drag, event: PointerEvent): void {
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    current.moved = true
    // Shift flips pan and turn at once, in the middle of a drag.
    const mode    = modeOf(current.button, event.shiftKey)
    if (mode !== current.mode) {
      if (current.mode === 'turn') target.turnEnded()
      if (mode === 'turn') target.turnStarted(current.x, current.y)
      current.mode = mode
    }
    if (mode === 'pan') target.dragPan(current.x, current.y, event.clientX, event.clientY)
    else {
      const goal = target.rig.goal
      goal.yaw   -= dx * YAW_PER_PX
      goal.pitch += dy * PITCH_PER_PX
      target.turnedByHand()
    }
    current.x = event.clientX
    current.y = event.clientY
    target.invalidate()
  }

  element.addEventListener('pointerup', (event) => {
    const released = drag
    drag           = null
    if (released?.mode === 'turn') target.turnEnded()
    if (!released || released.moved || released.button !== 0) return
    const button = target.buttonAt(event.clientX, event.clientY)
    if (button) target.pressButton(button)
    else target.click(target.cellAt(event.clientX, event.clientY), event.clientX, event.clientY)
  })

  element.addEventListener('pointerleave', () => target.hover(null))

  element.addEventListener('dblclick', (event) => {
    if (target.buttonAt(event.clientX, event.clientY)) return
    const selection = target.cellAt(event.clientX, event.clientY)
    if (selection) target.doubleClick(selection)
  })

  element.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const goal = target.rig.goal
      const unit = WHEEL_UNIT_PX[event.deltaMode] ?? 1
      if (event.ctrlKey || event.metaKey || event.altKey) {
        target.zoomAt(event.clientX, event.clientY, Math.exp(event.deltaY * unit * zoomRate()))
      } else if (event.shiftKey) {
        // Shift scrolls sideways only (some browsers already move the wheel's delta to x).
        goal.target.x += (event.deltaX || event.deltaY) * unit * SCROLL_PER_WHEEL_UNIT * alongTracks(goal.yaw)
        target.panned()
      } else {
        goal.target.y -= event.deltaY * unit * SCROLL_PER_WHEEL_UNIT * target.unitsPerPixel()
        goal.target.x += event.deltaX * unit * SCROLL_PER_WHEEL_UNIT * alongTracks(goal.yaw)
        if (event.deltaX) target.panned()
      }
      target.invalidate()
    },
    { passive: false },
  )
}

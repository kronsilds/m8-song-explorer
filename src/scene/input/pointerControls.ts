// Mouse and touch input over the 3D view: drag turns, right / Shift drag pans, the wheel
// scrolls (Ctrl / pinch zooms), click selects, double click focuses, hover highlights.

import type { Selection } from '../../model/selection'
import type { CameraRig } from '../camera/rig'
import type { SceneButton } from './picker'

/** What the controls drive: the world implements it. */
export interface PointerTarget {
  readonly rig: CameraRig
  /** World units per screen pixel at the goal distance. */
  unitsPerPixel(): number
  /** The view was panned sideways: the track in its middle may have changed. */
  panned(): void
  /** The view was turned by hand, away from any preset. */
  turnedByHand(): void
  invalidate(): void
  interacted(): void
  buttonAt(clientX: number, clientY: number): SceneButton | null
  cellAt(clientX: number, clientY: number): Selection | null
  hover(selection: Selection | null): void
  click(selection: Selection | null): void
  doubleClick(selection: Selection): void
  pressButton(button: SceneButton): void
}

/** Pixels the pointer must move before a press becomes a drag. */
const DRAG_THRESHOLD_PX     = 4
const YAW_PER_PX            = 0.0055
const PITCH_PER_PX          = 0.004
const ZOOM_PER_WHEEL_UNIT   = 0.0022
const SCROLL_PER_WHEEL_UNIT = 0.9
/** Wheel delta units: pixels, lines, pages. */
const WHEEL_UNIT_PX         = [1, 16, 400]

interface Drag {
  x     : number
  y     : number
  button: number
  moved : boolean
  pan   : boolean
}

export function bindPointerControls(element: HTMLElement, target: PointerTarget): void {
  let drag        : Drag | null = null
  let pendingHover: { x: number; y: number } | null = null

  element.addEventListener('contextmenu', (event) => event.preventDefault())
  for (const type of ['pointerdown', 'pointermove', 'wheel'] as const) element.addEventListener(type, () => target.interacted(), { passive: true })

  element.addEventListener('pointerdown', (event) => {
    element.setPointerCapture(event.pointerId)
    drag = {
      x     : event.clientX,
      y     : event.clientY,
      button: event.button,
      moved : false,
      pan   : event.button !== 0 || event.shiftKey
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
    current.x     = event.clientX
    current.y     = event.clientY
    const goal    = target.rig.goal
    if (current.pan) {
      const scale   = target.unitsPerPixel()
      goal.target.x -= dx * scale * Math.cos(goal.yaw)
      goal.target.z += dx * scale * Math.sin(goal.yaw)
      goal.target.y += dy * scale
      target.panned()
    } else {
      goal.yaw   -= dx * YAW_PER_PX
      goal.pitch += dy * PITCH_PER_PX
      target.turnedByHand()
    }
    target.invalidate()
  }

  element.addEventListener('pointerup', (event) => {
    const released = drag
    drag           = null
    if (!released || released.moved || released.button !== 0) return
    const button = target.buttonAt(event.clientX, event.clientY)
    if (button) target.pressButton(button)
    else target.click(target.cellAt(event.clientX, event.clientY))
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
        goal.distance *= Math.exp(event.deltaY * unit * ZOOM_PER_WHEEL_UNIT)
      } else {
        const scale   = target.unitsPerPixel() * SCROLL_PER_WHEEL_UNIT
        goal.target.y -= event.deltaY * unit * scale
        goal.target.x += (event.shiftKey ? event.deltaY : event.deltaX) * unit * scale
        if (event.shiftKey || event.deltaX) target.panned()
      }
      target.invalidate()
    },
    { passive: false },
  )
}

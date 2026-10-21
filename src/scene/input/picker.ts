// Turns a pointer position into what is under it: a cell of a track (front column, wall step
// details, panel header or table row) or a track's mute / solo button.

import { Matrix4, type Object3D, type PerspectiveCamera, type Ray, Raycaster, Vector2, type Vector3 } from 'three'
import type { TrackToggle } from '../../m8/midiControl'
import type { Selection } from '../../model/selection'
import {
  CHAR_W,
  FRONT_W,
  fieldAt,
  INST_COL,
  NOTE_COL,
  PANEL_CHARS,
  PANEL_FIELDS,
  PANEL_ROWS,
  PANEL_U0,
  ROW_H,
  SIDE_CHARS,
  SIDE_FIELDS,
  SIDE_U0,
  type SongLayout,
} from '../layout'
import type { TrackView } from '../track/trackView'

/** Walls fainter than this cannot be picked. */
const MIN_WALL_ALPHA         = 0.35
const MIN_PANEL_ALPHA        = 0.5
const MIN_BUTTON_FRONT_ALPHA = 0.5

interface Hit<T> {
  value   : T
  distance: number
}

export class ScenePicker {
  private readonly raycaster = new Raycaster()

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  private rayAt(clientX: number, clientY: number): Ray {
    const rect    = this.canvas.getBoundingClientRect()
    const pointer = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(pointer, this.camera)
    return this.raycaster.ray
  }

  /** Where the ray meets the plane z = 0 of an object, in its coordinates, and how far from the camera. */
  private hitPlane(object: Object3D, ray: Ray): { point: Vector3; distance: number } | null {
    const local = ray.clone().applyMatrix4(new Matrix4().copy(object.matrixWorld).invert())
    if (Math.abs(local.direction.z) < 1e-6) return null
    const along = -local.origin.z / local.direction.z
    if (along <= 0) return null
    const point = local.origin.clone().addScaledVector(local.direction, along)
    const world = point.clone().applyMatrix4(object.matrixWorld)
    return {
      point,
      distance: world.distanceTo(ray.origin)
    }
  }

  /** The cell under the pointer, nearest first. */
  pickCell(layout: SongLayout, views: TrackView[], clientX: number, clientY: number): Selection | null {
    const ray      = this.rayAt(clientX, clientY)
    let nearest    : Hit<Selection> | null = null
    // Columns that stepped back for an open wall let the pointer through to it: they are
    // picked only when nothing else is under the pointer.
    let behind     : Hit<Selection> | null = null
    const consider = (selection: Selection | null, distance: number, seeThrough = false) => {
      if (!selection) return
      if (seeThrough) {
        if (!behind || distance < behind.distance) behind = {
          value: selection,
          distance
        }
      } else if (!nearest || distance < nearest.distance) nearest = {
        value: selection,
        distance
      }
    }
    for (const view of views) {
      const front = this.hitPlane(view.front, ray)
      if (front) consider(this.frontCell(layout, view, front.point), front.distance, view.frontAlpha < 0.99)
      if (view.wallAlpha < MIN_WALL_ALPHA) continue
      const wall = this.hitPlane(view.wall, ray)
      if (wall) consider(this.wallCell(layout, view, wall.point), wall.distance)
    }
    return ((nearest ?? behind) as Hit<Selection> | null)?.value ?? null
  }

  private frontCell(layout: SongLayout, view: TrackView, point: Vector3): Selection | null {
    if (point.x <= -0.3 || point.x >= FRONT_W + 0.2 || view.inHeader(point.y)) return null
    const row      = layout.rowAtY(point.y)
    const instance = row == null ? null : layout.instanceAt(view.track.track, row)
    if (!instance || row == null) return null
    const char = point.x / CHAR_W
    if (char < NOTE_COL - 0.5) return {
      kind: 'chain',
      instance
    }
    return {
      kind  : 'step',
      instance,
      step  : row - instance.row,
      column: char >= INST_COL - 0.5 ? 'inst' : 'note'
    }
  }

  /** On the wall (u along it): the step details, else a panel. */
  private wallCell(layout: SongLayout, view: TrackView, point: Vector3): Selection | null {
    const { x: u, y } = point
    const track       = view.track.track
    if (u >= SIDE_U0 - 0.3 && u <= SIDE_U0 + SIDE_CHARS * CHAR_W + 0.3) {
      if (view.inHeader(y)) return null
      const row      = layout.rowAtY(y)
      const instance = row == null ? null : layout.instanceAt(track, row)
      if (!instance || row == null) return null
      const column = fieldAt(SIDE_FIELDS, Math.floor((u - SIDE_U0) / CHAR_W), 'vel')
      return {
        kind: 'step',
        instance,
        step: row - instance.row,
        column
      }
    }
    if (u < PANEL_U0 - 0.5) return null
    const panel = layout.tracks[track].panels.find(
      (p) =>
        p.alpha > MIN_PANEL_ALPHA &&
        u >= p.shownU - 0.5 &&
        u <= p.shownU + PANEL_CHARS * CHAR_W + 0.5 &&
        y <= p.shownY + 0.3 &&
        y > p.shownY - PANEL_ROWS * ROW_H,
    )
    if (!panel) return null
    const line = Math.floor((panel.shownY - y) / ROW_H)
    // Lines 0 and 1 are the panel's title and subtitle.
    if (line < 2) return {
      kind      : 'instrument',
      instrument: panel.instrument,
      table     : panel.table,
      track
    }
    const column = fieldAt(PANEL_FIELDS, Math.floor((u - panel.shownU) / CHAR_W), 'transpose')
    return {
      kind      : 'table',
      table     : panel.table,
      row       : Math.min(15, line - 2),
      column,
      track,
      instrument: panel.instrument
    }
  }

  /** The mute or solo button under the pointer, nearest first. */
  pickButton(views: TrackView[], clientX: number, clientY: number): { track: number; kind: TrackToggle } | null {
    const ray   = this.rayAt(clientX, clientY)
    let nearest : Hit<{ track: number; kind: TrackToggle }> | null = null
    for (const view of views) {
      if (view.frontAlpha < MIN_BUTTON_FRONT_ALPHA) continue
      const hit  = this.hitPlane(view.front, ray)
      const kind = hit && view.buttonAt(hit.point.x, hit.point.y)
      if (hit && kind && (!nearest || hit.distance < nearest.distance)) nearest = {
        value   : {
          track: view.track.track,
          kind
        },
        distance: hit.distance
      }
    }
    return nearest?.value ?? null
  }
}

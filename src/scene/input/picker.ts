// Turns a pointer position into what is under it: a cell of a track (front column, wall step
// details, panel header, table row or instrument value) or a button (a track's mute / solo, a
// panel's tab that turns it over).

import { Matrix4, type Object3D, type PerspectiveCamera, type Ray, Raycaster, Vector2, type Vector3 } from 'three'
import type { TrackToggle } from '../../m8/midiControl'
import type { Selection } from '../../model/selection'
import { isTitlePlace, placeAt } from '../instrumentFace'
import {
  CHAR_W,
  FRONT_W,
  fieldAt,
  INST_COL,
  NOTE_COL,
  PANEL_FIELDS,
  type Panel,
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

/** A button of the scene: a track's mute or solo, or the tab that turns a panel over. */
export type SceneButton = { track: number; kind: TrackToggle } | { track: number; kind: 'flip'; table: number }

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
      // Panels turn out of the wall: each is met in its own plane.
      for (const panel of layout.tracks[view.track.track].panels) {
        if (panel.alpha <= MIN_PANEL_ALPHA) continue
        const hit = this.hitPlane(view.faceFrame(panel), ray)
        if (hit) consider(this.panelCell(layout, view, panel, hit.point), hit.distance)
      }
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

  /** On the wall (u along it): the step details. */
  private wallCell(layout: SongLayout, view: TrackView, point: Vector3): Selection | null {
    const { x: u, y } = point
    const track       = view.track.track
    if (u < SIDE_U0 - 0.3 || u > SIDE_U0 + SIDE_CHARS * CHAR_W + 0.3 || view.inHeader(y)) return null
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

  /** On a panel, at (x, y) in its face's frame (x from its first character, y from its title line). */
  private panelCell(layout: SongLayout, view: TrackView, panel: Panel, point: Vector3): Selection | null {
    const { x, y } = point
    const track    = view.track.track
    if (x < -0.5 || x > view.panelWidth(panel) || y > 0.3 || y <= -view.shownRows(panel) * ROW_H) return null
    const line = Math.floor(-y / ROW_H)
    const face = view.shownFace(panel) === 'inst' && panel.instrument != null ? layout.instrumentFace(panel.instrument) : null
    if (face && panel.instrument != null) {
      const place = placeAt(face, x / CHAR_W, line)
      // Its title is the panel header.
      if (!place || isTitlePlace(place)) return {
        kind      : 'instrument',
        instrument: panel.instrument,
        table     : panel.table,
        track
      }
      return {
        kind      : 'instParam',
        instrument: panel.instrument,
        screen    : place.cell.screen,
        line      : place.cell.line,
        x         : place.cell.x,
        table     : panel.table,
        track
      }
    }
    // Lines 0 and 1 are the panel's title and subtitle.
    if (line < 2) return {
      kind      : 'instrument',
      instrument: panel.instrument,
      table     : panel.table,
      track
    }
    const column = fieldAt(PANEL_FIELDS, Math.floor(x / CHAR_W), 'transpose')
    return {
      kind      : 'table',
      table     : panel.table,
      row       : Math.min(15, line - 2),
      column,
      track,
      instrument: panel.instrument
    }
  }

  /** The button under the pointer (mute, solo, a panel's tab), nearest first. */
  pickButton(views: TrackView[], clientX: number, clientY: number): SceneButton | null {
    const ray      = this.rayAt(clientX, clientY)
    let nearest    : Hit<SceneButton> | null = null
    const consider = (value: SceneButton, distance: number) => {
      if (!nearest || distance < nearest.distance) nearest = {
        value,
        distance
      }
    }
    for (const view of views) {
      const track = view.track.track
      if (view.frontAlpha >= MIN_BUTTON_FRONT_ALPHA) {
        const hit  = this.hitPlane(view.front, ray)
        const kind = hit && view.buttonAt(hit.point.x, hit.point.y)
        if (hit && kind) consider({
          track,
          kind
        }, hit.distance)
      }
      if (view.wallAlpha < MIN_WALL_ALPHA) continue
      for (const panel of view.track.panels) {
        const hit = this.hitPlane(view.panelGroup(panel), ray)
        if (hit && view.onTab(panel, hit.point.x, hit.point.y)) consider({
          track,
          kind : 'flip',
          table: panel.table
        }, hit.distance)
      }
    }
    return (nearest as Hit<SceneButton> | null)?.value ?? null
  }
}

// A highlighted cell: a soft fill and a crisp outline, moved to whichever group the cell is in.

import { BufferGeometry, DoubleSide, Float32BufferAttribute, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, type Object3D } from 'three'
import { UNIT_QUAD } from '../shapes'

/** A cell's rectangle in its parent's coordinates, hanging down from its top-left corner. */
export interface CellRect {
  parent: Object3D
  x     : number
  y     : number
  w     : number
  h     : number
}

/** The outline of the unit quad: four sides as line segments. */
const UNIT_OUTLINE = [0, 0, 0, 1, 0, 0, 1, 0, 0, 1, -1, 0, 1, -1, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0]

export class CellMarker {
  readonly fill    = new Mesh(UNIT_QUAD, new MeshBasicMaterial({
    transparent: true,
    depthWrite : false,
    side       : DoubleSide
  }))
  readonly outline : LineSegments

  constructor() {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(UNIT_OUTLINE, 3))
    this.outline             = new LineSegments(geometry, new LineBasicMaterial({
      transparent: true,
      depthWrite : false
    }))
    this.fill.renderOrder    = 1
    this.outline.renderOrder = 3
    this.hide()
  }

  show(rect: CellRect, color: string, fillOpacity: number, outlineOpacity: number): void {
    for (const object of [this.fill, this.outline]) {
      if (object.parent !== rect.parent) rect.parent.add(object)
      object.position.set(rect.x, rect.y, 0.03)
      object.scale.set(rect.w, rect.h, 1)
      object.visible = true
    }
    const fill    = this.fill.material as MeshBasicMaterial
    const outline = this.outline.material as LineBasicMaterial
    fill.color.set(color)
    fill.opacity = fillOpacity
    outline.color.set(color)
    outline.opacity = outlineOpacity
  }

  set outlineOpacity(opacity: number) {
    ;(this.outline.material as LineBasicMaterial).opacity = opacity
  }

  hide(): void {
    this.fill.visible    = false
    this.outline.visible = false
  }
}

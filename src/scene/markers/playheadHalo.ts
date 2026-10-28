// A glow along the top or bottom edge of the view in a track's column, where the track's
// playhead is out of sight: under the header when it plays above the view, at the bottom of the
// view when it plays below it.

import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial, type Object3D } from 'three'

/** A unit quad hanging down from its top-left corner, opaque along its top edge and clear along its bottom one. */
const FADING_QUAD = (() => {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, -1, 0, 1, -1, 0]), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0]), 4))
  geometry.setIndex([0, 2, 1, 1, 2, 3])
  return geometry
})()

export class PlayheadHalo {
  readonly mesh = new Mesh(FADING_QUAD, new MeshBasicMaterial({
    vertexColors: true,
    transparent : true,
    depthWrite  : false,
    side        : DoubleSide
  }))

  constructor() {
    // Over the rows and the playhead markers, under the header (4 and up).
    this.mesh.renderOrder = 3
    this.mesh.visible     = false
  }

  /**
   * Shows the glow on `parent` across `x`..`x + w`, opaque at height `edge` and fading over
   * `reach`: downward from a top edge (reach > 0), upward from a bottom edge (reach < 0).
   */
  show(parent: Object3D, x: number, edge: number, w: number, reach: number, color: string, opacity: number): void {
    if (this.mesh.parent !== parent) parent.add(this.mesh)
    this.mesh.position.set(x, edge, 0.04)
    this.mesh.scale.set(w, reach, 1)
    const material   = this.mesh.material as MeshBasicMaterial
    material.color.set(color)
    material.opacity  = opacity
    this.mesh.visible = true
  }

  hide(): void {
    this.mesh.visible = false
  }
}

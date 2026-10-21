// The instrument face of a panel in 3D: background, the device rows as text, a bar after each
// level with marks under the parameters a modulator drives, and on its right the modulator
// cards with their curves and values. It is as tall as a table panel and as wide as two panel
// columns. It fades with its panel; its text exists only while it shows.

import { Group, type InstancedMesh, type LineSegments, type MeshBasicMaterial } from 'three'
import type { Text } from 'troika-three-text'
import { FACE_HEADER, INST_CHARS, type InstrumentFace, MOD_CARD_CHARS, MOD_CARD_ROWS, MOD_CURVE_ROWS, type ModCard, type TextRole } from '../instrumentFace'
import { CHAR_W, PANEL_CHARS, PANEL_COL_W, ROW_H } from '../layout'
import { mix, type Palette } from '../palette'
import { type ColoredRect, lineSegments, rectangles } from '../shapes'
import { disposeText, makeText, RichText } from '../text'

const BACKGROUND_OPACITY = 0.94
const BAR_OPACITY        = 0.9
const CURVE_FILL_ACTIVE  = 0.28
const CURVE_FILL_IDLE    = 0.08
const CURVE_LINE_ACTIVE  = 0.95
const CURVE_LINE_IDLE    = 0.3
/** A bar's band inside its row. */
const BAR_TOP            = ROW_H * 0.3
const BAR_HEIGHT         = ROW_H * 0.4
/** The meter under an FM operator level. */
const UNDER_TOP          = ROW_H * 0.86
const UNDER_HEIGHT       = ROW_H * 0.1
/** A modulator's mark under a bar. */
const MARK_HEIGHT        = ROW_H * 0.09

/** Width of the face in scene units, padding included: a table panel and the next column's (a colspan of 2). */
export const FACE_WIDTH        = PANEL_COL_W + PANEL_CHARS * CHAR_W + 0.9
/** Width of the header band over the title and TRANSP. rows: the Instrument view part. */
export const FACE_HEADER_WIDTH = INST_CHARS * CHAR_W + 0.65

interface Fading {
  material: { opacity: number }
  base    : number
}

export class InstrumentFaceView {
  readonly group           = new Group()
  private text             : Text | null = null
  private readonly fading  : Fading[] = []
  /** The background (and the modulator cards' tints), faded on its own while faces crossfade. */
  private background!      : Fading
  private readonly palette : Palette

  constructor(
    readonly face: InstrumentFace,
    palette: Palette,
  ) {
    this.palette = palette
    this.buildBackground()
    this.buildBars()
    for (const card of face.cards) this.buildCurve(card)
  }

  /**
   * Registers an object to fade with the face. Bars and curves draw after the background:
   * three sorts transparent meshes by their bounds' centre, which on the slanted wall would
   * put the background over everything to its right.
   */
  private fades<T extends InstancedMesh | LineSegments>(object: T, renderOrder = 1): T {
    object.renderOrder = renderOrder
    const material     = object.material as MeshBasicMaterial
    this.fading.push({
      material,
      base: material.opacity
    })
    this.group.add(object)
    return object
  }

  private slotColor(slot: number): string {
    return this.palette.mods[(slot - 1) % 4]
  }

  private buildBackground(): void {
    const { palette, face } = this
    const rects             : ColoredRect[] = [{
      x    : -0.45,
      y    : 0.25,
      w    : FACE_WIDTH,
      h    : face.rows * ROW_H + 0.5,
      z    : -0.06,
      color: palette.panel
    }, {
      x    : -0.45,
      y    : 0.25,
      w    : FACE_HEADER_WIDTH,
      h    : ROW_H * FACE_HEADER + 0.35,
      z    : -0.05,
      color: palette.panelHeader
    }]
    for (const card of face.cards) {
      rects.push({
        x    : card.col * CHAR_W - 0.15,
        y    : -card.row * ROW_H + 0.1,
        w    : MOD_CARD_CHARS * CHAR_W + 0.3,
        h    : MOD_CARD_ROWS * ROW_H - 0.2,
        z    : -0.05,
        color: mix(palette.panel, this.slotColor(card.slot.slot), card.active ? 0.1 : 0.03)
      })
    }
    const mesh       = rectangles(rects, BACKGROUND_OPACITY)
    mesh.renderOrder = 0
    this.group.add(mesh)
    this.background  = {
      material: mesh.material as MeshBasicMaterial,
      base    : BACKGROUND_OPACITY
    }
  }

  private buildBars(): void {
    const { palette } = this
    const track       = mix(palette.panel, palette.label, 0.2)
    const fill        = mix(palette.label, palette.value, 0.55)
    const rects       : ColoredRect[] = []
    for (const bar of this.face.bars) {
      const x     = bar.col * CHAR_W
      const w     = bar.width * CHAR_W - (bar.under ? 0 : 0.15)
      const top   = -bar.row * ROW_H - (bar.under ? UNDER_TOP : BAR_TOP)
      const h     = bar.under ? UNDER_HEIGHT : BAR_HEIGHT
      const slot  = bar.tint ?? bar.slots[0]
      const color = slot ? mix(fill, this.slotColor(slot), bar.tint ? 0.5 : 0.35) : fill
      rects.push({
        x,
        y    : top,
        w,
        h,
        z    : 0,
        color: track
      })
      if (bar.bipolar) {
        const middle = x + w / 2
        const end    = x + w * bar.level
        rects.push({
          x: Math.min(middle, end),
          y: top,
          w: Math.max(0.05, Math.abs(end - middle)),
          h,
          z: 0.01,
          color
        }, {
          x    : middle - 0.03,
          y    : top + 0.08,
          w    : 0.06,
          h    : h + 0.16,
          z    : 0.015,
          color: palette.label
        })
      } else if (bar.level > 0) {
        rects.push({
          x,
          y: top,
          w: w * bar.level,
          h,
          z: 0.01,
          color
        })
      }
      // Under the bar, one mark per modulator driving the parameter.
      bar.slots.forEach((slot, i) => {
        rects.push({
          x,
          y    : top - h - 0.06 - i * (MARK_HEIGHT + 0.04),
          w,
          h    : MARK_HEIGHT,
          z    : 0.01,
          color: this.slotColor(slot)
        })
      })
    }
    if (rects.length) this.fades(rectangles(rects, BAR_OPACITY))
  }

  /** A modulator's curve over its card, filled down to its base (the middle for an LFO). */
  private buildCurve(card: ModCard): void {
    if (card.points.length < 2) return
    const color  = this.slotColor(card.slot.slot)
    const left   = card.col * CHAR_W + 0.1
    const width  = MOD_CARD_CHARS * CHAR_W - 0.2
    const top    = -(card.row + 1) * ROW_H - 0.08
    const height = MOD_CURVE_ROWS * ROW_H - 0.2
    const xOf    = (t: number) => left + t * width
    const yOf    = (v: number) => top - height + Math.min(1, Math.max(0, v)) * height
    const base   = card.center ? yOf(0.5) : yOf(0)
    const fills  : ColoredRect[] = []
    const points : number[] = [left, base, 0.02, left + width, base, 0.02]
    for (let i = 0; i < card.points.length - 1; i += 1) {
      const [t0, v0] = card.points[i]
      const [t1, v1] = card.points[i + 1]
      points.push(xOf(t0), yOf(v0), 0.03, xOf(t1), yOf(v1), 0.03)
      // The fill under a segment, in a few strips so slopes look filled.
      const strips = Math.max(1, Math.ceil(((t1 - t0) * width) / 0.12))
      for (let k = 0; k < strips; k += 1) {
        const a = k / strips
        const b = (k + 1) / strips
        const y = yOf(v0 + (v1 - v0) * ((a + b) / 2))
        fills.push({
          x: xOf(t0 + (t1 - t0) * a),
          y: Math.max(y, base),
          w: Math.max(0.01, xOf(t0 + (t1 - t0) * b) - xOf(t0 + (t1 - t0) * a)),
          h: Math.abs(y - base),
          z: 0.005,
          color
        })
      }
    }
    if (fills.length) this.fades(rectangles(fills, card.active ? CURVE_FILL_ACTIVE : CURVE_FILL_IDLE))
    this.fades(lineSegments(points, color, card.active ? CURVE_LINE_ACTIVE : CURVE_LINE_IDLE))
  }

  private richText(): RichText {
    const { palette } = this
    const colors      : Record<TextRole, string> = {
      title : palette.title,
      label : palette.label,
      value : palette.value,
      option: palette.option,
      empty : palette.empty,
      slot1 : palette.mods[0],
      slot2 : palette.mods[1],
      slot3 : palette.mods[2],
      slot4 : palette.mods[3]
    }
    const rich        = new RichText()
    this.face.lines.forEach((runs, i) => {
      if (i) rich.newLine()
      for (const [text, role] of runs) rich.add(text, colors[role])
      // An empty line still needs a character for troika to keep its height.
      if (!runs.length) rich.add(' ', palette.empty)
    })
    return rich
  }

  /**
   * Fades the face: its content to `alpha`, its background to `backgroundAlpha`. Its text is
   * made while it shows and `textOn`, and dropped otherwise.
   */
  setAlpha(alpha: number, backgroundAlpha: number, textOn: boolean, onTextReady: () => void): void {
    this.group.visible               = Math.max(alpha, backgroundAlpha) > 0.01
    this.background.material.opacity = this.background.base * backgroundAlpha
    for (const { material, base } of this.fading) material.opacity = base * alpha
    const wanted = textOn && alpha > 0.01
    if (wanted && !this.text) {
      const text       = makeText(this.richText())
      text.position.z  = 0.04
      text.renderOrder = 2
      this.group.add(text)
      text.sync(onTextReady)
      this.text = text
    } else if (!wanted && this.text) {
      disposeText(this.text)
      this.text = null
    }
    if (this.text) this.text.fillOpacity = alpha
  }

  dispose(): void {
    if (this.text) disposeText(this.text)
    this.text = null
    this.group.traverse((object) => {
      const mesh = object as InstancedMesh
      const line = object as LineSegments
      if (line.isLineSegments) {
        line.geometry.dispose()
        ;(line.material as MeshBasicMaterial).dispose()
      } else if (mesh.isInstancedMesh) {
        ;(mesh.material as MeshBasicMaterial).dispose()
        mesh.dispose()
      }
    })
  }
}

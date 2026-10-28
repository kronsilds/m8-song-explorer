// A track's sticky header: the track title, the mute / solo buttons and the column names, one
// group on the front column and one on the wall, kept at the top of the view while the song
// scrolls under them.

import { DoubleSide, Group, type LineBasicMaterial, MathUtils, Mesh, MeshBasicMaterial } from 'three'
import type { Text } from 'troika-three-text'
import type { TrackToggle } from '../../m8/midiControl'
import { CHAR_W, FRONT_W, PANEL_U0, ROW_H, SIDE_CHARS, SIDE_U0 } from '../layout'
import type { Palette } from '../palette'
import { lineSegments, rectangles, UNIT_QUAD } from '../shapes'
import { makeText, RichText } from '../text'

/** Header extent around its column names line (group y 0): up over the title line, down under the names. */
export const HEADER_TOP  = ROW_H + 0.35
const HEADER_BOTTOM      = ROW_H + 0.4
/** Character columns of the mute and solo buttons, on the TRACK line. */
const BUTTON_COL         : Record<TrackToggle, number> = {
  mute: 9,
  solo: 11
}
const BUTTON_LABEL       : Record<TrackToggle, string> = {
  mute: 'M',
  solo: 'S'
}
const TOGGLES            : TrackToggle[] = ['mute', 'solo']
const BACKGROUND_OPACITY = 0.97

interface HeaderButton {
  box : Mesh
  text: Text
  on  : boolean | null
}

/** A material whose opacity follows the header's fade on the front or on the wall. */
interface FadingMaterial {
  material: { opacity: number }
  onWall  : boolean
  base    : number
}

export class TrackHeader {
  readonly front               = new Group()
  readonly wall                = new Group()
  /** Header y where the song starts, when nothing sticks. */
  readonly restY               : number
  /** Called when a text finished laying out (to redraw). */
  onTextReady                  : () => void = () => {}
  private readonly texts       : { text: Text; onWall: boolean }[] = []
  /** Background and bottom rule: shown once the header sticks over the rows. */
  private readonly backgrounds : FadingMaterial[] = []
  private readonly buttons     = {} as Record<TrackToggle, HeaderButton>
  /** How far the header shows its background (0 at its own place, 1 once stuck over the rows). */
  private stuck                = 0
  private frontAlpha           = 1
  private wallAlpha            = 0

  /**
   * @param restY header y at the start of the song
   * @param wallLength the wall's length: its header spans the FX columns and the panels, which slide under it
   */
  constructor(
    private readonly palette: Palette,
    track: number,
    restY: number,
    wallLength: number,
  ) {
    this.restY            = restY
    this.front.position.y = restY
    this.wall.position.y  = restY
    // Group y 0 is the top of the column names line, the same line on the front and the wall.
    const wallEnd         = Math.max(SIDE_U0 + SIDE_CHARS * CHAR_W, wallLength) + 0.35
    this.addBackground(this.front, false, -0.3, HEADER_TOP, FRONT_W + 0.3)
    this.addBackground(this.wall, true, SIDE_U0 - 0.35, 0.35, wallEnd)
    this.addText(
      new RichText()
        .add(`TRACK ${track + 1}`, palette.title)
        .newLine()
        .add('CH PH NTE IN', palette.empty),
      this.front,
      0,
      ROW_H,
      false,
    )
    this.addText(new RichText().add('VL IN FX1   FX2   FX3', palette.empty), this.wall, SIDE_U0, 0, true)
    this.addText(new RichText().add('INSTRUMENTS · TABLES', palette.empty), this.wall, PANEL_U0, 0, true)
    for (const kind of TOGGLES) this.addButton(kind)
    this.setTrackModes(false, false)
  }

  /** A background from `left` to `right` reaching `top` above the names line, and a rule along its bottom edge. */
  private addBackground(group: Group, onWall: boolean, left: number, top: number, right: number): void {
    const background       = rectangles([{
      x    : left,
      y    : top,
      w    : right - left,
      h    : top + HEADER_BOTTOM,
      z    : 0.05,
      color: this.palette.background
    }], 0)
    background.renderOrder = 4
    const rule             = lineSegments([left, -HEADER_BOTTOM, 0.055, right, -HEADER_BOTTOM, 0.055], this.palette.bracket, 0)
    rule.renderOrder       = 5
    group.add(background, rule)
    this.backgrounds.push({
      material: background.material as MeshBasicMaterial,
      onWall,
      base    : BACKGROUND_OPACITY
    }, {
      material: rule.material as LineBasicMaterial,
      onWall,
      base    : 1
    })
  }

  private addText(rich: RichText, parent: Group, x: number, y: number, onWall: boolean): void {
    const text = makeText(rich)
    text.position.set(x, y, 0.06)
    text.renderOrder = 5
    parent.add(text)
    text.sync(() => this.onTextReady())
    this.texts.push({ text, onWall })
  }

  private addButton(kind: TrackToggle): void {
    const col = BUTTON_COL[kind]
    const box = new Mesh(UNIT_QUAD, new MeshBasicMaterial({
      transparent: true,
      depthWrite : false,
      side       : DoubleSide
    }))
    box.position.set((col - 0.3) * CHAR_W, ROW_H + 0.02, 0.065)
    box.scale.set(1.6 * CHAR_W, ROW_H - 0.06, 1)
    box.renderOrder = 5
    const text      = makeText(new RichText().add(BUTTON_LABEL[kind], this.palette.label))
    text.position.set(col * CHAR_W, ROW_H, 0.07)
    text.renderOrder = 6
    this.front.add(box, text)
    this.buttons[kind] = {
      box,
      text,
      on: null
    }
  }

  /** Top of the column names line, where it is drawn now. */
  get y(): number {
    return this.front.position.y
  }

  /** Height of its bottom edge (the rule under the column names): rows above it are under the header. */
  get bottom(): number {
    return this.y - HEADER_BOTTOM
  }

  /**
   * Moves the header (front and wall together) to `y`, never above where the song starts.
   * Below its own place it covers the rows scrolling under it. Returns true when it moved.
   */
  moveTo(y: number): boolean {
    const clamped = Math.min(this.restY, y)
    if (Math.abs(clamped - this.front.position.y) < 1e-4) return false
    this.front.position.y = clamped
    this.wall.position.y  = clamped
    this.stuck            = MathUtils.clamp((this.restY - clamped) / ROW_H, 0, 1)
    this.applyOpacity()
    return true
  }

  setFade(frontAlpha: number, wallAlpha: number): void {
    this.frontAlpha = frontAlpha
    this.wallAlpha  = wallAlpha
    this.applyOpacity()
  }

  private applyOpacity(): void {
    const alphaOf = (onWall: boolean) => (onWall ? this.wallAlpha : this.frontAlpha)
    for (const { text, onWall } of this.texts) text.fillOpacity = alphaOf(onWall)
    for (const { material, onWall, base } of this.backgrounds) material.opacity = base * this.stuck * alphaOf(onWall)
    for (const kind of TOGGLES) {
      const button = this.buttons[kind]
      if (!button) continue
      ;(button.box.material as MeshBasicMaterial).opacity = (button.on ? 0.95 : 0.6) * this.frontAlpha
      button.text.fillOpacity                            = this.frontAlpha
    }
  }

  /** Lights the mute and solo buttons. */
  setTrackModes(muted: boolean, soloed: boolean): void {
    const { palette } = this
    const states      : Record<TrackToggle, boolean> = {
      mute: muted,
      solo: soloed
    }
    for (const kind of TOGGLES) {
      const button = this.buttons[kind]
      const on     = states[kind]
      if (button.on === on) continue
      button.on      = on
      const litColor = kind === 'mute' ? palette.tableLink : palette.link
      ;(button.box.material as MeshBasicMaterial).color.set(on ? litColor : palette.panelHeader)
      button.text.colorRanges = new RichText().add(BUTTON_LABEL[kind], on ? palette.background : palette.label).colorRanges
      button.text.sync(() => this.onTextReady())
    }
    this.applyOpacity()
  }

  /** The button at a point of the front column (front coordinates), if any. */
  buttonAt(x: number, y: number): TrackToggle | null {
    const top = this.y + ROW_H + 0.1
    if (y > top || y < top - ROW_H - 0.1) return null
    return TOGGLES.find((kind) => x >= (BUTTON_COL[kind] - 0.4) * CHAR_W && x <= (BUTTON_COL[kind] + 1.4) * CHAR_W) ?? null
  }

  /** True when height y (front or wall coordinates) is under the header. */
  covers(y: number): boolean {
    return y <= this.y + HEADER_TOP && y >= this.y - HEADER_BOTTOM
  }

  dispose(): void {
    for (const { text } of this.texts) text.dispose()
    for (const { box, text } of Object.values(this.buttons)) {
      ;(box.material as MeshBasicMaterial).dispose()
      text.dispose()
    }
  }
}

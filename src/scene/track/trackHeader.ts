// A track's sticky header: the track title with its mute / solo buttons, the fold buttons (FX,
// instruments and tables, more panel columns) and the column names, one group on the front column
// and one on the wall, kept at the top of the view while the song scrolls under them.

import { DoubleSide, Group, type LineBasicMaterial, MathUtils, Mesh, MeshBasicMaterial, type Object3D } from 'three'
import type { Text } from 'troika-three-text'
import type { TrackToggle } from '../../model/live'
import type { Palette } from '../../model/palette'
import { CHAR_W, DEFAULT_PANEL_COLS, FRONT_W, PANEL_U0, ROW_H, SIDE_END, SIDE_U0 } from '../layout'
import { lineSegments, rectangles, UNIT_QUAD } from '../shapes'
import { makeText, RichText } from '../text'

/** Header extent around its column names line (group y 0): up over the fold buttons and the title line above them, down under the names. */
export const HEADER_TOP    = ROW_H * 2 + 0.35
/** How far the header reaches under its column names line: rows above that are under it. */
export const HEADER_BOTTOM = ROW_H + 0.4
const BACKGROUND_OPACITY   = 0.97

/** The two parts of a track's wall that fold apart: the step details (VL, IN, FX), and the instrument and table panels. */
export type FoldSection = 'fx' | 'panels'
/** `cols` adds a column of panels to the wall (`+`), or takes the extra ones away (`-`) once it has the most it wants. */
export type HeaderButtonKind = TrackToggle | FoldSection | 'cols'
/** A button's light: off, on, or (a fold button) its part unfolded by a navigation, which folds it again when it leaves the track. */
export type ButtonState = 'off' | 'auto' | 'on'

/** Where a part of the header is: the front column, the step details of the wall, or its panels. */
type Part = 'front' | 'side' | 'panels'

interface ButtonSpec {
  /** The header line it is on: 0 the column names, 1 the fold buttons, 2 the title. */
  line : number
  /** Where its box starts and ends (character columns); its label is centred in it. */
  from : number
  to   : number
  label: string
}

/** Room around a one character label in its box, and between two boxes (character columns). */
const BUTTON_PAD   = 0.3
const BUTTON_GAP   = 0.4
/**
 * The fold buttons share the column's width evenly, from the left of the track name to the right
 * of its last character; M and S share the last slot above `+`, so the two lines line up.
 */
const FOLD_LEFT    = -BUTTON_PAD
const FOLD_RIGHT   = 12 + BUTTON_PAD
const FOLD_WIDTH   = (FOLD_RIGHT - FOLD_LEFT - 2 * BUTTON_GAP) / 3
const foldSlot     = (slot: number): Pick<ButtonSpec, 'from' | 'to'> => {
  const from = FOLD_LEFT + slot * (FOLD_WIDTH + BUTTON_GAP)
  return {
    from,
    to: from + FOLD_WIDTH
  }
}
/** Half of the last fold slot: M on its left, S on its right. */
const TOGGLE_WIDTH = (FOLD_WIDTH - BUTTON_GAP) / 2
const LAST_SLOT    = foldSlot(2)

const BUTTONS      : Record<HeaderButtonKind, ButtonSpec> = {
  mute  : {
    line : 2,
    from : LAST_SLOT.from,
    to   : LAST_SLOT.from + TOGGLE_WIDTH,
    label: 'M'
  },
  solo  : {
    line : 2,
    from : LAST_SLOT.to - TOGGLE_WIDTH,
    to   : LAST_SLOT.to,
    label: 'S'
  },
  fx    : {
    line : 1,
    ...foldSlot(0),
    label: 'FX'
  },
  panels: {
    line : 1,
    ...foldSlot(1),
    label: 'INS'
  },
  cols  : {
    line : 1,
    ...foldSlot(2),
    label: '+'
  }
}
/** The character column a label starts at to be centred in its button. */
const labelCol     = (spec: ButtonSpec, label: string): number => (spec.from + spec.to - label.length) / 2
const BUTTON_KINDS = Object.keys(BUTTONS) as HeaderButtonKind[]

interface HeaderButton {
  box  : Mesh
  text : Text
  state: ButtonState | null
}

/** A material whose opacity follows the header's fade on the front or on a part of the wall. */
interface FadingMaterial {
  material: { opacity: number }
  part    : Part
  base    : number
}

export class TrackHeader {
  readonly front                    = new Group()
  readonly wall                     = new Group()
  /** Header y where the song starts, when nothing sticks. */
  readonly restY                    : number
  /** Called when a text finished laying out (to redraw). */
  onTextReady                       : () => void = () => {}
  private readonly texts            : { text: Text; part: Part }[] = []
  /** Background and bottom rule: shown once the header sticks over the rows. */
  private readonly backgrounds      : FadingMaterial[] = []
  private readonly buttons          = {} as Record<HeaderButtonKind, HeaderButton>
  /** How far the header shows its background (0 at its own place, 1 once stuck over the rows). */
  private stuck                     = 0
  private frontAlpha                = 1
  private sideAlpha                 = 0
  private panelsAlpha               = 0
  /** The background and rule of the panels part, stretched to the wall's length (setWallLength). */
  private readonly panelsBackground : Object3D[]
  /** Whether the wall wants more columns than it starts with (the `cols` button then shows), and whether it has all it wants. */
  private moreColumns               = false
  private allColumns                = false

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
    this.addBackground(this.front, 'front', -0.3, HEADER_TOP, FRONT_W + 0.3)
    this.addBackground(this.wall, 'side', SIDE_U0 - 0.35, 0.35, PANEL_U0 - 0.35)
    this.panelsBackground = this.addBackground(this.wall, 'panels', PANEL_U0 - 0.35, 0.35, PANEL_U0)
    this.setWallLength(wallLength)
    this.addText(new RichText().add(`TRACK ${track + 1}`, palette.title), this.front, 0, ROW_H * 2, 'front')
    this.addText(new RichText().add('CH PH NTE IN', palette.empty), this.front, 0, 0, 'front')
    this.addText(new RichText().add('VL IN FX1   FX2   FX3', palette.empty), this.wall, SIDE_U0, 0, 'side')
    this.addText(new RichText().add('INSTRUMENTS · TABLES', palette.empty), this.wall, PANEL_U0, 0, 'panels')
    for (const kind of BUTTON_KINDS) this.addButton(kind)
    this.setTrackModes(false, false)
    this.setFolds('off', 'off')
    this.light('cols', 'off')
  }

  /**
   * A background from `left` to `right` reaching `top` above the names line, and a rule along its
   * bottom edge. Both are one unit wide, placed and stretched along x (see setWallLength).
   */
  private addBackground(group: Group, part: Part, left: number, top: number, right: number): Object3D[] {
    const background       = rectangles([{
      x    : 0,
      y    : top,
      w    : 1,
      h    : top + HEADER_BOTTOM,
      z    : 0.05,
      color: this.palette.background
    }], 0)
    background.renderOrder = 4
    const rule             = lineSegments([0, -HEADER_BOTTOM, 0.055, 1, -HEADER_BOTTOM, 0.055], this.palette.bracket, 0)
    rule.renderOrder       = 5
    for (const object of [background, rule]) {
      object.position.x = left
      object.scale.x    = right - left
    }
    group.add(background, rule)
    this.backgrounds.push({
      material: background.material as MeshBasicMaterial,
      part,
      base    : BACKGROUND_OPACITY
    }, {
      material: rule.material as LineBasicMaterial,
      part,
      base    : 1
    })
    return [background, rule]
  }

  /** Stretches the header of the panels to a wall `length` long (it grows or shrinks with its columns). */
  setWallLength(length: number): void {
    const width = Math.max(SIDE_END, length) + 0.35 - (PANEL_U0 - 0.35)
    for (const object of this.panelsBackground) object.scale.x = width
  }

  private addText(rich: RichText, parent: Group, x: number, y: number, part: Part): void {
    const text = makeText(rich)
    text.position.set(x, y, 0.06)
    text.renderOrder = 5
    parent.add(text)
    text.sync(() => this.onTextReady())
    this.texts.push({ text, part })
  }

  private addButton(kind: HeaderButtonKind): void {
    const spec                      = BUTTONS[kind]
    const { line, from, to, label } = spec
    const box                       = new Mesh(UNIT_QUAD, new MeshBasicMaterial({
      transparent: true,
      depthWrite : false,
      side       : DoubleSide
    }))
    box.position.set(from * CHAR_W, line * ROW_H + 0.02, 0.065)
    box.scale.set((to - from) * CHAR_W, ROW_H - 0.06, 1)
    box.renderOrder = 5
    const text      = makeText(new RichText().add(label, this.palette.label))
    text.position.set(labelCol(spec, label) * CHAR_W, line * ROW_H, 0.07)
    text.renderOrder = 6
    this.front.add(box, text)
    this.buttons[kind] = {
      box,
      text,
      state: null
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

  setFade(frontAlpha: number, sideAlpha: number, panelsAlpha: number): void {
    this.frontAlpha  = frontAlpha
    this.sideAlpha   = sideAlpha
    this.panelsAlpha = panelsAlpha
    this.applyOpacity()
  }

  private applyOpacity(): void {
    const alphaOf = (part: Part) => (part === 'front' ? this.frontAlpha : part === 'side' ? this.sideAlpha : this.panelsAlpha)
    for (const { text, part } of this.texts) text.fillOpacity = alphaOf(part)
    for (const { material, part, base } of this.backgrounds) material.opacity = base * this.stuck * alphaOf(part)
    for (const kind of BUTTON_KINDS) {
      const button = this.buttons[kind]
      if (!button) continue
      const shown                                        = kind === 'cols' ? (this.moreColumns ? this.panelsAlpha : 0) : 1
      ;(button.box.material as MeshBasicMaterial).opacity = (button.state === 'on' ? 0.95 : 0.6) * this.frontAlpha * shown
      button.text.fillOpacity                            = this.frontAlpha * shown
    }
  }

  /** Shows the `cols` button when the wall wants more columns than it starts with: `+` while it has fewer than it wants, else `-`. */
  setColumns(wanted: number, cols: number): void {
    this.moreColumns = wanted > DEFAULT_PANEL_COLS
    this.allColumns  = cols >= wanted
    const label      = this.allColumns ? '-' : '+'
    const button     = this.buttons.cols
    if (button.text.text !== label) {
      button.text.text       = label
      button.text.position.x = labelCol(BUTTONS.cols, label) * CHAR_W
      button.text.sync(() => this.onTextReady())
    }
    this.applyOpacity()
  }

  /** Lights the mute and solo buttons. */
  setTrackModes(muted: boolean, soloed: boolean): void {
    this.light('mute', muted ? 'on' : 'off')
    this.light('solo', soloed ? 'on' : 'off')
    this.applyOpacity()
  }

  /** Lights the fold buttons: on while the button keeps its part unfolded, only the label while a navigation unfolded it (auto). */
  setFolds(fx: ButtonState, panels: ButtonState): void {
    this.light('fx', fx)
    this.light('panels', panels)
    this.applyOpacity()
  }

  private light(kind: HeaderButtonKind, state: ButtonState): void {
    const { palette } = this
    const button      = this.buttons[kind]
    if (button.state === state) return
    button.state     = state
    const litColor   = kind === 'mute' || kind === 'panels' ? palette.tableLink : palette.link
    const labelColor = state === 'on' ? palette.background : state === 'auto' ? litColor : palette.label
    ;(button.box.material as MeshBasicMaterial).color.set(state === 'on' ? litColor : palette.panelHeader)
    button.text.colorRanges = new RichText().add(button.text.text, labelColor).colorRanges
    button.text.sync(() => this.onTextReady())
  }

  /** The button at a point of the front column (front coordinates), if any. */
  buttonAt(x: number, y: number): HeaderButtonKind | null {
    const found = BUTTON_KINDS.find((kind) => {
      if (kind === 'cols' && (!this.moreColumns || this.panelsAlpha < 0.5)) return false
      const { line, from, to } = BUTTONS[kind]
      const top                = this.y + line * ROW_H + 0.1
      return y <= top && y >= top - ROW_H - 0.1 && x >= (from - 0.1) * CHAR_W && x <= (to + 0.1) * CHAR_W
    })
    return found ?? null
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

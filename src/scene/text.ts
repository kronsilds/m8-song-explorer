// Monospace SDF text (troika) and a pool that only keeps the blocks near the camera alive:
// a long song is thousands of 16-line blocks, but a screen shows a few dozen.

import fontUrl from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff?url'
import { Color, LinearSRGBColorSpace, type Object3D } from 'three'
import { configureTextBuilder, preloadFont, Text } from 'troika-three-text'
import { FONT, ROW_H } from './layout'

configureTextBuilder({ sdfGlyphSize: 64 })

/** Below this opacity a text block is not worth keeping. */
const INVISIBLE_ALPHA = 0.01
/** New text blocks laid out per frame at most. */
const DEFAULT_BUDGET  = 24

/** Loads the font and the glyphs the tracker uses before the first frame. */
export const preloadText = (): Promise<void> =>
  new Promise((resolve) => preloadFont({
    font      : fontUrl,
    characters: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-#:·.>|/+Ø '
  }, () => resolve()))

/** A string with a colour per run of characters (a builder: add() and newLine() chain). */
export class RichText {
  text              = ''
  /** Colour from each character index on, as troika's colorRanges want them. */
  colorRanges       : Record<number, number> = {}
  private lastColor : string | null = null

  add(text: string, color: string): this {
    if (color !== this.lastColor) {
      // Run colours go to the shader as raw vertex data: hand them over linear, as three's
      // own colours are, or the output conversion brightens every grey.
      this.colorRanges[this.text.length] = new Color(color).getHex(LinearSRGBColorSpace)
      this.lastColor                     = color
    }
    this.text += text
    return this
  }

  newLine(): this {
    this.text += '\n'
    return this
  }
}

export function makeText(rich: RichText, scale = 1): Text {
  const text       = new Text()
  text.font        = fontUrl
  text.fontSize    = FONT * scale
  text.lineHeight  = ROW_H / (FONT * scale)
  text.anchorX     = 'left'
  text.anchorY     = 'top'
  text.whiteSpace  = 'nowrap'
  text.text        = rich.text
  text.colorRanges = rich.colorRanges
  text.color       = 0xffffff
  return text
}

export interface TextBlock {
  key   : string
  parent: Object3D
  x     : number
  /** Top of the block. */
  y     : number
  z?    : number
  /** Height downward from y, for the visibility test. */
  height: number
  /** Which fade the block follows: the front, a track's wall, or always shown. */
  layer : 'front' | 'wall' | 'static'
  track : number
  scale?: number
  build : () => RichText
}

interface LiveBlock {
  block: TextBlock
  text : Text
  alpha: number
}

/** An object pool of text meshes: blocks get a mesh while near the view, and lose it after. */
export class TextPool {
  private blocks        : TextBlock[] = []
  private readonly live = new Map<string, LiveBlock>()
  /** Called when a text finished laying out (to redraw). */
  onReady               : () => void = () => {}

  setBlocks(blocks: TextBlock[]): void {
    this.clear()
    this.blocks = blocks
  }

  get size(): number {
    return this.live.size
  }

  clear(): void {
    for (const { text } of this.live.values()) disposeText(text)
    this.live.clear()
  }

  /**
   * Keeps the blocks overlapping [yBottom, yTop] whose layer is visible; creates at most
   * `budget` new ones per call, nearest to `yCenter` first. Returns true when anything changed
   * or blocks are still waiting.
   */
  update(yTop: number, yBottom: number, yCenter: number, alphaOf: (block: TextBlock) => number, budget = DEFAULT_BUDGET): boolean {
    let changed  = this.refreshLive(yTop, yBottom, alphaOf)
    const wanted : { block: TextBlock; alpha: number; distance: number }[] = []
    for (const block of this.blocks) {
      if (this.live.has(block.key)) continue
      if (block.y - block.height >= yTop || block.y <= yBottom) continue
      const alpha = alphaOf(block)
      if (alpha <= INVISIBLE_ALPHA) continue
      wanted.push({
        block,
        alpha,
        distance: Math.abs(block.y - block.height / 2 - yCenter)
      })
    }
    wanted.sort((a, b) => a.distance - b.distance)
    for (const { block, alpha } of wanted.slice(0, budget)) {
      const text = makeText(block.build(), block.scale)
      text.position.set(block.x, block.y, block.z ?? 0.01)
      text.fillOpacity = alpha
      text.renderOrder = 2
      block.parent.add(text)
      text.sync(() => this.onReady())
      this.live.set(block.key, { block, text, alpha })
      changed = true
    }
    return changed || wanted.length > budget
  }

  /** Drops the live blocks that left the view (with a margin) or faded out; fades the others. */
  private refreshLive(yTop: number, yBottom: number, alphaOf: (block: TextBlock) => number): boolean {
    let changed  = false
    const margin = (yTop - yBottom) * 0.25
    for (const [key, entry] of this.live) {
      const { block } = entry
      const alpha     = alphaOf(block)
      const inRange   = block.y - block.height < yTop + margin && block.y > yBottom - margin
      if (!inRange || alpha <= INVISIBLE_ALPHA) {
        disposeText(entry.text)
        this.live.delete(key)
        changed = true
      } else if (Math.abs(alpha - entry.alpha) > 0.005) {
        entry.alpha            = alpha
        entry.text.fillOpacity = alpha
        changed                = true
      }
    }
    return changed
  }
}

export function disposeText(text: Text): void {
  text.parent?.remove(text)
  text.dispose()
}

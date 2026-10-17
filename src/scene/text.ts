// Monospace SDF text (troika) and a pool that only keeps the blocks near the camera alive:
// a long song is thousands of 16-line blocks, but a screen shows a few dozen.

import fontUrl from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff?url'
import { Color, LinearSRGBColorSpace, type Object3D } from 'three'
import { configureTextBuilder, preloadFont, Text } from 'troika-three-text'
import { FONT, ROW_H } from './layout'

configureTextBuilder({ sdfGlyphSize: 64 })

export const FONT_URL = fontUrl

/** Loads the font and the glyphs the tracker uses before the first frame. */
export const preloadText = (): Promise<void> =>
  new Promise((resolve) =>
    preloadFont({ font: fontUrl, characters: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-#:·.>|/ ' }, () => resolve()),
  )

/** A string with a colour per run of characters. */
export class Rich {
  text = ''
  ranges: Record<number, number> = {}
  private last: string | null = null

  add(s: string, color: string): this {
    if (color !== this.last) {
      // Run colours go to the shader as raw vertex data: hand them over linear, as three's
      // own colours are, or the output conversion brightens every grey.
      this.ranges[this.text.length] = new Color(color).getHex(LinearSRGBColorSpace)
      this.last = color
    }
    this.text += s
    return this
  }

  nl(): this {
    this.text += '\n'
    return this
  }
}

export function makeText(rich: Rich, scale = 1): Text {
  const t = new Text()
  t.font = fontUrl
  t.fontSize = FONT * scale
  t.lineHeight = ROW_H / (FONT * scale)
  t.anchorX = 'left'
  t.anchorY = 'top'
  t.whiteSpace = 'nowrap'
  t.text = rich.text
  t.colorRanges = rich.ranges
  t.color = 0xffffff
  return t
}

export interface TextBlock {
  key: string
  parent: Object3D
  x: number
  /** Top of the block. */
  y: number
  z?: number
  /** Height downward from y, for the visibility test. */
  height: number
  /** Which fade the block follows: the front, a track's wall, or always shown. */
  layer: 'front' | 'wall' | 'static'
  track: number
  scale?: number
  build: () => Rich
}

interface Live {
  block: TextBlock
  text: Text
  alpha: number
}

export class TextPool {
  private blocks: TextBlock[] = []
  private live = new Map<string, Live>()
  /** Called when a text finished laying out (to redraw). */
  onReady: () => void = () => {}

  setBlocks(blocks: TextBlock[]): void {
    this.clear()
    this.blocks = blocks
  }

  get size(): number {
    return this.live.size
  }

  clear(): void {
    for (const { text } of this.live.values()) {
      text.parent?.remove(text)
      text.dispose()
    }
    this.live.clear()
  }

  /**
   * Keeps the blocks overlapping [yBottom, yTop] whose layer is visible; creates at most
   * `budget` new ones per call, nearest to `yCenter` first.
   */
  update(yTop: number, yBottom: number, yCenter: number, alphaOf: (block: TextBlock) => number, budget = 24): boolean {
    let changed = false
    const margin = (yTop - yBottom) * 0.25
    for (const [key, entry] of this.live) {
      const { block } = entry
      const alpha = alphaOf(block)
      const inRange = block.y - block.height < yTop + margin && block.y > yBottom - margin
      if (!inRange || alpha <= 0.01) {
        entry.text.parent?.remove(entry.text)
        entry.text.dispose()
        this.live.delete(key)
        changed = true
      } else if (Math.abs(alpha - entry.alpha) > 0.005) {
        entry.alpha = alpha
        entry.text.fillOpacity = alpha
        changed = true
      }
    }
    const wanted: { block: TextBlock; alpha: number; dist: number }[] = []
    for (const block of this.blocks) {
      if (this.live.has(block.key)) continue
      if (block.y - block.height >= yTop || block.y <= yBottom) continue
      const alpha = alphaOf(block)
      if (alpha <= 0.01) continue
      wanted.push({ block, alpha, dist: Math.abs(block.y - block.height / 2 - yCenter) })
    }
    wanted.sort((a, b) => a.dist - b.dist)
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
}

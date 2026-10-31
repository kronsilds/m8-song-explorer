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
  /** A text with new content being laid out: it takes the place of `text` once ready. */
  next : Text | null
}

/** True when a text shows what `rich` holds. */
export function showsRich(text: Text, rich: RichText): boolean {
  if (text.text !== rich.text) return false
  const shown  = (text.colorRanges ?? {}) as Record<number, number>
  const wanted = Object.keys(rich.colorRanges)
  return wanted.length === Object.keys(shown).length && wanted.every((key) => shown[Number(key)] === rich.colorRanges[Number(key)])
}

/** An object pool of text meshes: blocks get a mesh while near the view, and lose it after. */
export class TextPool {
  private blocks        : TextBlock[] = []
  private readonly live = new Map<string, LiveBlock>()
  /** Called when a text finished laying out (to redraw). */
  onReady               : () => void = () => {}

  /**
   * Takes a new set of blocks. With `keepLive` (the same song, redrawn after an edit), a live text
   * whose block is still there moves to it as it is when it shows the same, and is laid out again
   * otherwise, showing until the new one is ready: nothing blinks. A block passed again as the same
   * object is taken to show the same.
   */
  setBlocks(blocks: TextBlock[], keepLive = false): void {
    if (!keepLive) this.clear()
    else {
      const byKey = new Map(blocks.map((block) => [block.key, block]))
      for (const [key, entry] of this.live) {
        const block = byKey.get(key)
        // The same block (its view was kept): the same text.
        if (block === entry.block) continue
        if (!block || (block.scale ?? 1) !== (entry.block.scale ?? 1)) {
          this.drop(key, entry)
          continue
        }
        entry.block = block
        place(entry.text, block)
        if (entry.next) place(entry.next, block)
        this.renew(entry)
      }
    }
    this.blocks = blocks
  }

  /** Lays out again the live blocks `which` picks whose content changed (see setBlocks); true when any did. */
  refresh(which: (block: TextBlock) => boolean): boolean {
    let changed = false
    for (const entry of this.live.values()) if (which(entry.block) && this.renew(entry)) changed = true
    return changed
  }

  /** Starts laying out a block's text again when its content changed; the shown one stays until it is ready. */
  private renew(entry: LiveBlock): boolean {
    const rich = entry.block.build()
    if (entry.next && showsRich(entry.next, rich)) return true
    if (entry.next) disposeText(entry.next)
    entry.next = null
    if (showsRich(entry.text, rich)) return false
    const text   = makeText(rich, entry.block.scale)
    place(text, entry.block)
    text.fillOpacity = entry.alpha
    text.renderOrder = entry.text.renderOrder
    text.visible     = false
    entry.next       = text
    text.sync(() => {
      if (entry.next !== text) return
      disposeText(entry.text)
      text.visible = true
      entry.text   = text
      entry.next   = null
      this.onReady()
    })
    return true
  }

  private drop(key: string, entry: LiveBlock): void {
    disposeText(entry.text)
    if (entry.next) disposeText(entry.next)
    this.live.delete(key)
  }

  get size(): number {
    return this.live.size
  }

  clear(): void {
    for (const { text, next } of this.live.values()) {
      disposeText(text)
      if (next) disposeText(next)
    }
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
      place(text, block)
      text.fillOpacity = alpha
      text.renderOrder = 2
      text.sync(() => this.onReady())
      this.live.set(block.key, {
        block,
        text,
        alpha,
        next: null
      })
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
        this.drop(key, entry)
        changed = true
      } else if (Math.abs(alpha - entry.alpha) > 0.005) {
        entry.alpha            = alpha
        entry.text.fillOpacity = alpha
        if (entry.next) entry.next.fillOpacity = alpha
        changed                = true
      }
    }
    return changed
  }
}

/** Puts a text where its block goes, under the block's parent. */
function place(text: Text, block: TextBlock): void {
  block.parent.add(text)
  text.position.set(block.x, block.y, block.z ?? 0.01)
}

export function disposeText(text: Text): void {
  text.parent?.remove(text)
  text.dispose()
}

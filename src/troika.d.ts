// troika-three-text ships loose class types; this declares the part the app uses.
declare module 'troika-three-text' {
  import type { Material, Mesh } from 'three'

  export class Text extends Mesh {
    text: string
    font: string | null
    fontSize: number
    anchorX: number | 'left' | 'center' | 'right' | `${number}%`
    anchorY: number | 'top' | 'top-baseline' | 'top-cap' | 'middle' | 'bottom-baseline' | 'bottom' | `${number}%`
    lineHeight: number | 'normal'
    letterSpacing: number
    whiteSpace: 'normal' | 'nowrap'
    color: number | string
    colorRanges: Record<number, number | string> | null
    fillOpacity: number
    outlineWidth: number | string
    outlineColor: number | string
    outlineOpacity: number
    sdfGlyphSize: number | null
    depthOffset: number
    material: Material
    sync(callback?: () => void): void
    dispose(): void
  }

  export function preloadFont(options: { font: string; characters?: string | string[] }, callback: () => void): void
  export function configureTextBuilder(config: { sdfGlyphSize?: number; useWorker?: boolean }): void
}

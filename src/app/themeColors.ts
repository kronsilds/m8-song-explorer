// The scene palette from the device theme: the exact theme (read from the Theme View) under
// the colours any screen shows now, plus the column colours learnt while exploring.

import type { M8Theme } from '@yam8d/m8-sdk'
import type { SongModel } from '../model/song'
import { makePalette, type Palette, type ThemeColors } from '../scene/palette'

export class ThemeColorsSource {
  /** Read from the Theme View. */
  exactTheme         : M8Theme | null
  /** Seen on the current screen (background, titles, cursor). */
  private observed   : Partial<ThemeColors> = {}
  /** What the current palette was made from, to skip rebuilding it for the same colours. */
  private paletteKey = ''
  palette            : Palette

  constructor(exactTheme: M8Theme | null, model: SongModel) {
    this.exactTheme = exactTheme
    this.palette    = makePalette(exactTheme?.colors ?? null, model.observedColors)
  }

  /** Records the colours a screen shows; true when they differ from the last ones. */
  observe(colors: Partial<ThemeColors>): boolean {
    if (JSON.stringify(colors) === JSON.stringify(this.observed)) return false
    this.observed = colors
    return true
  }

  /** A new palette when the colours changed since the last one, else null. */
  refresh(model: SongModel): Palette | null {
    const roles    = { ...(this.exactTheme?.colors ?? {}), ...this.observed }
    // Column colours learnt while exploring belong to the theme of that moment: once the
    // device shows another background, they are stale and the theme roles take over.
    const learntOn = model.observedColors.song?.background?.filled
    const columns  = learntOn && roles.background && learntOn !== roles.background ? {} : model.observedColors
    const key      = JSON.stringify([roles, columns])
    if (key === this.paletteKey) return null
    this.paletteKey = key
    this.palette    = makePalette(roles, columns)
    return this.palette
  }
}

// The song shown: its model and what is worked out from it (a SongContext, built again for each
// version of the model), drawn by the 3D view in the theme's colours and summed up in the HUD.

import { lastSongRow, type SongModel, usedItems } from '../model/song'
import { buildSongContext, type SongContext } from '../model/songContext'
import type { World } from '../scene/world'
import type { Hud } from '../ui/hud'
import type { ThemeColorsSource } from './themeColors'

export class ShownSong {
  private current : SongContext

  /** Shows `model` in the 3D view at once. */
  constructor(
    model: SongModel,
    private readonly world: World,
    private readonly hud: Hud,
    private readonly theme: ThemeColorsSource,
  ) {
    this.current = buildSongContext(model)
    world.setSong(this.current)
  }

  get model(): SongModel {
    return this.current.model
  }

  get context(): SongContext {
    return this.current
  }

  /** Shows another song model (or the same one read again). */
  show(model: SongModel, keepView: boolean): void {
    this.current = buildSongContext(model)
    this.world.setSong(this.current, keepView)
    this.refreshPalette()
    this.updateSummary()
  }

  /** The model changed in place (edits made on the M8): what is worked out from it is worked out again, and the scene follows. */
  update(): void {
    this.current = buildSongContext(this.model)
    this.world.updateSong(this.current)
  }

  /** The theme's colours for this song, in the HUD and the 3D view (when they changed). */
  refreshPalette(): void {
    const palette = this.theme.refresh(this.model)
    if (!palette) return
    this.hud.applyPalette(palette)
    this.world.setPalette(palette)
  }

  /** The HUD's one-line summary of the song, and its first warning. */
  updateSummary(): void {
    const { model } = this
    const source    =
      model.source === 'demo' ? 'demo song' : model.source === 'file' ? 'from file' : `read ${new Date(model.capturedAt).toLocaleString()}`
    const parts     = [
      `${model.name ?? 'UNTITLED'}${model.tempo ? ` · ${model.tempo} BPM` : ''}${model.midiSync?.syncOut ? ` · sync ${model.midiSync.syncOut}` : ''}`,
      `${lastSongRow(model) + 1} rows`,
      `${Object.keys(model.chains).length} chains`,
      `${Object.keys(model.phrases).length} phrases`,
      `${usedItems(model).instruments.length} instruments`,
      source,
    ]
    this.hud.setSummary(parts.join(' · '))
    if (model.warnings.length) this.hud.notify(`${model.warnings.length} warning(s): ${model.warnings[0]}`, 'warn', 7000, false)
  }
}

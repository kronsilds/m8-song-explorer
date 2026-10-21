// Song JSON export and import through the browser's download and file picker, so a song can
// be looked at without the M8.

import type { SongModel } from '../model/song'
import { isSongModel } from '../model/storage'

/** Saves the song as 'm8-<name>-<date>.json'. */
export function downloadSong(model: SongModel): void {
  const blob    = new Blob([JSON.stringify(model, null, 1)], { type: 'application/json' })
  const link    = document.createElement('a')
  const name    = (model.name ?? 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  link.href     = URL.createObjectURL(blob)
  link.download = `m8-${name}-${new Date(model.capturedAt).toISOString().slice(0, 10)}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}

/** Asks for a song JSON file; null when none is picked or it is not a song exported by this app. */
export function pickSongFile(): Promise<SongModel | null> {
  return new Promise((resolve) => {
    const input  = document.createElement('input')
    input.type   = 'file'
    input.accept = 'application/json,.json'
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      try {
        const value = JSON.parse(await file.text())
        resolve(isSongModel(value) ? {
          ...value,
          source: 'file'
        } : null)
      } catch {
        resolve(null)
      }
    })
    input.click()
  })
}

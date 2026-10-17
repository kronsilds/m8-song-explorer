// The last explored song and the last theme read, kept in the browser between sessions,
// and JSON export/import so a song can be looked at without the M8.

import type { M8Theme } from '@yam8d/m8-sdk'
import type { SongModel } from './song'

const MODEL_KEY = 'm8-song-explorer:model'
const THEME_KEY = 'm8-song-explorer:theme'

const read = <T>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

const write = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: the song stays in memory only.
  }
}

export function isSongModel(value: unknown): value is SongModel {
  const m = value as SongModel
  return !!m && m.version === 1 && Array.isArray(m.song) && typeof m.chains === 'object' && typeof m.phrases === 'object'
}

export const loadModel = (): SongModel | null => {
  const m = read<SongModel>(MODEL_KEY)
  return isSongModel(m) ? m : null
}
export const saveModel = (model: SongModel): void => write(MODEL_KEY, model)

export const loadTheme = (): M8Theme | null => read<M8Theme>(THEME_KEY)
export const saveTheme = (theme: M8Theme): void => write(THEME_KEY, theme)

export function exportModel(model: SongModel): void {
  const blob = new Blob([JSON.stringify(model, null, 1)], { type: 'application/json' })
  const a = document.createElement('a')
  const name = (model.name ?? 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  a.href = URL.createObjectURL(blob)
  a.download = `m8-${name}-${new Date(model.capturedAt).toISOString().slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export function importModel(): Promise<SongModel | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      try {
        const value = JSON.parse(await file.text())
        resolve(isSongModel(value) ? { ...value, source: 'file' } : null)
      } catch {
        resolve(null)
      }
    })
    input.click()
  })
}

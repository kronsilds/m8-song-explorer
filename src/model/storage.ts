// Browser storage: the last explored song, the last theme read and small settings, kept
// between sessions. Storage may be full or blocked; then values live in memory only.

import type { M8Theme } from '@yam8d/m8-sdk'
import { debugLog } from './debugLog'
import type { SongModel } from './song'

const KEY_PREFIX = 'm8-song-explorer:'

export function readItem(name: string): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + name)
  } catch {
    return null
  }
}

export function writeItem(name: string, value: string): void {
  try {
    localStorage.setItem(KEY_PREFIX + name, value)
  } catch (error) {
    // Full or blocked: not remembered.
    debugLog.problem('storage', `${name} not saved: ${(error as Error).message}`)
  }
}

function readJson<T>(name: string): T | null {
  try {
    const raw = readItem(name)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

const writeJson = (name: string, value: unknown): void => writeItem(name, JSON.stringify(value))

export function isSongModel(value: unknown): value is SongModel {
  const model = value as SongModel
  return !!model && model.version === 1 && Array.isArray(model.song) && typeof model.chains === 'object' && typeof model.phrases === 'object'
}

export function loadModel(): SongModel | null {
  const model = readJson<SongModel>('model')
  return isSongModel(model) ? model : null
}

export const saveModel = (model: SongModel): void => writeJson('model', model)

export const loadTheme = (): M8Theme | null => readJson<M8Theme>('theme')
export const saveTheme = (theme: M8Theme): void => writeJson('theme', theme)

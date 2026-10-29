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

/** Fills the parts an older or hand-made file may lack, so the scene never meets undefined. */
export function reviveSong(value: unknown): SongModel | null {
  if (!isSongModel(value)) return null
  return {
    ...value,
    name          : typeof value.name === 'string' ? value.name : null,
    capturedAt    : typeof value.capturedAt === 'number' ? value.capturedAt : Date.now(),
    instruments   : value.instruments ?? {},
    tables        : value.tables ?? {},
    observedColors: value.observedColors ?? {},
    theme         : value.theme ?? null,
    warnings      : Array.isArray(value.warnings) ? value.warnings : []
  }
}

export function loadModel(): SongModel | null {
  return reviveSong(readJson<SongModel>('model'))
}

export const saveModel = (model: SongModel): void => writeJson('model', model)

// ---------------------------------------------------------------------------
// Library: the songs explored before, so one that comes back on the M8 is not explored again.

/** Songs kept; the oldest goes first (a song is a few hundred KB of the ~5 MB localStorage). */
const LIBRARY_MAX = 6

interface LibraryEntry {
  key       : string
  name      : string
  capturedAt: number
}

const songKey = (name: string): string => name.trim().toLowerCase()

function readLibrary(): LibraryEntry[] {
  const entries = readJson<LibraryEntry[]>('library')
  return Array.isArray(entries) ? entries.filter((entry) => typeof entry?.key === 'string') : []
}

function dropFromLibrary(entry: LibraryEntry): void {
  try {
    localStorage.removeItem(`${KEY_PREFIX}song:${entry.key}`)
  } catch {
    // Blocked: nothing to free.
  }
}

/** Keeps a finished song (explored, imported or edited on the device) under its name. Unnamed and demo songs are not kept. */
export function rememberSong(model: SongModel): void {
  if (model.source === 'demo' || !model.name?.trim()) return
  const key     = songKey(model.name)
  const others  = readLibrary().filter((entry) => entry.key !== key)
  const entries = [...others, {
    key,
    name      : model.name,
    capturedAt: model.capturedAt
  }]
  while (entries.length > LIBRARY_MAX) dropFromLibrary(entries.shift() as LibraryEntry)
  writeJson(`song:${key}`, model)
  writeJson('library', entries)
}

/** The kept songs, most recently kept first. */
export function rememberedSongs(): SongModel[] {
  return readLibrary()
    .reverse()
    .map((entry) => reviveSong(readJson<SongModel>(`song:${entry.key}`)))
    .filter((model): model is SongModel => model != null)
}

export const loadTheme = (): M8Theme | null => readJson<M8Theme>('theme')
export const saveTheme = (theme: M8Theme): void => writeJson('theme', theme)

// Song JSON export and import through the browser's download and file picker, so a song can
// be looked at without the M8.

import { isM8sFile, readM8sFile } from '../model/m8sFile'
import type { SongModel } from '../model/song'
import { reviveSong } from '../model/storage'

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

export type PickedSong =
  | { kind: 'song'; model: SongModel }
  | { kind: 'cancelled' }
  | { kind: 'invalid'; reason: string }

/** Reads a song exported by this app; the reason says what was wrong with the file otherwise. */
export async function readSongFile(file: File): Promise<PickedSong> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (isM8sFile(bytes)) {
    const song = readM8sFile(bytes)
    return song ? {
      kind : 'song',
      model: song
    } : {
      kind  : 'invalid',
      reason: `${file.name} is cut short or from an unsupported firmware`
    }
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return {
      kind  : 'invalid',
      reason: `${file.name} is neither a .m8s song nor a JSON file`
    }
  }
  const model = reviveSong(value)
  if (!model) {
    return {
      kind  : 'invalid',
      reason: `${file.name} is not a song exported by this app`
    }
  }
  return {
    kind : 'song',
    model: {
      ...model,
      source: 'file'
    }
  }
}

/** Asks for a song JSON file. */
export function pickSongFile(): Promise<PickedSong> {
  return new Promise((resolve) => {
    const input         = document.createElement('input')
    input.type          = 'file'
    input.accept        = 'application/json,.json,.m8s'
    input.style.display = 'none'
    // Attached while the dialog is open: some browsers drop the events of a detached input.
    document.body.append(input)
    const done = (picked: PickedSong): void => {
      input.remove()
      resolve(picked)
    }
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return done({ kind: 'cancelled' })
      void readSongFile(file).then(done)
    })
    input.addEventListener('cancel', () => done({ kind: 'cancelled' }))
    input.click()
  })
}

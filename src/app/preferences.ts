// Small settings remembered in the browser between sessions.

import { DEFAULT_CHANNEL } from '../m8/midiControl'
import { readItem, writeItem } from '../model/storage'

export interface Preference<T> {
  get(): T
  set(value: T): void
}

/** An on / off setting stored as '1' / '0'. */
function flag(name: string, defaultOn: boolean): Preference<boolean> {
  return {
    get: () => {
      const stored = readItem(name)
      return stored == null ? defaultOn : stored !== '0'
    },
    set: (on) => writeItem(name, on ? '1' : '0')
  }
}

/** The MIDI channel (1..16) of the mute / solo buttons. */
const ccMapChannel       : Preference<number> = {
  get: () => {
    const channel = Number(readItem('cc-map-channel'))
    return channel >= 1 && channel <= 16 ? channel : DEFAULT_CHANNEL
  },
  set: (channel) => writeItem('cc-map-channel', String(channel))
}

export const preferences = {
  /** Skewed, tilted camera angles. */
  dramatic   : flag('dramatic', false),
  /** Transposed phrases show the notes they play. */
  playedNotes: flag('played-notes', true),
  /** The selection panel stays open. */
  infoPinned : flag('info-pinned', false),
  ccMapChannel
}

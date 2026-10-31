// Small settings remembered in the browser between sessions.

import { DEFAULT_CHANNEL } from '../m8/midiControl'
import { readItem, writeItem } from '../model/storage'
import { DEFAULT_WALL_DEGREES, WALL_DEGREES_RANGE } from '../scene/layout'

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

/** How far a track's wall is turned from the front, in degrees. */
const wallDegrees        : Preference<number> = {
  get: () => {
    const stored  = readItem('wall-degrees')
    const degrees = stored == null ? Number.NaN : Number(stored)
    return degrees >= WALL_DEGREES_RANGE.min && degrees <= WALL_DEGREES_RANGE.max ? degrees : DEFAULT_WALL_DEGREES
  },
  set: (degrees) => writeItem('wall-degrees', String(degrees))
}

export const preferences = {
  /** Skewed, tilted camera angles. */
  dramatic   : flag('dramatic', false),
  /** How far the wall is turned from the front (the step details and panels of an unfolded track). */
  wallDegrees,
  /** Transposed phrases show the notes they play. */
  playedNotes: flag('played-notes', true),
  /** Tables show only their rows with content; an empty one only its title. */
  trimTables : flag('trim-tables', true),
  /** The selection panel stays open. */
  infoPinned : flag('info-pinned', false),
  ccMapChannel
}

// Pitch classes and notes as the M8 writes them: 'C-4', 'C#4', 'C-A' (the octave is one hex digit).

export const PITCH_NAMES          = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

export const SEMITONES_PER_OCTAVE = 12

/** Highest note the M8 plays (G-A). */
export const HIGHEST_NOTE         = 10 * SEMITONES_PER_OCTAVE + 7

/** Any semitone count folded into a pitch class 0..11 (0 = C). */
export const pitchClass           = (semitones: number): number => ((semitones % SEMITONES_PER_OCTAVE) + SEMITONES_PER_OCTAVE) % SEMITONES_PER_OCTAVE

/** 'C#' -> 1; -1 for text that is not a pitch name. */
export const pitchClassOfName     = (name: string): number => (PITCH_NAMES as readonly string[]).indexOf(name)

/** 'C-4' -> 48, 'C#A' -> 121; null for OFF, '---' or text that is not a note. */
export function noteNumber(note: string | null): number | null {
  const match = /^([A-G])([-#])([0-9A-F])$/.exec(note ?? '')
  if (!match) return null
  const [, letter, accidental, octave] = match
  const pitch                          = pitchClassOfName(accidental === '#' ? `${letter}#` : letter)
  return pitch < 0 ? null : Number.parseInt(octave, 16) * SEMITONES_PER_OCTAVE + pitch
}

/** 48 -> 'C-4', the way the M8 writes it. */
export function noteText(note: number): string {
  const name   = PITCH_NAMES[pitchClass(note)]
  const octave = Math.floor(note / SEMITONES_PER_OCTAVE)
    .toString(16)
    .toUpperCase()
  return `${name[0]}${name[1] ?? '-'}${octave}`
}

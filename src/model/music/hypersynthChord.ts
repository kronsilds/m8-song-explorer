// What a Hypersynth chord is: the six intervals of an instrument's CHORD line, the chord they spell,
// the notes they make over a played note and where that chord sits in a scale.

import type { Fact } from '../description'
import type { Instrument, SongModel } from '../song'
import { chordInScale, identifyChord, identifyChords, pitchNames, type ScaleShape } from './chords'
import { formatTranspose, type ScaleChoice, scalePitches, transposeSemitones } from './harmony'
import { HIGHEST_NOTE, noteText, PITCH_NAMES, pitchClass } from './pitch'

const CHORD_NOTES = 6
const CHORD_TEXT  = new RegExp(`^([0-9A-F]{2})>\\s*((?:[0-9A-F]{2}\\s*){${CHORD_NOTES}})$`)

export interface HypersynthChord {
  bank     : string
  /** Semitones above the played note, one per voice (a value from 80 on is negative). */
  semitones: number[]
}

/** The bank and six intervals of a CHORD value ('00> 00 04 07 0C 00 00'); null for any other text. */
export function parseChord(text: string): HypersynthChord | null {
  const match = CHORD_TEXT.exec(text)
  if (!match) return null
  return {
    bank     : match[1],
    semitones: match[2].trim().split(/\s+/).map((value) => transposeSemitones(Number.parseInt(value, 16)))
  }
}

/** The chord and SCALE setting of a HYPERSYN instrument; null for another type or when its CHORD line was not read. */
export function hypersynthSettings(instrument: Instrument | null | undefined): { chord: HypersynthChord; scale: number } | null {
  if (instrument?.type !== 'HYPERSYN') return null
  const line  = (label: string) => instrument.lines.find((text) => text.startsWith(label)) ?? ''
  const chord = parseChord(line('CHORD').slice(8).trim())
  const scale = Number.parseInt(line('SCALE').slice(8, 10), 16)
  return chord ? { chord, scale: Number.isNaN(scale) ? 0 : scale } : null
}

/** The notes (numbers as pitch.ts counts them) the chord makes over a note, voices on the same note written once, lowest first. */
export const chordOver = (note: number, chord: HypersynthChord): number[] =>
  [...new Set(chord.semitones.map((value) => note + value))].filter((value) => value >= 0 && value <= HIGHEST_NOTE).sort((a, b) => a - b)

/** 'major chord', or why there is no name. */
function spelled(notes: number[]): string {
  const found = identifyChord(notes)
  if (found) return found.quality.name
  return new Set(notes.map(pitchClass)).size === 1 ? 'one note in several octaves' : 'no common chord'
}

/** What a CHORD value is by itself, whatever note plays it. */
export function chordFacts(text: string): Fact[] {
  const chord = parseChord(text)
  if (!chord) return []
  const { semitones } = chord
  const intervals     = (voices: number[]): string => voices.map(formatTranspose).join(' ')
  return [
    ['Chord', `${spelled(semitones)} (${intervals(semitones)} semitones above the played note)`],
    ['Bank', chord.bank],
    // SHIFT cross-fades the volume between the first three voices and the last three.
    ['Voices 1–3', `${intervals(semitones.slice(0, 3))}: ${spelled(semitones.slice(0, 3))}`],
    ['Voices 4–6', `${intervals(semitones.slice(3))}: ${spelled(semitones.slice(3))}`]
  ]
}

/** The steps of the scale a Hypersynth plays in: its own SCALE setting, else the track's; null when that scale lets every note through. */
export function scaleShapeOf(model: SongModel, track: ScaleChoice, instrumentScale: number): ScaleShape | null {
  const number = instrumentScale || track.scale
  const key    = number === track.scale ? track.key : null
  const scale  = model.scales?.[number]
  const pitches = scalePitches(scale, key)
  if (!pitches) return null
  const root = key ?? scale?.key ?? 0
  return {
    root,
    steps: [...pitches].map((pitch) => pitchClass(pitch - root)).sort((a, b) => a - b)
  }
}

/** The chord a Hypersynth plays over a note (as played, after transpose): its name, its notes and its place in `scale`. */
export function chordOverNoteFacts(chord: HypersynthChord, played: number, scale: ScaleShape | null, scaleName: string): Fact[] {
  const notes = chordOver(played, chord)
  const match = identifyChords(notes)[0] ?? null
  const facts : Fact[] = [['Chord played', match ? `${match.symbol} · ${match.name}` : spelled(notes)], ['Chord notes', notes.map(noteText).join(' ')]]
  if (match && scale) {
    const where = chordInScale(match, scale)
    const key   = `${PITCH_NAMES[scale.root]} ${scaleName}`.trim()
    const out   = where.outside.length ? `, ${pitchNames(where.outside)} outside the scale` : ''
    facts.push(['Chord in scale', where.numeral ? `${where.numeral} of ${key}${out}` : `Root ${PITCH_NAMES[match.root]} is not in ${key}${out}`])
  }
  return facts
}

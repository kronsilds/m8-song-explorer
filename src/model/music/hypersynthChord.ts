// What a Hypersynth CHORD line spells: its bank, intervals, chord names and the notes over C-4.

import type { Fact } from '../description'
import { formatTranspose, transposeSemitones } from './harmony'
import { pitchClass } from './pitch'
import { arpeggioText, chordName } from './tableWalk'

const CHORD_NOTES = 6
const CHORD_TEXT  = new RegExp(`^([0-9A-F]{2})>\\s*((?:[0-9A-F]{2}\\s*){${CHORD_NOTES}})$`)

/** What the six numbers (semitones above the played note, a value from 80 on read as negative) of a Hypersynth CHORD spell. */
export function chordFacts(text: string): Fact[] {
  const match = CHORD_TEXT.exec(text)
  if (!match) return []
  const semitones = match[2].trim().split(/\s+/).map((value) => transposeSemitones(Number.parseInt(value, 16)))
  const facts     : Fact[] = [['Chord bank', match[1]], ['Intervals', semitones.map(formatTranspose).join(' ')]]
  const named     = (notes: number[]): string => {
    const classes = new Set(notes.map(pitchClass))
    return classes.size === 1 ? 'one pitch class' : (chordName(notes) ?? 'no common chord')
  }
  facts.push(['Chord', `${named(semitones)} (six notes)`])
  // SHIFT cross-fades the volume between the first three notes and the last three.
  facts.push(['Notes 1-3', `${semitones.slice(0, 3).map(formatTranspose).join(' ')}: ${named(semitones.slice(0, 3))}`])
  facts.push(['Notes 4-6', `${semitones.slice(3).map(formatTranspose).join(' ')}: ${named(semitones.slice(3))} (SHIFT fades between the two sets)`])
  const over = arpeggioText('C-4', semitones)
  if (over) facts.push(['Over C-4', over])
  return facts
}

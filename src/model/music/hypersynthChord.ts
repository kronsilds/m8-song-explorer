// What a Hypersynth chord is: the six intervals of an instrument's CHORD line, the chord they spell,
// the notes they make over a played note (rounded to the scale the instrument plays in) and where
// that chord sits in a scale.
// A Hypersynth holds 16 chord banks. Its CHORD line shows one bank; the others are known once
// "Read chord banks" has read them from the M8 (Instrument.chords). A CRD command picks a bank for
// the notes that follow. A voice a bank does not use is drawn '--' (seen on the device).
// Not checked on a device: the chord voices being rounded to the scale like the played note, and a
// CRD lasting until the next instrument number.

import type { Fact } from '../description'
import { allFxCells, fxValues, type Instrument, type PhraseStep, type SongModel } from '../song'
import { chordInScale, identifyChord, identifyChords, pitchNames, type ScaleShape } from './chords'
import { formatTranspose, quantize, type ScaleChoice, scalePitches, transposeSemitones } from './harmony'
import { HIGHEST_NOTE, noteText, PITCH_NAMES, pitchClass } from './pitch'

const CHORD_NOTES        = 6
/** Chord banks of a Hypersynth: 00 to 0F. */
export const CHORD_BANKS = 16
// The bank, '>', then six voices: a hex interval or '--'. Spaces around '>' vary ('00>', '00 >').
const CHORD_TEXT         = new RegExp(`^([0-9A-F]{2})\\s*>\\s*((?:(?:[0-9A-F]{2}|--)\\s*){${CHORD_NOTES}})$`)

export interface HypersynthChord {
  bank     : string
  /** One per voice: semitones above the played note (a value from 80 on is negative), null for a voice drawn '--'. */
  voices   : (number | null)[]
  /** The voices that sound, in voice order. */
  semitones: number[]
}

/** The bank and six voices of a CHORD value ('00> 00 04 07 0C 00 00', '01> 00 03 07 -- -- --'); null for any other text. */
export function parseChord(text: string): HypersynthChord | null {
  const match = CHORD_TEXT.exec(text.trim().toUpperCase())
  if (!match) return null
  const voices = match[2].trim().split(/\s+/).map((value) => (value === '--' ? null : transposeSemitones(Number.parseInt(value, 16))))
  return {
    bank     : match[1],
    voices,
    semitones: voices.filter((value): value is number => value != null)
  }
}

/** The CHORD value of a Hypersynth's Instrument view ('01> 00 0B 10 15 -- --'); null for another type or a line that is not one. */
function chordValueOf(instrument: Instrument | null | undefined): string | null {
  if (instrument?.type !== 'HYPERSYN') return null
  // Lines read from the device can be in lower case.
  const text = (instrument.lines.map((line) => line.toUpperCase()).find((line) => line.startsWith('CHORD')) ?? '').slice(8).trim()
  return parseChord(text) ? text : null
}

/**
 * The chord banks known of an instrument once its Instrument view was read again: the ones known
 * before, plus the bank the view showed then and the one it shows now. Stepping the bank number on
 * the M8 adds each bank this way. Undefined when none is known.
 */
export function rememberedChordBanks(known: Instrument | null | undefined, now: Instrument): string[] | undefined {
  const texts = [chordValueOf(known), chordValueOf(now)].filter((text): text is string => text != null)
  if (!texts.length) return known?.chords
  const chords = Array.from({ length: CHORD_BANKS }, (_, bank) => known?.chords?.[bank] ?? '')
  for (const text of texts) chords[Number.parseInt(text.slice(0, 2), 16)] = text
  return chords
}

/** The Hypersynths of a song that plays a CRD command somewhere (in a phrase or a table): their chord banks are worth reading. */
export function hypersynthsWithChordCommands(model: SongModel): number[] {
  for (const fx of allFxCells(model)) {
    if (fxValues(fx, 'CRD').length) return Object.values(model.instruments).filter((instrument) => instrument.type === 'HYPERSYN').map((instrument) => instrument.id)
  }
  return []
}

/** The chord and SCALE setting of a HYPERSYN instrument; null for another type or when its CHORD line was not read. */
export function hypersynthSettings(instrument: Instrument | null | undefined): { chord: HypersynthChord; scale: number } | null {
  if (instrument?.type !== 'HYPERSYN') return null
  const line  = (label: string) => instrument.lines.map((text) => text.toUpperCase()).find((text) => text.startsWith(label)) ?? ''
  const chord = parseChord(line('CHORD').slice(8).trim())
  const scale = Number.parseInt(line('SCALE').slice(8, 10), 16)
  return chord ? {
    chord,
    scale: Number.isNaN(scale) ? 0 : scale
  } : null
}

/**
 * The chord of bank `bank` of a Hypersynth: the CHORD line when it shows that bank (it follows edits
 * made on the device), else the bank as "Read chord banks" read it; null when it is not known.
 */
export function chordOfBank(instrument: Instrument | null | undefined, bank: number): HypersynthChord | null {
  const shown = hypersynthSettings(instrument)?.chord
  if (shown && Number.parseInt(shown.bank, 16) === bank) return shown
  return parseChord(instrument?.chords?.[bank] ?? '')
}

/**
 * The notes (numbers as pitch.ts counts them) the chord makes over a note, voices on the same note
 * written once, lowest first. `pitches` (the scale's pitch classes) rounds each voice up to the scale.
 */
export const chordOver = (note: number, chord: HypersynthChord, pitches: Set<number> | null = null): number[] =>
  [...new Set(chord.semitones.map((value) => quantize(note + value, pitches)))].filter((value) => value >= 0 && value <= HIGHEST_NOTE).sort((a, b) => a - b)

/** The pitch classes of a scale shape, for rounding notes to it. */
const pitchesOf = (scale: ScaleShape | null): Set<number> | null => (scale ? new Set(scale.steps.map((step) => pitchClass(scale.root + step))) : null)

/**
 * The chord bank a CRD command puts in force on a step: the last CRD at or above it, back to the
 * row that last named an instrument (which puts the instrument's own bank back). Null without one.
 */
export function chordBankAt(steps: readonly PhraseStep[] | undefined, step: number): number | null {
  for (let row = step; row >= 0; row -= 1) {
    const crd = steps?.[row]?.fx.find((fx) => fx.cmd === 'CRD' && fx.val != null)
    if (crd) return crd.val
    if (steps?.[row]?.inst != null) return null
  }
  return null
}

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
  const { semitones, voices } = chord
  const sounding              = (list: (number | null)[]): number[] => list.filter((value): value is number => value != null)
  const intervals             = (list: (number | null)[]): string => list.map((value) => (value == null ? '--' : formatTranspose(value))).join(' ')
  const half                  = (list: (number | null)[]): string => (sounding(list).length ? `${intervals(list)}: ${spelled(sounding(list))}` : 'silent')
  if (!semitones.length) return [['Chord', 'no voice sounds'], ['Bank', chord.bank]]
  return [
    ['Chord', `${spelled(semitones)} (${intervals(semitones)} semitones above the played note)`],
    ['Bank', `${chord.bank} of 00–0F; a CRD command picks another bank for the notes that follow`],
    // SHIFT cross-fades the volume between the first three voices and the last three.
    ['Voices 1–3', half(voices.slice(0, 3))],
    ['Voices 4–6', half(voices.slice(3))]
  ]
}

/** The steps of the scale a Hypersynth plays in: its own SCALE setting, else the track's; null when that scale lets every note through. */
export function scaleShapeOf(model: SongModel, track: ScaleChoice, instrumentScale: number): ScaleShape | null {
  const number  = instrumentScale || track.scale
  const key     = number === track.scale ? track.key : null
  const scale   = model.scales?.[number]
  const pitches = scalePitches(scale, key)
  if (!pitches) return null
  const root = key ?? scale?.key ?? 0
  return {
    root,
    steps: [...pitches].map((pitch) => pitchClass(pitch - root)).sort((a, b) => a - b)
  }
}

/**
 * The chord a Hypersynth plays over a note (as played, after transpose): its name, its notes and its
 * place in `scale`. `round` rounds the voices to that scale (leave it off for a guessed key).
 */
export function chordOverNoteFacts(chord: HypersynthChord, played: number, scale: ScaleShape | null, scaleName: string, round = false): Fact[] {
  const plain   = chordOver(played, chord)
  const notes   = round ? chordOver(played, chord, pitchesOf(scale)) : plain
  const rounded = notes.join() !== plain.join()
  const match   = identifyChords(notes)[0] ?? null
  const key     = scale ? `${PITCH_NAMES[scale.root]} ${scaleName}`.trim() : ''
  const facts   : Fact[] = [
    ['Chord played', match ? `${match.symbol} · ${match.name}` : spelled(notes)],
    ['Chord notes', `${notes.map(noteText).join(' ')}${rounded ? ` · rounded to ${key} from ${plain.map(noteText).join(' ')}` : ''}`]
  ]
  if (match && scale) {
    const where = chordInScale(match, scale)
    const out   = where.outside.length ? `, ${pitchNames(where.outside)} outside the scale` : ''
    facts.push(['Chord in scale', where.numeral ? `${where.numeral} of ${key}${out}` : `Root ${PITCH_NAMES[match.root]} is not in ${key}${out}`])
  }
  return facts
}

// Chord recognition: the chord a set of notes spells (root position or inverted), and where it sits
// in a scale ('ii' of C major). Notes are numbers as pitch.ts counts them (C-4 = 48); only their
// pitch classes and the lowest one (the bass) count.

import { PITCH_NAMES, pitchClass } from './pitch'

export interface ChordQuality {
  /** Pitch classes above the root, ascending, the root (0) first. */
  intervals: readonly number[]
  /** Suffix of the chord symbol: '' for major, 'm7', 'maj7'... */
  symbol   : string
  /** Words for the quality: 'minor 7th chord'. */
  name     : string
}

const quality = (intervals: number[], symbol: string, name: string): ChordQuality => ({
  intervals,
  symbol,
  name
})

/** Known chords, most usual first: that order breaks ties between readings of the same notes. */
export const CHORD_QUALITIES: readonly ChordQuality[] = [
  quality([0], '', 'octaves'),
  quality([0, 7], '5', 'fifths (power chord)'),
  quality([0, 4, 7], '', 'major chord'),
  quality([0, 3, 7], 'm', 'minor chord'),
  quality([0, 3, 6], 'dim', 'diminished chord'),
  quality([0, 4, 8], 'aug', 'augmented chord'),
  quality([0, 2, 7], 'sus2', 'sus2 chord'),
  quality([0, 5, 7], 'sus4', 'sus4 chord'),
  quality([0, 4, 7, 11], 'maj7', 'major 7th chord'),
  quality([0, 3, 7, 10], 'm7', 'minor 7th chord'),
  quality([0, 4, 7, 10], '7', 'dominant 7th chord'),
  quality([0, 3, 6, 10], 'm7b5', 'half-diminished 7th chord'),
  quality([0, 3, 6, 9], 'dim7', 'diminished 7th chord'),
  quality([0, 3, 7, 11], 'm(maj7)', 'minor-major 7th chord'),
  quality([0, 4, 8, 10], '7#5', 'dominant 7th chord with a raised 5th'),
  quality([0, 4, 8, 11], 'maj7#5', 'major 7th chord with a raised 5th'),
  quality([0, 4, 6, 10], '7b5', 'dominant 7th chord with a lowered 5th'),
  quality([0, 4, 7, 9], '6', 'major 6th chord'),
  quality([0, 3, 7, 9], 'm6', 'minor 6th chord'),
  quality([0, 2, 4, 7], 'add9', 'add9 chord'),
  quality([0, 2, 3, 7], 'madd9', 'minor add9 chord'),
  quality([0, 5, 7, 10], '7sus4', '7sus4 chord'),
  quality([0, 2, 7, 10], '7sus2', '7sus2 chord'),
  quality([0, 2, 4, 7, 11], 'maj9', 'major 9th chord'),
  quality([0, 2, 3, 7, 10], 'm9', 'minor 9th chord'),
  quality([0, 2, 4, 7, 10], '9', 'dominant 9th chord'),
  quality([0, 2, 4, 7, 9], '6/9', '6/9 chord'),
  quality([0, 1, 4, 7, 10], '7b9', 'dominant 7th chord with a lowered 9th'),
  quality([0, 3, 4, 7, 10], '7#9', 'dominant 7th chord with a raised 9th'),
  quality([0, 2, 3, 5, 7, 10], 'm11', 'minor 11th chord'),
  quality([0, 2, 4, 7, 9, 10], '13', 'dominant 13th chord'),
  quality([0, 2, 4, 7, 9, 11], 'maj13', 'major 13th chord'),
]

export interface ChordMatch {
  /** Pitch class of the root (0 = C). */
  root    : number
  /** Pitch class of the lowest note. */
  bass    : number
  quality : ChordQuality
  /** 'Cm7', or 'Am7b5/C' for an inversion. */
  symbol  : string
  /** 'C minor 7th chord', or 'C minor 7th chord over E' for an inversion. */
  name    : string
  /** True when the lowest note is not the root. */
  inverted: boolean
  /** The pitch classes of the chord (0..11, not relative to the root), from the root up. */
  pitches : number[]
}

const pitchName = (pitch: number): string => PITCH_NAMES[pitchClass(pitch)]

/** 'C D#' for pitch classes, in the order given. */
export const pitchNames = (pitches: readonly number[]): string => pitches.map(pitchName).join(' ')

/** Every chord that spells exactly these notes, best reading first: the one rooted on the lowest note, then the most usual. */
export function identifyChords(notes: readonly number[]): ChordMatch[] {
  if (!notes.length) return []
  const bass    = pitchClass(Math.min(...notes))
  const classes = [...new Set(notes.map(pitchClass))]
  const matches : { match: ChordMatch; order: number }[] = []
  for (const root of classes) {
    const above = classes.map((pitch) => pitchClass(pitch - root)).sort((a, b) => a - b)
    const order = CHORD_QUALITIES.findIndex((chord) => chord.intervals.length === above.length && chord.intervals.every((pc, i) => pc === above[i]))
    if (order < 0) continue
    const found    = CHORD_QUALITIES[order]
    const inverted = root !== bass
    matches.push({
      order,
      match: {
        root,
        bass,
        quality: found,
        symbol : `${pitchName(root)}${found.symbol}${inverted ? `/${pitchName(bass)}` : ''}`,
        name   : `${pitchName(root)} ${found.name}${inverted ? ` over ${pitchName(bass)}` : ''}`,
        inverted,
        pitches: above.map((pitch) => pitchClass(pitch + root))
      }
    })
  }
  return matches.sort((a, b) => Number(a.match.inverted) - Number(b.match.inverted) || a.order - b.order).map(({ match }) => match)
}

/** The best reading of the notes, null when they spell no known chord. */
export const identifyChord = (notes: readonly number[]): ChordMatch | null => identifyChords(notes)[0] ?? null

// ---------------------------------------------------------------------------
// A chord in a scale

/** A scale as a root and its steps (pitch classes above the root, ascending). */
export interface ScaleShape {
  root : number
  steps: readonly number[]
}

export interface ChordInScale {
  /** Roman numeral of the root's degree ('ii', 'V7', 'vii°'), null when the root is not in the scale. */
  numeral: string | null
  /** The chord's pitch classes the scale does not have. */
  outside: number[]
}

const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']

/** A chord with a lowered third and no major third: its numeral is written in lower case. */
const isMinorQuality = (chord: ChordQuality): boolean => chord.intervals.includes(3) && !chord.intervals.includes(4)

/** What follows the numeral: 'm7' -> '7' (the numeral already says minor), 'dim' -> '°'. */
function numeralSuffix(chord: ChordQuality): string {
  switch (chord.symbol) {
    case 'dim':
      return '°'
    case 'dim7':
      return '°7'
    case 'm7b5':
      return 'ø7'
    case 'aug':
      return '+'
    case '5':
      return ''
    default:
      return isMinorQuality(chord) ? chord.symbol.replace(/^m(?!aj)/, '') : chord.symbol
  }
}

/** Where a chord sits in a scale: the numeral of its root, and the notes of it that the scale does not have. */
export function chordInScale(chord: ChordMatch, scale: ScaleShape): ChordInScale {
  const inScale = new Set(scale.steps.map((step) => pitchClass(scale.root + step)))
  const degree  = scale.steps.indexOf(pitchClass(chord.root - scale.root))
  const base    = degree < 0 ? null : (NUMERALS[degree] ?? `${degree + 1}`)
  return {
    numeral: base == null ? null : `${isMinorQuality(chord.quality) ? base.toLowerCase() : base}${numeralSuffix(chord.quality)}`,
    outside: chord.pitches.filter((pitch) => !inScale.has(pitch))
  }
}


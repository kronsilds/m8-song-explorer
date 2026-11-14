import { describe, expect, test } from 'bun:test'
import { describeSelection } from '../src/m8/semantics'
import { demoSong } from '../src/model/demo'
import { chordInScale, identifyChord, identifyChords } from '../src/model/music/chords'
import { chordFacts, chordOver, parseChord } from '../src/model/music/hypersynthChord'
import { buildSongContext } from '../src/model/songContext'

const C4 = 48

describe('naming chords', () => {
  test('root position, any octave and doubling', () => {
    expect(identifyChord([C4, C4 + 4, C4 + 7])?.symbol).toBe('C')
    expect(identifyChord([C4, C4 + 3, C4 + 7, C4 + 10, C4 + 12])?.symbol).toBe('Cm7')
    expect(identifyChord([C4 + 2, C4 + 5, C4 + 9])?.symbol).toBe('Dm')
    expect(identifyChord([C4, C4 + 7])?.name).toBe('C fifths (power chord)')
  })

  test('inversions name the root and the bass', () => {
    // E G C: first inversion of C major.
    const first = identifyChord([C4 + 4, C4 + 7, C4 + 12])
    expect(first?.symbol).toBe('C/E')
    expect(first?.name).toBe('C major chord over E')
    expect(first?.inverted).toBe(true)
  })

  test('a root position reading wins over an inversion of the same notes', () => {
    // C E G A is C6 in root position and Am7 over C: the root position one comes first.
    expect(identifyChords([C4, C4 + 4, C4 + 7, C4 + 9]).map((chord) => chord.symbol)).toEqual(['C6', 'Am7/C'])
    expect(identifyChord([C4, C4 + 3, C4 + 6, C4 + 9])?.symbol).toBe('Cdim7')
  })

  test('notes that spell nothing known', () => {
    expect(identifyChord([C4, C4 + 1, C4 + 2])).toBeNull()
    expect(identifyChord([])).toBeNull()
  })
})

describe('a chord in a scale', () => {
  const cMajor = { root: 0, steps: [0, 2, 4, 5, 7, 9, 11] }

  test('numerals follow the root and the quality', () => {
    const numeral = (notes: number[]) => chordInScale(identifyChord(notes) as NonNullable<ReturnType<typeof identifyChord>>, cMajor).numeral
    expect(numeral([C4, C4 + 4, C4 + 7])).toBe('I')
    expect(numeral([C4 + 2, C4 + 5, C4 + 9])).toBe('ii')
    expect(numeral([C4 + 7, C4 + 11, C4 + 14, C4 + 17])).toBe('V7')
    expect(numeral([C4 + 11, C4 + 14, C4 + 17])).toBe('vii°')
    expect(numeral([C4 + 4, C4 + 7, C4 + 11, C4 + 14])).toBe('iii7')
  })

  test('notes outside the scale, and a root that is not in it', () => {
    const minorThird = chordInScale(identifyChord([C4, C4 + 3, C4 + 7]) as NonNullable<ReturnType<typeof identifyChord>>, cMajor)
    expect(minorThird.numeral).toBe('i')
    expect(minorThird.outside).toEqual([3])
    const flat = chordInScale(identifyChord([C4 + 1, C4 + 5, C4 + 8]) as NonNullable<ReturnType<typeof identifyChord>>, cMajor)
    expect(flat.numeral).toBeNull()
  })
})

describe('Hypersynth chords', () => {
  test('a CHORD value, its voices and the notes over a note', () => {
    const chord = parseChord('00> 00 04 07 0C 00 00')
    expect(chord).toEqual({ bank: '00', semitones: [0, 4, 7, 12, 0, 0] })
    expect(chordOver(C4, chord as NonNullable<typeof chord>)).toEqual([48, 52, 55, 60])
    expect(parseChord('00> 00 04')).toBeNull()
    const facts = Object.fromEntries(chordFacts('00> 00 04 07 0C 00 00'))
    expect(facts.Chord).toBe('major chord (0 +4 +7 +12 0 0 semitones above the played note)')
    expect(facts['Voices 1–3']).toBe('0 +4 +7: major chord')
    expect(facts['Voices 4–6']).toBe('+12 0 0: octaves')
  })

  test('a negative voice (value from 80) reads below the note', () => {
    expect(parseChord('01> F4 00 03 07 00 00')?.semitones).toEqual([-12, 0, 3, 7, 0, 0])
  })

  test('the panel says which chord a Hypersynth plays over a note, and over a table row', () => {
    const model = demoSong()
    model.instruments[0] = {
      id   : 0,
      name : 'PAD',
      type : 'HYPERSYN',
      lines: ['INST. 00', '', 'TYPE    HYPERSYN', 'NAME    PAD', 'TRANSP. ON   TBL.TIC 01   EQ --', '', 'SCALE   00DEFAULT', 'CHORD   00> 00 03 07 0A 00 00']
    }
    const song = buildSongContext(model)
    const step = song.timeline.instances.find((instance) => model.phrases[instance.phrase].steps.some((s) => s.note && s.note !== 'OFF' && (song.effective.get(instance.key)?.[model.phrases[instance.phrase].steps.indexOf(s)] ?? null) === 0))
    if (!step) throw new Error('the demo plays instrument 00 somewhere')
    const index = model.phrases[step.phrase].steps.findIndex((s, i) => s.note && s.note !== 'OFF' && song.effective.get(step.key)?.[i] === 0)
    const note  = describeSelection(song, { kind: 'step', instance: step, step: index, column: 'note' })
    expect(note.facts.find(([label]) => label === 'Chord played')?.[1]).toMatch(/m7/)
    expect(note.facts.find(([label]) => label === 'Chord notes')?.[1].split(' ').length).toBe(4)
  })
})

import { describe, expect, test } from 'bun:test'
import { describeSelection } from '../src/m8/semantics'
import { demoSong } from '../src/model/demo'
import { chordInScale, identifyChord, identifyChords } from '../src/model/music/chords'
import { chordBankAt, chordFacts, chordOver, chordOverNoteFacts, parseChord } from '../src/model/music/hypersynthChord'
import { emptyStep, type PhraseStep } from '../src/model/song'
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
  const cMajor = {
    root : 0,
    steps: [0, 2, 4, 5, 7, 9, 11]
  }

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
    expect(chord).toEqual({
      bank     : '00',
      voices   : [0, 4, 7, 12, 0, 0],
      semitones: [0, 4, 7, 12, 0, 0]
    })
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
    const model          = demoSong()
    model.instruments[0] = {
      id   : 0,
      name : 'PAD',
      type : 'HYPERSYN',
      lines: ['INST. 00', '', 'TYPE    HYPERSYN', 'NAME    PAD', 'TRANSP. ON   TBL.TIC 01   EQ --', '', 'SCALE   00DEFAULT', 'CHORD   00> 00 03 07 0A 00 00']
    }
    const song           = buildSongContext(model)
    const step           = song.timeline.instances.find((instance) => model.phrases[instance.phrase].steps.some((s) => s.note && s.note !== 'OFF' && (song.effective.get(instance.key)?.[model.phrases[instance.phrase].steps.indexOf(s)] ?? null) === 0))
    if (!step) throw new Error('the demo plays instrument 00 somewhere')
    const index = model.phrases[step.phrase].steps.findIndex((s, i) => s.note && s.note !== 'OFF' && song.effective.get(step.key)?.[i] === 0)
    const note  = describeSelection(song, {
      kind    : 'step',
      instance: step,
      step    : index,
      column  : 'note'
    })
    expect(note.facts.find(([label]) => label === 'Chord played')?.[1]).toMatch(/m7/)
    expect(note.facts.find(([label]) => label === 'Chord notes')?.[1].split(' ').length).toBe(4)
  })
})

describe('Hypersynth chord banks and CRD', () => {
  const lines = (chord: string) => ['INST. 00', '', 'TYPE    HYPERSYN', 'NAME    PAD', 'TRANSP. ON   TBL.TIC 01   EQ --', '', 'SCALE   00DEFAULT', `CHORD   ${chord}`]

  /** The demo with instrument 00 as a Hypersynth playing `chord`, and the first step that plays it. */
  function padSong(chord: string, edit: (steps: PhraseStep[], index: number) => void = () => {}) {
    const model          = demoSong()
    model.instruments[0] = {
      id   : 0,
      name : 'PAD',
      type : 'HYPERSYN',
      lines: lines(chord)
    }
    const first          = buildSongContext(model)
    const instance       = first.timeline.instances.find((candidate) => model.phrases[candidate.phrase].steps.some((s, i) => s.note && s.note !== 'OFF' && first.effective.get(candidate.key)?.[i] === 0))
    if (!instance) throw new Error('the demo plays instrument 00 somewhere')
    const steps = model.phrases[instance.phrase].steps
    const index = steps.findIndex((s, i) => s.note && s.note !== 'OFF' && first.effective.get(instance.key)?.[i] === 0)
    edit(steps, index)
    const song  = buildSongContext(model)
    const facts = (column: 'note' | 'fx3cmd', step = index) => Object.fromEntries(describeSelection(song, {
      kind    : 'step',
      instance: song.timeline.instances.find((candidate) => candidate.key === instance.key) ?? instance,
      step,
      column
    }).facts)
    return {
      facts,
      index
    }
  }

  test('a bank other than 00 and voices drawn -- are read', () => {
    expect(parseChord('01> 00 03 07 -- -- --')).toEqual({
      bank     : '01',
      voices   : [0, 3, 7, null, null, null],
      semitones: [0, 3, 7]
    })
    expect(parseChord('0F > 00 04 07 0B 00 00')?.bank).toBe('0F')
    const facts = Object.fromEntries(chordFacts('01> 00 03 07 -- -- --'))
    expect(facts.Chord).toMatch(/^minor chord/)
    expect(facts['Voices 4–6']).toBe('silent')
    expect(padSong('01> 00 03 07 0A 00 00').facts('note')['Chord played']).toMatch(/m7/)
  })

  test('a CRD picks the bank from its row on, until a row names an instrument', () => {
    const steps    = Array.from({ length: 16 }, emptyStep)
    steps[2].fx[1] = {
      cmd: 'CRD',
      val: 3
    }
    steps[6].inst  = 0
    expect([0, 2, 5, 6, 9].map((step) => chordBankAt(steps, step))).toEqual([null, 3, 3, null, null])
  })

  test('the panel names the bank a CRD picks, and the chord when it is the bank that was read', () => {
    const same  = padSong('02> 00 03 07 0A 00 00', (steps, index) => {
      steps[index].fx[2] = {
        cmd: 'CRD',
        val: 2
      }
    })
    expect(same.facts('note')['Chord bank']).toContain('02, picked by a CRD command')
    expect(same.facts('note')['Chord played']).toMatch(/m7/)
    expect(same.facts('fx3cmd')['Chord played']).toMatch(/m7/)
    const other = padSong('00> 00 03 07 0A 00 00', (steps, index) => {
      steps[index].fx[2] = {
        cmd: 'CRD',
        val: 5
      }
    })
    expect(other.facts('note')['Chord bank']).toContain('05, picked by a CRD command (its notes are not known')
    expect(other.facts('note')['Chord played']).toBeUndefined()
  })

  test('the voices are rounded up to the scale', () => {
    const cMajor = new Set([0, 2, 4, 5, 7, 9, 11])
    const minor  = parseChord('00> 00 03 07 0A 00 00') as NonNullable<ReturnType<typeof parseChord>>
    // C minor 7 over C-4 in C major: D#4 rounds up to E-4, A#4 to B-4.
    expect(chordOver(C4, minor, cMajor)).toEqual([48, 52, 55, 59])
    const facts  = Object.fromEntries(chordOverNoteFacts(minor, C4, {
      root : 0,
      steps: [0, 2, 4, 5, 7, 9, 11]
    }, 'MAJOR', true))
    expect(facts['Chord played']).toMatch(/maj7/i)
    expect(facts['Chord notes']).toContain('rounded to C MAJOR from C-4 D#4 G-4 A#4')
  })
})

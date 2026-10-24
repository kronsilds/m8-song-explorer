import { expect, test } from 'bun:test'
import { absorbScreen } from '../src/m8/screen/liveScreen'
import { isPage, readProject, readScale, stableContent, viewOf } from '../src/m8/screen/screenReader'
import { describeSelection } from '../src/m8/semantics'
import { demoSong } from '../src/model/demo'
import {
  analyzePhrase,
  formatTranspose,
  instrumentTransposes,
  keyName,
  playedNote,
  quantize,
  referencedScales,
  ScaleMap,
  scaleLabel,
  scalePitches,
  transposeNote,
  transposeSemitones,
} from '../src/model/music/harmony'
import { noteNumber, noteText } from '../src/model/music/pitch'
import { scaleScreen } from '../src/model/screens'
import { emptyStep, type PhraseStep } from '../src/model/song'
import { buildTimeline, effectiveInstruments } from '../src/model/timeline'

const steps = (notes: string[]): PhraseStep[] => notes.map((note) => ({ ...emptyStep(), note }))

test('chain TSP bytes are signed semitones', () => {
  expect(transposeSemitones(0x05)).toBe(5)
  expect(transposeSemitones(0xf4)).toBe(-12)
  expect(transposeSemitones(null)).toBe(0)
  expect(formatTranspose(-12)).toBe('-12')
  expect(formatTranspose(7)).toBe('+7')
})

test('notes move by semitones in M8 spelling', () => {
  expect(noteNumber('C-4')).toBe(48)
  expect(noteText(49)).toBe('C#4')
  expect(transposeNote('A-3', 5)).toBe('D-4')
  expect(transposeNote('C-4', -12)).toBe('C-3')
  expect(transposeNote('B-9', 1)).toBe('C-A')
  expect(transposeNote('OFF', 3)).toBe('OFF')
  expect(transposeNote('C-0', -1)).toBeNull()
})

test('instruments with TRANSP. OFF ignore chain transpose', () => {
  const inst = (v: string) => ({
    id   : 0,
    name : null,
    type : 'SAMPLER',
    lines: ['', `TRANSP.  ${v}    TBL. TIC 01`]
  })
  expect(instrumentTransposes(inst('OFF'))).toBe(false)
  expect(instrumentTransposes(inst('ON'))).toBe(true)
  expect(instrumentTransposes(undefined)).toBe(true)
})

test('a phrase key is guessed from its notes', () => {
  const major = analyzePhrase(steps(['C-4', 'E-4', 'G-4', 'D-4', 'F-4', 'A-4', 'C-5']))
  expect(major.key && keyName(major.key)).toBe('C major')
  expect(major.key && keyName(major.key, 2)).toBe('D major')
  const minor = analyzePhrase(steps(['A-3', 'C-4', 'E-4', 'A-3', 'G-4', 'D-4', 'A-3']))
  expect(minor.key && keyName(minor.key)).toBe('A minor')
  expect(analyzePhrase(steps(['C-2', 'C-3'])).key).toBeNull()
})

test('a transposed step says what it plays, quantized to the track scale', () => {
  const model     = demoSong()
  const timeline  = buildTimeline(model)
  const effective = effectiveInstruments(model, timeline)
  const inst      = timeline.instances.find((i) => transposeSemitones(model.chains[i.chain].rows[i.chainRow].transpose) === -2)
  if (!inst) throw new Error('the demo has a chain row transposed by -2')
  const steps = model.phrases[inst.phrase].steps
  const d0    = describeSelection(model, {
    kind    : 'step',
    instance: inst,
    step    : 0,
    column  : 'note'
  }, effective.get(inst.key)?.[0])
  expect(d0.facts.find(([k]) => k === 'Chain transpose')?.[1]).toBe('-2 st (TSP FE)')
  // An earlier lead phrase's SCA 91 put the track in A minor: a note moved out of it goes up into it.
  const minor = new Set([9, 11, 0, 2, 4, 5, 7])
  const step  = steps.findIndex((s, i) => i >= 1 && noteNumber(s.note) != null && !minor.has(((noteNumber(s.note) as number) - 2) % 12))
  expect(step).toBeGreaterThan(0)
  const note     = steps[step].note
  const expected = noteText((noteNumber(note) as number) - 1)
  const d        = describeSelection(model, {
    kind    : 'step',
    instance: inst,
    step,
    column  : 'note'
  }, effective.get(inst.key)?.[step])
  expect(d.title).toBe(`Note ${note} → ${expected}`)
  expect(d.facts.find(([k]) => k === 'Plays')?.[1]).toStartWith(`${expected} (${note} -2, scale +1)`)
  expect(d.facts.find(([k]) => k === 'Track scale')?.[1]).toBe('01 MINOR · key A · SCA')
})

test('SCA and SCG choose the scale of a track from their step on', () => {
  const model    = demoSong()
  const timeline = buildTimeline(model)
  const map      = new ScaleMap(model, timeline)
  const lead     = timeline.instances.find((i) => model.phrases[i.phrase].steps[1].fx[2].cmd === 'SCA')
  if (!lead) throw new Error('no SCA in the demo')
  expect(map.at(lead.track, lead.row)).toMatchObject({
    scale : 0,
    source: 'project'
  })
  expect(map.at(lead.track, lead.row + 1)).toMatchObject({
    scale : 1,
    key   : 9,
    source: 'SCA'
  })
  expect(map.at((lead.track + 1) % 8, lead.row + 1).source).toBe('project')
  expect(referencedScales(model)).toEqual([1])
  expect(scaleLabel(model, map.at(lead.track, lead.row + 1))).toBe('01 MINOR · key A · SCA')
})

test('quantize goes up to the next scale note, as measured on the device', () => {
  const minorA = scalePitches(demoSong().scales?.[1], 9)
  expect(quantize(noteNumber('A#4') as number, minorA)).toBe(noteNumber('B-4'))
  expect(quantize(noteNumber('C-5') as number, minorA)).toBe(noteNumber('C-5'))
  expect(scalePitches(demoSong().scales?.[0], 0)).toBeNull()
  // The device test: scale C, E, G; C-4 transposed by 1, 2, 5 and 8 semitones.
  const triad  = new Set([0, 4, 7])
  const played = [1, 2, 5, 8].map((shift) => quantize((noteNumber('C-4') as number) + shift, triad))
  expect(played).toEqual(['E-4', 'E-4', 'G-4', 'C-5'].map((n) => noteNumber(n) as number))
})

test('a Scale view screen is read back', () => {
  const scale = demoSong().scales?.[1]
  if (!scale) throw new Error('no scale 01')
  const lines = scaleScreen({
    ...scale,
    key: 9
  }).map((l) => l.toLowerCase())
  const view  = viewOf({
    width : 40,
    height: 24,
    lines
  })
  expect(view.kind).toBe('scale')
  expect(readScale(view)).toEqual({
    ...scale,
    key: 9
  })
})

// Screens as the M8 drew them (Model:02, fw 6.5, LAAMAA_SNOWY), from the explorer's `d` dump.
const deviceScreen = (rows: Record<number, string>) => ({
  width : 40,
  height: 24,
  lines : Array.from({ length: 24 }, (_, y) => rows[y] ?? '')
})

test('the device Scale view and Project SCALE row are read', () => {
  const scale = deviceScreen({
    3 : ' SCALE 01',
    5 : ' KEY   C                          T>095',
    6 : '    EN OFFSET',
    7 : ' C  ON 00.00                      1 ---',
    8 : ' C# -- -- --                      2 ---',
    9 : ' D  ON 00.00                      3 ---',
    10: ' D# -- -- --                      4 ---',
    11: ' E  ON 00.00                      5 ---',
    12: ' F  ON 00.00                      6 ---',
    13: ' F# -- -- --                      7 ---',
    14: ' G  ON 00.00                      8 ---',
    15: ' G# -- -- --',
    16: ' A  ON 00.00',
    17: ' A# -- -- --',
    18: ' B  ON 00.00                        S',
    19: ' TUNE  440.00                       G',
    20: ' NAME  MAJOR-----------           SCPIT',
    21: '       LOAD SAVE                    V'
  })
  const read  = readScale(viewOf(scale))
  expect(read?.id).toBe(1)
  expect(read?.name).toBe('MAJOR')
  expect(read?.key).toBe(0)
  expect(read?.notes.map((n) => n.enabled)).toEqual([true, false, true, false, true, true, false, true, false, true, false, true])
  expect(read?.notes[2].offset).toBe(0)
  expect(read?.notes[1].offset).toBeNull()

  const project = deviceScreen({
    3 : ' PROJECT',
    5 : ' TEMPO        096.00 <>           T>095',
    6 : ' TRANSPOSE    00',
    7 : ' GROOVE       00DEFAULT           1 ---',
    8 : ' SCALE        00C CHROMATIC       2 ---',
    13: ' NAME         LAAMAA_SNOWY        7 ---'
  })
  expect(readProject(project)).toEqual({
    name     : 'LAAMAA_SNOWY',
    tempo    : 96,
    transpose: 0,
    scale    : 0,
    key      : 0,
    groove   : 0
  })
})

test('a Scale view with another key lists its notes from the key, stored as intervals', () => {
  const scale = {
    id   : 3,
    name : 'TRIAD',
    key  : 2,
    notes: Array.from({ length: 12 }, (_, i) => ({
      enabled: i === 0 || i === 4 || i === 7,
      offset : i === 0 || i === 4 || i === 7 ? 0 : null
    }))
  }
  const lines = scaleScreen(scale)
  // On the device the rows read D, D#, E, F, F# ... from the key D.
  expect(lines.some((line) => line.includes(' D  ON'))).toBe(true)
  expect(lines.some((line) => line.includes(' F# ON'))).toBe(true)
  const read = readScale(viewOf({
    width : 40,
    height: 24,
    lines
  }))
  expect(read?.key).toBe(2)
  expect(read?.notes.map((n) => n.enabled)).toEqual(scale.notes.map((n) => n.enabled))
})

test('the Scale view is read while the song plays, with the > marker on the note being played', () => {
  const rows    = {
    3 : ' SCALE 00',
    5 : ' KEY   C                          T>120',
    6 : '    EN OFFSET',
    7 : ' C  ON 00.00                      1 D-5',
    8 : ' C# -- -- --                      2 ---',
    9 : ' D >ON 00.00                      3 ---',
    10: ' D# ON 00.00',
    11: ' E  ON 00.00',
    12: ' F  ON 00.00',
    13: ' F# ON 00.00',
    14: ' G  ON 00.00',
    15: ' G# ON 00.00',
    16: ' A  ON 00.00',
    17: ' A# ON 00.00',
    18: ' B  ON 00.00                        S',
    19: ' TUNE  440.00                       G',
    20: ' NAME  CHROMATIC-------           SCPIT',
    21: '       LOAD SAVE                    V'
  }
  const playing = deviceScreen(rows)
  expect(isPage(viewOf(playing), 'scale')).toBe(true)
  expect(readScale(viewOf(playing))?.notes.map((n) => n.enabled)).toEqual([true, false, ...Array(10).fill(true)])
  // The marker moves with the notes: the same screen with the marker elsewhere is the same drawn content.
  const moved = deviceScreen({
    ...rows,
    9 : ' D  ON 00.00                      3 ---',
    11: ' E >ON 00.00'
  })
  expect(stableContent(moved)).toBe(stableContent(playing))
})

test('the Project SCALE byte is key (high digit) and scale number (low digit)', () => {
  const project = (value: string) =>
    readProject(
      deviceScreen({
        3 : ' PROJECT',
        5 : ' TEMPO        120.00 <>           T>120',
        6 : ' TRANSPOSE    00',
        7 : ' GROOVE       00DEFAULT           1 ---',
        8 : ` SCALE        ${value} CHROMATIC       2 ---`,
        13: ' NAME         TEST                7 ---'
      }),
    )
  // '20D': key D (2), scale 0, not scale number 0x20, which does not exist.
  expect(project('20D')).toMatchObject({
    scale: 0,
    key  : 2
  })
  expect(project('B3A#')).toMatchObject({
    scale: 3,
    key  : 10
  })
  expect(project('00C')).toMatchObject({
    scale: 0,
    key  : 0
  })
})

test('a written note outside the scale is quantized at play time too, without a transpose', () => {
  const model  = demoSong()
  model.scales = {
    ...model.scales,
    7: {
      id   : 7,
      name : 'TRIAD',
      key  : 2,
      notes: Array.from({ length: 12 }, (_, i) => ({
        enabled: i === 0 || i === 4 || i === 7,
        offset : 0
      }))
    }
  }
  // Scale 7 with key D (D, F#, A): an E-4 written under another scale plays F#4 (checked on the device).
  const played = playedNote(model, 'E-4', 0, null, {
    scale : 7,
    key   : 2,
    source: 'project'
  })
  expect(played.note).toBe('F#4')
  expect(played.snapped).toBe(2)
  expect(played.shift).toBe(0)
})

test("a scale note's semitone offset is added after the quantizing", () => {
  const model  = demoSong()
  // Key C# of a scale of C, E, G with offsets +1, +1, 0: C-5 goes up to C#5 (scale), then +1 (offset): D-5 (checked on the device).
  model.scales = {
    ...model.scales,
    0: {
      id   : 0,
      name : 'TRIAD',
      key  : 1,
      notes: Array.from({ length: 12 }, (_, i) => ({
        enabled: i === 0 || i === 4 || i === 7,
        offset : i === 0 || i === 4 ? 1 : 0
      }))
    }
  }
  const played = playedNote(model, 'C-5', 0, null, {
    scale : 0,
    key   : 1,
    source: 'SCA'
  })
  expect(played.note).toBe('C#5')
  expect(played.snapped).toBe(1)
  expect(played.detune).toBe(1)
  expect(played.sounding).toBe('D-5')
  // Written in the scale (C# with the C# offset): D-5 as well, with no quantizing.
  expect(playedNote(model, 'C#5', 0, null, {
    scale : 0,
    key   : 1,
    source: 'SCA'
  }).sounding).toBe('D-5')
})

test('the selection says when only the scale moved a written note', () => {
  const model            = demoSong()
  model.scales           = {
    7: {
      id   : 7,
      name : 'TRIAD',
      key  : 0,
      notes: Array.from({ length: 12 }, (_, i) => ({
        enabled: i === 0 || i === 4 || i === 7,
        offset : 0
      }))
    }
  }
  model.projectScale     = 7
  model.projectKey       = 0
  model.projectTranspose = 0
  const timeline         = buildTimeline(model)
  const effective        = effectiveInstruments(model, timeline)
  const triad            = new Set([0, 4, 7])
  for (const inst of timeline.instances) {
    if (transposeSemitones(model.chains[inst.chain].rows[inst.chainRow].transpose) !== 0) continue
    const steps = model.phrases[inst.phrase].steps
    const step  = steps.findIndex((s) => noteNumber(s.note) != null && !triad.has((noteNumber(s.note) as number) % 12))
    if (step < 0) continue
    const d = describeSelection(model, {
      kind    : 'step',
      instance: inst,
      step,
      column  : 'note'
    }, effective.get(inst.key)?.[step])
    // The demo has no SCA that would change the track's scale before this step on every track: skip those.
    if (!d.facts.some(([k]) => k === 'Quantized')) continue
    expect(d.title).toContain('(scale)')
    expect(d.facts.find(([k]) => k === 'Quantized')?.[1]).toContain('no transpose')
    return
  }
  throw new Error('no note outside the triad on an untransposed phrase in the demo')
})

test('edits to the Scale view and the Project SCALE are folded in live', () => {
  const model  = demoSong()
  const scale  = {
    id   : 4,
    name : 'TRIAD',
    key  : 2,
    notes: Array.from({ length: 12 }, (_, i) => ({
      enabled: i === 0 || i === 4 || i === 7,
      offset : i === 0 || i === 4 || i === 7 ? 0 : null
    }))
  }
  const screen = {
    width : 40,
    height: 24,
    lines : scaleScreen(scale)
  }
  expect(absorbScreen(model, screen)).toBe(true)
  expect(model.scales?.[4]?.notes.map((n) => n.enabled)).toEqual(scale.notes.map((n) => n.enabled))
  expect(model.scales?.[4]?.name).toBe('TRIAD')
  expect(model.projectKey).toBe(2)
  // The same screen again changes nothing.
  expect(absorbScreen(model, screen)).toBe(false)
  const project = deviceScreen({
    3 : ' PROJECT',
    5 : ' TEMPO        120.00 <>           T>120',
    6 : ' TRANSPOSE    05',
    7 : ' GROOVE       00DEFAULT           1 ---',
    8 : ' SCALE        94A TRIAD           2 ---',
    13: ' NAME         TEST                7 ---'
  })
  expect(absorbScreen(model, project)).toBe(true)
  expect(model.projectScale).toBe(4)
  expect(model.projectKey).toBe(9)
  expect(model.projectTranspose).toBe(5)
})

import { expect, test } from 'bun:test'
import { describeSelection } from '../src/m8/semantics'
import { demoSong } from '../src/model/demo'
import { readProject, readScale, viewOf } from '../src/m8/driver'
import {
  analyzePhrase,
  formatTranspose,
  instrumentTransposes,
  keyName,
  noteNumber,
  noteText,
  quantize,
  ScaleMap,
  scaleLabel,
  scalePitches,
  transposeNote,
  transposeSemitones,
} from '../src/model/harmony'
import { scaleScreen } from '../src/model/screens'
import { buildTimeline, effectiveInstruments, emptyStep, type PhraseStep } from '../src/model/song'

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
  const inst = (v: string) => ({ id: 0, name: null, type: 'SAMPLER', lines: ['', `TRANSP.  ${v}    TBL. TIC 01`] })
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
  const model = demoSong()
  const timeline = buildTimeline(model)
  const effective = effectiveInstruments(model, timeline)
  const inst = timeline.instances.find((i) => transposeSemitones(model.chains[i.chain].rows[i.chainRow].transpose) === -2)
  if (!inst) throw new Error('the demo has a chain row transposed by -2')
  const steps = model.phrases[inst.phrase].steps
  const d0 = describeSelection(model, { kind: 'step', instance: inst, step: 0, column: 'note' }, effective.get(inst.key)?.[0])
  expect(d0.facts.find(([k]) => k === 'Chain transpose')?.[1]).toBe('-2 st (TSP FE)')
  // An earlier lead phrase's SCA 91 put the track in A minor: a note moved out of it goes down into it.
  const minor = new Set([9, 11, 0, 2, 4, 5, 7])
  const step = steps.findIndex((s, i) => i >= 1 && noteNumber(s.note) != null && !minor.has(((noteNumber(s.note) as number) - 2) % 12))
  expect(step).toBeGreaterThan(0)
  const note = steps[step].note
  const expected = noteText((noteNumber(note) as number) - 3)
  const d = describeSelection(model, { kind: 'step', instance: inst, step, column: 'note' }, effective.get(inst.key)?.[step])
  expect(d.title).toBe(`Note ${note} → ${expected}`)
  expect(d.facts.find(([k]) => k === 'Plays')?.[1]).toStartWith(`${expected} (${note} -2, scale -1)`)
  expect(d.facts.find(([k]) => k === 'Track scale')?.[1]).toBe('01 MINOR · key A · SCA')
})

test('SCA and SCG choose the scale of a track from their step on', () => {
  const model = demoSong()
  const timeline = buildTimeline(model)
  const map = new ScaleMap(model, timeline)
  const lead = timeline.instances.find((i) => model.phrases[i.phrase].steps[1].fx[2].cmd === 'SCA')
  if (!lead) throw new Error('no SCA in the demo')
  expect(map.at(lead.track, lead.row)).toMatchObject({ scale: 0, source: 'project' })
  expect(map.at(lead.track, lead.row + 1)).toMatchObject({ scale: 1, key: 9, source: 'SCA' })
  expect(map.at((lead.track + 1) % 8, lead.row + 1).source).toBe('project')
  expect(ScaleMap.referenced(model)).toEqual([1])
  expect(scaleLabel(model, map.at(lead.track, lead.row + 1))).toBe('01 MINOR · key A · SCA')
})

test('quantize goes down to the scale note below', () => {
  const minorA = scalePitches(demoSong().scales?.[1], 9)
  expect(quantize(noteNumber('A#4') as number, minorA)).toBe(noteNumber('A-4'))
  expect(quantize(noteNumber('C-5') as number, minorA)).toBe(noteNumber('C-5'))
  expect(scalePitches(demoSong().scales?.[0], 0)).toBeNull()
})

test('a Scale view screen is read back', () => {
  const scale = demoSong().scales?.[1]
  if (!scale) throw new Error('no scale 01')
  const lines = scaleScreen({ ...scale, key: 9 }).map((l) => l.toLowerCase())
  const view = viewOf({ width: 40, height: 24, lines })
  expect(view.kind).toBe('scale')
  expect(readScale(view)).toEqual({ ...scale, key: 9 })
})

// Screens as the M8 drew them (Model:02, fw 6.5, LAAMAA_SNOWY), from the explorer's `d` dump.
const deviceScreen = (rows: Record<number, string>) => ({
  width: 40,
  height: 24,
  lines: Array.from({ length: 24 }, (_, y) => rows[y] ?? ''),
})

test('the device Scale view and Project SCALE row are read', () => {
  const scale = deviceScreen({
    3: ' SCALE 01',
    5: ' KEY   C                          T>095',
    6: '    EN OFFSET',
    7: ' C  ON 00.00                      1 ---',
    8: ' C# -- -- --                      2 ---',
    9: ' D  ON 00.00                      3 ---',
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
    21: '       LOAD SAVE                    V',
  })
  const read = readScale(viewOf(scale))
  expect(read?.id).toBe(1)
  expect(read?.name).toBe('MAJOR')
  expect(read?.key).toBe(0)
  expect(read?.notes.map((n) => n.enabled)).toEqual([true, false, true, false, true, true, false, true, false, true, false, true])
  expect(read?.notes[2].offset).toBe(0)
  expect(read?.notes[1].offset).toBeNull()

  const project = deviceScreen({
    3: ' PROJECT',
    5: ' TEMPO        096.00 <>           T>095',
    6: ' TRANSPOSE    00',
    7: ' GROOVE       00DEFAULT           1 ---',
    8: ' SCALE        00C CHROMATIC       2 ---',
    13: ' NAME         LAAMAA_SNOWY        7 ---',
  })
  expect(readProject(project)).toEqual({ name: 'LAAMAA_SNOWY', tempo: 96, transpose: 0, scale: 0, key: 0, groove: 0 })
})

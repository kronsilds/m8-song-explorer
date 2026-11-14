// Reading a Hypersynth's 16 chord banks: the walk on the (fake) M8, a bank stepped by hand on the
// device, and what the Selection panel says once the banks are known.

import { expect, test } from 'bun:test'
import { absorbScreen } from '../src/m8/screen/liveScreen'
import { describeSelection } from '../src/m8/semantics'
import { readChordBanks } from '../src/m8/tasks/chordReader'
import { demoSong } from '../src/model/demo'
import { chordOfBank, hypersynthsWithChordCommands } from '../src/model/music/hypersynthChord'
import { emptyFx, type SongModel } from '../src/model/song'
import { buildSongContext } from '../src/model/songContext'
import { FakeM8 } from './fakeM8'

/** The banks of a Hypersynth as a Model:02 (firmware 6.5) showed them, bank by bank. */
const DEVICE_BANKS = [
  '00> 00 00 00 00 00 00',
  '01> 00 0B 10 15 -- --',
  '02> 00 0A 0F 14 -- --',
  '03> 00 04 0B 0E -- --',
  '04> 00 07 0A 0F -- --',
  '05> 00 13 0B 10 -- --',
  '06> 00 15 0B 10 -- --',
  '07> 00 0A 0F 13 -- --',
  '08> 00 0B 10 13 -- --',
  '09> 00 04 0B 0C -- --',
  '0A> 00 04 07 0C -- --',
  '0B> 00 06 09 0F -- --',
  '0C> 00 04 0A 0E -- --',
  '0D> 00 00 00 00 00 00',
  '0E> 00 00 00 00 00 00',
  '0F> 00 0A 10 13 0E 00'
]

/** The demo's Hypersynth, and the demo with a CRD on the first step that plays it. */
function songWithChordCommand(bank: number) {
  const model = demoSong()
  const pad   = Object.values(model.instruments).find((instrument) => instrument.type === 'HYPERSYN')
  if (!pad) throw new Error('the demo has a Hypersynth')
  const first    = buildSongContext(model)
  const instance = first.timeline.instances.find((candidate) => model.phrases[candidate.phrase].steps.some((s, i) => s.note && s.note !== 'OFF' && first.effective.get(candidate.key)?.[i] === pad.id))
  if (!instance) throw new Error('the demo plays its Hypersynth')
  const steps = model.phrases[instance.phrase].steps
  const step  = steps.findIndex((s, i) => s.note && s.note !== 'OFF' && first.effective.get(instance.key)?.[i] === pad.id)
  // One CRD in the song, on that step.
  for (const phrase of Object.values(model.phrases)) for (const s of phrase.steps) s.fx = s.fx.map((fx) => (fx.cmd === 'CRD' ? emptyFx() : fx))
  steps[step].fx[2] = {
    cmd: 'CRD',
    val: bank
  }
  return {
    model,
    pad,
    instance,
    step
  }
}

const noteFacts = (model: SongModel, instance: ReturnType<typeof songWithChordCommand>['instance'], step: number) => {
  const song = buildSongContext(model)
  return Object.fromEntries(describeSelection(song, {
    kind    : 'step',
    instance: song.timeline.instances.find((candidate) => candidate.key === instance.key) ?? instance,
    step,
    column  : 'note'
  }).facts)
}

test('reads the 16 banks with checked Edit+Left / Right steps and puts the bank back', async () => {
  const { model, pad }    = songWithChordCommand(1)
  const fake              = new FakeM8(model)
  fake.chordBanks[pad.id] = DEVICE_BANKS
  fake.chordBank[pad.id]  = 5
  const startView         = fake.view
  const banks             = await readChordBanks(fake, [pad.id], { pollMs: 0 })
  expect(banks.get(pad.id)).toEqual(DEVICE_BANKS)
  expect(fake.chordBank[pad.id]).toBe(5)
  expect(fake.view).toBe(startView)
  expect(fake.forbidden).toEqual([])
})

test('an instrument without a CHORD line is left out, with no Edit pressed', async () => {
  const model   = demoSong()
  const sampler = Object.values(model.instruments).find((instrument) => instrument.type === 'SAMPLER')
  const fake    = new FakeM8(model)
  const banks   = await readChordBanks(fake, [sampler?.id ?? 0], { pollMs: 0 })
  expect(banks.size).toBe(0)
  expect(fake.forbidden).toEqual([])
})

test('a song with a CRD command asks for the chord banks of its Hypersynths', () => {
  const { model, pad, instance, step } = songWithChordCommand(1)
  expect(hypersynthsWithChordCommands(model)).toEqual([pad.id])
  model.phrases[instance.phrase].steps[step].fx[2] = emptyFx()
  expect(hypersynthsWithChordCommands(model)).toEqual([])
})

test('the panel names the chord of the bank a CRD picks once the banks are read', () => {
  const { model, pad, instance, step } = songWithChordCommand(0x0a)
  const before                         = noteFacts(model, instance, step)
  expect(before['Chord bank']).toContain('its notes are not known')
  expect(before['Chord played']).toBeUndefined()
  model.instruments[pad.id].chords = DEVICE_BANKS
  const after                      = noteFacts(model, instance, step)
  expect(after['Chord bank']).toBe('0A, picked by a CRD command')
  // Bank 0A is 00 04 07 0C: a major chord over the played note.
  expect(after['Chord played']).toBeDefined()
  expect(after['Chord notes']?.split(' · ')[0].split(' ').length).toBeGreaterThanOrEqual(3)
})

test('a bank stepped by hand on the M8 is kept with the ones seen before', async () => {
  const { model, pad }    = songWithChordCommand(1)
  const fake              = new FakeM8(model)
  fake.chordBanks[pad.id] = DEVICE_BANKS
  await fake.navigateToView('inst')
  while (fake.inst !== pad.id) await fake.press(['opt', fake.inst < pad.id ? 'right' : 'left'])
  for (const bank of [1, 2]) {
    fake.chordBank[pad.id] = bank
    expect(absorbScreen(model, await fake.getScreen())).toBe(true)
  }
  const instrument = model.instruments[pad.id]
  expect(instrument.chords?.[1]).toBe(DEVICE_BANKS[1])
  expect(instrument.chords?.[2]).toBe(DEVICE_BANKS[2])
  expect(chordOfBank(instrument, 1)?.semitones).toEqual([0, 11, 16, 21])
  // A bank never shown stays unknown.
  expect(chordOfBank(instrument, 9)).toBeNull()
})

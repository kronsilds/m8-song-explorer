// Track mute / solo notes: which note and channel go out, through a fake Web MIDI.

import { afterEach, expect, test } from 'bun:test'
import { holdNote, MidiControl } from '../src/m8/midiControl'

const realNavigator = globalThis.navigator

function fakeMidi(names: string[]): { sent: { name: string; data: number[] }[] } {
  const sent    : { name: string; data: number[] }[] = []
  const outputs = new Map(
    names.map((name, i) => [
      String(i),
      {
        name,
        state: 'connected',
        open : async () => {},
        send : (data: number[]) => sent.push({
          name,
          data: [...data]
        })
      },
    ]),
  )
  Object.defineProperty(globalThis, 'navigator', {
    value       : { requestMIDIAccess: async () => ({ outputs }) },
    configurable: true
  })
  return { sent }
}

afterEach(() => Object.defineProperty(globalThis, 'navigator', {
  value       : realNavigator,
  configurable: true
}))

test('mute and solo notes of tracks 1 and 8', () => {
  expect([0, 7].map((t) => holdNote('mute', t))).toEqual([12, 19])
  expect([0, 7].map((t) => holdNote('solo', t))).toEqual([20, 27])
})

test('on holds the note on the M8 port, off releases it; channel 11 by default', async () => {
  const { sent } = fakeMidi(['Other synth', 'M8'])
  const midi     = new MidiControl()
  await midi.set('solo', 2, true)
  await midi.set('solo', 2, false)
  expect(sent).toEqual([{
    name: 'M8',
    data: [0x9a, holdNote('solo', 2), 0x7f]
  }, {
    name: 'M8',
    data: [0x8a, holdNote('solo', 2), 0]
  }])
})

test('changing the channel releases the held notes on the old one', async () => {
  const { sent } = fakeMidi(['M8'])
  const midi     = new MidiControl(11)
  await midi.set('mute', 0, true)
  midi.channel = 3
  expect(sent.map((m) => m.data)).toEqual([
    [0x9a, holdNote('mute', 0), 0x7f],
    [0x8a, holdNote('mute', 0), 0],
  ])
})

test('no M8 port is an error', async () => {
  fakeMidi(['Other synth'])
  await expect(new MidiControl().set('mute', 0, true)).rejects.toThrow(/no MIDI output named M8/)
})

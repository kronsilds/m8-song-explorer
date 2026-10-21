import { expect, test } from 'bun:test'
import { readMidiSync, SYNC_OUT_TARGET, setMidiSyncOut } from '../src/m8/tasks/midiSync'
import { demoSong } from '../src/model/demo'
import { FakeM8 } from './fakeM8'

test('reads SYNC OUT from Project > MIDI SETTINGS and comes back to the song', async () => {
  const fake   = new FakeM8(demoSong())
  fake.syncOut = 1
  const sync   = await readMidiSync(fake, { pollMs: 0 })
  expect(sync).toEqual({
    syncIn : 'OFF',
    syncOut: 'CLOCK'
  })
  expect(fake.view).toBe('song')
  expect(fake.forbidden).toEqual([])
})

test('sets SYNC OUT to clock + transport + SPP, one checked step at a time', async () => {
  const fake = new FakeM8(demoSong())
  expect(await setMidiSyncOut(fake, { pollMs: 0 })).toBe(SYNC_OUT_TARGET)
  expect(fake.syncOut).toBe(5)
  expect(fake.view).toBe('song')
  expect(fake.forbidden).toEqual([])
})

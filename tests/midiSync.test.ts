import { expect, test } from 'bun:test'
import { parseChannel, planChannel, readMidiSync, SYNC_OUT_TARGET, setCcMapChannel, setMidiSyncOut } from '../src/m8/tasks/midiSync'
import { demoSong } from '../src/model/demo'
import { FakeM8 } from './fakeM8'

test('reads SYNC OUT and the channels from Project > MIDI SETTINGS and comes back to the song', async () => {
  const fake          = new FakeM8(demoSong())
  fake.syncOut        = 1
  fake.ccMapChan      = 11
  fake.songRowCueChan = 3
  const sync          = await readMidiSync(fake, { pollMs: 0 })
  expect(sync).toEqual({
    syncIn        : 'OFF',
    syncOut       : 'CLOCK',
    ccMapChan     : '11',
    songRowCueChan: '03'
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

test('parses channel values', () => {
  expect(parseChannel('ALL')).toBe('ALL')
  expect(parseChannel('11')).toBe(11)
  expect(parseChannel('03')).toBe(3)
  expect(parseChannel('17')).toBeNull()
  expect(parseChannel('OFF')).toBeNull()
  expect(parseChannel(null)).toBeNull()
})

const sync = (ccMapChan: string | null, songRowCueChan: string | null) => ({
  syncIn : 'OFF',
  syncOut: 'OFF',
  ccMapChan,
  songRowCueChan
})

test('plans: a single CC MAP CHAN is adopted by the explorer', () => {
  expect(planChannel(sync('05', 'ALL'), 11)).toEqual({
    kind   : 'adopt',
    channel: 5
  })
})

test('plans: ALL is set to the explorer channel, unless the song row cue uses it', () => {
  expect(planChannel(sync('ALL', '02'), 11)).toEqual({
    kind   : 'set',
    channel: 11,
    reason : 'all',
    moved  : false
  })
  expect(planChannel(sync('ALL', '11'), 11)).toEqual({
    kind   : 'set',
    channel: 12,
    reason : 'all',
    moved  : true
  })
  expect(planChannel(sync('ALL', '16'), 16)).toEqual({
    kind   : 'set',
    channel: 1,
    reason : 'all',
    moved  : true
  })
})

test('plans: a CC MAP CHAN shared with the song row cue is moved, the cue is left', () => {
  expect(planChannel(sync('07', '07'), 11)).toEqual({
    kind   : 'set',
    channel: 11,
    reason : 'cue-clash',
    moved  : false
  })
  expect(planChannel(sync(null, '07'), 11)).toEqual({ kind: 'unknown' })
})

test('sets CC MAP CHAN from ALL to a channel with checked steps, never touching the cue', async () => {
  const fake          = new FakeM8(demoSong())
  fake.songRowCueChan = 2
  expect(await setCcMapChannel(fake, 4, { pollMs: 0 })).toBe('04')
  expect(fake.ccMapChan).toBe(4)
  expect(fake.songRowCueChan).toBe(2)
  expect(fake.view).toBe('song')
  expect(fake.forbidden).toEqual([])
})

test('sets CC MAP CHAN downwards from a higher channel', async () => {
  const fake     = new FakeM8(demoSong())
  fake.ccMapChan = 9
  expect(await setCcMapChannel(fake, 6, { pollMs: 0 })).toBe('06')
  expect(fake.forbidden).toEqual([])
})

test('waits for the text under the cursor to catch up with the cursor before editing a value', async () => {
  const fake = new FakeM8(demoSong(), { lateCursorText: 250 })
  expect(await setMidiSyncOut(fake, { pollMs: 0 })).toBe(SYNC_OUT_TARGET)
  fake.ccMapChan = 0
  expect(await setCcMapChannel(fake, 6, { pollMs: 0 })).toBe('06')
  expect(fake.forbidden).toEqual([])
})

test('says where the cursor is when it never reaches the value', async () => {
  const fake = new FakeM8(demoSong(), { lateCursorText: 60000 })
  const logs : string[] = []
  await expect(setCcMapChannel(fake, 6, {
    pollMs: 0,
    log   : (message) => logs.push(message)
  })).rejects.toThrow('the cursor is on "NONE", not MIDI SETTINGS')
  expect(logs.some((message) => message.includes('the cursor is not on the MIDI SETTINGS entry') && message.toUpperCase().includes('PROJECT'))).toBe(true)
})

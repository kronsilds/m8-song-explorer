import { beforeEach, expect, test } from 'bun:test'
import { matchesSong } from '../src/m8/screen/liveScreen'
import { demoSong } from '../src/model/demo'
import { projectScreen, songScreen } from '../src/model/screens'
import { rememberedSongs, rememberSong, reviveSong } from '../src/model/storage'
import { readSongFile } from '../src/ui/songFile'

const screen = (lines: string[]) => ({
  width : 40,
  height: 24,
  lines : lines.map((l) => l.toLowerCase())
})

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem   : (key: string) => store.get(key) ?? null,
    setItem   : (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
})

const named = (name: string) => ({
  ...demoSong(),
  source: 'device' as const,
  name
})

test('a kept song comes back by its screen; demo and unnamed songs are not kept', () => {
  rememberSong(demoSong())
  rememberSong({
    ...named('X'),
    name: null
  })
  expect(rememberedSongs()).toEqual([])
  const model = named('NEON DRIFT')
  rememberSong(model)
  const [kept] = rememberedSongs()
  expect(kept.name).toBe('NEON DRIFT')
  expect(matchesSong(kept, screen(songScreen(model, 0)))).toBe(true)
  expect(matchesSong(kept, screen(projectScreen('NEON DRIFT', 128)))).toBe(true)
  expect(matchesSong(kept, screen(projectScreen('OTHER', 128)))).toBe(false)
})

test('keeping a song again replaces it; the oldest of more than six is dropped', () => {
  for (let i = 0; i < 8; i += 1) rememberSong(named(`SONG ${i}`))
  rememberSong(named('SONG 5'))
  const names = rememberedSongs().map((song) => song.name)
  expect(names).toHaveLength(6)
  expect(names[0]).toBe('SONG 5')
  expect(names).not.toContain('SONG 0')
  expect(names.filter((name) => name === 'SONG 5')).toHaveLength(1)
})

test('a partial song file is completed; a non-song is refused with a reason', async () => {
  const partial = {
    version: 1,
    source : 'device',
    song   : [],
    chains : {},
    phrases: {}
  }
  const revived = reviveSong(partial)
  expect(revived?.instruments).toEqual({})
  expect(revived?.warnings).toEqual([])
  const ok = await readSongFile(new File([JSON.stringify(partial)], 'a.json'))
  expect(ok.kind === 'song' && ok.model.source).toBe('file')
  const bad = await readSongFile(new File(['{"x":1}'], 'b.json'))
  expect(bad.kind).toBe('invalid')
  const m8s = await readSongFile(new File([new Uint8Array([0x4d, 0x38, 0x56, 0xff])], 'c.m8s'))
  expect(m8s.kind === 'invalid' && m8s.reason).toContain('.m8s')
})

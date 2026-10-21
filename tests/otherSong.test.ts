import { expect, test } from 'bun:test'
import { isOtherSong } from '../src/m8/screen/liveScreen'
import { demoSong } from '../src/model/demo'
import { projectScreen, songScreen } from '../src/model/screens'

const screen = (lines: string[]) => ({
  width : 40,
  height: 24,
  lines : lines.map((l) => l.toLowerCase())
})

test('the explored song on screen, or a few edits to it, is the same song', () => {
  const model = demoSong()
  expect(isOtherSong(model, screen(songScreen(model, 0)))).toBe(false)
  const edited      = structuredClone(model)
  edited.song[2][0] = 0x40
  edited.song[3][1] = 0x41
  expect(isOtherSong(model, screen(songScreen(edited, 0)))).toBe(false)
})

test('another song: many song cells differ, or another project name', () => {
  const model = demoSong()
  const other = structuredClone(model)
  other.song  = other.song.map((row) => row.map((c) => (c == null ? 0xfe : (c + 0x30) & 0xff)))
  expect(isOtherSong(model, screen(songScreen(other, 0)))).toBe(true)
  expect(isOtherSong(model, screen(projectScreen('SAFETY168_F', 168)))).toBe(true)
  expect(isOtherSong(model, screen(projectScreen('NEON DRIFT', 128)))).toBe(false)
})

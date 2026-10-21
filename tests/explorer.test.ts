import { describe, expect, test } from 'bun:test'
import { isPage, viewOf } from '../src/m8/screen/screenReader'
import { exploreSong } from '../src/m8/tasks/explorer'
import { demoSong } from '../src/model/demo'
import { chainScreen, phraseScreen } from '../src/model/screens'
import { chainLength, lastSongRow, type SongModel, usedItems } from '../src/model/song'
import { buildTimeline } from '../src/model/timeline'
import { FakeM8, type FakeOptions } from './fakeM8'

const explore = async (device: SongModel, options: FakeOptions = {}, songRows?: number) => {
  const fake  = new FakeM8(device, options)
  const logs  : string[] = []
  const model = await exploreSong(fake, {
    pollMs         : 0,
    settleTimeoutMs: 400,
    songRows,
    log            : (m) => logs.push(m)
  })
  return { fake, model, logs }
}

/** What the explorer should find: the played part of the song. */
function expectSameSong(model: SongModel, device: SongModel) {
  expect(model.warnings).toEqual([])
  expect(lastSongRow(model)).toBe(lastSongRow(device))
  for (let r = 0; r <= lastSongRow(device); r += 1) expect(model.song[r]).toEqual(device.song[r])
  const timeline = buildTimeline(device)
  for (const inst of timeline.instances) {
    expect(model.chains[inst.chain]).toEqual(device.chains[inst.chain])
    expect(model.phrases[inst.phrase]).toEqual(device.phrases[inst.phrase])
  }
  for (const id of usedItems(device).instruments) {
    expect(model.instruments[id]?.type).toBe(device.instruments[id].type)
    expect(model.instruments[id]?.name).toBe(device.instruments[id].name)
  }
  for (const id of usedItems(device).tables) expect(model.tables[id]).toEqual(device.tables[id])
  for (const id of usedItems(device).instruments) expect(model.tables[id]).toEqual(device.tables[id])
  expect(model.projectScale).toBe(device.projectScale ?? 0)
  expect(model.projectTranspose).toBe(device.projectTranspose ?? 0)
  expect(model.projectKey).toBe(device.projectKey ?? 0)
  expect(model.scales).toEqual(device.scales)
}

describe('exploreSong', () => {
  test('reads the whole demo song without editing anything', async () => {
    const device          = demoSong()
    const { fake, model } = await explore(device)
    expectSameSong(model, device)
    expect(model.name).toBe('NEON DRIFT')
    expect(model.tempo).toBe(128)
    expect(fake.forbidden).toEqual([])
    expect(fake.view).toBe('song')
    // Phrases after a chain's end are not read: they are never played.
    for (const chain of Object.values(model.chains)) {
      for (const row of chain.rows.slice(chainLength(chain))) if (row.phrase != null) expect(model.phrases[row.phrase]).toBeDefined()
    }
  })

  test('indicators after the number in a title are not part of the id', () => {
    const device = demoSong()
    const chain  = Object.values(device.chains)[0]
    const phrase = Object.values(device.phrases)[0]
    // '*': used elsewhere in the chain or song (the manual); '^' seen on phrases; '{' is a slashed 0.
    const cases  : [string[], string, string, number][] = [
      [chainScreen(chain), ' chain 0b*', 'chain', 0x0b],
      [phraseScreen(phrase), ' phrase 19*', 'phrase', 0x19],
      [phraseScreen(phrase), ' phrase 27^', 'phrase', 0x27],
      [chainScreen(chain), ' chain {b*', 'chain', 0x0b],
    ]
    for (const [screen, title, kind, id] of cases) {
      const lines = screen.map((l) => l.toLowerCase())
      lines[3]    = title
      const view  = viewOf({
        width : 40,
        height: 24,
        lines
      })
      expect(view).toMatchObject({ kind, id })
      expect(isPage(view, view.kind, id)).toBe(true)
    }
  })

  test('presses a missed Shift+Right / Shift+Left again instead of giving up on the chain', async () => {
    const device                = demoSong()
    const { fake, model, logs } = await explore(device, {
      missedPresses: [{
        view : 'song',
        keys : 'shift+right',
        count: 1
      }, {
        view : 'chain',
        keys : 'shift+right',
        count: 2
      }, {
        view : 'phrase',
        keys : 'shift+left',
        count: 1
      }, {
        view : 'chain',
        keys : 'shift+left',
        count: 1
      }],
    })
    expectSameSong(model, device)
    expect(fake.missed).toBe(5)
    expect(logs.filter((l) => l.includes('pressing it again'))).toHaveLength(5)
    expect(fake.forbidden).toEqual([])
  })

  test('copes with views drawn over several frames', async () => {
    const device          = demoSong()
    const { fake, model } = await explore(device, { partialReads: 2 })
    expectSameSong(model, device)
    expect(fake.forbidden).toEqual([])
  })

  test('falls back to the chain when Option+Down does not move between phrases', async () => {
    const device          = demoSong()
    const { model, logs } = await explore(device, { phraseOptionDownBroken: true })
    expectSameSong(model, device)
    expect(logs.some((l) => l.includes('Option+Down'))).toBe(true)
  })

  test('steps one item at a time when Option+Up/Down goes the other way', async () => {
    const device               = demoSong()
    device.instruments[0x40]   = {
      id   : 0x40,
      name : 'FAR',
      type : 'SAMPLER',
      lines: []
    }
    device.phrases[0].steps[1] = {
      ...device.phrases[0].steps[1],
      note: 'C-4',
      inst: 0x40
    }
    const { model, logs }      = await explore(device, { invertedBigSteps: true })
    expect(model.instruments[0x40]?.name).toBe('FAR')
    expect(logs.some((l) => l.includes('single steps'))).toBe(true)
  })

  test('reads chains that start far down the song', async () => {
    const device      = demoSong()
    device.song[0xf3] = [null, null, null, null, null, null, null, 0x0b]
    const { model }   = await explore(device)
    expect(model.song[0xf3]?.[7]).toBe(0x0b)
    expect(model.chains[0x0b]).toEqual(device.chains[0x0b])
  })

  test('learns the colours of each view', async () => {
    const { model } = await explore(demoSong())
    expect(model.observedColors.phrase?.note).toEqual({
      filled: '#ffffff',
      empty : '#444444'
    })
    expect(model.observedColors.song?.background?.filled).toBe('#000000')
  })

  test('stops early when cancelled, keeping what it read', async () => {
    const device     = demoSong()
    const fake       = new FakeM8(device)
    const controller = new AbortController()
    const model      = await exploreSong(fake, {
      pollMs    : 0,
      signal    : controller.signal,
      onProgress: (p) => {
        if (p.phase === 'chains' && p.done === 2) controller.abort()
      }
    })
    expect(model.warnings.at(-1)).toContain('cancelled')
    expect(Object.keys(model.chains).length).toBe(2)
  })
})

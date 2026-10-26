import { describe, expect, test } from 'bun:test'
import { M8Driver, M8MoveError } from '../src/m8/driver'
import { isPage } from '../src/m8/screen/screenReader'
import { demoSong } from '../src/model/demo'
import { FakeM8 } from './fakeM8'

const model = demoSong()
const id    = Object.values(model.instruments).find((instrument) => instrument.mods)?.id as number

/** An M8 on the Inst. Mods view of an instrument, with `count` cells changing on every read. */
function modsView(count: number) {
  const cells = Array.from({ length: count }, (_, n) => ({
    x: 8 + n,
    y: 5
  }))
  const fake  = new FakeM8(model, {
    flicker: {
      view: 'instmods',
      cells
    }
  })
  fake.view   = 'instmods'
  fake.inst   = id
  return fake
}

describe('settle that gives up', () => {
  test('a drawn view that never stops changing is an error that says so, with the screen in the log', async () => {
    const messages : string[] = []
    const driver   = new M8Driver(modsView(20), {
      pollMs         : 0,
      settleTimeoutMs: 60,
      log            : (message) => messages.push(message)
    })
    const failure  = driver.settle((v) => isPage(v, 'instmods', id), 'the modulators')
    await expect(failure).rejects.toThrow('its content kept changing between reads')
    expect(messages.some((message) => message.includes('the modulators failed') && message.includes('05|'))).toBe(true)
  })

  test('a view that never passes the fully-drawn check says that', async () => {
    const driver  = new M8Driver(modsView(0), {
      pollMs         : 0,
      settleTimeoutMs: 40
    })
    const failure = driver.settle((v) => isPage(v, 'song'), 'the song view')
    await expect(failure).rejects.toBeInstanceOf(M8MoveError)
    await expect(failure).rejects.toThrow('it never passed the fully-drawn check')
  })
})

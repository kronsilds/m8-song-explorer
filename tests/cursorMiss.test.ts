import { describe, expect, test } from 'bun:test'
import { type CursorMiss, M8Driver } from '../src/m8/driver'
import { songCellX } from '../src/m8/screen/screenReader'
import { demoSong } from '../src/model/demo'
import { FakeM8 } from './fakeM8'

/** An M8 whose navigateTo answers like the SDK did on the device: true, with the cursor left short of the cell. */
class ShortFake extends FakeM8 {
  answer = true
  constructor(model: ConstructorParameters<typeof FakeM8>[0]) {
    super(model)
    this.view = 'song'
  }
  override async navigateTo(x: number, y: number): Promise<boolean> {
    await super.navigateTo(x - 3, y)
    return this.answer
  }
}

const drive = (fake: ShortFake) => {
  const misses : CursorMiss[] = []
  const driver = new M8Driver(fake, {
    pollMs      : 0,
    onCursorMiss: (miss) => misses.push(miss)
  })
  return { driver, misses }
}

describe('cursor misses', () => {
  test('navigateTo that says true with the cursor on another cell is reported, and the arrows finish the move', async () => {
    const fake               = new ShortFake(demoSong())
    const { driver, misses } = drive(fake)
    await driver.moveToSongCell(0, 3)
    expect(misses.length).toBeGreaterThan(0)
    expect(misses[0]).toMatchObject({
      outcome: 'wrong-cell',
      target : { x: songCellX(3) },
      view   : 'song'
    })
    expect(misses[0].cursor?.x).not.toBe(songCellX(3))
    expect((await fake.getState()).cursorPos?.x).toBe(songCellX(3))
  })

  test('navigateTo that says false is reported as refused', async () => {
    const fake               = new ShortFake(demoSong())
    fake.answer              = false
    const { driver, misses } = drive(fake)
    await driver.moveToSongCell(0, 3)
    expect(misses[0]?.outcome).toBe('refused')
  })

  test('a navigateTo that fails is reported with its error, and still fails', async () => {
    const fake               = new ShortFake(demoSong())
    fake.navigateTo          = async () => {
      throw new Error('navigateTo(1, 2) did not answer within 5000 ms')
    }
    const { driver, misses } = drive(fake)
    await expect(driver.moveToSongCell(0, 3)).rejects.toThrow('did not answer')
    expect(misses[0]).toMatchObject({
      outcome: 'error',
      error  : 'navigateTo(1, 2) did not answer within 5000 ms'
    })
  })
})

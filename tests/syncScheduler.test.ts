import { describe, expect, test } from 'bun:test'
import { FOLLOW_MAX_WAIT_MS, FOLLOW_QUIET_MS, SETTLE_MS, type SyncClock, type SyncKind, SyncScheduler } from '../src/app/syncScheduler'

/** A clock that only moves when the test says so. */
class FakeClock implements SyncClock {
  time           = 0
  private timers = new Map<number, { at: number; run: () => void }>()
  private nextId = 1

  now        = (): number => this.time
  setTimer   = (run: () => void, ms: number): number => {
    const id = this.nextId++
    this.timers.set(id, {
      at: this.time + ms,
      run
    })
    return id
  }
  clearTimer = (id: number): void => {
    this.timers.delete(id)
  }

  /** Moves to `time`, running the timers due on the way, in order, and letting the reads they start end. */
  async advanceTo(time: number): Promise<void> {
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= time).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.time = due[1].at
      due[1].run()
      await drain()
    }
    this.time = time
  }
}

/** Lets the reads that ended hand over to the queued ones. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A scheduler whose reads end at once, and the reads it made with their times. */
function scheduler() {
  const clock = new FakeClock()
  const reads : { kind: SyncKind; at: number }[] = []
  const syncs = new SyncScheduler(async (kind) => {
    reads.push({
      kind,
      at: clock.time
    })
  }, clock)
  return { clock, reads, syncs }
}

describe('reading the M8 after its events', () => {
  test('one move: the cursor is read once the burst has passed, edits once the screen is quiet', async () => {
    const { clock, reads, syncs } = scheduler()
    syncs.poke()
    await clock.advanceTo(FOLLOW_QUIET_MS - 1)
    expect(reads).toEqual([])
    await clock.advanceTo(SETTLE_MS)
    expect(reads).toEqual([{
      kind: 'follow',
      at  : FOLLOW_QUIET_MS
    }, {
      kind: 'settled',
      at  : SETTLE_MS
    }])
  })

  test('moves faster than the settle time are each followed; edits wait for the last one', async () => {
    const { clock, reads, syncs } = scheduler()
    for (const at of [0, 50, 100, 150]) {
      await clock.advanceTo(at)
      syncs.poke()
    }
    await clock.advanceTo(1000)
    expect(reads).toEqual([{
      kind: 'follow',
      at  : 30
    }, {
      kind: 'follow',
      at  : 80
    }, {
      kind: 'follow',
      at  : 130
    }, {
      kind: 'follow',
      at  : 180
    }, {
      kind: 'settled',
      at  : 150 + SETTLE_MS
    }])
  })

  test('a stream of events (a held key, a song playing) still has the cursor read regularly', async () => {
    const { clock, reads, syncs } = scheduler()
    for (let at = 0; at <= 500; at += 10) {
      await clock.advanceTo(at)
      syncs.poke()
    }
    const follows = reads.filter((read) => read.kind === 'follow').map((read) => read.at)
    expect(follows.length).toBeGreaterThanOrEqual(4)
    const gaps    = follows.slice(1).map((at, i) => at - follows[i])
    expect(Math.max(...gaps)).toBeLessThanOrEqual(FOLLOW_MAX_WAIT_MS + 10)
    expect(reads.some((read) => read.kind === 'settled')).toBe(false)
    await clock.advanceTo(500 + SETTLE_MS)
    expect(reads.at(-1)).toEqual({
      kind: 'settled',
      at  : 500 + SETTLE_MS
    })
  })

  test('one read at a time; what was asked meanwhile runs after it, a settled read standing for a follow', async () => {
    const clock = new FakeClock()
    const reads : SyncKind[] = []
    let running = 0
    let most    = 0
    let release = () => {}
    const syncs = new SyncScheduler((kind) => {
      reads.push(kind)
      running += 1
      most    = Math.max(most, running)
      return new Promise<void>((resolve) => {
        release = () => {
          running -= 1
          resolve()
        }
      })
    }, clock)
    syncs.poke()
    await clock.advanceTo(FOLLOW_QUIET_MS)
    expect(reads).toEqual(['follow'])
    // While the first read hangs: another move (a follow), then quiet (a settled read).
    await clock.advanceTo(40)
    syncs.poke()
    await clock.advanceTo(40 + SETTLE_MS)
    expect(reads).toEqual(['follow'])
    release()
    await drain()
    expect(reads).toEqual(['follow', 'settled'])
    release()
    await drain()
    expect(reads).toEqual(['follow', 'settled'])
    expect(most).toBe(1)
  })
})

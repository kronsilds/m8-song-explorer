// When the app reads the M8 after its events. The cursor is followed soon after each move,
// and still regularly while events keep coming; edits made on the device are folded into the
// model only once the screen has been quiet long enough to be fully drawn. One read runs at a
// time, so the results come in the order the reads were asked.

/** 'follow': where the cursor is. 'settled': that, plus edits, another song and theme colours. */
export type SyncKind = 'follow' | 'settled'

/** The clock the scheduler runs on: the browser's, or a fake one in the tests. */
export interface SyncClock {
  now       : () => number
  setTimer  : (run: () => void, ms: number) => number
  clearTimer: (id: number) => void
}

/** Quiet time before the cursor is read: the M8 sends what it draws for a key in a burst of a few ms. */
export const FOLLOW_QUIET_MS    = 30
/** While events keep coming (a held key, notes on the cursor row while the song plays), the cursor is still read this often. */
export const FOLLOW_MAX_WAIT_MS = 100
/** Quiet time before edits are read: long enough for a whole redraw to have ended. */
export const SETTLE_MS          = 140

const browserClock: SyncClock = {
  now       : () => performance.now(),
  setTimer  : (run, ms) => window.setTimeout(run, ms),
  clearTimer: (id) => window.clearTimeout(id)
}

export class SyncScheduler {
  private readonly read  : (kind: SyncKind) => Promise<void>
  private readonly clock : SyncClock
  private followTimer    : number | null = null
  /** When the first event not followed yet came. */
  private waitingSince   = 0
  private settleTimer    : number | null = null
  private reading        = false
  /** The read to run once the current one ends. */
  private queued         : SyncKind | null = null

  constructor(read: (kind: SyncKind) => Promise<void>, clock: SyncClock = browserClock) {
    this.read  = read
    this.clock = clock
  }

  /** An M8 event, or another reason to look again: a follow read soon, a settled read once quiet. */
  poke(): void {
    const now = this.clock.now()
    if (this.followTimer == null) this.waitingSince = now
    else this.clock.clearTimer(this.followTimer)
    const left       = Math.max(0, this.waitingSince + FOLLOW_MAX_WAIT_MS - now)
    this.followTimer = this.clock.setTimer(() => {
      this.followTimer = null
      this.request('follow')
    }, Math.min(FOLLOW_QUIET_MS, left))
    if (this.settleTimer != null) this.clock.clearTimer(this.settleTimer)
    this.settleTimer = this.clock.setTimer(() => {
      this.settleTimer = null
      this.request('settled')
    }, SETTLE_MS)
  }

  /** Reads now, or right after the read running; a settled read also does what a follow read does. */
  private request(kind: SyncKind): void {
    if (this.reading) {
      if (this.queued !== 'settled') this.queued = kind
      return
    }
    this.reading = true
    void this.read(kind).finally(() => {
      this.reading = false
      const next   = this.queued
      this.queued  = null
      if (next) this.request(next)
    })
  }
}

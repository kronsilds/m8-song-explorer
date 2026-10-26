// The debug log: what to send with a bug report. Three parts with three lifetimes:
//   - global state (connection, permissions, MIDI sync, song, settings): providers read when the log is exported;
//   - exploration and device task runs, and problems: kept for the whole session;
//   - events: a rolling buffer of the last user actions and playback happenings.
// Plain data; the page-wide instance is `debugLog`. Nothing here touches the DOM or the M8.

export type EventData = Record<string, unknown>

export interface LogEvent extends EventData {
  /** Counts every event of the session: gaps in a window of the buffer show what was dropped. */
  seq : number
  /** Milliseconds since the page started. */
  t   : number
  type: string
}

export type RunKind = 'explore' | 'sync' | 'theme'
export type RunOutcome = 'running' | 'done' | 'cancelled' | 'failed'

export interface LogRun {
  id             : number
  kind           : RunKind
  /** Milliseconds since the page started, when it began and ended. */
  t              : number
  endT           : number | null
  durationMs     : number | null
  outcome        : RunOutcome
  info           : EventData
  /** When each phase began (exploring: song, chains, instruments ...). */
  phases         : { t: number; phase: string; message: string }[]
  /** What the run said while it went (the driver's retries, moves that failed), head kept. */
  messages       : { t: number; text: string }[]
  messagesDropped: number
  /** The warnings the run ended with. */
  warnings       : string[]
  result         : EventData
}

export interface LogProblem {
  source    : string
  message   : string
  detail?   : unknown
  count     : number
  firstT    : number
  lastT     : number
  /** When the thing that failed worked again (a later attempt succeeded). */
  resolvedT?: number
}

export interface DebugReport {
  format       : 'm8-song-explorer-debug'
  version      : 1
  exportedAt   : string
  pageStartedAt: string
  uptimeMs     : number
  /** State right now, one entry per provider. */
  global       : Record<string, unknown>
  /** The exploration runs, newest last. */
  exploration  : LogRun[]
  /** The MIDI sync checks and theme reads. */
  deviceTasks  : LogRun[]
  problems     : LogProblem[]
  eventLimit   : number
  /** Events pushed out of the rolling buffer since the page started. */
  eventsDropped: number
  events       : LogEvent[]
}

export interface DebugLogOptions {
  eventLimit?: number
  /** Milliseconds since the page started. */
  now?       : () => number
  /** Epoch milliseconds when the page started. */
  startedAt? : number
  wall?      : () => number
}

export const EVENT_LIMIT = 400
const RUNS_PER_KIND      = 5
const RUN_MESSAGE_LIMIT  = 300
const PROBLEM_LIMIT      = 60
const TEXT_LIMIT         = 400
/** A run's messages may carry a screen dump. */
const MESSAGE_LIMIT      = 1600

/** A long message cut short (screen dumps in the exploration's log would swamp the file). */
export const clip = (text: string, limit = TEXT_LIMIT): string => (text.length > limit ? `${text.slice(0, limit)}…` : text)

const rounded = (ms: number): number => Math.round(ms * 10) / 10

type Provider = () => unknown | Promise<unknown>

/** A run in progress: the exploration or a device task writes its story here. */
export class RunHandle {
  constructor(
    private readonly run: LogRun,
    private readonly now: () => number,
  ) {}

  phase(phase: string, message: string): void {
    const { phases } = this.run
    if (phases.at(-1)?.phase !== phase) phases.push({
      t      : rounded(this.now()),
      phase,
      message: clip(message)
    })
  }

  message(text: string): void {
    if (this.run.messages.length >= RUN_MESSAGE_LIMIT) {
      this.run.messagesDropped += 1
      return
    }
    this.run.messages.push({
      t   : rounded(this.now()),
      text: clip(text, MESSAGE_LIMIT)
    })
  }

  finish(outcome: Exclude<RunOutcome, 'running'>, result: EventData = {}, warnings: string[] = []): void {
    const endT          = rounded(this.now())
    this.run.endT       = endT
    this.run.durationMs = rounded(endT - this.run.t)
    this.run.outcome    = outcome
    this.run.result     = result
    this.run.warnings   = warnings.map((warning) => clip(warning))
  }
}

export class DebugLog {
  private readonly eventLimit  : number
  private readonly now         : () => number
  private readonly startedAt   : number
  private readonly wall        : () => number
  private readonly providers   = new Map<string, Provider>()
  private readonly runs        : LogRun[] = []
  private readonly problems    = new Map<string, LogProblem>()
  private readonly lastEmitted = new Map<string, { t: number; suppressed: number }>()
  private events               : LogEvent[] = []
  private sequence             = 0
  private runSequence          = 0
  private dropped              = 0

  constructor(options: DebugLogOptions = {}) {
    this.eventLimit = options.eventLimit ?? EVENT_LIMIT
    this.now        = options.now ?? (() => performance.now())
    this.startedAt  = options.startedAt ?? (typeof performance === 'undefined' ? Date.now() : performance.timeOrigin)
    this.wall       = options.wall ?? (() => Date.now())
  }

  // ---------------------------------------------------------------------------
  // Rolling events

  /** One thing the user did or the playback went through. The oldest event goes when the buffer is full. */
  event(type: string, data: EventData = {}): void {
    this.sequence += 1
    this.events.push({
      seq: this.sequence,
      t  : rounded(this.now()),
      type,
      ...data
    })
    if (this.events.length > this.eventLimit) {
      this.events.splice(0, this.events.length - this.eventLimit)
      this.dropped = this.sequence - this.events.length
    }
  }

  /**
   * An event that may come in bursts (a drifting playhead, a clock stalling): at most one per
   * `intervalMs` for the same `key`, the next one carrying how many were left out.
   */
  throttled(key: string, intervalMs: number, type: string, data: EventData = {}): void {
    const now  = this.now()
    const last = this.lastEmitted.get(key)
    if (last && now - last.t < intervalMs) {
      last.suppressed += 1
      return
    }
    this.lastEmitted.set(key, {
      t         : now,
      suppressed: 0
    })
    this.event(type, last?.suppressed ? {
      ...data,
      suppressed: last.suppressed
    } : data)
  }

  // ---------------------------------------------------------------------------
  // Problems: kept for the whole session, repeats counted

  problem(source: string, message: string, detail?: unknown): void {
    const key      = `${source}|${message}`
    const now      = rounded(this.now())
    const existing = this.problems.get(key)
    if (existing) {
      existing.count += 1
      existing.lastT = now
      delete existing.resolvedT
      return
    }
    this.problems.set(key, {
      source,
      message: clip(message),
      ...(detail === undefined ? {} : { detail }),
      count  : 1,
      firstT : now,
      lastT  : now
    })
    if (this.problems.size > PROBLEM_LIMIT) {
      const oldest = [...this.problems.entries()].sort((a, b) => a[1].lastT - b[1].lastT)[0]
      this.problems.delete(oldest[0])
    }
  }

  /** The thing that failed under `source` worked again: its problems stay listed, marked with the time. */
  resolve(source: string): void {
    const now = rounded(this.now())
    for (const problem of this.problems.values()) if (problem.source === source && problem.resolvedT == null) problem.resolvedT = now
  }

  // ---------------------------------------------------------------------------
  // Exploration and device tasks

  startRun(kind: RunKind, info: EventData = {}): RunHandle {
    this.runSequence += 1
    const run        : LogRun = {
      id             : this.runSequence,
      kind,
      t              : rounded(this.now()),
      endT           : null,
      durationMs     : null,
      outcome        : 'running',
      info,
      phases         : [],
      messages       : [],
      messagesDropped: 0,
      warnings       : [],
      result         : {}
    }
    this.runs.push(run)
    const ofKind = this.runs.filter((other) => other.kind === kind)
    if (ofKind.length > RUNS_PER_KIND) this.runs.splice(this.runs.indexOf(ofKind[0]), 1)
    return new RunHandle(run, this.now)
  }

  // ---------------------------------------------------------------------------
  // Global state

  /** A section of the global state, read when the log is exported (a value, or a function returning one). */
  provide(section: string, value: unknown): void {
    this.providers.set(section, typeof value === 'function' ? (value as Provider) : () => value)
  }

  /** The whole log as plain JSON. A provider that throws leaves an `error` in its section. */
  async report(): Promise<DebugReport> {
    const global: Record<string, unknown> = {}
    for (const [section, provider] of this.providers) {
      try {
        global[section] = await provider()
      } catch (error) {
        global[section] = { error: error instanceof Error ? error.message : String(error) }
      }
    }
    const uptime = rounded(this.now())
    return {
      format       : 'm8-song-explorer-debug',
      version      : 1,
      exportedAt   : new Date(this.wall()).toISOString(),
      pageStartedAt: new Date(this.startedAt).toISOString(),
      uptimeMs     : uptime,
      global,
      exploration  : this.runs.filter((run) => run.kind === 'explore'),
      deviceTasks  : this.runs.filter((run) => run.kind !== 'explore'),
      problems     : [...this.problems.values()],
      eventLimit   : this.eventLimit,
      eventsDropped: this.dropped,
      events       : [...this.events]
    }
  }
}

/** The page's log. */
export const debugLog = new DebugLog()

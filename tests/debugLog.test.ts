import { describe, expect, test } from 'bun:test'
import type { M8Client, M8TransportEvent } from '@yam8d/m8-sdk'
import { PlaybackFeed } from '../src/app/playbackFeed'
import { type PlaybackEvent, PlaybackTracker } from '../src/m8/playback'
import { DebugLog } from '../src/model/debugLog'
import { demoSong } from '../src/model/demo'
import { grooveReports, summarizeTicks } from '../src/model/music/groove'
import { FIRST_CONTENT_ROW, phraseScreen } from '../src/model/screens'
import type { Groove } from '../src/model/song'
import { buildTimeline } from '../src/model/timeline'
import type { World } from '../src/scene/world'

/** A log on a clock the test moves. */
function clockedLog(eventLimit = 5) {
  const clock = { now: 0 }
  const log   = new DebugLog({
    eventLimit,
    now      : () => clock.now,
    startedAt: Date.UTC(2026, 9, 26, 12, 0, 0),
    wall     : () => Date.UTC(2026, 9, 26, 12, 5, 0)
  })
  return { clock, log }
}

const groove = (id: number, ticks: number[], ppq = 24): Groove => ({
  id,
  ticks: [...ticks, ...Array(16 - ticks.length).fill(null)],
  ppq
})

describe('debug log', () => {
  test('the rolling events keep the last N and count what was dropped', async () => {
    const { clock, log } = clockedLog(5)
    for (let n = 1; n <= 8; n += 1) {
      clock.now = n * 10
      log.event('step', { n })
    }
    const report = await log.report()
    expect(report.events.map((event) => event.n)).toEqual([4, 5, 6, 7, 8])
    expect(report.events.map((event) => event.seq)).toEqual([4, 5, 6, 7, 8])
    expect(report.events[0]).toMatchObject({
      type: 'step',
      t   : 40
    })
    expect(report.eventsDropped).toBe(3)
    expect(report.eventLimit).toBe(5)
  })

  test('exploration runs, problems and global sections survive any number of events', async () => {
    const { clock, log } = clockedLog(3)
    log.provide('connection', {
      mode     : 'standalone',
      transport: 'serial'
    })
    log.provide('live', () => ({ answer: 42 }))
    log.provide('permissions', async () => ({ midi: 'granted' }))
    log.provide('broken', () => {
      throw new Error('no access')
    })
    const run = log.startRun('explore', { previousSong: 'DEMO' })
    clock.now = 100
    run.phase('song', 'Reading the song view')
    run.phase('song', 'Song rows 00-0F')
    run.phase('chains', 'Chain 01')
    run.message('Option+Down in the phrase view did not reach the next phrase')
    clock.now = 900
    run.finish('done', { chains: 12 }, ['instrument 07: waited 2000 ms'])
    log.problem('sync', 'getScreen did not answer within 4000 ms')
    for (let n = 0; n < 50; n += 1) log.event('drift', { n })

    const report = await log.report()
    expect(report.events).toHaveLength(3)
    expect(report.global).toEqual({
      connection : {
        mode     : 'standalone',
        transport: 'serial'
      },
      live       : { answer: 42 },
      permissions: { midi: 'granted' },
      broken     : { error: 'no access' }
    })
    expect(report.exploration).toHaveLength(1)
    expect(report.exploration[0]).toMatchObject({
      kind      : 'explore',
      outcome   : 'done',
      durationMs: 900,
      info      : { previousSong: 'DEMO' },
      result    : { chains: 12 },
      warnings  : ['instrument 07: waited 2000 ms']
    })
    expect(report.exploration[0].phases.map((phase) => phase.phase)).toEqual(['song', 'chains'])
    expect(report.exploration[0].messages).toHaveLength(1)
    expect(report.problems).toHaveLength(1)
    expect(report.exportedAt).toBe('2026-10-26T12:05:00.000Z')
    expect(report.pageStartedAt).toBe('2026-10-26T12:00:00.000Z')
    // It is plain JSON.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })

  test('only the last runs of each kind are kept, and a run keeps the head of its messages', async () => {
    const { log } = clockedLog()
    for (let n = 0; n < 8; n += 1) log.startRun('explore', { n }).finish('done')
    log.startRun('sync').finish('done')
    const run = log.startRun('explore')
    for (let n = 0; n < 400; n += 1) run.message(`message ${n}`)
    const report = await log.report()
    expect(report.exploration.map((r) => r.info.n)).toEqual([4, 5, 6, 7, undefined])
    expect(report.deviceTasks).toHaveLength(1)
    const last = report.exploration.at(-1)
    expect(last?.messages).toHaveLength(300)
    expect(last?.messages[0].text).toBe('message 0')
    expect(last?.messagesDropped).toBe(100)
    expect(last?.outcome).toBe('running')
  })

  test('a repeated problem is counted, not listed again', async () => {
    const { clock, log } = clockedLog()
    clock.now            = 10
    log.problem('sync', 'timeout')
    clock.now = 20
    log.problem('sync', 'timeout')
    clock.now = 30
    log.problem('sync', 'timeout')
    log.problem('storage', 'full')
    const report = await log.report()
    expect(report.problems).toEqual([{
      source : 'sync',
      message: 'timeout',
      count  : 3,
      firstT : 10,
      lastT  : 30
    }, {
      source : 'storage',
      message: 'full',
      count  : 1,
      firstT : 30,
      lastT  : 30
    }])
  })

  test('a burst of one kind of event is thinned out, the next one saying how many were left out', async () => {
    const { clock, log } = clockedLog(20)
    for (const now of [0, 50, 100, 200, 260, 300]) {
      clock.now = now
      log.throttled('drift:1', 250, 'drift', { track: 1 })
    }
    log.throttled('drift:2', 250, 'drift', { track: 2 })
    const report = await log.report()
    expect(report.events.map((event) => [event.track, event.t, event.suppressed])).toEqual([
      [1, 0, undefined],
      [1, 260, 3],
      [2, 300, undefined]
    ])
  })
})

describe('grooves in the log', () => {
  test('lists the grooves the song plays with, flags the ones that are not plain sixteenths and what points at them', () => {
    const model           = demoSong()
    model.projectGroove   = 1
    model.grooves         = {
      1: groove(1, [8, 4]),
      3: groove(3, [6, 6]),
      5: groove(5, [0x10, 0x10], 48)
    }
    const [first, second] = Object.values(model.phrases)
    first.steps[2].fx[0]  = {
      cmd: 'GRV',
      val: 3
    }
    second.steps[0].fx[1] = {
      cmd: 'GGR',
      val: 5
    }
    second.steps[1].fx[1] = {
      cmd: 'GRV',
      val: 9
    }
    expect(grooveReports(model)).toEqual([{
      id      : 1,
      loop    : [8, 4],
      ppq     : 24,
      standard: false,
      read    : true,
      usedBy  : ['project']
    }, {
      id      : 3,
      loop    : [6, 6],
      ppq     : 24,
      standard: true,
      read    : true,
      usedBy  : ['GRV']
    }, {
      id      : 5,
      loop    : [8, 8],
      ppq     : 48,
      standard: false,
      read    : true,
      usedBy  : ['GGR']
    }, {
      id      : 9,
      loop    : [6],
      ppq     : null,
      standard: true,
      read    : false,
      usedBy  : ['GRV']
    }])
  })

  test('summarizes how the steps of a chain differ from the plain sixteenth', () => {
    expect(summarizeTicks(Array(16).fill(6))).toEqual({
      steps      : 16,
      nonStandard: 0,
      distinct   : [6]
    })
    expect(summarizeTicks([8, 4, 8, 4, 0, 6])).toEqual({
      steps      : 6,
      nonStandard: 5,
      distinct   : [0, 4, 6, 8]
    })
  })
})

describe('playback events', () => {
  const model    = demoSong()
  const timeline = buildTimeline(model)
  const bandRow  = (songRow: number) => timeline.bands.find((b) => b.songRow === songRow)?.row as number

  test('a MIDI start places the tracks, Stop ends it, and a second start counts as a restart', () => {
    const tracker   = new PlaybackTracker(model, timeline)
    const events    : PlaybackEvent[] = []
    tracker.onEvent = (event) => events.push(event)
    tracker.clockTick(600, 12000, 20)
    expect(tracker.transportStart(bandRow(3), 12000)).toBe(true)
    expect(events).toEqual([{
      kind    : 'started',
      source  : 'transport',
      spp     : bandRow(3),
      startRow: 3
    }])
    expect(tracker.describeTracks().length).toBeGreaterThan(0)
    expect(tracker.describeTracks()[0]).toMatchObject({
      songRow: 3,
      step   : 0,
      ticks  : {
        nonStandard: 0,
        distinct   : [6]
      }
    })
    tracker.transportStart(bandRow(3), 12100)
    tracker.transportReset('transport-stop')
    expect(events.map((event) => (event.kind === 'stopped' ? `stopped:${event.reason}` : event.kind))).toEqual([
      'started',
      'stopped:restart',
      'started',
      'stopped:transport-stop'
    ])
    // Nothing playing: a reset says nothing.
    tracker.transportReset('device-down')
    expect(events).toHaveLength(4)
  })
})

describe('playback feed in the log', () => {
  test('play start context, transport, clock gaps, drifts and the stop end up in the events', async () => {
    const model    = demoSong()
    const timeline = buildTimeline(model)
    const log      = new DebugLog({ eventLimit: 50 })
    const world    = {
      layout           : { timeline },
      setPlayheadSource: () => {}
    } as unknown as World
    const feed     = new PlaybackFeed(world, () => model, () => null, () => false, log)
    feed.appState  = () => ({ following: true })
    let send       : (event: M8TransportEvent) => void = () => {}
    feed.listenToClock({
      onTransport: (callback: (event: M8TransportEvent) => void) => {
        send = callback
        return () => {}
      }
    } as unknown as M8Client)
    const at      = (ms: number) => performance.timeOrigin + ms
    const clock   = (tick: number, ms: number): M8TransportEvent => ({
      kind     : 'clock',
      ticks    : tick,
      at       : at(ms),
      msPerTick: 20
    })
    const songRow = 3
    const bandRow = timeline.bands.find((b) => b.songRow === songRow)?.row as number

    feed.tracker.context = {
      songRow,
      track: 0
    }
    send(clock(600, 12000))
    send({
      kind     : 'position',
      ticks    : 600,
      at       : at(12000),
      msPerTick: 20,
      spp      : bandRow
    })
    send({
      kind     : 'continue',
      ticks    : 600,
      at       : at(12000),
      msPerTick: 20
    })
    send(clock(606, 12120))
    // The clock stalls for a second.
    send(clock(612, 13240))

    // The M8 shows step 9 of the kick's phrase where the tracker is on step 0.
    const kick     = model.song[songRow][0] as number
    const phraseId = model.chains[kick].rows[0].phrase as number
    const lines    = phraseScreen(model.phrases[phraseId])
    const y        = FIRST_CONTENT_ROW + 9
    lines[y]       = `${lines[y].slice(0, 2)}>${lines[y].slice(3)}`
    feed.tracker.observe({
      width : 40,
      height: 24,
      lines
    }, 12100)

    send({
      kind     : 'stop',
      ticks    : 700,
      at       : at(14000),
      msPerTick: 20
    })

    const { events, global } = await log.report()
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['transport', 'play-start', 'clock-gap', 'drift', 'play-stop']))
    const start = events.find((event) => event.type === 'play-start')
    expect(start).toMatchObject({
      source  : 'transport',
      startRow: songRow,
      cursor  : {
        songRow,
        track: 0
      },
      app     : { following: true },
      timeBase: 'MIDI clock'
    })
    const placed = (start?.tracks ?? []) as { track: number; songRow: number }[]
    expect(placed.length).toBeGreaterThan(0)
    expect(placed.every((t) => t.songRow <= songRow)).toBe(true)
    expect(events.find((event) => event.type === 'clock-gap')).toMatchObject({
      gapMs   : 1120,
      expected: 120
    })
    expect(events.find((event) => event.type === 'drift')).toMatchObject({
      track    : 1,
      songRow,
      actual   : 9,
      timeBase : 'MIDI clock',
      stepTicks: 6
    })
    const stop = events.find((event) => event.type === 'play-stop')
    expect(stop).toMatchObject({
      reason : 'transport-stop',
      session: {
        corrections: 1,
        maxSteps   : expect.any(Number),
        clockGaps  : 1
      }
    })
    expect(global.playback).toMatchObject({
      playing: false,
      totals : {
        sessions   : 1,
        corrections: 1
      },
      clock  : {
        gaps    : 1,
        maxGapMs: 1120
      }
    })
  })
})

describe('log noise and context', () => {
  const model    = demoSong()
  const timeline = buildTimeline(model)
  const songRow  = 3
  const bandRow  = timeline.bands.find((b) => b.songRow === songRow)?.row as number
  const at       = (ms: number) => performance.timeOrigin + ms

  function playingFeed(log: DebugLog) {
    const world = {
      layout           : { timeline },
      setPlayheadSource: () => {}
    } as unknown as World
    const feed  = new PlaybackFeed(world, () => model, () => null, () => false, log)
    let send    : (event: M8TransportEvent) => void = () => {}
    feed.listenToClock({
      onTransport: (callback: (event: M8TransportEvent) => void) => {
        send = callback
        return () => {}
      }
    } as unknown as M8Client)
    feed.tracker.context = {
      songRow,
      track: 0
    }
    return {
      feed,
      send: (event: M8TransportEvent) => send(event)
    }
  }

  test('a clock whose measured tempo wobbles is not logged as a tempo change', async () => {
    const log      = new DebugLog({ eventLimit: 200 })
    const { send } = playingFeed(log)
    send({
      kind     : 'clock',
      ticks    : 600,
      at       : at(12000),
      msPerTick: 19.5
    })
    send({
      kind     : 'position',
      ticks    : 600,
      at       : at(12000),
      msPerTick: 19.5,
      spp      : bandRow
    })
    send({
      kind     : 'continue',
      ticks    : 600,
      at       : at(12000),
      msPerTick: 19.5
    })
    // 40 sixteenths, each measured a little fast or slow (about 126 to 131 BPM).
    for (let n = 1; n <= 40; n += 1) send({
      kind     : 'clock',
      ticks    : 600 + n * 6,
      at       : at(12000 + n * 117),
      msPerTick: n % 2 ? 19.1 : 19.9
    })
    const { events, global } = await log.report()
    expect(events.filter((event) => event.type === 'tempo')).toHaveLength(1)
    expect((global.playback as { clock: { bpm: number } }).clock.bpm).toBeGreaterThan(126)
    expect((global.playback as { clock: { bpm: number } }).clock.bpm).toBeLessThan(131)
  })

  test('the tempo restarts when the clock comes back after a pause, and ignores wild first measurements', async () => {
    const log      = new DebugLog({ eventLimit: 200 })
    const { send } = playingFeed(log)
    // A song at 125 BPM (19.2 ms per tick), then the clock stops for 30 s and returns at 150 BPM (16.7 ms).
    send({
      kind     : 'clock',
      ticks    : 600,
      at       : at(12000),
      msPerTick: 19.2
    })
    send({
      kind     : 'position',
      ticks    : 600,
      at       : at(12000),
      msPerTick: 19.2,
      spp      : bandRow
    })
    send({
      kind     : 'continue',
      ticks    : 600,
      at       : at(12000),
      msPerTick: 19.2
    })
    for (let n = 1; n <= 30; n += 1) send({
      kind     : 'clock',
      ticks    : 600 + n * 6,
      at       : at(12000 + n * 115),
      msPerTick: 19.2
    })
    const afterPause = 12000 + 30 * 115 + 30000
    // The first measurement after the pause is wild (it spans the pause), the next ones are right.
    send({
      kind     : 'clock',
      ticks    : 1000,
      at       : at(afterPause),
      msPerTick: 60
    })
    for (let n = 1; n <= 7; n += 1) send({
      kind     : 'clock',
      ticks    : 1000 + n * 6,
      at       : at(afterPause + n * 100),
      msPerTick: 16.7
    })
    const { global, events } = await log.report()
    const clock              = (global.playback as { clock: { bpm: number } }).clock
    expect(clock.bpm).toBeGreaterThan(147)
    expect(clock.bpm).toBeLessThan(153)
    expect(events.find((event) => event.type === 'clock-gap')).toMatchObject({ playing: true })
  })

  test('a clock that was just enabled is not reported missing, and the refusal before it is marked resolved', async () => {
    const log      = new DebugLog()
    const { feed } = playingFeed(log)
    let answer     = {
      ok   : false,
      error: 'WebMIDI requires a site permission add-on to activate'
    }
    const client   = { enableMidiTransport: async () => answer } as unknown as M8Client
    await feed.enableClock(client)
    answer = {
      ok   : true,
      error: undefined
    } as unknown as typeof answer
    await feed.enableClock(client)
    feed.tracker.transportStart(bandRow, 12000)
    ;(feed as unknown as { checkClockWhilePlaying(): void }).checkClockWhilePlaying()
    const report = await log.report()
    expect(report.events.map((event) => event.type)).not.toContain('no-clock-while-playing')
    expect(report.problems).toHaveLength(1)
    expect(report.problems[0]).toMatchObject({
      source: 'midi-clock',
      count : 1
    })
    expect(report.problems[0].resolvedT).toBeGreaterThanOrEqual(report.problems[0].firstT)
  })

  test('a problem that comes back is no longer marked resolved', async () => {
    const { clock, log } = clockedLog()
    log.problem('midi-clock', 'refused')
    clock.now = 50
    log.resolve('midi-clock')
    expect((await log.report()).problems[0].resolvedT).toBe(50)
    clock.now = 80
    log.problem('midi-clock', 'refused')
    const [problem] = (await log.report()).problems
    expect(problem.resolvedT).toBeUndefined()
    expect(problem.count).toBe(2)
  })

  test('a reanchor says how far off the prediction was', () => {
    const tracker   = new PlaybackTracker(model, timeline)
    const events    : PlaybackEvent[] = []
    tracker.onEvent = (event) => events.push(event)
    tracker.clockTick(600, 12000, 20)
    tracker.transportStart(bandRow, 12000)
    // The M8 shows step 9 of a phrase after 5 ticks: 49 ticks sooner than the tracker had it.
    const kick     = model.song[songRow][0] as number
    const phraseId = model.chains[kick].rows[0].phrase as number
    const lines    = phraseScreen(model.phrases[phraseId])
    const y        = FIRST_CONTENT_ROW + 9
    lines[y]       = `${lines[y].slice(0, 2)}>${lines[y].slice(3)}`
    tracker.clockTick(605, 12100, 20)
    tracker.observe({
      width : 40,
      height: 24,
      lines
    }, 12100)
    const reanchor = events.find((event) => event.kind === 'reanchor')
    expect(reanchor).toMatchObject({
      reason: 'window',
      from  : {
        songRow,
        step: 0
      },
      to    : {
        songRow,
        step: 9
      }
    })
    expect((reanchor as { offTicks: number }).offTicks).toBeLessThan(-30)
  })
})

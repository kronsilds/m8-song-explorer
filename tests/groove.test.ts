import { describe, expect, test } from 'bun:test'
import { PlaybackTracker } from '../src/m8/playback'
import { readGroove, viewOf } from '../src/m8/screen/screenReader'
import { exploreSong } from '../src/m8/tasks/explorer'
import { demoSong } from '../src/model/demo'
import { chainStepTicks, grooveLoop, occurrenceKey, referencedGrooves, stepClockTicks } from '../src/model/music/groove'
import { FIRST_CONTENT_ROW, grooveScreen, phraseScreen } from '../src/model/screens'
import type { Groove, SongModel } from '../src/model/song'
import { buildTimeline } from '../src/model/timeline'
import { FakeM8 } from './fakeM8'

const groove   = (id: number, ticks: number[], ppq = 24): Groove => ({
  id,
  ticks: [...ticks, ...Array(16 - ticks.length).fill(null)],
  ppq
})
const SWING    = groove(1, [8, 4])
const TRIPLETS = groove(3, [0x10, 0x10, 0x10, 0], 48)

describe('grooves', () => {
  test('step lengths in clock ticks: the loop, skipped steps and the PPQ', () => {
    expect(grooveLoop(SWING)).toEqual([8, 4])
    expect([0, 1, 2, 3].map((s) => stepClockTicks(SWING, s))).toEqual([8, 4, 8, 4])
    // 48 PPQ: 10 (hex) = 16 ticks = 8 clock ticks; 00 skips the step.
    expect([0, 1, 2, 3, 4].map((s) => stepClockTicks(TRIPLETS, s))).toEqual([8, 8, 8, 0, 8])
    expect(stepClockTicks(undefined, 5)).toBe(6)
    expect(grooveLoop(groove(4, [0, 0]))).toEqual([6])
  })

  test('the project groove applies to every track until GRV (its track) or GGR (all tracks)', () => {
    const model                                = demoSong()
    model.projectGroove                        = 1
    model.grooves                              = {
      1: SWING,
      3: TRIPLETS
    }
    const timeline                             = buildTimeline(model)
    const first                                = timeline.byTrack[0][0]
    model.phrases[first.phrase].steps[4].fx[2] = {
      cmd: 'GRV',
      val: 3
    }
    expect(referencedGrooves(model)).toEqual([1, 3])
    const ticks = chainStepTicks(model, timeline)
    const kick  = ticks.get(occurrenceKey(0, first.songRow)) as number[]
    const at    = first.chainRow * 16
    expect(kick.slice(at, at + 8)).toEqual([8, 4, 8, 4, 8, 8, 8, 0])
    // Other tracks keep the project groove.
    const other = timeline.byTrack[1][0]
    expect(ticks.get(occurrenceKey(1, other.songRow))?.slice(0, 4)).toEqual([8, 4, 8, 4])
  })

  test('a CHA on the step decides a GRV: X for the FX left of it, Y right of it (device: CHA F0 kept GRV 01 out, CHA FF let it in)', () => {
    const lengths = (cha: number, chaLane: number) => {
      const model      = demoSong()
      model.grooves    = {
        1: SWING
      }
      const timeline   = buildTimeline(model)
      const first      = timeline.byTrack[0][0]
      const step       = model.phrases[first.phrase].steps[0]
      step.fx          = [{
        cmd: null,
        val: null
      }, {
        cmd: null,
        val: null
      }, {
        cmd: null,
        val: null
      }]
      step.fx[chaLane] = {
        cmd: 'CHA',
        val: cha
      }
      step.fx[1]       = {
        cmd: 'GRV',
        val: 1
      }
      const ticks      = chainStepTicks(model, timeline).get(occurrenceKey(0, first.songRow)) as number[]
      return ticks.slice(first.chainRow * 16, first.chainRow * 16 + 2)
    }
    expect(lengths(0xf0, 0)).toEqual([6, 6])
    expect(lengths(0xff, 0)).toEqual([8, 4])
    // GRV left of the CHA: X decides.
    expect(lengths(0x0f, 2)).toEqual([6, 6])
    expect(lengths(0xf0, 2)).toEqual([8, 4])
  })

  test('reads a Groove view, with a play marker on row 0', () => {
    const lines              = grooveScreen(TRIPLETS).map((l) => l.toLowerCase())
    lines[FIRST_CONTENT_ROW] = `${lines[FIRST_CONTENT_ROW].slice(0, 2)}>${lines[FIRST_CONTENT_ROW].slice(3)}`
    const view               = viewOf({
      width : 40,
      height: 24,
      lines
    })
    expect(view).toMatchObject({
      kind: 'groove',
      id  : 3
    })
    expect(readGroove(view)).toEqual(TRIPLETS)
  })

  test('the exploration reads the project groove and the ones GRV / GGR point at', async () => {
    const device                                = demoSong()
    device.projectGroove                        = 1
    device.grooves                              = {
      1: SWING,
      3: TRIPLETS,
      5: groove(5, [6])
    }
    const first                                 = buildTimeline(device).byTrack[0][0]
    device.phrases[first.phrase].steps[4].fx[2] = {
      cmd: 'GGR',
      val: 3
    }
    const fake                                  = new FakeM8(device)
    const model                                 = await exploreSong(fake, {
      pollMs         : 0,
      settleTimeoutMs: 400
    })
    expect(model.warnings).toEqual([])
    expect(model.projectGroove).toBe(1)
    expect(model.grooves).toEqual({
      1: SWING,
      3: TRIPLETS
    })
    expect(fake.forbidden).toEqual([])
    expect(fake.view).toBe('song')
  })
})

/**
 * A swung phrase on the kick track (08 04 at 24 PPQ), read every `pollMs` with the MIDI clock
 * running; the tracker knows the grooves or not. Returns how often the prediction matched.
 */
function simulateSwing(knowsGroove: boolean): number {
  const device    = demoSong()
  device.grooves  = { 0: groove(0, [8, 4]) }
  const model     : SongModel = knowsGroove ? device : {
    ...device,
    grooves: undefined
  }
  const timeline  = buildTimeline(model)
  const tracker   = new PlaybackTracker(model, timeline)
  const kick      = model.song[2][0] as number
  const phraseId  = model.chains[kick].rows[0].phrase as number
  const band      = timeline.bands.find((b) => b.songRow === 2)?.row as number
  tracker.context = {
    songRow: 2,
    track  : 0
  }
  const msPerTick = 60000 / 96 / 24
  const t0        = 1000.3
  const trueStep  = (ms: number) => {
    const ticks = (ms - t0) / msPerTick
    if (ticks < 0) return -1
    const inPhrase = ticks % 96
    return 2 * Math.floor(inPhrase / 12) + (inPhrase % 12 >= 8 ? 1 : 0)
  }
  let hits        = 0
  let checks      = 0
  for (let ms = t0 + 7; ms < t0 + 96 * msPerTick * 0.95; ms += 60) {
    const tick = Math.floor(ms / msPerTick)
    tracker.clockTick(tick, tick * msPerTick, msPerTick)
    const shown = trueStep(ms - 25)
    const lines = phraseScreen(model.phrases[phraseId])
    if (shown >= 0) {
      const y  = FIRST_CONTENT_ROW + shown
      lines[y] = `${lines[y].slice(0, 2)}>${lines[y].slice(3)}`
      tracker.observe({
        width : 40,
        height: 24,
        lines
      }, ms)
    }
    for (const probe of [ms + 18, ms + 42]) {
      if (probe - t0 < 24 * msPerTick) continue // warm-up
      checks += 1
      if (tracker.playheads(probe)[0]?.row === band + trueStep(probe)) hits += 1
    }
  }
  return hits / checks
}

describe('PlaybackTracker with grooves', () => {
  test('a swung phrase is followed step by step when the groove is known', () => {
    const known = simulateSwing(true)
    expect(known).toBeGreaterThan(0.95)
    expect(simulateSwing(false)).toBeLessThan(known)
  })
})

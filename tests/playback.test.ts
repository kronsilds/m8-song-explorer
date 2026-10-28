import { describe, expect, test } from 'bun:test'
import type { M8Screen } from '@yam8d/m8-sdk'
import { type PlaybackEvent, PlaybackTracker } from '../src/m8/playback'
import { demoSong } from '../src/model/demo'
import { chainScreen, FIRST_CONTENT_ROW, phraseScreen, songScreen } from '../src/model/screens'
import { chainLength, emptyModel, emptyStep, ROWS_PER_PHRASE } from '../src/model/song'
import { buildTimeline } from '../src/model/timeline'

const model    = demoSong()
const timeline = buildTimeline(model)
const STEP_MS  = 60000 / 120 / 4

/** The Song view with a play marker before the cell of each playing track, as the M8 draws it. */
function songWithMarkers(rows: (number | null)[], bpm = 120): M8Screen {
  const lines = songScreen(model, 0)
  rows.forEach((row, t) => {
    if (row == null) return
    const y          = FIRST_CONTENT_ROW + row
    const chars      = lines[y].split('')
    chars[3 + 3 * t] = '>'
    lines[y]         = chars.join('')
  })
  lines[5] = `${lines[5].padEnd(33)}T>${String(bpm).padStart(3, '0')}`
  return {
    width : 40,
    height: 24,
    lines
  }
}

/** The device draws the play marker in the blank after the step number ('F>---'). */
function markStep(lines: string[], step: number): string[] {
  const out = [...lines]
  const y   = FIRST_CONTENT_ROW + step
  out[y]    = `${out[y].slice(0, 2)}>${out[y].slice(3)}`
  return out
}

const TRACKS_COUNT = 8
const bandRow      = (songRow: number) => timeline.bands.find((b) => b.songRow === songRow)?.row as number

/**
 * The device: phrase `phraseId` of the kick track playing from `t0`, read every `pollMs`, the
 * screen showing each step `latencyMs` late. Returns how often the prediction matched the M8.
 */
function simulate(options: { clockMsPerTick?: number; pollMs?: number; latencyMs?: number; bpm?: number }) {
  const { pollMs = 60, latencyMs = 25, bpm = 96 } = options
  const stepMs                                    = 60000 / bpm / 4
  const tracker                                   = new PlaybackTracker(model, timeline)
  const kick                                      = model.song[2][0] as number
  const phraseId                                  = model.chains[kick].rows[0].phrase as number
  tracker.context                                 = {
    songRow: 2,
    track  : 0
  }
  const t0                                        = 1000.3
  const trueStep                                  = (ms: number) => Math.floor((ms - t0) / stepMs) % 16
  let hits                                        = 0
  let checks                                      = 0
  for (let ms = t0 + 7; ms < t0 + 16 * stepMs * 0.95; ms += pollMs) {
    // Like the host: clock events carry the time of their tick.
    if (options.clockMsPerTick) {
      const tick = Math.floor(ms / options.clockMsPerTick)
      tracker.clockTick(tick, tick * options.clockMsPerTick, options.clockMsPerTick)
    }
    const shown = trueStep(ms - latencyMs)
    const lines = markStep(phraseScreen(model.phrases[phraseId]), shown)
    lines[5]    = `${lines[5].padEnd(33)}T>${String(bpm).padStart(3, '0')}`
    if (shown >= 0) tracker.observe({
      width : 40,
      height: 24,
      lines
    }, ms)
    // Between readings, at odd times, compare with the truth.
    for (const probe of [ms + pollMs * 0.3, ms + pollMs * 0.7]) {
      if (probe - t0 < 4 * stepMs) continue // warm-up
      const head = tracker.playheads(probe)[0]
      checks     += 1
      if (head?.row === bandRow(2) + trueStep(probe)) hits += 1
    }
  }
  return hits / checks
}

describe('PlaybackTracker', () => {
  test('readings narrow down when steps start: the playhead matches the M8, not a poll behind', () => {
    expect(simulate({})).toBeGreaterThan(0.95)
    expect(simulate({ clockMsPerTick: 60000 / 96 / 24 })).toBeGreaterThan(0.95)
    expect(simulate({
      pollMs   : 100,
      latencyMs: 10
    })).toBeGreaterThan(0.85)
  })

  test('song markers place each track at its song row, then it moves on at the tempo', () => {
    const tracker = new PlaybackTracker(model, timeline)
    expect(tracker.observe(songWithMarkers([2, 2, 2, 2, 2, null, null, null]), 1000)).toBe(true)
    expect(tracker.bpm).toBe(120)
    const at = tracker.playheads(1000 + 10 * STEP_MS + 1)
    expect(at[0]).toMatchObject({
      row    : bandRow(2) + 10,
      songRow: 2,
      exact  : false
    })
    expect(at[5]).toBeNull()
  })

  test('a track entering the next song row is exact from then on', () => {
    const tracker = new PlaybackTracker(model, timeline)
    tracker.observe(songWithMarkers([2]), 0)
    const kick   = model.song[2][0] as number
    const length = chainLength(model.chains[kick]) * ROWS_PER_PHRASE
    // Predicted to reach row 3 after `length` steps; the screen agrees a little later.
    tracker.observe(songWithMarkers([3]), length * STEP_MS + 40)
    const [kickHead] = tracker.playheads(length * STEP_MS + 40 + 3 * STEP_MS + 1)
    expect(kickHead?.songRow).toBe(3)
    expect(kickHead?.row).toBe(bandRow(3) + 3)
  })

  test('the prediction walks past a chain end without the screen', () => {
    const tracker = new PlaybackTracker(model, timeline)
    tracker.observe(songWithMarkers([2]), 0)
    const kick   = model.song[2][0] as number
    const length = chainLength(model.chains[kick]) * ROWS_PER_PHRASE
    const [head] = tracker.playheads((length + 2) * STEP_MS + 1)
    expect(head).toMatchObject({
      row    : bandRow(3) + 2,
      songRow: 3,
      exact  : false
    })
  })

  test('a phrase view marker sets the exact step of the track playing that phrase', () => {
    const tracker = new PlaybackTracker(model, timeline)
    tracker.observe(songWithMarkers([2]), 0)
    const kick     = model.song[2][0] as number
    const phraseId = model.chains[kick].rows[0].phrase as number
    const lines    = phraseScreen(model.phrases[phraseId])
    tracker.observe({
      width : 40,
      height: 24,
      lines : markStep(lines, 9)
    }, 2 * STEP_MS)
    const [head] = tracker.playheads(2 * STEP_MS + 1)
    // One reading: the step is right, when it started is known to a step.
    expect(head).toMatchObject({
      row    : bandRow(2) + 9,
      songRow: 2,
      exact  : false
    })
  })

  test('a phrase on screen before any song view anchors the track the M8 came from', () => {
    const tracker   = new PlaybackTracker(model, timeline)
    const bass      = model.song[2][3] as number
    const phraseId  = model.chains[bass].rows[1].phrase as number
    tracker.context = {
      songRow: 2,
      track  : 3
    }
    tracker.observe({
      width : 40,
      height: 24,
      lines : markStep(phraseScreen(model.phrases[phraseId]), 4)
    }, 0)
    const heads = tracker.playheads(1)
    expect(heads[3]).toMatchObject({
      row    : bandRow(2) + 16 + 4,
      songRow: 2,
      exact  : false
    })
    expect(heads.filter(Boolean)).toHaveLength(1)
  })

  test('stops once the markers are gone', () => {
    const tracker = new PlaybackTracker(model, timeline)
    tracker.observe(songWithMarkers([2]), 0)
    tracker.observe(songWithMarkers([]), 500)
    expect(tracker.playing).toBe(true)
    tracker.observe(songWithMarkers([]), 1000)
    expect(tracker.playing).toBe(false)
    expect(tracker.playheads(1000).every((h) => h == null)).toBe(true)
  })

  /** A phrase no track plays at song row `songRow` (its first phrases), to browse to on the M8. */
  function idlePhrase(songRow: number): number {
    const playing = new Set<number>()
    for (const chainId of model.song[songRow]) {
      for (const r of model.chains[chainId as number]?.rows ?? []) if (r.phrase != null) playing.add(r.phrase)
    }
    return Number(Object.keys(model.phrases).find((id) => !playing.has(Number(id))))
  }

  test('leaving the Song view keeps every track following: no marker on a chain nobody plays', () => {
    const tracker = new PlaybackTracker(model, timeline)
    // Without MIDI transport: markers on the Song view place the tracks...
    tracker.observe(songWithMarkers([2, 2, 2, 2, 2, null, null, null]), 0)
    const before = tracker.playheads(10 * STEP_MS).map((h) => h?.row)
    // ...then the M8 shows a phrase none of them plays, with no marker, for seconds.
    const idle   = phraseScreen(model.phrases[idlePhrase(2)])
    for (let ms = 100; ms <= 6000; ms += 500) tracker.observe({
      width : 40,
      height: 24,
      lines : idle
    }, ms)
    expect(tracker.playing).toBe(true)
    const after = tracker.playheads(10 * STEP_MS).map((h) => h?.row)
    expect(after).toEqual(before)
    expect(after.filter((r) => r != null)).toHaveLength(5)
  })

  test('a phrase that should be playing but shows no marker means stopped', () => {
    const tracker = new PlaybackTracker(model, timeline)
    tracker.observe(songWithMarkers([2]), 0)
    const kick     = model.song[2][0] as number
    const phraseId = model.chains[kick].rows[0].phrase as number
    const lines    = phraseScreen(model.phrases[phraseId])
    tracker.observe({
      width : 40,
      height: 24,
      lines
    }, 2 * STEP_MS)
    expect(tracker.playing).toBe(true)
    tracker.observe({
      width : 40,
      height: 24,
      lines
    }, 2 * STEP_MS + 1000)
    expect(tracker.playing).toBe(false)
  })

  test('with MIDI transport the Stop message ends the song, not missing markers', () => {
    const tracker = new PlaybackTracker(model, timeline)
    const ms      = (tick: number) => tick * 20
    tracker.clockTick(600, ms(600), 20)
    expect(tracker.transportStart(bandRow(3), ms(600))).toBe(true)
    // Even the phrase the kick plays shows no marker (the user is on its chain, say): kept.
    const kick     = model.song[3][0] as number
    const phraseId = model.chains[kick].rows[0].phrase as number
    const lines    = phraseScreen(model.phrases[phraseId])
    for (let tick = 601; tick < 700; tick += 6) {
      tracker.clockTick(tick, ms(tick), 20)
      tracker.observe({
        width : 40,
        height: 24,
        lines
      }, ms(tick))
    }
    expect(tracker.playing).toBe(true)
    expect(tracker.playheads(ms(700)).filter(Boolean).length).toBeGreaterThan(0)
    tracker.transportReset()
    expect(tracker.playing).toBe(false)
  })

  test('with MIDI transport the Song view without markers (playing rows off screen) keeps playing', () => {
    const tracker = new PlaybackTracker(model, timeline)
    const ms      = (tick: number) => tick * 20
    tracker.clockTick(600, ms(600), 20)
    expect(tracker.transportStart(bandRow(3), ms(600))).toBe(true)
    for (let tick = 601; tick < 800; tick += 6) {
      tracker.clockTick(tick, ms(tick), 20)
      tracker.observe(songWithMarkers([]), ms(tick))
    }
    expect(tracker.playing).toBe(true)
    expect(tracker.playheads(ms(800)).filter(Boolean).length).toBeGreaterThan(0)
  })

  test('a clock running before playback is only a time base', () => {
    const tracker = new PlaybackTracker(model, timeline)
    for (let tick = 6; tick <= 600; tick += 6) tracker.clockTick(tick, tick * 20, 20)
    expect(tracker.playheads(12000).every((h) => h == null)).toBe(true)
    tracker.observe(songWithMarkers([2]), 12000)
    tracker.clockTick(600 + 6 * 3, 12000 + 18 * 20, 20)
    expect(tracker.playheads(12000 + 18 * 20)[0]?.row).toBe(bandRow(2) + 3)
    tracker.transportReset()
    expect(tracker.playheads(12500).every((h) => h == null)).toBe(true)
  })

  test('Song Position + Continue place every track at once, on the clock', () => {
    const tracker = new PlaybackTracker(model, timeline)
    const ms      = (tick: number) => tick * 20
    tracker.clockTick(600, ms(600), 20)
    // Play on song row 03: the M8 sends SPP = the timeline row where that song row starts.
    expect(tracker.transportStart(bandRow(3), ms(600))).toBe(true)
    // Step 0 starts on the first clock after Continue (601), step 5 on 601 + 30.
    tracker.clockTick(631, ms(631), 20)
    const heads   = tracker.playheads(ms(631) + 1)
    const playing = model.song[3].map((c, t) => (c == null ? null : t)).filter((t) => t != null)
    for (const t of playing) expect(heads[t as number]).toMatchObject({
      row    : bandRow(3) + 5,
      songRow: 3,
      exact  : true
    })
    // A track with an empty cell there plays the last chain above it, so no track with a chain above is silent.
    const silent = model.song[3].map((c, t) => (c == null && !model.song.slice(0, 3).some((row) => row[t] != null) ? t : null)).filter((t) => t != null)
    expect(heads.filter(Boolean)).toHaveLength(TRACKS_COUNT - silent.length)
    // A position where no song row starts: nothing placed, the screen decides.
    expect(tracker.transportStart(bandRow(3) + 5, ms(700))).toBe(false)
  })

  test('MIDI clock drives the steps once it arrives', () => {
    const tracker = new PlaybackTracker(model, timeline)
    tracker.clockTick(0, 0, 20)
    tracker.observe(songWithMarkers([2]), 0)
    tracker.clockTick(6 * 5, 5000, 20) // 5 steps of clock, whatever the wall time says
    expect(tracker.playheads(5000)[0]?.row).toBe(bandRow(2) + 5)
  })
})

describe('each track loops its own run of chains', () => {
  // Rows 0-2 are one run, row 3 is blank, rows 4-5 another run; track 0 has no chain on row 5.
  const source = demoSong()
  const blank  = Array(8).fill(null) as (number | null)[]
  const last   = [...source.song[2]]
  last[0]      = null
  const two    = {
    ...source,
    song: [source.song[2], source.song[3], source.song[2], blank, source.song[3], last]
  }
  const looped = buildTimeline(two)
  const bandOf = (songRow: number) => looped.bands.find((b) => b.songRow === songRow) as (typeof looped.bands)[number]
  const ms     = (tick: number) => tick * 20
  const place  = (cursorRow: number | null, spp: number) => {
    const tracker   = new PlaybackTracker(two, looped)
    tracker.context = cursorRow == null ? null : {
      songRow: cursorRow,
      track  : 0
    }
    tracker.clockTick(600, ms(600), 20)
    const placed = tracker.transportStart(spp, ms(600))
    return {
      placed,
      rows: tracker.playheads(ms(601) + 1).map((head) => head?.songRow ?? null)
    }
  }

  test('a blank row ends a block and the next row starts one', () => {
    expect(looped.bands.map((b) => b.blank)).toEqual([false, false, false, true, false, false])
    expect(bandOf(2).block).toBe(0)
    expect(bandOf(3).block).toBe(0)
    expect(bandOf(4).block).toBe(bandOf(4).row)
  })

  test('Play places every track on the cursor row, whatever the Song Position says', () => {
    expect(place(4, 0).rows).toEqual(two.song[4].map((chain) => (chain == null ? null : 4)))
    expect(place(5, 123456).rows[1]).toBe(5)
  })

  test('a track with an empty cell on the start row plays its last chain above it', () => {
    // Track 0 has no chain on row 5: it plays the one on row 4, the others row 5.
    expect(place(5, 0).rows[0]).toBe(4)
  })

  test('Play on a blank row plays the last chain of each track above it', () => {
    const above = (track: number) => [2, 1, 0].find((row) => two.song[row][track] != null) ?? null
    expect(place(3, 0).rows).toEqual(two.song[0].map((_, track) => above(track)))
  })

  test('without a cursor, a position only one song row has places the tracks, else nothing', () => {
    expect(place(null, 0).placed).toBe(false)
    expect(place(null, bandOf(2).row).placed).toBe(true)
  })

  test('a track at the end of its run goes back to the start of the run', () => {
    const tracker = new PlaybackTracker(two, looped)
    tracker.clockTick(0, 0, 20)
    tracker.observe(songWithMarkers([null, 5]), 0)
    // The last row of the run plays through, then loops to row 4.
    const total = (songRow: number) => chainLength(two.chains[two.song[songRow][1] as number]) * ROWS_PER_PHRASE * 6
    const ticks = total(5) + 6
    tracker.clockTick(ticks, ticks * 20, 20)
    expect(tracker.playheads(ticks * 20)[1]?.songRow).toBe(4)
  })

  test('blank rows below an isolated row play that row, in a loop', () => {
    const solo      = {
      ...source,
      song: [source.song[2], blank, source.song[3], blank, blank]
    }
    const soloLine  = buildTimeline(solo)
    const tracker   = new PlaybackTracker(solo, soloLine)
    tracker.context = {
      songRow: 4,
      track  : 0
    }
    tracker.clockTick(600, ms(600), 20)
    expect(tracker.transportStart(0, ms(600))).toBe(true)
    const rows = (at: number) => tracker.playheads(at).map((head) => head?.songRow ?? null)
    expect(rows(ms(601) + 1)).toEqual(solo.song[2].map((chain) => (chain == null ? null : 2)))
    // Past the end of the row it plays again, never on to the blank rows.
    const chain = chainLength(solo.chains[solo.song[2].find((c) => c != null) as number]) * ROWS_PER_PHRASE * 6
    const later = 601 + chain + 12
    tracker.clockTick(later, ms(later), 20)
    expect(rows(ms(later))).toEqual(solo.song[2].map((c) => (c == null ? null : 2)))
  })
})

describe('a MIDI clock that stops', () => {
  test('is dropped after a silence: the playheads go on from where they were, at the tempo the screen shows', () => {
    const tracker   = new PlaybackTracker(model, timeline)
    const events    : PlaybackEvent[] = []
    tracker.onEvent = (event) => events.push(event)
    const ms        = (tick: number) => tick * 20
    // 125 BPM on the clock; the song starts and plays on it.
    tracker.clockTick(600, ms(600), 20)
    expect(tracker.transportStart(bandRow(3), ms(600))).toBe(true)
    for (let tick = 606; tick <= 700; tick += 6) tracker.clockTick(tick, ms(tick), 20)
    const lastClock = ms(696)
    // Just before the silence is long enough, and just after it: the same step.
    const before    = tracker.playheads(lastClock + 1999.9).map((h) => h?.step)
    const after     = tracker.playheads(lastClock + 2000).map((h) => h?.step)
    expect(after).toEqual(before)
    expect(events.filter((event) => event.kind === 'clock-lost')).toEqual([{
      kind    : 'clock-lost',
      silentMs: 2000
    }])
    // The M8 shows 60 BPM: a step lasts 250 ms from now on, not the 120 ms of the lost clock.
    tracker.observe(songWithMarkers([], 60), lastClock + 2000)
    expect(tracker.bpm).toBe(60)
    const start = tracker.playheads(lastClock + 2000)[0]?.step as number
    expect(tracker.playheads(lastClock + 2000 + 10 * 250)[0]?.step).toBe(start + 10)
    expect(tracker.playing).toBe(true)
  })

  test('a clock that keeps coming is never dropped, also while the song is stopped', () => {
    const tracker   = new PlaybackTracker(model, timeline)
    const events    : PlaybackEvent[] = []
    tracker.onEvent = (event) => events.push(event)
    for (let tick = 6; tick <= 600; tick += 6) {
      tracker.clockTick(tick, tick * 20, 20)
      tracker.observe(songWithMarkers([]), tick * 20)
    }
    expect(events).toEqual([])
  })
})

describe('HOP in a phrase', () => {
  // Track 1: chain 00 plays phrases 00 (HOP 04 on step 7) and 01, then chain 01 on row 1:
  // phrase 03, the chain's only one, with HOP 02 on step 3. Track 2: phrase 02, HOP FF on step 9.
  const song    = emptyModel('demo')
  const phrase  = (id: number, hop: [step: number, value: number] | null) => {
    const steps = Array.from({ length: ROWS_PER_PHRASE }, emptyStep)
    steps[0]    = {
      ...steps[0],
      note: 'C-4',
      inst: 0
    }
    if (hop) steps[hop[0]].fx[0] = {
      cmd: 'HOP',
      val: hop[1]
    }
    return {
      id,
      steps
    }
  }
  const chain   = (id: number, phrases: number[]) => ({
    id,
    rows: Array.from({ length: 16 }, (_, row) => ({
      phrase   : phrases[row] ?? null,
      transpose: 0
    }))
  })
  song.phrases  = {
    0: phrase(0, [7, 0x04]),
    1: phrase(1, null),
    2: phrase(2, [9, 0xff]),
    3: phrase(3, [3, 0x02])
  }
  song.chains   = {
    0: chain(0, [0, 1]),
    1: chain(1, [3]),
    2: chain(2, [2])
  }
  const empty   = Array(7).fill(null) as (number | null)[]
  song.song     = [[0, 2, ...empty.slice(1)], [1, ...empty]]
  const hopLine = buildTimeline(song)
  const rowOf   = (songRow: number) => hopLine.bands.find((b) => b.songRow === songRow)?.row as number
  const ms      = (tick: number) => tick * 20
  // Step 0 starts on tick 601 (the first clock after Continue), six ticks a step.
  const started = () => {
    const tracker   = new PlaybackTracker(song, hopLine)
    tracker.context = {
      songRow: 0,
      track  : 0
    }
    tracker.clockTick(600, ms(600), 20)
    tracker.transportStart(0, ms(600))
    return tracker
  }
  const at      = (tracker: PlaybackTracker, tick: number) => {
    tracker.clockTick(tick, ms(tick), 20)
    return tracker.playheads(ms(tick) + 1)
  }

  test("reaching the HOP's step, the track goes on at row Y of the next phrase: that step does not play", () => {
    const tracker = started()
    expect(at(tracker, 601 + 41)[0]).toMatchObject({
      songRow: 0,
      step   : 6
    })
    expect(at(tracker, 601 + 44)[0]).toMatchObject({
      songRow: 0,
      step   : 20,
      row    : rowOf(0) + 20
    })
  })

  test("a HOP 0Y in the chain's last phrase goes to row Y of the next chain (here the start of the run)", () => {
    const tracker = started()
    // 7 steps of phrase 00, 12 of phrase 01 (rows 4-F): row 1 at tick 601 + 114.
    expect(at(tracker, 601 + 115)[0]).toMatchObject({
      songRow: 1,
      step   : 0
    })
    // Phrase 03 plays steps 0-2, then HOP 02: row 0 is the start of the run, step 2.
    expect(at(tracker, 601 + 133)[0]).toMatchObject({
      songRow: 0,
      step   : 2
    })
  })

  test('HOP FF stops the track as it reaches its step', () => {
    const tracker = started()
    expect(at(tracker, 601 + 53)[1]?.step).toBe(8)
    expect(at(tracker, 601 + 55)[1]).toBeNull()
  })

  test('a phrase view after a HOP fits the prediction: no restart', () => {
    const tracker   = started()
    const events    : PlaybackEvent[] = []
    tracker.onEvent = (event) => events.push(event)
    tracker.clockTick(645, ms(645), 20)
    tracker.observe({
      width : 40,
      height: 24,
      lines : markStep(phraseScreen(song.phrases[1]), 4)
    }, ms(645))
    expect(events.filter((event) => event.kind === 'reanchor')).toEqual([])
    expect(at(tracker, 647)[0]?.step).toBe(20)
  })
})

describe('counted HOPs (device, GEN_INTERMIS)', () => {
  // Track 1: phrase 00 alone in chain 00, its next song row empty: HOP 60 on step 1, HOP 32 on 3,
  // HOP 34 on 5, HOP 02 on 6. Track 2: phrase 01 alone in chain 01, HOP 24 on step 5; chain 02
  // (empty phrase 02) on the next song row. Track 3: phrase 03, HOP 01 on step 2 (loops step 1).
  const song   = emptyModel('demo')
  const phrase = (id: number, hops: [step: number, value: number][]) => {
    const steps = Array.from({ length: ROWS_PER_PHRASE }, emptyStep)
    steps[1]    = {
      ...steps[1],
      note: 'G#3',
      inst: 0
    }
    for (const [step, value] of hops) steps[step].fx[0] = {
      cmd: 'HOP',
      val: value
    }
    return {
      id,
      steps
    }
  }
  const chain  = (id: number, phraseId: number) => ({
    id,
    rows: Array.from({ length: 16 }, (_, row) => ({
      phrase   : row === 0 ? phraseId : null,
      transpose: 0
    }))
  })
  song.phrases = {
    0: phrase(0, [[1, 0x60], [3, 0x32], [5, 0x34], [6, 0x02]]),
    1: phrase(1, [[5, 0x24]]),
    2: phrase(2, []),
    3: phrase(3, [[2, 0x01]])
  }
  song.chains  = {
    0: chain(0, 0),
    1: chain(1, 1),
    2: chain(2, 2),
    3: chain(3, 3)
  }
  song.song    = [[0, 1, 3, null, null, null, null, null], [null, 2, null, null, null, null, null, null]]
  const line   = buildTimeline(song)
  const ms     = (tick: number) => tick * 20
  // Step 0 starts on tick 601 (the first clock after Continue), six ticks a step.
  const start  = () => {
    const tracker   = new PlaybackTracker(song, line)
    tracker.context = {
      songRow: 0,
      track  : 0
    }
    tracker.clockTick(600, ms(600), 20)
    tracker.transportStart(0, ms(600))
    return tracker
  }
  const at     = (tracker: PlaybackTracker, tick: number) => {
    tracker.clockTick(tick, ms(tick), 20)
    return tracker.playheads(ms(tick) + 1)
  }
  const stepAt = (tracker: PlaybackTracker, track: number, tick: number) => at(tracker, 601 + tick)[track]?.step

  test('HOP XY hops X times, then its own step plays and the phrase runs on', () => {
    const tracker = start()
    // Step 0 seven times (HOP 60 hops six), then step 1, the HOP's own.
    expect([0, 6, 41, 42, 47].map((tick) => stepAt(tracker, 0, tick))).toEqual([0, 0, 0, 1, 1])
    // Step 2 four times (HOP 32), step 3, step 4 four times (HOP 34), step 5, then HOP 02 (X = 0) back to step 2.
    expect([48, 71, 72, 78, 101, 102, 108].map((tick) => stepAt(tracker, 0, tick))).toEqual([2, 2, 3, 4, 4, 5, 2])
  })

  test('the count starts over each time round, and a long walk goes round whole turns', () => {
    const tracker = start()
    // From tick 108 the track goes round 2 x4, 3, 4 x4, 5: 60 ticks a turn.
    expect([132, 138, 161, 162, 168].map((tick) => stepAt(tracker, 0, tick))).toEqual([3, 4, 4, 5, 2])
    expect(stepAt(tracker, 0, 108 + 60 * 5000 + 25)).toBe(3)
  })

  test("a HOP in a chain's only phrase stays in it, though another chain follows on the next song row", () => {
    const tracker = start()
    // Steps 0-4, HOP 24 twice back to step 4, then step 5 plays, 6-F, then chain 02 on row 1.
    expect([29, 30, 36, 42, 48].map((tick) => stepAt(tracker, 1, tick))).toEqual([4, 4, 4, 5, 6])
    expect(at(tracker, 601 + 108)[1]).toMatchObject({
      songRow: 1,
      step   : 0
    })
    // Back on row 0 after chain 02's 16 steps, and the HOP counts from the start again.
    expect(at(tracker, 601 + 204)[1]).toMatchObject({
      songRow: 0,
      step   : 0
    })
    expect([204 + 30, 204 + 36, 204 + 42].map((tick) => stepAt(tracker, 1, tick))).toEqual([4, 4, 5])
  })

  test('a step played again counts as a new step', () => {
    const tracker = start()
    const serials = [3, 9, 15, 21].map((tick) => at(tracker, 601 + tick)[2]?.serial)
    // Track 3: step 0, then step 1 over and over.
    expect([3, 9, 15, 21].map((tick) => stepAt(tracker, 2, tick))).toEqual([0, 1, 1, 1])
    expect(serials).toEqual([0, 1, 2, 3])
  })

  /** A view with its row `row` marked, and the tempo. */
  const marked = (lines: string[], row: number): M8Screen => {
    const out = markStep(lines, row)
    out[5]    = `${out[5].padEnd(33)}T>120`
    return {
      width : 40,
      height: 24,
      lines : out
    }
  }

  test('readings of a step the track comes back to fit the time round they are about: no restart', () => {
    const tracker   = start()
    const events    : PlaybackEvent[] = []
    tracker.onEvent = (event) => events.push(event)
    tracker.context = {
      songRow: 0,
      track  : 2
    }
    // Track 3's Phrase view, read every 5 ticks while it loops step 1 (a new time round every 6 ticks).
    for (let tick = 8; tick < 200; tick += 5) {
      tracker.clockTick(601 + tick, ms(601 + tick), 20)
      tracker.observe(marked(phraseScreen(song.phrases[3]), 1), ms(601 + tick))
    }
    // The Chain view of track 1's chain, which loops on itself: row 0 plays, as the walk says.
    tracker.context = {
      songRow: 0,
      track  : 0
    }
    tracker.clockTick(601 + 300, ms(601 + 300), 20)
    tracker.observe(marked(chainScreen(song.chains[0]), 0), ms(601 + 300))
    expect(events.filter((event) => event.kind === 'reanchor')).toEqual([])
    expect(stepAt(tracker, 0, 300)).toBe(stepAt(start(), 0, 300))
  })
})

describe('HOPs on a test song (device, 2026-10-29)', () => {
  // Track 1: chain 00 = phrases 00 and 01 on song row 0, chain 01 (phrase 02) on row 1. Phrase 00
  // has HOP 14 on step C, phrase 01 HOP 04 on step 8. The M8's Chain 00 view showed row 0 for 3 s,
  // row 1 for 1 s, then no marker for 1.5 s (chain 01 from row 4), then row 0 again.
  const song    = emptyModel('test')
  const withHop = (id: number, step: number, value: number) => {
    const steps = Array.from({ length: ROWS_PER_PHRASE }, emptyStep)
    if (step >= 0) steps[step].fx[0] = {
      cmd: 'HOP',
      val: value
    }
    return {
      id,
      steps
    }
  }
  song.phrases  = {
    0: withHop(0, 12, 0x14),
    1: withHop(1, 8, 0x04),
    2: withHop(2, -1, 0)
  }
  const chainOf = (id: number, phrases: number[]) => ({
    id,
    rows: Array.from({ length: 16 }, (_, row) => ({
      phrase   : phrases[row] ?? null,
      transpose: 0
    }))
  })
  song.chains   = {
    0: chainOf(0, [0, 1]),
    1: chainOf(1, [2])
  }
  song.song     = [[0, ...Array(7).fill(null)], [1, ...Array(7).fill(null)]]
  const line    = buildTimeline(song)
  const ms      = (tick: number) => tick * 20
  const placeAt = (tick: number) => {
    const tracker   = new PlaybackTracker(song, line)
    tracker.context = {
      songRow: 0,
      track  : 0
    }
    tracker.clockTick(600, ms(600), 20)
    tracker.transportStart(0, ms(600))
    tracker.clockTick(601 + tick, ms(601 + tick), 20)
    const head      = tracker.playheads(ms(601 + tick) + 1)[0]
    return head ? `${head.songRow}:${head.step}` : null
  }

  test('HOP 14 hops back in its own phrase once, though the chain has a next phrase', () => {
    // Steps 0-B (72 ticks), back to 4-B (48), then C-F play (24): phrase 01 at tick 144.
    expect([71, 72, 119, 120, 143, 144].map(placeAt)).toEqual(['0:11', '0:4', '0:11', '0:12', '0:15', '0:16'])
  })

  test('HOP 04 in the chain\'s last phrase goes to row 4 of the next song row\'s chain, then the chain starts over', () => {
    // Phrase 01 steps 0-7 (48 ticks), chain 01 from row 4 (12 steps, 72 ticks), then row 0 from its first step.
    expect([191, 192, 263, 264].map(placeAt)).toEqual(['0:23', '1:4', '1:15', '0:0'])
  })
})

describe('a phrase played more than once in its chain', () => {
  // Track 1: chain 00 on song row 0, phrase 00 four times.
  const song      = emptyModel('repeats')
  song.phrases    = {
    0: {
      id   : 0,
      steps: Array.from({ length: ROWS_PER_PHRASE }, emptyStep)
    }
  }
  song.chains     = {
    0: {
      id  : 0,
      rows: Array.from({ length: 16 }, (_, row) => ({
        phrase   : row < 4 ? 0 : null,
        transpose: 0
      }))
    }
  }
  song.song       = [[0, ...Array(7).fill(null)]]
  const repeats   = buildTimeline(song)
  const withTempo = (lines: string[]): M8Screen => {
    const out = [...lines]
    out[5]    = `${out[5].padEnd(33)}T>120`
    return {
      width : 40,
      height: 24,
      lines : out
    }
  }
  /** The Phrase view at chain position `chainPosition` (its '<'), step `step` playing. */
  const phraseAt  = (chainPosition: number | null, step: number) => withTempo(markStep(phraseScreen(song.phrases[0], chainPosition), step))
  const tracker   = () => {
    const made   = new PlaybackTracker(song, repeats)
    made.context = {
      songRow: 0,
      track  : 0
    }
    return made
  }

  test("first seen on a Phrase view, it plays the repeat the '<' marks", () => {
    const marked = tracker()
    marked.observe(phraseAt(2, 4), 1000)
    expect(marked.playheads(1001)[0]).toMatchObject({
      songRow: 0,
      step   : 2 * ROWS_PER_PHRASE + 4
    })
    const unmarked = tracker()
    unmarked.observe(phraseAt(null, 4), 1000)
    expect(unmarked.playheads(1001)[0]?.step).toBe(4)
  })

  /** The Song view with track 1's marker on song row 0: first seen there, somewhere in the chain. */
  const songView  = () => {
    const lines = songScreen(song, 0)
    lines[6]    = `${lines[6].slice(0, 3)}>${lines[6].slice(4)}`
    return withTempo(lines)
  }

  test("the M8's track plays the chain row its marks say: the only one, or the one that is not the view's", () => {
    const placed = tracker()
    placed.observe(songView(), 1000)
    placed.observe(phraseAt(3, 4), 1050)
    expect(placed.playheads(1051)[0]?.step).toBe(3 * ROWS_PER_PHRASE + 4)
    // 16 steps on, the chain has started over: the view stays on row 3, a second mark on row 0.
    placed.observe(withTempo(markStep(phraseScreen(song.phrases[0], 3, 0), 4)), 1050 + 16 * STEP_MS)
    expect(placed.playheads(1051 + 16 * STEP_MS)[0]).toMatchObject({
      songRow: 0,
      step   : 4
    })
  })

  describe('Play on a Phrase view plays that phrase alone', () => {
    test('playing that starts on a Phrase view loops the phrase at its chain position', () => {
      const looping   = tracker()
      const events    : PlaybackEvent[] = []
      looping.onEvent = (event) => events.push(event)
      looping.observe(phraseAt(1, 0), 1000)
      expect(events.find((event) => event.kind === 'phrase-loop')).toMatchObject({
        looping : true,
        why     : 'started-on-phrase',
        chainRow: 1
      })
      // 20 steps on: step 4 of the same phrase, not of the next repeat.
      expect(looping.playheads(1001 + 20 * STEP_MS)[0]?.step).toBe(ROWS_PER_PHRASE + 4)
      // Long after (no reading meanwhile), still in it.
      expect(looping.playheads(1001 + (16 * 500 + 7) * STEP_MS)[0]?.step).toBe(ROWS_PER_PHRASE + 7)
    })

    test("the marker starting the phrase over while the '<' stays: the track loops it", () => {
      const looping = tracker()
      looping.observe(songView(), 1000)
      // Song row 0, chain row 1, steps C to F, then step 0 again with the '<' still on row 1.
      ;[12, 13, 14, 15, 0].forEach((row, i) => {
        looping.observe(phraseAt(1, row), 1050 + i * STEP_MS)
      })
      const at = 1051 + 4 * STEP_MS
      expect(looping.playheads(at)[0]?.step).toBe(ROWS_PER_PHRASE)
      expect(looping.playheads(at + 20 * STEP_MS)[0]?.step).toBe(ROWS_PER_PHRASE + 4)
    })

    test("the '<' moving on with the marker: the song plays on, the loop ends", () => {
      const playing   = tracker()
      const events    : PlaybackEvent[] = []
      playing.onEvent = (event) => events.push(event)
      playing.observe(phraseAt(1, 0), 1000)
      // Shift+Play, not Play: the song goes on to row 2, which gets a second mark.
      playing.observe(withTempo(markStep(phraseScreen(song.phrases[0], 1, 2), 0)), 1000 + 16 * STEP_MS)
      expect(events.filter((event) => event.kind === 'phrase-loop').map((event) => event.kind === 'phrase-loop' && event.why)).toEqual(['started-on-phrase', 'moved-on'])
      expect(playing.playheads(1001 + 16 * STEP_MS)[0]?.step).toBe(2 * ROWS_PER_PHRASE)
      expect(playing.playheads(1001 + 24 * STEP_MS)[0]?.step).toBe(2 * ROWS_PER_PHRASE + 8)
    })

    test('a song going on to the same phrase on the next song row is not a loop', () => {
      // Chain 01 (phrase 00 alone) on song rows 0 and 1: the '<' stays on row 0 as the song goes on.
      const twice     = structuredClone(song)
      twice.chains[1] = {
        id  : 1,
        rows: Array.from({ length: 16 }, (_, row) => ({
          phrase   : row === 0 ? 0 : null,
          transpose: 0
        }))
      }
      twice.song      = [
        [1, ...Array(7).fill(null)],
        [1, ...Array(7).fill(null)],
      ]
      const going     = new PlaybackTracker(twice, buildTimeline(twice))
      const events    : PlaybackEvent[] = []
      going.onEvent   = (event) => events.push(event)
      going.context   = {
        songRow: 0,
        track  : 0
      }
      const lines     = songScreen(twice, 0)
      lines[6]        = `${lines[6].slice(0, 3)}>${lines[6].slice(4)}`
      going.observe(withTempo(lines), 1000)
      ;[12, 13, 14, 15, 0].forEach((row, i) => {
        going.observe(withTempo(markStep(phraseScreen(twice.phrases[0], 0), row)), 1050 + i * STEP_MS)
      })
      expect(events.filter((event) => event.kind === 'phrase-loop')).toEqual([])
      expect(going.playheads(1051 + 4 * STEP_MS)[0]).toMatchObject({
        songRow: 1,
        step   : 0
      })
    })

    test('a start caught past its first beat is a loop when the read before showed the view without a marker', () => {
      const late   = tracker()
      const events : PlaybackEvent[] = []
      late.onEvent = (event) => events.push(event)
      late.observe(withTempo(phraseScreen(song.phrases[0], 1)), 1000)
      late.observe(phraseAt(1, 6), 1000 + 7 * STEP_MS)
      expect(events.find((event) => event.kind === 'phrase-loop')).toMatchObject({ why: 'started-on-phrase' })
      // Caught on step 6 with no read before: maybe a song already playing, no loop.
      const caught   = tracker()
      const seen     : PlaybackEvent[] = []
      caught.onEvent = (event) => seen.push(event)
      caught.observe(phraseAt(1, 6), 1000)
      expect(seen.filter((event) => event.kind === 'phrase-loop')).toEqual([])
    })
  })

  test('a second mark on a row playing another phrase keeps the song going there', () => {
    // Chain 00 plays phrase 00, then phrase 01, then 00 twice: Shift+Play from row 0 without MIDI.
    const mixed                    = structuredClone(song)
    mixed.phrases[1]               = {
      id   : 1,
      steps: Array.from({ length: ROWS_PER_PHRASE }, emptyStep)
    }
    mixed.chains[0].rows[1].phrase = 1
    const going                    = new PlaybackTracker(mixed, buildTimeline(mixed))
    const events                   : PlaybackEvent[] = []
    going.onEvent                  = (event) => events.push(event)
    going.context                  = {
      songRow: 0,
      track  : 0
    }
    going.observe(withTempo(markStep(phraseScreen(mixed.phrases[0], 0), 0)), 1000)
    // Row 1 (phrase 01) plays: no marker on phrase 00, a second mark on row 1, read after read.
    for (let at = 1000 + 16 * STEP_MS; at < 1000 + 28 * STEP_MS; at += 60) going.observe(withTempo(phraseScreen(mixed.phrases[0], 0, 1)), at)
    expect(going.playing).toBe(true)
    expect(events.filter((event) => event.kind === 'phrase-loop').map((event) => event.kind === 'phrase-loop' && event.why)).toEqual(['started-on-phrase', 'moved-on'])
    expect(going.playheads(1001 + 28 * STEP_MS)[0]?.step).toBe(ROWS_PER_PHRASE + 12)
  })

  test('Shift+Play on a Phrase view starts the tracks at its chain position: the Song Position counts it', () => {
    const going = tracker()
    going.observe(withTempo(phraseScreen(song.phrases[0], 3)), 1000)
    expect(going.transportStart(3 * ROWS_PER_PHRASE, 2000)).toBe(true)
    expect(Math.floor((going.playheads(2001 + 2 * STEP_MS)[0]?.step ?? -1) / ROWS_PER_PHRASE)).toBe(3)
    // From the Song view the same position starts the chain from its top.
    const fromSong = tracker()
    fromSong.observe(withTempo(songScreen(song, 0)), 1000)
    fromSong.transportStart(3 * ROWS_PER_PHRASE, 2000)
    expect(Math.floor((fromSong.playheads(2001 + 2 * STEP_MS)[0]?.step ?? -1) / ROWS_PER_PHRASE)).toBe(0)
  })

  test('the markers a read still shows just after a MIDI Stop start nothing', () => {
    const stopping = tracker()
    stopping.transportStart(0, 1000)
    stopping.transportReset('transport-stop')
    expect(stopping.observe(phraseAt(1, 5), 1100)).toBe(false)
    expect(stopping.playing).toBe(false)
    expect(stopping.observe(phraseAt(1, 8), 1500)).toBe(true)
  })
})

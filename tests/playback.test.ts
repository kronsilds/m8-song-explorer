import { describe, expect, test } from 'bun:test'
import type { M8Screen } from '@yam8d/m8-sdk'
import { PlaybackTracker } from '../src/m8/playback'
import { demoSong } from '../src/model/demo'
import { FIRST_CONTENT_ROW, phraseScreen, songScreen } from '../src/model/screens'
import { chainLength, ROWS_PER_PHRASE } from '../src/model/song'
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

import { expect, test } from 'bun:test'
import { describeSelection } from '../src/m8/semantics'
import { demoSong } from '../src/model/demo'
import { buildSongContext } from '../src/model/songContext'
import { buildTimeline } from '../src/model/timeline'

const model      = demoSong()
const timeline   = buildTimeline(model)
const instanceOf = (pred: (p: number) => boolean) => {
  const inst = timeline.instances.find((i) => pred(i.phrase))
  if (!inst) throw new Error('no instance')
  return inst
}
const text       = (d: ReturnType<typeof describeSelection>) => d.parts.map((p) => `${p.kind}: ${p.text}`).join('\n')

test('an ARP value is read as intervals by the SDK', () => {
  const arp = instanceOf((p) => model.phrases[p].steps[0].fx[0].cmd === 'ARP')
  const d   = describeSelection(buildSongContext(model), {
    kind    : 'step',
    instance: arp,
    step    : 0,
    column  : 'fx1val'
  })
  expect(d.path).toContain(`Phrase ${arp.phrase.toString(16).toUpperCase().padStart(2, '0')}`)
  expect(text(d)).toMatch(/semitones/)
})

test('phrase-wide facts show on the note and chain cells, not on velocity, instrument or FX cells', () => {
  const phrase = instanceOf((p) => model.phrases[p].steps.some((s) => s.note && s.note !== 'OFF'))
  const step   = model.phrases[phrase.phrase].steps.findIndex((s) => s.note && s.note !== 'OFF')
  const labels = (column: 'note' | 'vel' | 'inst' | 'fx1cmd' | 'fx3val') =>
    describeSelection(buildSongContext(model), {
      kind    : 'step',
      instance: phrase,
      step,
      column
    }).facts.map(([label]) => label)
  expect(labels('note')).toContain('Phrase usage')
  for (const column of ['vel', 'inst', 'fx1cmd', 'fx3val'] as const) {
    expect(labels(column)).not.toContain('Phrase usage')
    expect(labels(column)).not.toContain('Notes in phrase')
  }
  const chain = describeSelection(buildSongContext(model), {
    kind    : 'chain',
    instance: phrase
  })
  expect(chain.facts.map(([label]) => label)).toContain('Phrase usage')
})

test('an empty cell under a REP knows the lane is still running', () => {
  const riser = instanceOf((p) => model.phrases[p].steps[1].fx[0].cmd === 'REP')
  const d     = describeSelection(buildSongContext(model), {
    kind    : 'step',
    instance: riser,
    step    : 4,
    column  : 'fx1cmd'
  })
  expect(d.facts.find(([label]) => label === 'Repeat')?.[1]).toMatch(/REP .* per row is still shifting/)
})

test('table cells and instrument headers', () => {
  const d = describeSelection(buildSongContext(model), {
    kind      : 'table',
    table     : 0,
    row       : 1,
    column    : 'fx1val',
    track     : 0,
    instrument: 0
  })
  expect(d.title).toBe('FX1 · VOL F8')
  expect(d.parts.length).toBeGreaterThan(0)
  const h = describeSelection(buildSongContext(model), {
    kind      : 'instrument',
    instrument: 3,
    table     : 3,
    track     : 3
  })
  expect(h.facts).toContainEqual(['Type', 'MACROSYN'])
  expect(h.facts.find(([k]) => k === 'Used on tracks')?.[1]).toBe('4')
})

test('missing modulator settings explain how to read them', () => {
  const model = demoSong()
  delete model.instruments[3].mods
  const description = describeSelection(buildSongContext(model), {
    kind      : 'instrument',
    instrument: 3,
    table     : 3,
    track     : 3
  })
  expect(description.facts).toContainEqual(['Modulators', 'Settings unavailable. Explore the song again to read the modulators.'])
})

test('an unused table says that the song never triggers it', () => {
  const description = describeSelection(buildSongContext(demoSong()), {
    kind      : 'table',
    table     : 0xff,
    row       : 0,
    column    : 'transpose',
    track     : 0,
    instrument: null
  })
  expect(description.facts).toContainEqual(['Playback triggered by', 'Not triggered anywhere in this song.'])
})


import { expect, test } from 'bun:test'
import { describeSelection } from '../src/m8/semantics'
import { demoSong } from '../src/model/demo'
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
  const d   = describeSelection(model, {
    kind    : 'step',
    instance: arp,
    step    : 0,
    column  : 'fx1val'
  })
  expect(d.path).toContain(`Phrase ${arp.phrase.toString(16).toUpperCase().padStart(2, '0')}`)
  expect(text(d)).toMatch(/semitones/)
})

test('an empty cell under a REP knows the lane is still running', () => {
  const riser = instanceOf((p) => model.phrases[p].steps[1].fx[0].cmd === 'REP')
  const d     = describeSelection(model, {
    kind    : 'step',
    instance: riser,
    step    : 4,
    column  : 'fx1cmd'
  })
  expect(text(d)).toMatch(/REP still active/)
})

test('table cells and instrument headers', () => {
  const d = describeSelection(model, {
    kind      : 'table',
    table     : 0,
    row       : 1,
    column    : 'fx1val',
    track     : 0,
    instrument: 0
  })
  expect(d.title).toBe('FX1 · VOL F8')
  expect(d.parts.length).toBeGreaterThan(0)
  const h = describeSelection(model, {
    kind      : 'instrument',
    instrument: 3,
    table     : 3,
    track     : 3
  })
  expect(h.facts).toContainEqual(['Type', 'MACROSYN'])
  expect(h.facts.find(([k]) => k === 'Played on tracks')?.[1]).toBe('4')
})

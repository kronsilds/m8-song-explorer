import { expect, test } from 'bun:test'
import { describeSelection } from '../src/m8/semantics'
import { demoSong } from '../src/model/demo'
import { buildSongContext } from '../src/model/songContext'
import { buildTimeline } from '../src/model/timeline'

const model    = demoSong()
const timeline = buildTimeline(model)
const arp      = timeline.instances.find((instance) => model.phrases[instance.phrase].steps[0].fx[0].cmd === 'ARP')
if (!arp) throw new Error('the demo needs an ARP on step 0, FX1')

const describe = (column: 'fx1cmd' | 'fx1val') => describeSelection(buildSongContext(model), {
  kind    : 'step',
  instance: arp,
  step    : 0,
  column
})

test('the panel keeps the SDK field details but drops its repeated location', () => {
  const description = describe('fx1cmd')
  expect(description.parts.find((part) => part.kind === 'field')?.text).toBe('FX1 Command: ARP')
  expect(description.parts.some((part) => part.kind === 'location')).toBe(false)
})

test('command explanations are direct sentences instead of parenthetical fragments', () => {
  const info = describe('fx1cmd').parts.find((part) => part.kind === 'fxInfo')?.text
  expect(info).toBeDefined()
  expect(info).not.toStartWith('(')
  expect(info).toEndWith('.')
})

test('an FX value names its command and does not repeat the value prefix', () => {
  const parts   = describe('fx1val').parts
  const command = parts.find((part) => part.kind === 'fxTarget')?.text
  const meaning = parts.find((part) => part.kind === 'meaning')?.text
  expect(command).toStartWith('ARP · ')
  expect(command).not.toStartWith('for ')
  expect(meaning).toBeDefined()
  expect(meaning).not.toMatch(/^value /i)
  expect(meaning).toMatch(/semitones/)
})

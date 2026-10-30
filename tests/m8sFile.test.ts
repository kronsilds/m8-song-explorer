import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { readM8sFile } from '../src/model/m8sFile'
import { readSongFile } from '../src/ui/songFile'

// The sample songs live in the workspace root, outside this repository; without them the tests do nothing.
const sample = (name: string): Buffer | null => (existsSync(`../${name}.m8s`) ? readFileSync(`../${name}.m8s`) : null)

test('ASHAMEDDATA (saved by fw 6.6.2): name, tempo, song grid, chains and phrases', () => {
  const bytes = sample('ASHAMEDDATA')
  if (!bytes) return
  const model = readM8sFile(bytes)
  expect(model?.name).toBe('ASHAMEDDATA')
  expect(model?.tempo).toBe(120)
  expect(model?.song).toHaveLength(32)
  // 0xFE is a real chain here; 0xFF is the empty cell.
  expect(model?.song[1]).toEqual([254, 254, 254, 254, 254, 254, 6, 7])
  expect(model?.song[4]).toEqual([0, 9, 254, 2, 254, 254, 6, 7])
  expect(model?.chains[6].rows.slice(0, 5).map((row) => row.phrase)).toEqual([8, 9, 10, 11, null])
  expect(Object.keys(model?.phrases ?? {}).length).toBeGreaterThan(40)
  expect(model?.phrases[0].steps[0]).toMatchObject({
    note: 'C-4',
    vel : 0x64,
    inst: 1
  })
})

test('WAFFELISER (fw 6.6.2): the same layout', () => {
  const bytes = sample('WAFFELISER')
  if (!bytes) return
  const model = readM8sFile(bytes)
  expect(model?.name).toBe('WAFFELISER66')
  expect(model?.tempo).toBe(223)
  expect(model?.song).toHaveLength(10)
  expect(model?.song[0]).toEqual([0xf0, null, null, null, null, null, null, null])
  expect(model?.chains[0x10].rows.slice(0, 3).map((row) => row.phrase)).toEqual([0x20, 0x21, 0x2e])
  expect(model?.warnings[0]).toContain('6.6.2')
})

test('the file picker path reads a .m8s and refuses a cut-short one', async () => {
  const bytes = sample('WAFFELISER')
  if (!bytes) return
  const ok = await readSongFile(new File([bytes], 'WAFFELISER.m8s'))
  expect(ok.kind === 'song' && ok.model.source).toBe('file')
  const cut = await readSongFile(new File([bytes.subarray(0, 4000)], 'cut.m8s'))
  expect(cut.kind).toBe('invalid')
})

test('ASHAMEDDATA: song, chains and phrases equal the device exploration of the same song', () => {
  const bytes    = sample('ASHAMEDDATA')
  const explored = existsSync('../m8-ashameddata-2026-10-29.json') ? JSON.parse(readFileSync('../m8-ashameddata-2026-10-29.json', 'utf8')) : null
  if (!bytes || !explored) return
  const model  = readM8sFile(bytes)
  if (!model) throw new Error('ASHAMEDDATA.m8s did not read')
  const padded = (song: (number | null)[][]) => Array.from({ length: 256 }, (_, row) => song[row] ?? Array(8).fill(null))
  expect(padded(model.song)).toEqual(padded(explored.song))
  expect(model.chains).toEqual(explored.chains)
  expect(model.phrases).toEqual(explored.phrases)
})

test('ASHAMEDDATA: the 15 instruments give the same Instrument and Inst. Mods lines as the device', () => {
  const bytes    = sample('ASHAMEDDATA')
  const explored = existsSync('../m8-ashameddata-2026-10-29.json') ? JSON.parse(readFileSync('../m8-ashameddata-2026-10-29.json', 'utf8')) : null
  if (!bytes || !explored) return
  const model = readM8sFile(bytes)
  expect(Object.keys(model?.instruments ?? {})).toEqual(Object.keys(explored.instruments))
  for (const [id, instrument] of Object.entries<{ name: string | null; type: string; lines: string[]; mods: string[] }>(explored.instruments)) {
    const got = model?.instruments[Number(id)]
    expect(got?.type).toBe(instrument.type)
    expect(got?.lines.map((line) => line.trimEnd())).toEqual(instrument.lines.map((line) => line.trimEnd()))
    expect(got?.mods?.map((line) => line.trimEnd())).toEqual(instrument.mods.map((line) => line.trimEnd()))
  }
})

test('ASHAMEDDATA: the 15 tables equal the device exploration', () => {
  const bytes    = sample('ASHAMEDDATA')
  const explored = existsSync('../m8-ashameddata-2026-10-29.json') ? JSON.parse(readFileSync('../m8-ashameddata-2026-10-29.json', 'utf8')) : null
  if (!bytes || !explored) return
  const model = readM8sFile(bytes)
  expect(model?.tables).toEqual(explored.tables)
})

test('ASHAMEDDATA: scale 0 and groove 0 equal the device exploration', () => {
  const bytes    = sample('ASHAMEDDATA')
  const explored = existsSync('../m8-ashameddata-2026-10-29.json') ? JSON.parse(readFileSync('../m8-ashameddata-2026-10-29.json', 'utf8')) : null
  if (!bytes || !explored) return
  const model = readM8sFile(bytes)
  expect(model?.scales).toEqual(explored.scales)
  expect(model?.grooves).toEqual(explored.grooves)
  expect(model?.projectScale).toBe(explored.projectScale)
  expect(model?.projectGroove).toBe(explored.projectGroove)
})

test('ASHAMEDDATA: project transpose and key equal the device exploration', () => {
  const bytes    = sample('ASHAMEDDATA')
  const explored = existsSync('../m8-ashameddata-2026-10-29.json') ? JSON.parse(readFileSync('../m8-ashameddata-2026-10-29.json', 'utf8')) : null
  if (!bytes || !explored) return
  const model = readM8sFile(bytes)
  expect(model?.projectTranspose).toBe(explored.projectTranspose)
  expect(model?.projectKey).toBe(explored.projectKey)
})

// Saved from the M8 after the edits described in each test (fw 6.6.2 saved from a 6.5 song).
test('ASHAMEDDATA1: project transpose 3, scale 2, key D, groove 5 at 48 ppq, and a detuned scale', () => {
  const bytes = sample('ASHAMEDDATA1')
  if (!bytes) return
  const model = readM8sFile(bytes)
  expect(model).toMatchObject({
    projectTranspose: 3,
    projectScale    : 2,
    projectKey      : 2,
    projectGroove   : 5
  })
  expect(model?.grooves?.[5]).toEqual({
    id   : 5,
    ticks: [0x0c, 0x08, 0x12, 0x14, null, null, null, null, null, null, null, null, null, null, null, null],
    ppq  : 48
  })
  const scale = model?.scales?.[2]
  expect(scale?.name).toBe('MINOR')
  expect(scale?.key).toBe(2)
  expect(scale?.notes[2].offset).toBe(1.5)
  expect(scale?.notes[7].offset).toBe(-24)
  expect(scale?.notes[0].offset).toBe(0)
})

// FXIDS: every FX command typed in on the device (fw 6.6.2), cell after cell in the order Edit+Right
// steps through them; the names are the ones its screen showed. Phrases 00-01 play instrument 00 (none),
// phrase 02 instrument 01 (WAVSYNTH, modulators set to ADSR, DRUM, TRIG and TRACKING), and phrases 04,
// 06 ... 0E instruments 02-07 (MACROSYN, SAMPLER, FMSYNTH, HYPERSYN, MIDI OUT, EXTERNAL; default AHD, AHD, LFO, LFO modulators).
const SEQUENCER_SHOWN  = 'ARP ARC CHA DEL GRV HOP RND RNL RET REP RTO NTH PSL PBN PVB PVX SCA SCG SED SNG TBL THO TIC TBX TPO TSP GGR RMX INS NXT KIL OFF MTT VMV VMX VDE VRE VIN USB EQI EQM VT1 VT2 VT3 VT4 VT5 VT6 VT7 VT8 XMT XMM XMF XMW XMR XDT XDF XDW XDR XRS XRD XRM XRF XRW XRH XRZ IMX IDE IRE VI2 IM2 ID2 IR2 DJC DJR DJT OTT OTC OTI'
const DEFAULT_MODS     = 'EA1 AT1 HO1 DE1 ET1 EA2 AT2 HO2 DE2 ET2 LA3 LO3 LS3 LF3 LT3 LA4 LO4 LS4 LF4 LT4'
const INSTRUMENT_SHOWN : Record<number, string> = {
  2 : 'VOL PIT FIN OSC SIZ MUL WRP SCN FIL CUT RES AMP LIM PAN SNC ERR DRY SMX SDL SRV EA1 AT1 DE1 SU1 ET1 EA2 PK2 BO2 DE2 ET2 EA3 AT3 HO3 DE3 ET3 TA4 TS4 TL4 TH4 TX4',
  4 : `VOL PIT FIN OSC TBR COL DEG RED FIL CUT RES AMP LIM PAN TRG ERR DRY SMX SDL SRV ${DEFAULT_MODS}`,
  6 : `VOL PIT FIN PLY STA LOP LEN DEG FLT CUT RES AMP LIM PAN SLI ERR DRY SMX SDL SRV ${DEFAULT_MODS}`,
  8 : `VOL PIT FIN ALG FM1 FM2 FM3 FM4 FIL CUT RES AMP LIM PAN SNC ERR DRY SMX SDL SRV ${DEFAULT_MODS}`,
  10: `VOL PIT FIN CRD CVO SWM WID SUB FIL CUT RES AMP LIM PAN SNC ERR DRY SMX SDL SRV ${DEFAULT_MODS}`,
  12: `VOL PIT MPG MPB ADD CHD CCA CCB CCC CCD CCE CCF CCG CCH CCI CCJ --- --- --- --- ${DEFAULT_MODS}`,
  14: `VOL PIT MPB MPG CCA CCB CCC CCD FIL CUT RES AMP LIM PAN ADD CHD DRY SMX SDL SRV ${DEFAULT_MODS}`
}

test('FXIDS: every FX command id is named as the device showed it', () => {
  const bytes = sample('FXIDS')
  if (!bytes) return
  const model = readM8sFile(bytes)
  if (!model) throw new Error('FXIDS.m8s did not read')
  const shown = (...ids: number[]) => ids.flatMap((id) => model.phrases[id].steps.flatMap((step) => step.fx.map((fx) => fx.cmd))).filter((cmd) => cmd != null).join(' ')
  expect(shown(0, 1)).toBe(SEQUENCER_SHOWN)
  for (const [id, names] of Object.entries(INSTRUMENT_SHOWN)) expect(shown(Number(id))).toBe(names)
})

test('ASHAMEDDATAZ: Sampler, External and MIDI OUT instruments read as the device shows them', async () => {
  const bytes = sample('ASHAMEDDATAZ')
  if (!bytes) return
  const { readInstrument } = await import('../src/model/m8sInstruments')
  const lines              = (id: number) => readInstrument(bytes, id, 0x13a3e)?.lines.map((line) => line.trimEnd())
  expect(lines(0x20)).toEqual([
    'INST. 20', '', 'TYPE    SAMPLER       LOAD SAVE', 'NAME    ------------', 'TRANSP. ON   TBL.TIC 01   EQ --', '',
    'SAMPLE  LOAD             REC.', '',
    'SLICE   12(018)   AMP 20', 'PLAY    02FWDLOOP LIM 08POST:W3', 'START   11        PAN 70', 'LOOP ST 22        DRY 55',
    'LENGTH  66        MFX 21', 'DETUNE  90        DEL 31', 'DEGRADE 33        REV 41', 'FILTER  01LOWPASS', 'CUTOFF  77', 'RES     44'
  ])
  expect(lines(0x21)).toEqual([
    'INST. 21', '', 'TYPE    EXTERNAL      LOAD SAVE', 'NAME    ------------', 'TRANSP. ON   TBL.TIC 01   EQ --', '',
    'INPUT   00LINE-IN STEREO', 'PORT    02MIDI', 'CHANNEL 05', 'BANK:PG ---:---', '',
    'CCA 040:--        AMP 77', 'CCB 002:--        LIM 00CLIP', 'CCC 003:--        PAN 20', 'CCD 004:--        DRY 33',
    'FILTER  00OFF     MFX 44', 'CUTOFF  88        DEL 55', 'RES     99        REV 66'
  ])
  expect(lines(0x22)).toEqual([
    'INST. 22', '', 'TYPE    MIDI OUT      LOAD SAVE', 'NAME    ------------', 'TRANSP. ON   TBL.TIC 01   EQ --', '',
    'PORT        02USB', 'CHANNEL     07', 'BANK:PG     ---:---', 'CCA CC:VAL  ---:20', 'CCB CC:VAL  ---:21', 'CCC CC:VAL  ---:--',
    'CCD CC:VAL  ---:--', 'CCE CC:VAL  ---:--', 'CCF CC:VAL  ---:--', 'CCG CC:VAL  ---:--', 'CCH CC:VAL  ---:--', 'CCI CC:VAL  ---:--', 'CCJ CC:VAL  ---:3F'
  ])
})

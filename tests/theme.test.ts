import { expect, test } from 'bun:test'
import { parseThemeScreen } from '@yam8d/m8-sdk'

/** The Theme View as the M8 drew it (Model:02, firmware 6.5), in RGB mode and in HSV mode, for the same theme. */
const screen = (rows: string[]) => ({
  width : 40,
  height: 24,
  lines : [...rows, ...Array(24 - rows.length).fill('')]
})

const rgb = screen([
  '',
  '',
  '',
  ' THEME SETTINGS',
  '',
  ' MODE          R  G  B',
  ' BACKGROUND    14 13 11',
  ' TEXT:EMPTY    00 00 00',
  ' TEXT:INFO     89 89 89',
  ' TEXT:DEFAULT  9F 9F 9F',
  ' TEXT:VALUE    E9 E9 E9',
  ' TEXT:TITLES   EA BE 88',
  ' PLAY MARKERS  5F FF 84',
  ' CURSOR        D9 FF D5',
  ' SELECTION     FF C0 FF',
  ' SCOPE/SLIDER  FF CA 8C',
  ' METER LOW     00 FF 50',
  ' METER MID     FF E0 00',
  ' METER PEAK    FF 00 70',
  '',
  ' THEME NAME    BUSINESSCORE',
])

const hsv = screen([
  '',
  '',
  '',
  ' THEME SETTINGS',
  '',
  ' MODE          H  S  V',
  ' BACKGROUND    1C 26 14',
  ' TEXT:EMPTY    00 00 00',
  ' TEXT:INFO     00 00 89',
  ' TEXT:DEFAULT  00 00 9F',
  ' TEXT:VALUE    00 00 E9',
  ' TEXT:TITLES   17 6A EA',
  ' PLAY MARKERS  5E A0 FF',
  ' CURSOR        51 2A FF',
  ' SELECTION     D5 3F FF',
  ' SCOPE/SLIDER  17 73 FF',
  ' METER LOW     62 FF FF',
  ' METER MID     25 FF FF',
  ' METER PEAK    EE FF FF',
  '',
  ' THEME NAME    BUSINESSCORE',
])

test('the Theme View is read in RGB and in HSV mode', () => {
  const fromRgb = parseThemeScreen(rgb)
  const fromHsv = parseThemeScreen(hsv)
  expect(fromRgb?.mode).toBe('rgb')
  expect(fromHsv?.mode).toBe('hsv')
  expect(fromHsv?.name).toBe('BUSINESSCORE')
  // The hue is one byte (a step is about 1.4 degrees), so the HSV reading is within a few units.
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
  const off     : string[] = []
  for (const role of Object.keys(fromRgb?.colors ?? {}) as (keyof NonNullable<typeof fromRgb>['colors'])[]) {
    const fromRgbColor = fromRgb?.colors?.[role] as string
    const fromHsvColor = fromHsv?.colors?.[role] as string
    const worst        = Math.max(...[0, 1, 2].map((i) => Math.abs(channel(fromRgbColor, i) - channel(fromHsvColor, i))))
    if (worst > 8) off.push(`${role} ${fromRgbColor} ${fromHsvColor}`)
  }
  expect(off).toEqual([])
})

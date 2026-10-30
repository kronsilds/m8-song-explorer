// FX command names of a .m8s file: the command byte of a phrase step or table row, named as the M8
// screen shows it. Read from FXIDS.m8s, a song saved on fw 6.6.2 with every command typed in on the
// device (sequencer and mixer commands, the commands of each instrument type, and the modulator
// commands of each modulator type), then compared with the screen.
// Commands from 0x80 belong to an instrument: their name depends on its type, and for 0x92-0xA5 on
// the type of its modulators.

import { INSTRUMENT_SIZE, KINDS, MOD_SIZE, MODS_AT } from './m8sInstruments'

/** Sequencer and mixer commands, 00-4D. Phrases and tables share the ids. */
const SEQUENCER = (
  'ARP CHA DEL GRV HOP KIL RND RNL RET REP RMX NTH PSL PBN PVB PVX ' +
  'SCA SCG SED SNG TBL THO TIC TBX TPO TSP OFF VMV XMM XMF XMW XMR ' +
  'XDT XDF XDW XDR XRS XRD XRM XRF XRW XRZ VMX VDE VRE VT1 VT2 VT3 ' +
  'VT4 VT5 VT6 VT7 VT8 DJC VIN IMX IDE IRE VI2 IM2 ID2 IR2 USB DJR ' +
  'DJT EQM EQI INS RTO ARC GGR NXT XRH XMT OTT OTC OTI MTT'
).split(' ')

const INSTRUMENT_AT = 0x80
const EXTRA_AT      = 0xa6
const MOD_FX_AT     = 0x92
const MOD_FX_COUNT  = 5

/** Per instrument type: the names of 80-91, then of A6 and A7. '---' is a command the type does not use. */
const INSTRUMENT: Record<string, string[]> = {
  WAVSYNTH  : 'VOL PIT FIN OSC SIZ MUL WRP SCN FIL CUT RES AMP LIM PAN DRY SMX SDL SRV SNC ERR'.split(' '),
  MACROSYN  : 'VOL PIT FIN OSC TBR COL DEG RED FIL CUT RES AMP LIM PAN DRY SMX SDL SRV TRG ERR'.split(' '),
  SAMPLER   : 'VOL PIT FIN PLY STA LOP LEN DEG FLT CUT RES AMP LIM PAN DRY SMX SDL SRV SLI ERR'.split(' '),
  FMSYNTH   : 'VOL PIT FIN ALG FM1 FM2 FM3 FM4 FIL CUT RES AMP LIM PAN DRY SMX SDL SRV SNC ERR'.split(' '),
  HYPERSYN  : 'VOL PIT FIN CRD CVO SWM WID SUB FIL CUT RES AMP LIM PAN DRY SMX SDL SRV SNC ERR'.split(' '),
  'MIDI OUT': 'VOL PIT MPG MPB ADD CHD CCA CCB CCC CCD CCE CCF CCG CCH CCI CCJ --- --- --- ---'.split(' '),
  EXTERNAL  : 'VOL PIT MPB MPG CCA CCB CCC CCD FIL CUT RES AMP LIM PAN DRY SMX SDL SRV ADD CHD'.split(' ')
}

/** The five commands of a modulator, by modulator type (AHD, ADSR, DRUM, LFO, TRIG, TRACKING); the slot number follows. */
const MOD_FX = ['EA AT HO DE ET', 'EA AT DE SU ET', 'EA PK BO DE ET', 'LA LO LS LF LT', 'EA AT HO DE ET', 'TA TS TL TH TX'].map((names) => names.split(' '))

const unknown = (cmd: number): string => `?${cmd.toString(16).toUpperCase().padStart(2, '0')}`

/**
 * The name of command byte `cmd` (not FF) as the M8 shows it on a step or row played by `instrument`;
 * '?XX' when the name is not known. `instrumentsAt` is where the 128 instruments start in the file.
 */
export function fxName(bytes: Uint8Array, cmd: number, instrumentsAt: number, instrument: number | null): string {
  if (cmd < INSTRUMENT_AT) return SEQUENCER[cmd] ?? unknown(cmd)
  const at    = instrument == null || instrument >= 128 ? -1 : instrumentsAt + instrument * INSTRUMENT_SIZE
  const names = at >= 0 && at + INSTRUMENT_SIZE <= bytes.length ? INSTRUMENT[KINDS[bytes[at]]] : undefined
  if (!names) return unknown(cmd)
  if (cmd >= MOD_FX_AT && cmd < MOD_FX_AT + 4 * MOD_FX_COUNT) {
    const slot = Math.floor((cmd - MOD_FX_AT) / MOD_FX_COUNT)
    const kind = bytes[at + MODS_AT + slot * MOD_SIZE] >> 4
    const name = MOD_FX[kind]?.[(cmd - MOD_FX_AT) % MOD_FX_COUNT]
    return name ? `${name}${slot + 1}` : unknown(cmd)
  }
  if (cmd < MOD_FX_AT) return names[cmd - INSTRUMENT_AT]
  if (cmd === EXTRA_AT || cmd === EXTRA_AT + 1) return names[18 + cmd - EXTRA_AT]
  return unknown(cmd)
}

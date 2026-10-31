// What a selected cell means: the SDK's reading of the cell as the M8 shows it, and what the app
// knows from the whole song. m8/semantics.ts writes it; the HUD shows it.

import type { M8DescriptionPart } from '@yam8d/m8-sdk'

/** One line of facts: a label and its value. */
export type Fact = [label: string, value: string]

export interface CellDescription {
  /** Breadcrumb from the song down to the cell. */
  path : string[]
  /** Short title, e.g. "FX2 · KIL 03". */
  title: string
  parts: M8DescriptionPart[]
  /** Extra facts the app knows from the whole song (instrument name, uses...). */
  facts: Fact[]
}

// Numbers written the way the M8 shows them: upper case hex.

/** 0x0b -> '0B'; `empty` for a missing value ('--' by default). */
export const hex2     = (value: number | null | undefined, empty = '--'): string =>
  value == null ? empty : value.toString(16).toUpperCase().padStart(2, '0')

/** 11 -> 'B': a row number of a chain, phrase, table or groove. */
export const hexDigit = (value: number): string => value.toString(16).toUpperCase()

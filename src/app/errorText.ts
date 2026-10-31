// An error as text for the HUD and the debug log.

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

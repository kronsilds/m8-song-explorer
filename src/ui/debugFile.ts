// Debug log export through the browser's download.

import type { DebugReport } from '../model/debugLog'

/** Saves the log as 'm8-explorer-debug-<song>-<date>-<time>.json'; returns the file name. */
export function downloadDebugReport(report: DebugReport, songName: string | null): string {
  const blob    = new Blob([JSON.stringify(report, null, 1)], { type: 'application/json' })
  const link    = document.createElement('a')
  const name    = (songName ?? 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const stamp   = report.exportedAt.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  link.href     = URL.createObjectURL(blob)
  link.download = `m8-explorer-debug-${name}-${stamp}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  return link.download
}

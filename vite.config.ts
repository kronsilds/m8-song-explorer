import { readFileSync } from 'node:fs'
import { defineConfig, searchForWorkspaceRoot } from 'vite'

/** The installed SDK's version, for the debug log. */
function sdkVersion(): string | null {
  try {
    return (JSON.parse(readFileSync(new URL('./node_modules/@yam8d/m8-sdk/package.json', import.meta.url), 'utf8')) as { version: string }).version
  } catch {
    return null
  }
}

export default defineConfig({
  base: './',
  define: {
    __SDK_VERSION__: JSON.stringify(sdkVersion()),
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    // three.js and the SDF text renderer are most of the bundle.
    chunkSizeWarningLimit: 1200,
  },
  server: {
    // The SDK is linked from ../yam8d/packages/m8-sdk
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), '../yam8d/packages/m8-sdk'] },
  },
})

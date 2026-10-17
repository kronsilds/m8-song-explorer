import { defineConfig, searchForWorkspaceRoot } from 'vite'

export default defineConfig({
  base: './',
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

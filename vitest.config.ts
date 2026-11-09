import { defineConfig } from 'vitest/config'

// Unit, golden and conformance tests for the headless framework (packages/, apps/cli).
// Lighting ownership is testable without WebGL; rendered 3D uses the add-on scenarios.
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'src/three/lab/*.test.ts', 'src/runtime/*.test.ts'],
    environment: 'node',
    setupFiles: ['./src/runtime/science.test.setup.ts', './src/runtime/content.test.setup.ts'],
    // Conformance tests compile whole practicals; under a full parallel run on a busy machine they
    // take three to five times as long as alone, so the limit only catches hangs.
    testTimeout: 120000,
  },
})

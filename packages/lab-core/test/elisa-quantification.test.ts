// Quantifying antibody by ELISA against a known standard: duplicates, saturation and the working
// range, and the sera read only from their in-range points.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

describe('conformance: ELISA against a known standard', () => {
  const def = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio22-elisa-standard-quantification.labx.json')) as ExperimentDefinition

  it('rehearses for several seeds, the sera within a quarter of the truth', () => {
    for (const seed of [1, 2]) {
      const r = compile(def, cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 600000)
})

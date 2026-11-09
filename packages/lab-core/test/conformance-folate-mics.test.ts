// Folate-pathway antibiotics: trimethoprim and sulfamethoxazole MICs for a reference E. coli, a
// urinary isolate carrying dfrA and S. aureus, with a solvent-only row.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const mics = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro15-folate-antibiotic-mics.labx.json')) as ExperimentDefinition
const recorded = (r: ReturnType<typeof compile>, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)?.value

describe('conformance: folate-pathway antibiotic MICs', () => {
  it('rehearses for several seeds: the isolate resists trimethoprim, the solvent inhibits nothing', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(mics, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
      expect(recorded(r, 'MIC-A')).toBe(0.25)
      expect(recorded(r, 'MIC-G')).toBe(256)
    }
  }, 300000)

  it('an isolate without dfrA is inhibited like K-12, and trimethoprim becomes a reasonable choice', () => {
    const def = structuredClone(mics)
    def.materials!.samples!.find((s) => s.id === 'uti')!.contains![0].substance = 'micro:escherichia-coli-k12'
    const r = compile(def, catalogue, { seed: 1 })
    expect(recorded(r, 'MIC-B')).toBe(0.25)
    expect(r.run!.decisions['breakpoint']).toBe('susceptible')
    expect(r.rehearsal!.expectedObservations.find((e) => e.id === 'e-isolate')!.passed).toBe(false)
  }, 180000)
})

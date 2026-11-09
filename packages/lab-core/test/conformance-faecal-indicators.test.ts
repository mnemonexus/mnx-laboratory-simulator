// Is it safe to swim? Viable counts by serial dilution and spread plating, E. coli on EMB, and the
// limit of detection of plating 0.1 mL.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const water = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro11-faecal-indicators.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const noted = (r: Result, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)?.value

describe('conformance: faecal indicators', () => {
  it('rehearses for several seeds with every goal met', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(water, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(noted(r, 'EMB-emb-b0')).not.toMatch(/sheen/)
    }
  }, 240000)

  it('without vortexing each dilution, each draw is mostly the sample just added: every plate is too many to count', () => {
    const def = structuredClone(water)
    const series = def.procedure!.steps!.find((s) => s.id === 'a-series')!
    series.steps = series.steps!.filter((s) => s.ref !== 'core:mix')
    const r = compile(def, catalogue, { seed: 1 })
    for (const k of [3, 4, 5]) expect(noted(r, `count-na-a${k}`)).toBeNull()
    expect(noted(r, 'TVC-per-mL-a')).toBeNull()
  }, 240000)
})

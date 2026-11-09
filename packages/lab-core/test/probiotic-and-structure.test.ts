// A probiotic identified by Gram stain, MRS agar and a species-specific PCR; and GALC's turnover in two
// conditions, which times a crystal soak. Both reach their goals over several seeds, and their key
// consequences come from the models: MRS stops E. coli, the PCR amplifies only L. acidophilus, and GALC
// works tens of times more slowly at pH 7.5 than at its acidic optimum.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const def = (pack: string, id: string) => readJson(join(PACKAGES, pack, 'definitions', `${id}.labx.json`)) as ExperimentDefinition
const value = (r: ReturnType<typeof compile>, f: string) => r.kernel!.world.notebook.find((e) => e.field === f)!.value

describe('probiotic identification (micro18)', () => {
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: MRS selects lactobacilli and the PCR names L. acidophilus`, () => {
      const r = compile(def('pack-microbiology', 'micro18-probiotic-identification'), cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
      expect(value(r, 'mrs-controls')).toMatch(/sector 1: confluent.*sector 2: none/)
      // The drink holds only L. rhamnosus: it grows on MRS, with one kind of colony.
      expect(value(r, 'mrs-drink')).toMatch(/^\d+ colonies: \d+ larger, creamy white/)
      expect(value(r, 'mrs-capsule')).toMatch(/small, grey-white.*larger, creamy white/)
      for (const lane of ['sizes-pcr-la1', 'sizes-pcr-la2']) expect((value(r, lane) as number[]).some((b) => Math.abs(b - 129) < 10)).toBe(true)
      expect(value(r, 'sizes-pcr-ec')).toEqual([])
      expect(value(r, 'sizes-pcr-water')).toEqual([])
    }, 240000)
  }
})

describe('timing a crystal soak from GALC turnover (bio30)', () => {
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: turnover is tens of times slower at pH 7.5`, () => {
      const r = compile(def('pack-biochemistry', 'bio30-structure-from-soaks-crystals-and-grids'), cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
      const acid = value(r, 'turnover-s-acid') as number
      const soak = value(r, 'turnover-s-soak') as number
      // kcat × bell-shaped pH factor (pKa 3.5 and 5.7) at 21 °C: about 0.86 at pH 4.6 and 0.016 at pH 7.5.
      expect(soak / acid).toBeGreaterThan(35)
      expect(soak / acid).toBeLessThan(75)
    }, 120000)
  }
})

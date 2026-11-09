// Nutrients in a stream: two derivatisation assays, each read within its calibration. The effluent
// is diluted into range; zinc timing matters because the reduction is partial.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const nutrients = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem14-stream-nutrients.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const noted = (r: Result, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)?.value as number
const nitrateTruth = (r: Result, s: string) => (evaluate(`value(truth(conc, '${s}', 'chem:sodium-nitrate'), 'mol/L') * 62000`, runEnv(r.run!)) as number)

describe('conformance: stream nutrients', () => {
  it('rehearses for several seeds: every goal met, the undiluted effluent beyond the standards', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(nutrients, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 240000)

  it('left on the zinc for 10 minutes instead of 2, the samples read far too high', () => {
    const def = structuredClone(nutrients)
    const wait = def.procedure!.steps!.find((s) => s.id === 'samples-on-zinc')!
    wait.params = { ...wait.params, duration: '10 min' }
    const r = compile(def, catalogue, { seed: 1 })
    expect(noted(r, 'NO3-below')).toBeGreaterThan(2 * nitrateTruth(r, 'below'))
  }, 120000)
})

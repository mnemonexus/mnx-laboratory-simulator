// A viable count: a ten-fold serial dilution, duplicate spread plates, the countable range and
// CFU per mL (composes the dilution technique, plating, growth and colony counting).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const viable = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro5-viable-count.labx.json')) as ExperimentDefinition

function run(def: ExperimentDefinition, seed: number) {
  const r = compile(def, catalogue, { seed })
  const env = runEnv(r.run!)
  const n = (p: string) => evaluate(`colonies('${p}')`, env) as number
  const cfu = r.kernel!.world.notebook.find((e) => e.field === 'cfu-per-ml')!.value as number
  return { r, n, cfu, truth: evaluate("cells('culture', viable)", env) as number }
}

describe('conformance: viable count', () => {
  it('rehearses for several seeds: within 25 % of the truth, duplicates that agree, ten-fold steps', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { r, n, cfu, truth } = run(viable, seed)
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(Math.abs(cfu / truth - 1)).toBeLessThan(0.25)
      // Duplicates differ by no more than Poisson scatter allows.
      const mean6 = (n('p6a') + n('p6b')) / 2
      expect(Math.abs(n('p6a') - n('p6b'))).toBeLessThan(4 * Math.sqrt(mean6))
      // Each step down the series is ten-fold.
      const mean5 = (n('p5a') + n('p5b')) / 2
      expect(mean5 / mean6).toBeGreaterThan(7)
      expect(mean5 / mean6).toBeLessThan(14)
    }
  }, 60000)

  it('plating 10 µL but calculating for 100 µL gives a count ten times too low', () => {
    const def = structuredClone(viable)
    const plating = def.procedure!.steps!.find((s) => s.id === 'plating')!
    plating.steps!.find((s) => s.id === 'spread')!.params!.volume = '10 uL'
    const { r, cfu, truth } = run(def, 1)
    expect(cfu / truth).toBeLessThan(0.2)
    expect(r.rehearsal!.goals[0].passed).toBe(false)
  })
})

describe('nutrient-limited growth', () => {
  it('broth diluted ten-fold supports about a tenth of the cells', () => {
    const final = (lbGPerL: number) => {
      const w = emptyWorld(1)
      addPlace(w, catalogue, 'inc', 'core:incubator', undefined, '37 Cel')
      addSupply(w, catalogue, { id: 'b', label: 'Broth', container: 'core:conical-tube-15ml', amount: '10 mL', components: [{ substance: 'micro:lb-nutrients', conc: `${lbGPerL} g/L` }], populations: [{ substance: 'micro:escherichia-coli-k12', perL: 1e9 }], place: 'inc' })
      w.containers.b.contents.temperatureK = w.places.inc.temperatureK
      const k = createKernel(catalogue, w)
      k.execute({ op: 'core:advance-time', params: { duration: '24 h' } })
      return k.world.containers.b.contents.layers[0].populations!['micro:escherichia-coli-k12'].viable / 10
    }
    const full = final(15)
    const tenth = final(1.5)
    expect(full).toBeGreaterThan(1.8e9)
    expect(tenth / full).toBeGreaterThan(0.08)
    expect(tenth / full).toBeLessThan(0.12)
  })
})

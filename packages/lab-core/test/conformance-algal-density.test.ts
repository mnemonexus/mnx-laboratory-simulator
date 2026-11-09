// Algae in a river: concentrate by centrifugation, count in a haemocytometer, work back. The
// estimate tracks the truth (a little low: liquid left behind dilutes the concentrate), the
// downstream bloom stands out, and mistakes in the concentration step have their consequences.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const algae = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro10-algal-density.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const noted = (r: Result, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)?.value as number
const group = (def: ExperimentDefinition, id: string) => def.procedure!.steps!.find((s) => s.id === id)!

describe('conformance: algal density', () => {
  it('rehearses for several seeds: every goal met, the downstream site densest', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(algae, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(noted(r, 'mean-per-mL-site-c')).toBeGreaterThan(2 * noted(r, 'mean-per-mL-site-a'))
    }
  }, 180000)

  it('without vortexing the pellet back up, the counts are a small fraction of the truth', () => {
    const def = structuredClone(algae)
    const takeUp = group(def, 'take-up')
    takeUp.steps = takeUp.steps!.filter((s) => s.id !== 'vortex')
    const counts = group(def, 'counts')
    counts.steps = counts.steps!.filter((s) => s.id !== 'mix')
    const r = compile(def, catalogue, { seed: 1 })
    expect(noted(r, 'mean-per-mL-site-c')).toBeLessThan(0.2 * (compile(algae, catalogue, { seed: 1 }).kernel!.world.notebook.find((e) => e.field === 'mean-per-mL-site-c')!.value as number))
  }, 120000)

  it('with the blank left out the rotor is unbalanced: the run stops and nothing is concentrated', () => {
    const def = structuredClone(algae)
    const conc = group(def, 'concentrate')
    conc.forEach = { var: 'x', in: "=[['tube-a', 'site-a', 'Site A', 1], ['tube-b', 'site-b', 'Site B', 2], ['tube-c', 'site-c', 'Site C', 3]]" }
    const takeUp = group(def, 'take-up')
    takeUp.forEach = conc.forEach
    const r = compile(def, catalogue, { seed: 1 })
    expect(r.kernel!.world.incidents.some((i) => i.kind === 'mechanical')).toBe(true)
  }, 120000)
})

// A purification table: an affinity column, a Bradford assay of the fractions and GFP by its
// absorbance, composed into yield and fold purification. The numbers come from the run: skip the
// washes and host proteins carry over into the eluate, so the fold falls.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const table = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio13-purification-table.labx.json')) as ExperimentDefinition
const noted = (r: ReturnType<typeof compile>, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)!.value as number

describe('conformance: purification table', () => {
  it('rehearses for several seeds: most of the GFP kept, about six-fold purer', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(table, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(r.run!.decisions.ceiling).toBe('six')
      expect(noted(r, 'yield-%')).toBeGreaterThan(80)
      expect(noted(r, 'fold-purification')).toBeGreaterThan(4.5)
      expect(noted(r, 'fold-purification')).toBeLessThan(6.5)
      // The lysate's total protein is 2.4 mg/mL; 2 mL were loaded.
      expect(noted(r, 'protein-mg-lysate')).toBeGreaterThan(4.3)
      expect(noted(r, 'protein-mg-lysate')).toBeLessThan(5.3)
    }
  }, 120000)

  it('without the washes, host proteins come off with the GFP and the fold falls', () => {
    const def = structuredClone(table)
    def.procedure!.steps = def.procedure!.steps!.filter((s) => s.id !== 'washes')
    const r = compile(def, catalogue, { seed: 1 })
    const washed = compile(table, catalogue, { seed: 1 })
    expect(noted(r, 'fold-purification')).toBeLessThan(noted(washed, 'fold-purification') - 0.5)
  }, 60000)

  it('unknowns sharing one plate group are flagged, not silently left unread', () => {
    const def = structuredClone(table)
    const map = def.procedure!.steps!.find((s) => s.id === 'plate-map')!
    const groups = (map.params as { groups: { group: string }[] }).groups
    ;(map.params as { groups: unknown[] }).groups = [groups[0], { group: 'fractions', items: ['l-dil', 'ft-dil', 'e1'], role: 'unknown' }]
    const r = compile(def, catalogue, { seed: 1 })
    expect(r.rehearsal!.quality.find((q) => q.criterion === 'unknowns-found')?.passed).toBe(false)
    expect(compile(table, catalogue, { seed: 1 }).rehearsal!.quality.find((q) => q.criterion === 'unknowns-found')?.passed).toBe(true)
  }, 60000)
})

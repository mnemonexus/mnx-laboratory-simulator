// Antibiotics together: additive by default (Loewe), with a declared interaction where a pair is
// not (trimethoprim with sulfamethoxazole, FICI 0.3); in broth and from discs dipped in a mixture,
// and a checkerboard that measures the FICI.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'
import { zonesOn } from '../src/models/discdiffusion.ts'
import { combinedRatio } from '../src/models/growth.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const TMP = 'micro:trimethoprim'
const SMX = 'micro:sulfamethoxazole'

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

describe('combined action', () => {
  it('one drug is its own ratio, two unrelated drugs add, and a synergistic pair inhibits at equal shares of its FICI', () => {
    expect(combinedRatio(cat, [{ substance: TMP, ratio: 0.7 }])).toBeCloseTo(0.7, 12)
    expect(combinedRatio(cat, [{ substance: 'micro:gentamicin', ratio: 0.5 }, { substance: 'micro:streptomycin', ratio: 0.5 }])).toBeCloseTo(1, 12)
    expect(combinedRatio(cat, [{ substance: TMP, ratio: 0.15 }, { substance: SMX, ratio: 0.15 }])).toBeCloseTo(1, 12)
    expect(combinedRatio(cat, [{ substance: TMP, ratio: 0.1 }, { substance: SMX, ratio: 0.1 }])).toBeLessThan(1)
  })

  it('a disc dipped in the mixture leaves a larger zone than either drug at the same strength, and a water disc none', () => {
    const w = emptyWorld(1)
    addPlace(w, cat, 'incubator', 'core:incubator')
    addEquipment(w, cat, 'spreader', 'core:cell-spreader')
    addSupply(w, cat, { id: 'cells', label: 'cells', container: 'core:microtube-1.5ml', amount: '1 mL', preparation: 'micro:nutrient-broth-sterile', populations: [{ substance: 'micro:escherichia-coli-k12', perL: 7e9 }] })
    addSupply(w, cat, { id: 'plate', label: 'plate', container: 'core:petri-dish-90mm', amount: '20 mL', preparation: 'micro:nutrient-agar' })
    const sol = (id: string, comps: Array<[string, string]>) => addSupply(w, cat, { id, label: id, container: 'core:microtube-1.5ml', amount: '500 uL', preparation: 'core:water-deionised', components: comps.map(([substance, conc]) => ({ substance, conc })) })
    sol('t', [[TMP, '0.05 mg/mL']])
    sol('s', [[SMX, '0.95 mg/mL']])
    sol('m', [[TMP, '0.05 mg/mL'], [SMX, '0.95 mg/mL']])
    sol('w', [])
    const k = createKernel(cat, w)
    run(k, 'core:set-environment', { device: 'incubator', temperature: '37 Cel' })
    run(k, 'core:transfer', { source: 'cells', destination: 'plate', volume: '100 uL' })
    run(k, 'core:spread', { plate: 'plate', tool: 'spreader' })
    for (const [i, src] of ['t', 's', 'm', 'w'].entries()) {
      run(k, 'core:fetch', { equipment: 'core:susceptibility-disc', id: `d-${src}` })
      run(k, 'core:transfer', { source: src, destination: `d-${src}`, volume: '15 uL' })
      run(k, 'core:apply-disc', { disc: `d-${src}`, plate: 'plate', position: i + 1 })
    }
    run(k, 'core:place-in', { container: 'plate', place: 'incubator' })
    run(k, 'core:advance-time', { duration: '18 h' })
    const zones = Object.fromEntries(zonesOn(cat, k.world.containers.plate)!.map((z) => [z.disc, z.diameterMm]))
    expect(zones['d-m']).toBeGreaterThan(zones['d-t'] + 2)
    expect(zones['d-t']).toBeGreaterThan(zones['d-s'])
    expect(zones['d-w']).toBe(6)
  })
})

describe('conformance: checkerboards', () => {
  const board = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro16-checkerboard-synergy.labx.json')) as ExperimentDefinition
  const fici = (r: ReturnType<typeof compile>, pair: string) => r.kernel!.world.notebook.find((e) => e.field === `fici-${pair}`)?.value as number

  it('rehearses for several seeds: trimethoprim with sulfamethoxazole synergistic, the aminoglycosides additive', () => {
    for (const seed of [1, 2]) {
      const r = compile(board, cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
      expect(fici(r, 'tmp-smx')).toBeLessThanOrEqual(0.5)
      expect(fici(r, 'gen-str')).toBe(1)
    }
  }, 600000)

  it('without the declared interaction, the folate pair is merely additive', () => {
    const packs = loadAllPacks()
    for (const p of packs) for (const s of p.substances ?? []) if (s.antibiotic?.interactions) delete s.antibiotic.interactions
    const { catalogue: plain } = Catalogue.build(packs)
    const r = compile(board, plain, { seed: 1 })
    expect(fici(r, 'tmp-smx')).toBeGreaterThan(0.5)
    expect(r.run!.decisions['pair-1']).toBe('indifferent')
  }, 300000)
})

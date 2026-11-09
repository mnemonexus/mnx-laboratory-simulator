// Distillation: vapour-liquid equilibrium from catalogue data, enrichment through a column's
// theoretical plates up to the azeotrope, a depleting pot, and fractions read by density.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { vapourAfter, vleFor } from '../src/models/distillation.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const distillation = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem9-fractional-distillation.labx.json')) as ExperimentDefinition
const value = (r: ReturnType<typeof compile>, f: string) => r.kernel!.world.notebook.find((e) => e.field === f)!.value as number

describe('conformance: simple and fractional distillation', () => {
  it('rehearses for several seeds: the column gives a much richer first fraction, below the azeotrope', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = compile(distillation, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(value(r, 'ethanol-%-simple-1')).toBeGreaterThan(50)
      expect(value(r, 'ethanol-%-simple-1')).toBeLessThan(75)
      expect(value(r, 'ethanol-%-fractional-1')).toBeGreaterThan(80)
    }
  }, 60000)
})

describe('distillation model', () => {
  const vle = vleFor(catalogue, { volumeL: 1, species: { 'core:ethanol': 1 } })!

  it('enriches the vapour at each plate but never past the azeotrope', () => {
    expect(vapourAfter(vle, 0.072, 1)).toBeCloseTo(0.389, 2)
    expect(vapourAfter(vle, 0.072, 4)).toBeGreaterThan(vapourAfter(vle, 0.072, 2))
    expect(vapourAfter(vle, 0.072, 50)).toBeLessThan(0.9)
    expect(vapourAfter(vle, 0.072, 50)).toBeGreaterThan(0.88)
  })

  it('refuses to distil a pot to dryness', () => {
    const w = emptyWorld(1)
    addSupply(w, catalogue, { id: 'pot', label: 'Pot', container: 'core:round-bottom-flask-250ml', amount: '20 mL', components: [{ substance: 'core:ethanol', conc: '157.8 g/L' }] })
    const k = createKernel(catalogue, w)
    k.execute({ op: 'core:fetch', params: { equipment: 'core:conical-tube-50ml', id: 'r' } })
    const result = k.execute({ op: 'core:distil', params: { flask: 'pot', receiver: 'r', volume: '18 mL' } })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.refusal.code).toBe('TO-DRYNESS')
  })
})

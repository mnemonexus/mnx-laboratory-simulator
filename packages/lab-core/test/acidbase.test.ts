import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { fractions, layerPH, pKw, solvePH, visibleColour } from '../src/models/acidbase.ts'
import { epsilon } from '../src/models/measurement.ts'
import { addEquipment, addSupply, createKernel, emptyWorld, meanLayer } from '../src/kernel/index.ts'
import type { Layer } from '../src/kernel/state.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const layer = (species: Record<string, number>, volumeL = 1): Layer => ({ volumeL, species })
const pH = (species: Record<string, number>) => layerPH(cat, layer(species), 298.15)!

describe('acid–base solver (textbook values, 25 °C, ideal solution)', () => {
  it('water, strong acid and strong base', () => {
    expect(pH({})).toBeCloseTo(7.0, 2)
    expect(pH({ 'core:hydrochloric-acid': 0.01 })).toBeCloseTo(2.0, 2)
    expect(pH({ 'core:sodium-hydroxide': 0.01 })).toBeCloseTo(12.0, 2)
    expect(pKw(310.15)).toBeCloseTo(13.6, 1)
  })

  it('weak acid, buffer and amphiprotic salt', () => {
    expect(pH({ 'core:acetic-acid': 0.1 })).toBeCloseTo(2.88, 2)
    expect(pH({ 'core:acetic-acid': 0.1, 'core:sodium-acetate': 0.1 })).toBeCloseTo(4.76, 2)
    // KHP: (pKa1 + pKa2) / 2 ≈ 4.18 at this concentration.
    expect(pH({ 'core:potassium-hydrogen-phthalate': 0.05 })).toBeGreaterThan(4.0)
    expect(pH({ 'core:potassium-hydrogen-phthalate': 0.05 })).toBeLessThan(4.25)
    expect(pH({ 'core:tris': 0.05, 'core:hydrochloric-acid': 0.0394 })).toBeCloseTo(7.5, 1)
  })

  it('the calibration buffer recipes give their labelled pH', () => {
    for (const [prep, expected] of [['core:ph-buffer-4', 4.0], ['core:ph-buffer-7', 7.0]] as const) {
      const comps = cat.preparations.get(prep)!.components
      const species: Record<string, number> = {}
      for (const c of comps) species[c.substance] = Number(c.conc.split(' ')[0]) / 1000
      expect(pH(species)).toBeCloseTo(expected, 2)
    }
  })

  it('titration curve of KHP with NaOH has its equivalence jump near pH 9', () => {
    const khp = 0.0025
    const at = (frac: number) => solvePH([
      { substance: 'khp', total: khp / 0.075, pKa: [2.95, 5.41], charge: 0, spectator: 1 },
      { substance: 'naoh', total: (khp * frac) / 0.075, pKa: [], charge: 0, spectator: 1 },
    ])
    expect(at(0.5)).toBeCloseTo(5.41, 1)
    expect(at(1.0)).toBeGreaterThan(8.5)
    expect(at(1.0)).toBeLessThan(9.3)
    expect(at(1.02) - at(0.98)).toBeGreaterThan(3)
  })

  it('fractions sum to one and shift with pH', () => {
    const a = fractions([2.15, 7.2, 12.35], 7.2)
    expect(a.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 12)
    expect(a[1]).toBeCloseTo(0.5, 2)
    expect(a[2]).toBeCloseTo(0.5, 2)
  })

  it('phenolphthalein is colourless in acid and pink in base', () => {
    const base = (s: string, nm: number) => epsilon(cat, s, nm)
    expect(visibleColour(cat, layer({ 'core:phenolphthalein': 4e-5, 'core:hydrochloric-acid': 1e-3 }), 298.15, base)).toBe('colourless')
    expect(visibleColour(cat, layer({ 'core:phenolphthalein': 4e-5, 'core:sodium-hydroxide': 1e-3 }), 298.15, base)).toBe('pink')
  })
})

describe('pH meter', () => {
  it('reads wrong until calibrated with two buffers, then right', () => {
    const w = emptyWorld(5)
    addEquipment(w, cat, 'meter', 'core:ph-meter.benchtop')
    addSupply(w, cat, { id: 'b4', label: 'pH 4.00 buffer', container: 'core:beaker-100ml', amount: '50 mL', preparation: 'core:ph-buffer-4' })
    addSupply(w, cat, { id: 'b7', label: 'pH 7.00 buffer', container: 'core:beaker-100ml', amount: '50 mL', preparation: 'core:ph-buffer-7' })
    addSupply(w, cat, { id: 'tris', label: 'Tris buffer', container: 'core:beaker-100ml', amount: '50 mL', preparation: 'core:tris-50mm-ph7.5' })
    const k = createKernel(cat, w, { noise: 0 })
    const truth = layerPH(cat, meanLayer(k.world.containers.tris.contents), k.world.containers.tris.contents.temperatureK)!
    const read = () => {
      const r = k.execute({ op: 'core:measure', params: { instrument: 'meter', subject: 'tris' } })
      if (!r.ok) throw new Error(r.refusal.message)
      return Number(r.outputs.value)
    }
    const before = read()
    expect(k.execute({ op: 'core:calibrate', params: { instrument: 'meter', mode: 'two-point', buffers: ['b4', 'b7'] } }).ok).toBe(true)
    const after = read()
    expect(Math.abs(after - truth)).toBeLessThanOrEqual(0.02)
    expect(Math.abs(before - truth)).toBeGreaterThan(Math.abs(after - truth))
  })
})

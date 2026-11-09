// Liquid–liquid phases and an organic work-up: ethyl acetate standing over water, partition by logP
// and pH, brine and a drying agent, reflux at the mixture's boiling point, the esterification
// equilibrium with water as a product, rotary evaporation, and the Fischer ester practical.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld, type Kernel, type SupplySpec } from '../src/kernel/index.ts'
import { waterMol } from '../src/models/distillation.ts'
import { isOrganic } from '../src/models/phases.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const ETOAC = { substance: 'chem:ethyl-acetate', conc: '902 g/L' }

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

function bench(...supplies: SupplySpec[]): Kernel {
  const w = emptyWorld(1)
  for (const s of supplies) addSupply(w, cat, s)
  return createKernel(cat, w, { handlingError: 0, noise: 0 })
}

const bottle = (id: string, amount: string, components: SupplySpec['components'], preparation?: string): SupplySpec => ({ id, label: id, container: 'core:reagent-bottle-1l', amount, components, ...(preparation ? { preparation } : {}) })

describe('two liquids that do not mix', () => {
  it('a little ethyl acetate dissolves in water; more stands as a lighter layer that diffusion does not mix', () => {
    const k = bench(bottle('water', '100 mL', []), bottle('etoac', '100 mL', [ETOAC]))
    run(k, 'core:fetch', { equipment: 'core:separating-funnel-250ml', id: 'sep', label: 'sep' })
    run(k, 'core:transfer', { source: 'water', destination: 'sep', volume: '60 mL' })
    run(k, 'core:transfer', { source: 'etoac', destination: 'sep', volume: '2 mL' })
    run(k, 'core:close', { container: 'sep' })
    run(k, 'core:mix', { container: 'sep', method: 'invert', cycles: 5 })
    expect(k.world.containers.sep.contents.layers).toHaveLength(1)
    run(k, 'core:open', { container: 'sep' })
    run(k, 'core:transfer', { source: 'etoac', destination: 'sep', volume: '20 mL' })
    run(k, 'core:close', { container: 'sep' })
    run(k, 'core:mix', { container: 'sep', method: 'shake', cycles: 3 })
    run(k, 'core:advance-time', { duration: '2 h' })
    const [top, bottom] = k.world.containers.sep.contents.layers
    expect(isOrganic(cat, top)).toBe(true)
    expect(isOrganic(cat, bottom)).toBe(false)
    // About 8 g/100 mL of it stays in the water (some 5 mL of the 22), and the solvent takes up some water.
    expect(top.volumeL * 1000).toBeGreaterThan(15)
    expect(top.volumeL * 1000).toBeLessThan(18.5)
    expect(waterMol(cat, top) * 18).toBeGreaterThan(0.3)
  })

  it('an acid goes into the solvent from acidic water and out again into bicarbonate; a neutral ester stays', () => {
    const k = bench(
      bottle('acidic', '100 mL', [{ substance: 'chem:4-nitrocinnamic-acid', conc: '10 mM' }, { substance: 'chem:ethyl-4-nitrocinnamate', conc: '10 mM' }, { substance: 'core:sulfuric-acid', conc: '0.2 M' }]),
      bottle('etoac', '100 mL', [ETOAC]),
      bottle('bicarb', '100 mL', [], 'core:sodium-bicarbonate-saturated'),
    )
    run(k, 'core:fetch', { equipment: 'core:separating-funnel-250ml', id: 'sep', label: 'sep' })
    run(k, 'core:fetch', { equipment: 'core:beaker-100ml', id: 'aq', label: 'aq' })
    run(k, 'core:transfer', { source: 'acidic', destination: 'sep', volume: '30 mL' })
    run(k, 'core:transfer', { source: 'etoac', destination: 'sep', volume: '30 mL' })
    run(k, 'core:close', { container: 'sep' })
    run(k, 'core:mix', { container: 'sep', method: 'shake', cycles: 3 })
    run(k, 'core:open', { container: 'sep' })
    const share = (s: string) => {
      const [org, aq] = k.world.containers.sep.contents.layers
      return (org.species[s] ?? 0) / ((org.species[s] ?? 0) + (aq.species[s] ?? 0))
    }
    expect(share('chem:4-nitrocinnamic-acid')).toBeGreaterThan(0.95)
    expect(share('chem:ethyl-4-nitrocinnamate')).toBeGreaterThan(0.99)
    expect(k.world.containers.sep.contents.layers[0].species['core:sulfuric-acid'] ?? 0).toBe(0)
    run(k, 'core:drain', { funnel: 'sep', receiver: 'aq' })
    run(k, 'core:transfer', { source: 'bicarb', destination: 'sep', volume: '30 mL' })
    run(k, 'core:close', { container: 'sep' })
    run(k, 'core:mix', { container: 'sep', method: 'shake', cycles: 3 })
    expect(share('chem:4-nitrocinnamic-acid')).toBeLessThan(0.05)
    expect(share('chem:ethyl-4-nitrocinnamate')).toBeGreaterThan(0.99)
  })

  it('shaken without its stopper, a separating funnel loses half its contents', () => {
    const k = bench(bottle('water', '100 mL', []))
    run(k, 'core:fetch', { equipment: 'core:separating-funnel-250ml', id: 'sep', label: 'sep' })
    run(k, 'core:transfer', { source: 'water', destination: 'sep', volume: '40 mL' })
    run(k, 'core:mix', { container: 'sep', method: 'shake' })
    expect(k.world.containers.sep.contents.layers[0].volumeL * 1000).toBeLessThan(25)
  })
})

describe('drying an organic layer', () => {
  function wetExtract(mgso4G: number, brine: boolean) {
    const k = bench(bottle('water', '100 mL', [{ substance: 'core:sodium-chloride', conc: '0.5 M' }]), bottle('etoac', '100 mL', [ETOAC]), bottle('brine', '100 mL', [], 'core:brine-saturated'),
      { id: 'mgso4', label: 'MgSO4', container: 'core:reagent-bottle-50ml', amount: '20 g', solid: 'core:magnesium-sulfate-anhydrous' })
    run(k, 'core:fetch', { equipment: 'core:separating-funnel-250ml', id: 'sep', label: 'sep' })
    run(k, 'core:fetch', { equipment: 'core:beaker-100ml', id: 'aq', label: 'aq' })
    run(k, 'core:fetch', { equipment: 'core:conical-flask-100ml', id: 'dry', label: 'dry' })
    run(k, 'core:transfer', { source: 'water', destination: 'sep', volume: '30 mL' })
    run(k, 'core:transfer', { source: 'etoac', destination: 'sep', volume: '40 mL' })
    run(k, 'core:mix', { container: 'sep', method: 'swirl', cycles: 10 })
    run(k, 'core:drain', { funnel: 'sep', receiver: 'aq' })
    if (brine) {
      run(k, 'core:transfer', { source: 'brine', destination: 'sep', volume: '20 mL' })
      run(k, 'core:mix', { container: 'sep', method: 'swirl', cycles: 10 })
      run(k, 'core:drain', { funnel: 'sep', receiver: 'aq' })
    }
    const solventWater = waterMol(cat, k.world.containers.sep.contents.layers[0])
    run(k, 'core:transfer', { source: 'sep', destination: 'dry', all: true })
    if (mgso4G > 0) {
      run(k, 'core:add-solid', { substance: 'mgso4', destination: 'dry', mass: `${mgso4G} g` })
      run(k, 'core:mix', { container: 'dry', method: 'swirl' })
    }
    return { k, solventWater, c: k.world.containers.dry.contents }
  }

  it('brine leaves the solvent drier than water does', () => {
    expect(wetExtract(0, true).solventWater).toBeLessThan(0.9 * wetExtract(0, false).solventWater)
  })

  it('enough magnesium sulfate takes up all the water, droplets and their salt included, and some stays free-flowing', () => {
    const { c } = wetExtract(2, true)
    expect(c.layers).toHaveLength(1)
    expect(waterMol(cat, c.layers[0])).toBeLessThan(1e-9)
    expect(c.solid['core:magnesium-sulfate-anhydrous']).toBeGreaterThan(0.002)
    expect(c.solid['core:magnesium-sulfate-heptahydrate']).toBeGreaterThan(0)
    expect(c.layers[0].species['core:sodium-chloride'] ?? 0).toBe(0)
  })

  it('too little clumps completely and leaves water behind', () => {
    const { c } = wetExtract(0.2, false)
    expect(c.solid['core:magnesium-sulfate-anhydrous'] ?? 0).toBeLessThan(1e-9)
    expect(c.layers.reduce((a, l) => a + waterMol(cat, l), 0)).toBeGreaterThan(0.01)
  })
})

describe('heating ethanol mixtures', () => {
  function heated(place: string, equipment: string, temperature: string) {
    const w = emptyWorld(1)
    addPlace(w, cat, place, equipment)
    addSupply(w, cat, bottle('etoh', '100 mL', [{ substance: 'core:ethanol', conc: '789 g/L' }]))
    const k = createKernel(cat, w, { handlingError: 0, noise: 0 })
    run(k, 'core:fetch', { equipment: 'core:round-bottom-flask-100ml', id: 'rbf', label: 'rbf' })
    run(k, 'core:transfer', { source: 'etoh', destination: 'rbf', volume: '20 mL' })
    run(k, 'core:place-in', { container: 'rbf', place })
    run(k, 'core:set-environment', { device: place, temperature })
    run(k, 'core:advance-time', { duration: '30 min' })
    return k.world.containers.rbf.contents
  }

  it('under a reflux condenser it boils at its own boiling point and loses nothing', () => {
    const c = heated('mantle', 'core:reflux-apparatus', '110 Cel')
    expect(c.temperatureK - 273.15).toBeGreaterThan(77.5)
    expect(c.temperatureK - 273.15).toBeLessThan(79)
    expect(c.layers[0].volumeL * 1000).toBeCloseTo(20, 1)
  })

  it('in an open bath above its boiling point it boils away', () => {
    const c = heated('bath', 'core:water-bath', '95 Cel')
    expect(c.temperatureK - 273.15).toBeLessThan(79)
    expect(c.layers.reduce((a, l) => a + l.volumeL, 0) * 1000).toBeLessThan(18)
  })
})

describe('the Fischer esterification', () => {
  it('goes to an equilibrium with K = 4, water counted as a product', () => {
    const w = emptyWorld(1)
    addPlace(w, cat, 'mantle', 'core:reflux-apparatus')
    addSupply(w, cat, { id: 'mix', label: 'mix', container: 'core:round-bottom-flask-100ml', amount: '20 mL',
      components: [{ substance: 'core:ethanol', conc: '8 M' }, { substance: 'chem:4-nitrocinnamic-acid', conc: '0.25 M' }, { substance: 'core:sulfuric-acid', conc: '1 M' }] })
    const k = createKernel(cat, w)
    run(k, 'core:place-in', { container: 'mix', place: 'mantle' })
    run(k, 'core:set-environment', { device: 'mantle', temperature: '110 Cel' })
    run(k, 'core:advance-time', { duration: '12 h' })
    const l = k.world.containers.mix.contents.layers[0]
    const K = ((l.species['chem:ethyl-4-nitrocinnamate'] ?? 0) * waterMol(cat, l)) / ((l.species['chem:4-nitrocinnamic-acid'] ?? 0) * (l.species['core:ethanol'] ?? 0))
    expect(K).toBeGreaterThan(3.6)
    expect(K).toBeLessThan(4.4)
  })

  it('is slow without heat', () => {
    const w = emptyWorld(1)
    addSupply(w, cat, { id: 'mix', label: 'mix', container: 'core:round-bottom-flask-100ml', amount: '20 mL',
      components: [{ substance: 'core:ethanol', conc: '16 M' }, { substance: 'chem:4-nitrocinnamic-acid', conc: '0.25 M' }, { substance: 'core:sulfuric-acid', conc: '0.9 M' }] })
    const k = createKernel(cat, w)
    run(k, 'core:advance-time', { duration: '1 h' })
    const l = k.world.containers.mix.contents.layers[0]
    expect((l.species['chem:ethyl-4-nitrocinnamate'] ?? 0) / 0.005).toBeLessThan(0.1)
  })
})

describe('rotary evaporation', () => {
  it('takes off the solvent and leaves the solute as a solid; water as its own layer goes only slowly', () => {
    const w = emptyWorld(1)
    addEquipment(w, cat, 'rv', 'core:rotary-evaporator')
    addSupply(w, cat, { id: 'ext', label: 'extract', container: 'core:round-bottom-flask-100ml', amount: '30 mL', components: [ETOAC, { substance: 'chem:ethyl-4-nitrocinnamate', conc: '0.1 M' }] })
    addSupply(w, cat, bottle('water', '100 mL', [{ substance: 'core:sodium-chloride', conc: '1 M' }]))
    const k = createKernel(cat, w, { handlingError: 0, noise: 0 })
    run(k, 'core:transfer', { source: 'water', destination: 'ext', volume: '5 mL' })
    run(k, 'core:concentrate', { flask: 'ext', evaporator: 'rv', duration: '10 min' })
    const c = k.world.containers.ext.contents
    expect(c.solid['chem:ethyl-4-nitrocinnamate']).toBeCloseTo(0.003, 6)
    expect(c.layers).toHaveLength(1)
    expect(isOrganic(cat, c.layers[0])).toBe(false)
    expect(c.layers[0].volumeL * 1000).toBeGreaterThan(1.5)
  })
})

describe('conformance: Fischer esterification and work-up', () => {
  const def = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem16-fischer-ester-workup.labx.json')) as ExperimentDefinition

  it('rehearses for several seeds', () => {
    for (const seed of [1, 2]) {
      const r = compile(def, cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 900000)
})

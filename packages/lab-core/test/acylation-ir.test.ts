// Acylating a phenol with an acid chloride and triethylamine, the infrared spectra of what comes out,
// reactions keeping the liquid's volume honest, and the ester practical followed by IR.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addEquipment, addSupply, createKernel, emptyWorld, type Kernel, type SupplySpec } from '../src/kernel/index.ts'
import { waterMol } from '../src/models/distillation.ts'
import { irSpectrum } from '../src/models/infrared.ts'
import { isOrganic } from '../src/models/phases.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}
const solid = (s: Record<string, number>) => ({ layers: [], solid: s, temperatureK: 294 })
const near = (bands: Array<{ wavenumber: number }>, lo: number, hi: number) => bands.some((b) => b.wavenumber >= lo && b.wavenumber <= hi)

describe('infrared spectra', () => {
  it('an aryl ester shows its C=O near 1740 and the nitro bands, and no broad O–H', () => {
    const s = irSpectrum(cat, solid({ 'chem:4-nitrophenyl-benzoate': 0.002 }))!
    expect(near(s.bands, 1735, 1745)).toBe(true)
    expect(near(s.bands, 1515, 1530) && near(s.bands, 1340, 1350)).toBe(true)
    expect(s.bands.some((b) => b.broad)).toBe(false)
  })

  it('a carboxylic acid shows a very broad O–H and its C=O near 1685; a wet sample shows water', () => {
    const acid = irSpectrum(cat, solid({ 'chem:benzoic-acid': 0.002 }))!
    expect(near(acid.bands, 1680, 1690)).toBe(true)
    expect(acid.bands.some((b) => b.broad)).toBe(true)
    const wet = irSpectrum(cat, { layers: [{ volumeL: 2e-4, species: {} }], solid: { 'chem:4-nitrophenyl-benzoate': 0.002 }, temperatureK: 294 })!
    expect(wet.bands.some((b) => b.broad && b.wavenumber > 3300)).toBe(true)
  })

  it('the spectrometer reports the bands an analyst would write down', () => {
    const w = emptyWorld(1)
    addEquipment(w, cat, 'ir', 'core:ir-spectrometer')
    addSupply(w, cat, { id: 'p', label: 'p', container: 'core:watch-glass', amount: '0.5 g', solid: 'chem:4-nitrophenyl-benzoate' })
    addSupply(w, cat, { id: 'salt', label: 's', container: 'core:watch-glass', amount: '0.5 g', solid: 'core:sodium-chloride' })
    const k = createKernel(cat, w)
    const r = run(k, 'core:measure', { instrument: 'ir', subject: 'p' })
    expect((r.outputs.bands as string[]).some((b) => b.startsWith('17') && b.endsWith('(s)'))).toBe(true)
    const none = k.execute({ op: 'core:measure', params: { instrument: 'ir', subject: 'salt' } })
    expect(none.ok ? '' : none.refusal.code).toBe('NOTHING-TO-SEE')
  })
})

describe('acylating 4-nitrophenol', () => {
  function flask(components: SupplySpec['components'], minutes: number, temperature = '0 Cel') {
    const w = emptyWorld(1)
    addSupply(w, cat, { id: 'f', label: 'f', container: 'core:round-bottom-flask-100ml', amount: '20 mL', temperature, components })
    const k = createKernel(cat, w)
    run(k, 'core:advance-time', { duration: `${minutes} min` })
    return k.world.containers.f.contents.layers[0].species
  }
  const thf = { substance: 'chem:tetrahydrofuran', conc: '12 M' }

  it('with triethylamine it is mostly done within minutes in the cold; without a base it does not go', () => {
    const base = [thf, { substance: 'bio:p-nitrophenol', conc: '0.125 M' }, { substance: 'chem:benzoyl-chloride', conc: '0.13 M' }]
    const withBase = flask([...base, { substance: 'chem:triethylamine', conc: '0.1375 M' }], 10)
    expect((withBase['chem:4-nitrophenyl-benzoate'] ?? 0) / 0.0025).toBeGreaterThan(0.8)
    const without = flask(base, 10)
    expect(without['chem:4-nitrophenyl-benzoate'] ?? 0).toBe(0)
  })

  it('water turns the acid chloride into the acid within minutes', () => {
    const sp = flask([{ substance: 'chem:benzoyl-chloride', conc: '0.01 M' }], 5, '21 Cel')
    expect((sp['chem:benzoic-acid'] ?? 0) / 0.0002).toBeGreaterThan(0.9)
  })

  it('an ester in dry THF with triethylamine does not hydrolyse: hydroxide needs water', () => {
    const sp = flask([thf, { substance: 'chem:4-nitrophenyl-benzoate', conc: '0.1 M' }, { substance: 'chem:triethylamine', conc: '0.05 M' }], 60, '21 Cel')
    expect(sp['chem:4-nitrophenyl-benzoate']).toBeCloseTo(0.002, 8)
  })
})

describe('the volume of a reacting liquid', () => {
  it('a solvent used up by a reaction is not counted as water', () => {
    const w = emptyWorld(1)
    addSupply(w, cat, { id: 'f', label: 'f', container: 'core:round-bottom-flask-100ml', amount: '20 mL', temperature: '0 Cel',
      components: [{ substance: 'chem:tetrahydrofuran', conc: '12 M' }, { substance: 'bio:p-nitrophenol', conc: '0.125 M' }, { substance: 'chem:benzoyl-chloride', conc: '0.13 M' }, { substance: 'chem:triethylamine', conc: '0.14 M' }] })
    const k = createKernel(cat, w)
    const before = waterMol(cat, k.world.containers.f.contents.layers[0])
    run(k, 'core:advance-time', { duration: '30 min' })
    expect(waterMol(cat, k.world.containers.f.contents.layers[0]) - before).toBeLessThan(1e-6)
  })
})

describe('extraction from THF', () => {
  it('THF goes mostly with the ethyl acetate, and that layer is still the solvent layer', () => {
    const w = emptyWorld(1)
    addSupply(w, cat, { id: 'q', label: 'q', container: 'core:separating-funnel-250ml', amount: '30 mL', components: [{ substance: 'chem:tetrahydrofuran', conc: '8 M' }] })
    addSupply(w, cat, { id: 'e', label: 'e', container: 'core:reagent-bottle-250ml', amount: '100 mL', components: [{ substance: 'chem:ethyl-acetate', conc: '902 g/L' }] })
    const k = createKernel(cat, w)
    run(k, 'core:transfer', { source: 'e', destination: 'q', volume: '20 mL', tool: 'pour' })
    run(k, 'core:close', { container: 'q' })
    run(k, 'core:mix', { container: 'q', method: 'shake', cycles: 3 })
    const [top, bottom] = k.world.containers.q.contents.layers
    expect(isOrganic(cat, top)).toBe(true)
    expect(isOrganic(cat, bottom)).toBe(false)
    expect(top.species['chem:tetrahydrofuran']).toBeGreaterThan(bottom.species['chem:tetrahydrofuran'])
  })
})

describe('conformance: acylating a phenol, followed by IR', () => {
  const def = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem18-phenol-acylation-ir.labx.json')) as ExperimentDefinition

  it('rehearses for several seeds', () => {
    for (const seed of [1, 2]) {
      const r = compile(def, cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 600000)
})

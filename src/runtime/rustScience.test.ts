import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { solvePH, type AcidBaseSystem } from '../../packages/lab-core/src/models/acidbase.ts'
import { installScientificNumerics } from '../../packages/lab-core/src/models/numerics.ts'
import { compile } from '../../packages/lab-core/src/index.ts'
import { catalogue, practicals } from './content'
import { createRustScience } from './rustScience'
import { speciate, type ComplexSystem } from '../../packages/lab-core/src/models/complexation.ts'
import { nernstSlope, redoxEquilibrate } from '../../packages/lab-core/src/models/redox.ts'
import { SCIENCE_WASM_BASE64 } from './science.wasm.gen'
import { equilibriumEnthalpy } from '../../packages/lab-core/src/models/thermochem.ts'

afterEach(() => installScientificNumerics(null))
beforeEach(() => installScientificNumerics(null))
describe('production Rust/Wasm numerical science', () => {
  it('rejects malformed Wasm ABI lengths before taking a memory slice', async () => {
    const binary = Uint8Array.from(atob(SCIENCE_WASM_BASE64), character => character.charCodeAt(0))
    const { instance } = await WebAssembly.instantiate(binary)
    const redox = instance.exports.lab_redox as (length: number, pH: number, temperature: number, volume: number) => number
    // The first value can overflow a wasm32 usize when computing output length.
    for (const length of [3681400542, 4294967295, 65538, 1, 0]) expect(redox(length, 7, 298.15, 0.1)).toBe(0)
    const enthalpy = instance.exports.lab_enthalpy as (length: number, volume: number, temperature: number, pH: number) => number
    expect(enthalpy(4294967295, 1, 298.15, 7)).toBeNaN()
  })
  it('matches independent textbook limits and the original charge-balance solver', async () => {
    const rust = await createRustScience()
    expect(rust.solvePH([], 298.15)).toBeCloseTo(7, 12)
    for (const temperature of [278.15, 298.15, 310.15]) {
      for (const concentration of [1e-6, 0.001, 0.05, 0.1]) {
        const systems: AcidBaseSystem[] = [
          { substance: 'acid', total: concentration, pKa: [4.76], charge: 0, spectator: 0 },
          { substance: 'salt', total: concentration, pKa: [4.76], charge: 0, spectator: 1 },
          { substance: 'phosphate', total: concentration / 3, pKa: [2.15, 7.2, 12.35], charge: 0, spectator: 2 },
        ]
        expect(rust.solvePH(systems, temperature)).toBeCloseTo(solvePH(systems, temperature), 10)
      }
    }
    expect(() => rust.solvePH([], -1)).toThrow(/domain/)
    expect(rust.populationDelta(100, 0.01, 10, Infinity)).toBe(10)
    expect(rust.populationDelta(100, 0.01, 10, 3)).toBe(3)
    expect(rust.populationDelta(100, -0.01, 100, Infinity)).toBeCloseTo(100 * (Math.exp(-1) - 1), 12)
  })
  it('conserves ligand and ion inventories and matches competing-complex reference solves', async () => {
    const rust = await createRustScience()
    for (const scale of [1e-3, 1, 100]) {
      const cs: ComplexSystem = {
        ligands: [{ substance: 'edta', total: scale * 1e-3, pKa: [2, 2.67, 6.16, 10.26] }, { substance: 'indicator', total: scale * 3e-5, pKa: [6.3, 11.55] }],
        ions: [{ ion: 'Ca', total: scale * 8e-4 }, { ion: 'Mg', total: scale * 5e-4 }],
        pairs: [{ ligand: 0, ion: 0, logK: 10.65 }, { ligand: 0, ion: 1, logK: 8.69 }, { ligand: 1, ion: 0, logK: 5.4 }, { ligand: 1, ion: 1, logK: 7 }],
      }
      const warmRust: { z?: number[] } = {}, warmReference: { z?: number[] } = {}
      for (const pH of [1, 5, 7, 10, 12, 10, 5]) {
        const expected = speciate(cs, pH, warmReference)
        const actual = rust.speciate(cs, pH, warmRust)
        for (const ligand of cs.ligands) {
          let bound = 0
          for (const ion of cs.ions) {
            expect(actual.bound[ligand.substance][ion.ion]).toBeCloseTo(expected.bound[ligand.substance][ion.ion], 8)
            bound += actual.bound[ligand.substance][ion.ion]
          }
          expect(bound).toBeLessThanOrEqual(1 + 1e-8)
          expect(bound).toBeGreaterThanOrEqual(0)
        }
        for (const ion of cs.ions) {
          const bound = cs.ligands.reduce((sum, ligand) => sum + actual.bound[ligand.substance][ion.ion] * ligand.total, 0)
          expect((actual.freeIon[ion.ion] + bound) / ion.total).toBeCloseTo(1, 7)
        }
        expect(warmRust.z).toHaveLength(4)
      }
      const acids: AcidBaseSystem[] = cs.ligands.map(l => ({ ...l, charge: 0, spectator: 2 }))
      for (const temperature of [278.15, 298.15, 310.15]) {
        expect(rust.solvePH(acids, temperature, cs)).toBeCloseTo(solvePH(acids, temperature, cs), 8)
      }
    }
    // Independent equal-total 1:1 quadratic; avoids proving only agreement with TS.
    const single: ComplexSystem = { ligands: [{ substance: 'L', total: 0.001, pKa: [] }], ions: [{ ion: 'M', total: 0.001 }], pairs: [{ ligand: 0, ion: 0, logK: 6 }] }
    const free = 2 * 0.001 / (1 + Math.sqrt(1 + 4 * 1e6 * 0.001))
    expect(rust.speciate(single, 7).freeIon.M).toBeCloseTo(free, 12)
    expect(() => rust.speciate({ ...single, pairs: [{ ligand: 1, ion: 0, logK: 6 }] }, 7)).toThrow(/domain/)
    expect(() => rust.speciate({ ...single, ions: [{ ion: 'M', total: -1 }] }, 7)).toThrow(/domain/)
    expect(() => rust.speciate(single, NaN)).toThrow(/domain/)
    expect(() => rust.solvePH([], -1, single)).toThrow(/domain/)
  })
  it('preserves Nernst potentials, electron inventories, and redox layer identities', async () => {
    const rust = await createRustScience(), cat = catalogue().catalogue
    const mixtures: Record<string, number>[] = [
      { 'chem:ammonium-iron-ii-sulfate': 2.5e-3, 'core:potassium-permanganate': 0.4e-3 },
      { 'chem:iron-iii-aq': 1e-3, 'core:potassium-permanganate': 1e-3 },
      { 'chem:ammonium-iron-ii-sulfate': 1e-3, 'core:manganese-ii-aq': 1e-3 },
      { 'core:iodine': 1e-3, 'chem:ammonium-iron-ii-sulfate': 1e-3 },
      { 'core:iodine': 1e-3, 'core:potassium-iodide': 2e-3 },
    ]
    for (const species of mixtures) for (const pH of [0, 7, 14]) for (const temperature of [278.15, 298.15, 310.15]) {
      const layer = { volumeL: 0.05, species: { ...species } }
      installScientificNumerics(null)
      const expected = redoxEquilibrate(cat, layer, pH, temperature)!
      installScientificNumerics(rust)
      const actual = redoxEquilibrate(cat, layer, pH, temperature)!
      expect(actual.potentialV).toBeCloseTo(expected.potentialV, 10)
      expect(Object.keys(actual.layer.species)).toEqual(Object.keys(expected.layer.species))
      for (const id of Object.keys(expected.layer.species)) expect(actual.layer.species[id]).toBeCloseTo(expected.layer.species[id], 12)
      expect(actual.layer === layer).toBe(expected.layer === layer)
    }
    const iron = { n: 1, e0: 0.68, protons: 0, k: 1, oxMol: 9e-4, redMol: 1e-4 }
    expect(rust.redox([iron], 0, 298.15, 0.05).potentialV).toBeCloseTo(0.68 + nernstSlope(298.15) * Math.log10(9), 12)
    const mixed = [ { ...iron, oxMol: 0, redMol: 2.5e-3 }, { n: 5, e0: 1.51, protons: 8, k: 1, oxMol: 0.4e-3, redMol: 0 } ]
    const red = rust.redox(mixed, 0, 298.15, 0.05).reducedMol!
    expect(red[0] + 5 * red[1]).toBeCloseTo(2.5e-3, 12)
    // General stoichiometry branch, including the non-quadratic root.
    const higher = [iron, { ...iron, n: 3, k: 3, e0: 0.8 }]
    const higherRed = rust.redox(higher, 3, 310.15, 0.1).reducedMol!
    expect(higherRed[0] + higherRed[1]).toBeCloseTo(iron.redMol + iron.redMol, 12)
    expect(() => rust.redox([iron], 0, 298.15, 0)).toThrow(/domain/)
    expect(() => rust.redox([{ ...iron, n: 0 }], 0, 298.15, 0.05)).toThrow(/domain/)
  })
  it('preserves chemical enthalpy across temperatures, protonation and dilution', async () => {
    const rust = await createRustScience(), cat = catalogue().catalogue
    const species: Record<string, number>[] = [
      {}, { 'core:sodium-hydroxide': 0.01 }, { 'core:hydrochloric-acid': 0.01 },
      { 'core:ammonia': 0.01, 'core:ammonium-chloride': 0.01 },
      { 'core:acetic-acid': 0.01, 'core:sodium-hydroxide': 0.005 },
    ]
    for (const temperature of [278.15, 298.15, 310.15]) for (const volumeL of [0.01, 0.1, 1]) for (const composition of species) {
      const layer = { volumeL, species: composition }
      installScientificNumerics(null)
      const expected = equilibriumEnthalpy(cat, layer, temperature)
      installScientificNumerics(rust)
      expect(equilibriumEnthalpy(cat, layer, temperature)).toBeCloseTo(expected, 8)
    }
    expect(rust.chemicalEnthalpy([], 1, 298.15, 7)).toBeCloseTo(0.00558, 12)
    // Unsorted site/enthalpy pairs must stay associated when sorted in Rust.
    const unordered = [{ moles: 0.01, pKa: [10, 4], ionisationJ: [1200, 3400] }]
    const ordered = [{ moles: 0.01, pKa: [4, 10], ionisationJ: [3400, 1200] }]
    expect(rust.chemicalEnthalpy(unordered, 0.1, 298.15, 7)).toBe(rust.chemicalEnthalpy(ordered, 0.1, 298.15, 7))
    expect(() => rust.chemicalEnthalpy([{ moles: 1, pKa: [7], ionisationJ: [] }], 1, 298.15, 7)).toThrow(/pair/)
    expect(() => rust.chemicalEnthalpy([], -1, 298.15, 7)).toThrow(/domain/)
    expect(() => rust.chemicalEnthalpy([], 1, 298.15, NaN)).toThrow(/domain/)
  })
  for (const id of ['chem10-edta-water-hardness', 'chem11-iron-thiocyanate-equilibrium', 'chem12-permanganate-iron', 'chem13-vitamin-c-iodine', 'chem8-enthalpy-neutralisation']) {
    it(`runs ${id} using the Rust equilibrium kernels`, async () => {
      const input = practicals().find(p => p.id === id)!.json
      const rust = await createRustScience()
      for (const seed of [1, 17, 42]) {
        installScientificNumerics(null)
        const reference = compile(input, catalogue().catalogue, { seed, rehearse: true })
        let complexCalls = 0, coupledCalls = 0, redoxCalls = 0, enthalpyCalls = 0
        installScientificNumerics({ ...rust,
          speciate: (...args) => { complexCalls++; return rust.speciate(...args) },
          solvePH: (...args) => { if (args[2]) coupledCalls++; return rust.solvePH(...args) },
          redox: (...args) => { redoxCalls++; return rust.redox(...args) },
          chemicalEnthalpy: (...args) => { enthalpyCalls++; return rust.chemicalEnthalpy(...args) },
        })
        const actual = compile(input, catalogue().catalogue, { seed, rehearse: true })
        expect(actual.rehearsal!.ok).toBe(true)
        expect(actual.rehearsal!.goals).toEqual(reference.rehearsal!.goals)
        expect(actual.rehearsal!.events).toBe(reference.rehearsal!.events)
        if (id.includes('edta') || id.includes('thiocyanate')) {
          expect(complexCalls).toBeGreaterThan(0)
          expect(coupledCalls).toBeGreaterThan(0)
        } else if (id.includes('enthalpy')) expect(enthalpyCalls).toBeGreaterThan(0)
        else expect(redoxCalls).toBeGreaterThan(0)
        const values = (result: typeof actual) => result.kernel!.world.notebook.filter(entry => typeof entry.value === 'number').map(entry => ({ field: entry.field, value: entry.value as number }))
        const expected = values(reference), obtained = values(actual)
        expect(obtained.map(entry => entry.field)).toEqual(expected.map(entry => entry.field))
        obtained.forEach((entry, index) => expect(entry.value).toBeCloseTo(expected[index].value, 7))
      }
    }, 120000)
  }
  for (const id of ['chem6-buffer-capacity', 'micro4-growth-curve']) {
    it(`runs the complete ${id} model through Rust without changing its goals`, async () => {
      const input = practicals().find(p => p.id === id)!.json
      const rust = await createRustScience()
      for (const seed of [1, 17, 42]) {
        installScientificNumerics(null)
        const reference = compile(input, catalogue().catalogue, { seed, rehearse: true }).rehearsal!
        let calls = 0
        installScientificNumerics({ ...rust, solvePH: (...args) => { calls++; return rust.solvePH(...args) }, populationDelta: (...args) => { calls++; return rust.populationDelta(...args) } })
        const actual = compile(input, catalogue().catalogue, { seed, rehearse: true }).rehearsal!
        expect(actual.ok).toBe(true)
        expect(actual.goals).toEqual(reference.goals)
        expect(actual.events).toBe(reference.events)
        expect(calls).toBeGreaterThan(0)
      }
    })
  }
})

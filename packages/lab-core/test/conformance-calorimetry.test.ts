// Calorimetry: proton-transfer heat released when liquids mix (strong base −55.8 kJ/mol, ammonia
// −52.2), an insulated cup that loses heat slowly, and extrapolation to the time of mixing.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const calor = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem8-enthalpy-neutralisation.labx.json')) as ExperimentDefinition
const value = (r: ReturnType<typeof compile>, f: string) => r.kernel!.world.notebook.find((e) => e.field === f)!.value as number
const readings = (r: ReturnType<typeof compile>, f: string) => r.kernel!.world.notebook.filter((e) => e.field === f).map((e) => e.value as number)

describe('conformance: enthalpy of neutralisation', () => {
  it('rehearses for several seeds: HCl + NaOH within 10 % of −55.8 kJ/mol; ammonia gives less', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = compile(calor, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(value(r, 'dH-kJ-weak')).toBeGreaterThan(value(r, 'dH-kJ-strong'))
    }
  }, 60000)

  it('in a plain beaker the mixture cools visibly; the insulated cup barely does', () => {
    const beaker = structuredClone(calor)
    const runs = beaker.procedure!.steps!.find((s) => s.id === 'runs')!
    runs.steps!.find((s) => s.id === 'fetch-cup')!.params!.equipment = 'core:beaker-250ml'
    const fall = (r: ReturnType<typeof compile>) => {
      const t = readings(r, 'T-strong')
      return Math.max(...t) - t[t.length - 1]
    }
    expect(fall(compile(beaker, catalogue, { seed: 1 }))).toBeGreaterThan(1)
    expect(fall(compile(calor, catalogue, { seed: 1 }))).toBeLessThan(0.4)
  }, 30000)
})

describe('heat of proton transfer', () => {
  /** Heat (J) released on pouring 50 mL of a base into 50 mL of an acid, from the temperature rise. */
  function heat(acid: { substance: string; conc: string }, base: { substance: string; conc: string }) {
    const w = emptyWorld(1)
    addSupply(w, catalogue, { id: 'a', label: 'Acid', container: 'core:beaker-250ml', amount: '50 mL', components: [acid] })
    addSupply(w, catalogue, { id: 'b', label: 'Base', container: 'core:beaker-250ml', amount: '50 mL', components: [base] })
    const k = createKernel(catalogue, w, { noise: 0, handlingError: 0 })
    const t0 = k.world.containers.a.contents.temperatureK
    k.execute({ op: 'core:transfer', params: { source: 'b', destination: 'a', volume: '49 mL', tool: 'pour' } })
    k.execute({ op: 'core:mix', params: { container: 'a', method: 'swirl', cycles: 5 } })
    const c = k.world.containers.a.contents
    const volumeL = c.layers.reduce((x, l) => x + l.volumeL, 0)
    return (c.temperatureK - t0) * 4184 * volumeL
  }

  it('HCl + NaOH releases 55.8 kJ per mole of water', () => {
    const q = heat({ substance: 'core:hydrochloric-acid', conc: '1.0 mol/L' }, { substance: 'core:sodium-hydroxide', conc: '1.0 mol/L' })
    expect(q / 0.049 / 1000).toBeCloseTo(55.8, 0)
  })

  it('acetic acid + NaOH releases about the same (its ionisation enthalpy is near zero); HCl + ammonia about 52 kJ', () => {
    const acetic = heat({ substance: 'core:acetic-acid', conc: '1.0 mol/L' }, { substance: 'core:sodium-hydroxide', conc: '1.0 mol/L' })
    expect(acetic / 0.049 / 1000).toBeCloseTo(55.8, 0)
    const nh3 = heat({ substance: 'core:hydrochloric-acid', conc: '1.0 mol/L' }, { substance: 'core:ammonia', conc: '1.0 mol/L' })
    expect(nh3 / 0.049 / 1000).toBeGreaterThan(50)
    expect(nh3 / 0.049 / 1000).toBeLessThan(53)
  })

  it('mixing two neutral solutions releases nothing', () => {
    expect(Math.abs(heat({ substance: 'core:sodium-chloride', conc: '1.0 mol/L' }, { substance: 'core:sodium-chloride', conc: '0.5 mol/L' }))).toBeLessThan(1)
  })
})

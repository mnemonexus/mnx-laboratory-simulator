// Mass-action kinetics: ethyl ethanoate saponification followed by pH at two temperatures, a
// second-order rate constant from 1/[OH⁻] against time, and the activation energy.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const ester = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem5-ester-hydrolysis-kinetics.labx.json')) as ExperimentDefinition
const value = (r: ReturnType<typeof compile>, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)!.value as number

describe('conformance: ester hydrolysis kinetics', () => {
  it('rehearses for several seeds: k at 25 °C within 15 %, Ea within 20 %', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = compile(ester, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(Math.abs(value(r, 'k-25') / 0.11 - 1)).toBeLessThan(0.08)
      expect(Math.abs(value(r, 'Ea-kJ') / 43 - 1)).toBeLessThan(0.15)
    }
  }, 60000)

  it('using pKw = 14.00 at 35 °C doubles the apparent k there and wrecks the activation energy', () => {
    const def = structuredClone(ester)
    def.procedure!.steps!.find((s) => s.id === 'rate-constants')!.forEach!.in = '=[[25, 14.0], [35, 14.0]]'
    const right = compile(ester, catalogue, { seed: 1 })
    const wrong = compile(def, catalogue, { seed: 1 })
    expect(value(wrong, 'k-35') / value(right, 'k-35')).toBeCloseTo(10 ** 0.32, 1)
    expect(value(wrong, 'Ea-kJ')).toBeGreaterThan(80)
    expect(wrong.rehearsal!.goals.find((g) => g.id === 'g-ea')!.passed).toBe(false)
  })
})

describe('mass-action kinetics', () => {
  function mixture(T: string, ester: number, base: number) {
    const w = emptyWorld(1)
    addPlace(w, catalogue, 'bath', 'core:water-bath', undefined, T)
    addSupply(w, catalogue, { id: 'r', label: 'Reaction', container: 'core:beaker-250ml', amount: '100 mL', place: 'bath',
      components: [{ substance: 'chem:ethyl-acetate', conc: `${ester} mol/L` }, { substance: 'core:sodium-hydroxide', conc: `${base} mol/L` }] })
    w.containers.r.contents.temperatureK = w.places.bath.temperatureK
    return createKernel(catalogue, w)
  }
  const conc = (k: ReturnType<typeof mixture>, s: string) => k.world.containers.r.contents.layers[0].species[s] / 0.1

  it('follows the integrated second-order law, and conserves the ester as acetate', () => {
    const k = mixture('25 Cel', 0.02, 0.02)
    k.execute({ op: 'core:advance-time', params: { duration: '20 min' } })
    // 1/c = 1/c0 + k t
    expect(1 / conc(k, 'core:sodium-hydroxide')).toBeCloseTo(1 / 0.02 + 0.11 * 1200, -1)
    expect(conc(k, 'chem:ethyl-acetate') + conc(k, 'core:sodium-acetate')).toBeCloseTo(0.02, 6)
  })

  it('is pseudo-first-order in a large excess of base, with Arrhenius temperature dependence', () => {
    const rate = (T: string) => {
      const k = mixture(T, 0.001, 0.1)
      k.execute({ op: 'core:advance-time', params: { duration: '60 s' } })
      return -Math.log(conc(k, 'chem:ethyl-acetate') / 0.001) / 60
    }
    const k25 = rate('25 Cel')
    expect(k25).toBeCloseTo(0.11 * 0.1, 3)
    expect(rate('35 Cel') / k25).toBeCloseTo(Math.exp((43000 / 8.314) * (1 / 298.15 - 1 / 308.15)), 1)
  })
})

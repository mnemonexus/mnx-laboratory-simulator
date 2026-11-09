// Size-exclusion chromatography: elution by native size, a calibration of Kav against log mass,
// LDH's native mass (a tetramer of 35 kDa chains), band broadening by sample volume, desalting.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate, makeEnv } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { epsilon } from '../src/models/measurement.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const sec = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio8-gel-filtration-native-mass.labx.json')) as ExperimentDefinition
const field = (r: ReturnType<typeof compile>, f: string) => r.kernel!.world.notebook.find((e) => e.field === f)?.value

describe('conformance: native mass by gel filtration', () => {
  it('rehearses for several seeds: three standard peaks, LDH within 25 % of 140 kDa, four chains', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(sec, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(Math.abs((field(r, 'LDH-kDa') as number) / 140 - 1)).toBeLessThan(0.25)
      expect(r.run!.decisions.chains).toBe('four')
    }
  }, 60000)

  it('too large a sample volume blurs BSA and ovalbumin into one peak', () => {
    const def = structuredClone(sec)
    def.procedure!.steps!.find((s) => s.id === 'runs')!.steps!.find((s) => s.id === 'apply')!.params!.volume = '2 mL'
    for (const id of ['standards', 'ldh']) Object.assign(def.materials!.supplies!.find((s) => s.id === id)!, { amount: '3 mL', container: 'core:conical-tube-15ml' })
    const r = compile(def, catalogue, { seed: 1 })
    expect((field(r, 'Ve-standards') as number[]).length).toBeLessThan(3)
  }, 30000)
})

describe('size-exclusion columns', () => {
  it('a desalting column puts protein in the void volume and salt at the total volume', () => {
    const w = emptyWorld(1)
    addSupply(w, catalogue, { id: 's', label: 'Sample', container: 'core:microtube-1.5ml', amount: '1 mL', components: [{ substance: 'bio:bovine-serum-albumin', conc: '2 g/L' }, { substance: 'core:sodium-chloride', conc: '1 mol/L' }] })
    addSupply(w, catalogue, { id: 'water', label: 'Water', container: 'core:reagent-bottle-250ml', amount: '50 mL', components: [] })
    const k = createKernel(catalogue, w)
    k.execute({ op: 'core:fetch', params: { equipment: 'core:desalting-column', id: 'col' } })
    k.execute({ op: 'core:transfer', params: { source: 's', destination: 'col', volume: '900 uL' } })
    const found: Array<{ bsa: number; salt: number }> = []
    for (let f = 0; f < 12; f++) {
      k.execute({ op: 'core:fetch', params: { equipment: 'core:microtube-1.5ml', id: `f${f}` } })
      k.execute({ op: 'core:elute', params: { column: 'col', buffer: 'water', into: `f${f}`, volume: '1 mL' } })
      const l = k.world.containers[`f${f}`].contents.layers[0]
      found.push({ bsa: l.species['bio:bovine-serum-albumin'] ?? 0, salt: l.species['core:sodium-chloride'] ?? 0 })
    }
    const top = (xs: number[]) => xs.indexOf(Math.max(...xs))
    expect(top(found.map((x) => x.bsa))).toBe(2)
    expect(top(found.map((x) => x.salt))).toBeGreaterThanOrEqual(7)
    // Nearly all the protein comes out before any salt to speak of.
    const bsaEarly = found.slice(0, 5).reduce((a, x) => a + x.bsa, 0) / found.reduce((a, x) => a + x.bsa, 0)
    const saltEarly = found.slice(0, 5).reduce((a, x) => a + x.salt, 0) / found.reduce((a, x) => a + x.salt, 0)
    expect(bsaEarly).toBeGreaterThan(0.95)
    expect(saltEarly).toBeLessThan(0.05)
  })

  it('peaks() finds local maxima above a floor, refined between fractions', () => {
    const env = makeEnv({ x: [1, 2, 3, 4, 5, 6, 7], y: [0, 0.2, 1, 0.2, 0, 0.6, 0.6] })
    const p = evaluate('peaks(x, y, 0.5)', env) as number[]
    expect(p.length).toBe(2)
    expect(p[0]).toBeCloseTo(3, 5)
    expect(p[1]).toBeGreaterThanOrEqual(6)
  })

  it('proteins absorb at 280 nm from their ε280 and not in the visible', () => {
    // BSA: 1 mg/mL reads about 0.66 in 1 cm.
    expect(epsilon(catalogue, 'bio:bovine-serum-albumin', 280) / 66430).toBeCloseTo(0.66, 2)
    expect(epsilon(catalogue, 'bio:bovine-serum-albumin', 340)).toBe(0)
  })
})

// Growth in soil: on a sole carbon source an organism also needs mineral nitrogen and phosphorus
// (the scarcer limits its yield), a soil's water carries what dissolves from it, and a drier soil
// slows growth.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addPlace, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'
import { MOISTURE_OPT } from '../src/models/growth.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const PP = 'micro:pseudomonas-putida'

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

const cells = (k: Kernel, id: string) => k.world.containers[id].contents.layers[0].populations?.[PP]?.viable ?? 0
const conc = (k: Kernel, id: string, s: string) => (k.world.containers[id].contents.layers[0].species[s] ?? 0) / k.world.containers[id].contents.layers[0].volumeL

/** Soils of 50 g with 2.5 × 10⁵ P. putida in their water: [id, water, extra components of the water]. */
function soils(...list: Array<[string, string, Array<{ substance: string; conc: string }>]>): Kernel {
  const w = emptyWorld(1)
  addPlace(w, cat, 'incubator', 'core:incubator')
  for (const [id, water, extra] of list) {
    addSupply(w, cat, {
      id, label: id, container: 'core:conical-flask-250ml', amount: '50 g',
      solids: [{ substance: 'core:soil', massG: 50 }],
      wet: { amount: water, components: [{ substance: 'micro:hexadecane', conc: '20 g/L' }, ...extra], populations: [{ substance: PP, total: 2.5e5 }] },
    })
  }
  const k = createKernel(cat, w)
  run(k, 'core:set-environment', { device: 'incubator', temperature: '25 Cel' })
  for (const [id] of list) run(k, 'core:place-in', { container: id, place: 'incubator' })
  return k
}

const NUTRIENTS = [{ substance: 'core:ammonium-chloride', conc: '2 g/L' }, { substance: 'core:potassium-dihydrogen-phosphate', conc: '1 g/L' }]

describe('mineral nutrients', () => {
  it('a sole carbon source supports no growth without nitrogen and phosphorus, and full growth with them', () => {
    const w = emptyWorld(1)
    addPlace(w, cat, 'incubator', 'core:incubator')
    addSupply(w, cat, { id: 'bare', label: 'bare', container: 'core:conical-flask-100ml', amount: '40 mL', preparation: 'core:water-deionised', components: [{ substance: 'micro:hexadecane', conc: '1 g/L' }], populations: [{ substance: PP, perL: 1e8 }] })
    addSupply(w, cat, { id: 'msm', label: 'msm', container: 'core:conical-flask-100ml', amount: '40 mL', preparation: 'micro:mineral-salts-medium', components: [{ substance: 'micro:hexadecane', conc: '1 g/L' }], populations: [{ substance: PP, perL: 1e8 }] })
    const k = createKernel(cat, w)
    run(k, 'core:set-environment', { device: 'incubator', temperature: '30 Cel' })
    for (const id of ['bare', 'msm']) run(k, 'core:place-in', { container: id, place: 'incubator' })
    run(k, 'core:advance-time', { duration: '48 h' })
    expect(cells(k, 'bare')).toBeLessThanOrEqual(4e6 * 1.001)
    expect(cells(k, 'msm') / 0.04).toBeGreaterThan(1e12)
  })

  it("a soil's water holds its extractable nitrogen and phosphate, and adding more raises the yield", () => {
    const k = soils(['plain', '10 mL', []], ['fed', '10 mL', NUTRIENTS])
    // 18 mg of ammonium chloride per kg of soil: 0.9 mg in 10 mL.
    expect(conc(k, 'plain', 'core:ammonium-chloride') * 53.49).toBeCloseTo(0.09, 3)
    run(k, 'core:advance-time', { duration: '48 h' })
    const [plain, fed] = [cells(k, 'plain') / 50, cells(k, 'fed') / 50]
    // Nitrogen runs short at about 10⁸ per gram; fed, the soil's water itself is the limit.
    expect(plain).toBeGreaterThan(5e7)
    expect(plain).toBeLessThan(2e8)
    expect(fed).toBeGreaterThan(2.5 * plain)
  })
})

describe('soil moisture', () => {
  it('a drier soil slows growth in proportion to its water, below 60 % of field capacity', () => {
    // Field capacity 0.4 mL/g: 6 mL in 50 g is 30 %, 12 mL is 60 %.
    const k = soils(['dry', '6 mL', NUTRIENTS], ['moist', '12 mL', NUTRIENTS])
    run(k, 'core:advance-time', { duration: '8 h' })
    const fold = (id: string) => cells(k, id) / 2.5e5
    // Doublings in 8 h scale with the moisture factor: 0.3 / 0.6 = half as many.
    expect(Math.log2(fold('dry')) / Math.log2(fold('moist'))).toBeCloseTo(0.3 / MOISTURE_OPT, 1)
  })

  it('a suspension of soil in much more water grows as a liquid culture', () => {
    const k = soils(['slurry', '100 mL', NUTRIENTS], ['moist', '12 mL', NUTRIENTS])
    run(k, 'core:advance-time', { duration: '8 h' })
    // (The larger volume takes a little longer to warm up.)
    expect(Math.abs(Math.log2(cells(k, 'slurry') / 2.5e5) - Math.log2(cells(k, 'moist') / 2.5e5))).toBeLessThan(0.2)
  })
})

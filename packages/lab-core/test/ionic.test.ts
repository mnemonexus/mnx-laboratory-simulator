// The ionic equilibrium model (models/ionic.ts and the Rust tableau solver) through the kernel, as
// a learner mixes reagents: precipitates by solubility product, their colours, complexes that
// dissolve them, amphoteric hydroxides, hydrolysis, and pH-dependent colour. Each consequence comes
// from data (log K, spectra), not from rules about particular reagents.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { meanLayer } from '../src/kernel/state.ts'
import { layerPH } from '../src/models/acidbase.ts'
import { srgbToLab } from '../src/models/colour.ts'
import { appearance } from '../src/models/measurement.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

type Add = [substance: string, conc: string, mL: number]
function mix(adds: Add[]) {
  const w = emptyWorld(1)
  adds.forEach(([s, conc], i) => addSupply(w, cat, { id: `r${i}`, label: s, container: 'core:conical-tube-50ml', amount: '40 mL', components: [{ substance: s, conc }] }))
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  }
  run('core:fetch', { equipment: 'core:beaker-100ml', id: 'b' })
  adds.forEach(([, , mL], i) => run('core:transfer', { source: `r${i}`, destination: 'b', volume: `${mL} mL`, tool: 'pour' }))
  run('core:mix', { container: 'b', method: 'swirl', cycles: 3 })
  const c = k.world.containers.b
  const solids: Record<string, number> = {}
  for (const l of c.contents.layers) for (const [s, n] of Object.entries(l.particles ?? {})) if (n > 0) solids[s] = (solids[s] ?? 0) + n
  for (const [s, n] of Object.entries(c.contents.solid)) if (n > 0) solids[s] = (solids[s] ?? 0) + n
  return { c, solids, pH: layerPH(cat, meanLayer(c.contents), c.contents.temperatureK)!, look: appearance(cat, c, 1.5)! }
}
const hue = (rgb: [number, number, number]) => {
  const [, a, b] = srgbToLab(rgb)
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360
}

describe('ionic equilibrium: precipitation', () => {
  it('silver halides come out white, cream and yellow, nearly completely', () => {
    for (const [salt, solid, name, halide] of [['aq:sodium-chloride', 'aq:silver-chloride', 'white', 'aq:chloride'], ['aq:potassium-bromide', 'aq:silver-bromide', 'pale yellow', 'aq:bromide'], ['aq:potassium-iodide', 'aq:silver-iodide', 'yellow', 'aq:iodide']]) {
      const r = mix([['aq:silver-nitrate', '0.1 mol/L', 10], [salt, '0.1 mol/L', 10]])
      // Poured without a measuring tool, each portion is within a few per cent of 10 mL; the
      // solubility products leave next to no silver in solution.
      expect(r.solids[solid] / 1e-3).toBeGreaterThan(0.94)
      const left = r.c.contents.layers[0].species
      expect(Math.min(left['aq:silver'] ?? 0, left[halide] ?? 0)).toBeLessThan(1e-7)
      expect(r.look.precipitate?.name).toBe(name)
      expect(r.look.opacity).toBeGreaterThan(0.9)
      expect(r.pH).toBeCloseTo(7, 0)
    }
  })

  it('hydrochloric acid from the core catalogue precipitates silver chloride too', () => {
    const r = mix([['core:hydrochloric-acid', '0.1 mol/L', 10], ['aq:silver-nitrate', '0.1 mol/L', 10]])
    expect(r.solids['aq:silver-chloride']).toBeGreaterThan(0.94e-3)
  })

  it('excess ammonia dissolves silver chloride but not silver iodide', () => {
    const agcl = mix([['aq:silver-nitrate', '0.1 mol/L', 5], ['aq:sodium-chloride', '0.1 mol/L', 5], ['aq:ammonia', '2 mol/L', 20]])
    expect(agcl.solids['aq:silver-chloride'] ?? 0).toBe(0)
    const agi = mix([['aq:silver-nitrate', '0.1 mol/L', 5], ['aq:potassium-iodide', '0.1 mol/L', 5], ['aq:ammonia', '2 mol/L', 20]])
    expect(agi.solids['aq:silver-iodide']).toBeGreaterThan(0.47e-3)
  })

  it('copper hydroxide is a pale blue precipitate that excess ammonia turns to a deep blue solution', () => {
    const some = mix([['aq:copper-ii-sulfate', '0.1 mol/L', 10], ['aq:ammonia', '0.1 mol/L', 10]])
    expect(some.solids['aq:copper-ii-hydroxide']).toBeGreaterThan(0.4e-3)
    expect(some.look.precipitate?.name).toBe('blue')
    const excess = mix([['aq:copper-ii-sulfate', '0.1 mol/L', 10], ['aq:ammonia', '2 mol/L', 20]])
    expect(excess.solids['aq:copper-ii-hydroxide'] ?? 0).toBe(0)
    expect(excess.look.opacity).toBeLessThan(0.01)
    // Much deeper than the copper sulfate it came from: the tetraammine absorbs at 600 nm (ε ≈ 50).
    const plain = mix([['aq:copper-ii-sulfate', '0.1 mol/L', 10], ['core:water', '1 mol/L', 0.001]])
    expect(srgbToLab(excess.look.liquid)[0]).toBeLessThan(srgbToLab(plain.look.liquid)[0] - 20)
    expect(hue(excess.look.liquid)).toBeGreaterThan(240)
    expect(hue(excess.look.liquid)).toBeLessThan(320)
  })

  it('zinc and aluminium hydroxides redissolve in excess alkali; magnesium hydroxide does not', () => {
    expect(mix([['aq:zinc-sulfate', '0.1 mol/L', 10], ['aq:sodium-hydroxide', '0.1 mol/L', 15]]).solids['aq:zinc-hydroxide']).toBeGreaterThan(0.5e-3)
    expect(mix([['aq:zinc-sulfate', '0.1 mol/L', 10], ['aq:sodium-hydroxide', '2 mol/L', 20]]).solids['aq:zinc-hydroxide'] ?? 0).toBe(0)
    expect(mix([['aq:aluminium-sulfate', '0.05 mol/L', 10], ['aq:sodium-hydroxide', '2 mol/L', 20]]).solids['aq:aluminium-hydroxide'] ?? 0).toBe(0)
    expect(mix([['aq:magnesium-sulfate', '0.1 mol/L', 10], ['aq:sodium-hydroxide', '2 mol/L', 20]]).solids['aq:magnesium-hydroxide']).toBeGreaterThan(0.99e-3)
  })

  it('the hydroxide test tells the ions apart by colour', () => {
    const colour = (salt: string, solid: string) => {
      const r = mix([[salt, '0.1 mol/L', 10], ['aq:sodium-hydroxide', '0.1 mol/L', 30]])
      expect(r.solids[solid]).toBeGreaterThan(0.5e-3)
      return r.look.precipitate!.name
    }
    expect(colour('aq:iron-ii-sulfate', 'aq:iron-ii-hydroxide')).toBe('green')
    expect(colour('aq:iron-iii-chloride', 'aq:iron-iii-hydroxide')).toBe('brown')
    expect(colour('aq:copper-ii-sulfate', 'aq:copper-ii-hydroxide')).toBe('blue')
  })

  it('sulfate with barium, iodide with lead, carbonate with calcium, chromate with silver', () => {
    expect(mix([['aq:barium-chloride', '0.1 mol/L', 10], ['aq:sodium-sulfate', '0.1 mol/L', 10]]).look.precipitate?.name).toBe('white')
    expect(mix([['aq:lead-ii-nitrate', '0.1 mol/L', 10], ['aq:potassium-iodide', '0.2 mol/L', 10]]).look.precipitate?.name).toBe('yellow')
    expect(mix([['aq:calcium-chloride', '0.1 mol/L', 10], ['aq:sodium-carbonate', '0.1 mol/L', 10]]).solids['aq:calcium-carbonate']).toBeGreaterThan(0.95e-3)
    expect(mix([['aq:silver-nitrate', '0.1 mol/L', 10], ['aq:potassium-chromate', '0.05 mol/L', 10]]).look.precipitate?.name).toBe('red')
  })
})

describe('ionic equilibrium: solutions', () => {
  it('iron(III) chloride is acidic by hydrolysis, copper sulfate mildly so, sodium sulfate neutral', () => {
    expect(mix([['aq:iron-iii-chloride', '0.1 mol/L', 20]]).pH).toBeGreaterThan(1.6)
    expect(mix([['aq:iron-iii-chloride', '0.1 mol/L', 20]]).pH).toBeLessThan(2.3)
    const cu = mix([['aq:copper-ii-sulfate', '0.5 mol/L', 20]]).pH
    expect(cu).toBeGreaterThan(3.8)
    expect(cu).toBeLessThan(5)
    // Sulfate is a very weak base (HSO₄⁻ pKa 1.99): 0.1 M sodium sulfate is pH 7.5 in theory.
    const so4 = mix([['aq:sodium-sulfate', '0.1 mol/L', 20]]).pH
    expect(so4).toBeGreaterThan(7.2)
    expect(so4).toBeLessThan(7.8)
  })

  it('chromate is yellow, and acid turns it orange (dichromate and its relatives)', () => {
    const yellow = mix([['aq:potassium-chromate', '0.01 mol/L', 20]])
    const orange = mix([['aq:potassium-chromate', '0.01 mol/L', 10], ['aq:hydrochloric-acid', '1 mol/L', 10]])
    expect(yellow.look.liquidName).toMatch(/yellow/)
    // Acid pulls the hue toward red: hydrogenchromate, dichromate and chlorochromate absorb further into the blue-green.
    expect(hue(orange.look.liquid)).toBeLessThan(hue(yellow.look.liquid) - 8)
    expect(mix([['aq:potassium-dichromate', '0.01 mol/L', 20]]).pH).toBeLessThan(5)
  })

  it('cobalt(II) chloride is pink, and blue in concentrated hydrochloric acid', () => {
    expect(mix([['aq:cobalt-ii-chloride', '0.1 mol/L', 20]]).look.liquidName).toMatch(/pink/)
    expect(mix([['aq:cobalt-ii-chloride', '0.1 mol/L', 5], ['aq:hydrochloric-acid', '10 mol/L', 20]]).look.liquidName).toMatch(/blue/)
  })

  it('acidified iron(III) with thiocyanate is blood red', () => {
    const r = mix([['aq:iron-iii-nitrate', '0.002 mol/L', 10], ['aq:nitric-acid', '0.2 mol/L', 5], ['aq:potassium-thiocyanate', '0.02 mol/L', 10]])
    expect(r.look.liquidName).toMatch(/red/)
  })

  it('leaves plain acid–base and salt water to the charge-balance solver and their substances as they were', () => {
    const r = mix([['core:sodium-chloride', '0.1 mol/L', 10], ['core:sodium-hydroxide', '0.1 mol/L', 10]])
    expect(Object.keys(r.c.contents.layers[0].species)).toEqual(expect.arrayContaining(['core:sodium-chloride', 'core:sodium-hydroxide']))
    expect(r.pH).toBeGreaterThan(12.5)
  })
})

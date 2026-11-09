// What the bench is told to draw for a vessel (session lookOf, from appearance()): the colour seen,
// how clear it is, what has settled and how hard gas bubbles off. All of it from the simulation:
// a precipitate clouds the liquid, settles by Stokes' law, and fizzing follows the gas given off.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { lookOf } from '../src/session/session.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function beaker(liquids: Array<[id: string, substance: string, conc: string, mL: number]>) {
  const w = emptyWorld(1)
  for (const [id, substance, conc] of liquids) addSupply(w, cat, { id, label: id, container: 'core:reagent-bottle-250ml', amount: '200 mL', components: [{ substance, conc }] })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  }
  run('core:fetch', { equipment: 'core:beaker-100ml', id: 'b' })
  for (const [id, , , mL] of liquids) run('core:transfer', { source: id, destination: 'b', volume: `${mL} mL`, tool: 'pour' })
  run('core:mix', { container: 'b', method: 'swirl', cycles: 3 })
  return { run, look: () => lookOf(cat, k.world.containers.b).look! }
}

describe('the look of a vessel on the bench', () => {
  it('a fresh precipitate clouds the liquid; left to stand it settles and the liquid clears', () => {
    const { run, look } = beaker([['cu', 'aq:copper-ii-sulfate', '0.1 mol/L', 30], ['oh', 'aq:sodium-hydroxide', '1 mol/L', 3]])
    const fresh = look()
    expect(fresh.clarity).toBeLessThan(0.1)
    expect(fresh.sediment).toBeUndefined()
    run('core:advance-time', { duration: '30 min' })
    const settled = look()
    expect(settled.clarity).toBeGreaterThan(0.9)
    // Gelatinous copper hydroxide lies loose: a layer several percent of the liquid's depth, pale blue.
    expect(settled.sediment!.fraction).toBeGreaterThan(0.03)
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(settled.sediment!.colour.slice(i, i + 2), 16))
    expect(b).toBeGreaterThan(r)
    expect(g).toBeGreaterThan(r)
  })

  it('a coloured solution keeps its colour and is clear', () => {
    const { look } = beaker([['cu', 'aq:copper-ii-sulfate', '0.5 mol/L', 30]])
    const l = look()
    expect(l.clarity).toBeGreaterThan(0.99)
    const [r, , b] = [1, 3, 5].map((i) => parseInt(l.liquid.slice(i, i + 2), 16))
    expect(b).toBeGreaterThan(r + 30)
  })

  it('magnesium in acid fizzes, then stops when the ribbon is gone', () => {
    const { run, look } = beaker([['hcl', 'aq:hydrochloric-acid', '1 mol/L', 30]])
    run('core:add-solid', { substance: 'aq:magnesium-ribbon', destination: 'b', mass: '0.05 g' })
    run('core:advance-time', { duration: '5 s' })
    expect(look().bubbling).toBeGreaterThan(0.5)
    expect(look().sediment).toBeDefined()
    run('core:advance-time', { duration: '5 min' })
    expect(look().bubbling).toBe(0)
    expect(look().sediment).toBeUndefined()
  })
})

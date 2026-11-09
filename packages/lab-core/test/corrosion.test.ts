// Corrosion (E8): an iron nail rusts in water that holds oxygen, faster in salt water, hardly at
// all in boiled water under oil or with no water; zinc wrapped round it corrodes instead
// (sacrificial protection), and copper makes it rust faster.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const RUST = 'aq:iron-iii-hydroxide'

/** mg of each corrosion product on the metal after three days. */
function after3Days(water: 'tap' | 'salt' | 'boiled' | 'none', others: string[] = [], oil = false): Record<string, number> {
  const w = emptyWorld(1)
  addSupply(w, cat, { id: 'tap', label: 'tap', container: 'core:reagent-bottle-250ml', amount: '100 mL', components: [{ substance: 'core:oxygen', conc: '0.28 mM' }] })
  addSupply(w, cat, { id: 'salt', label: 'salt', container: 'core:reagent-bottle-250ml', amount: '100 mL', components: [{ substance: 'core:oxygen', conc: '0.25 mM' }, { substance: 'aq:sodium-chloride', conc: '0.5 mol/L' }] })
  addSupply(w, cat, { id: 'boiled', label: 'boiled', container: 'core:reagent-bottle-250ml', amount: '100 mL', components: [{ substance: 'core:oxygen', conc: '0.005 mM' }] })
  addSupply(w, cat, { id: 'oil', label: 'oil', container: 'core:reagent-bottle-250ml', amount: '50 mL', components: [{ substance: 'core:vegetable-oil', conc: '920 g/L' }] })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as Record<string, string>
  }
  run('core:fetch', { equipment: 'core:boiling-tube', id: 't', label: 't' })
  run('core:add-solid', { substance: 'aq:iron-nail', destination: 't', mass: '3 g' })
  for (const m of others) run('core:add-solid', { substance: m, destination: 't', mass: '1 g' })
  if (water !== 'none') run('core:transfer', { source: water, destination: 't', volume: '20 mL', tool: 'pour' })
  if (oil) run('core:transfer', { source: 'oil', destination: 't', volume: '3 mL', tool: 'pour' })
  run('core:advance-time', { duration: '3 d' })
  const coating = k.world.containers.t.contents.coating ?? {}
  return Object.fromEntries(Object.entries(coating).map(([s, n]) => [s, n * 1000 * (s === RUST ? 106.87 : 99.4)]))
}

describe('corrosion', () => {
  it('a nail rusts in water with oxygen, faster in salt water; not in boiled water under oil, nor dry', () => {
    const tap = after3Days('tap')[RUST] ?? 0
    expect(tap).toBeGreaterThan(1.5)
    expect(after3Days('salt')[RUST] ?? 0).toBeGreaterThan(1.2 * tap)
    expect(after3Days('boiled', [], true)[RUST] ?? 0).toBeLessThan(tap / 5)
    expect(after3Days('none')[RUST] ?? 0).toBe(0)
  })

  it('zinc wrapped round the nail corrodes instead; copper makes the nail rust faster', () => {
    const withZinc = after3Days('tap', ['aq:zinc-strip'])
    expect(withZinc[RUST] ?? 0).toBe(0)
    expect(withZinc['aq:zinc-hydroxide'] ?? 0).toBeGreaterThan(1)
    expect(after3Days('tap', ['aq:copper-strip'])[RUST] ?? 0).toBeGreaterThan(after3Days('tap')[RUST] ?? 0)
  })
})

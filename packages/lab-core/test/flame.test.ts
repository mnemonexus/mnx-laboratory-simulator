// Flame tests through the kernel (models/flame.ts, kernel/ops-flame.ts): each colour follows from the
// element's emission lines and bands, the eye's response and the burner's own blue, not from a table
// of flame colours; so a trace of sodium hides potassium, cobalt glass shows it again, and a wire
// that is not cleaned shows what it last held.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { addEquipment } from '../src/kernel/world.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function bench(liquids: Array<[id: string, components: Array<[substance: string, conc: string]>]>) {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'wire', 'core:flame-test-wire')
  for (const [id, components] of liquids) {
    addSupply(w, cat, { id, label: id, container: 'core:reagent-bottle-250ml', amount: '50 mL', components: components.map(([substance, conc]) => ({ substance, conc })) })
  }
  const k = createKernel(cat, w)
  const flame = (sample: string, extra: Record<string, unknown> = {}) => {
    const r = k.execute({ op: 'core:flame-test', params: { sample, wire: 'wire', ...extra } })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as { colour: string; lines?: number[]; appearance: string }
  }
  return { k, flame }
}

describe('flame colours from emission', () => {
  it('each metal gives its own colour', () => {
    const salts: Array<[string, string, RegExp]> = [
      ['aq:lithium-chloride', '0.5 mol/L', /crimson|red/],
      ['aq:sodium-chloride', '0.5 mol/L', /yellow-orange/],
      ['aq:potassium-chloride', '0.5 mol/L', /lilac/],
      ['aq:calcium-chloride', '0.5 mol/L', /orange-red/],
      ['aq:strontium-chloride', '0.5 mol/L', /crimson|red/],
      ['aq:barium-chloride', '0.5 mol/L', /apple green/],
      ['aq:copper-ii-chloride', '0.5 mol/L', /blue-green/],
      ['aq:copper-ii-sulfate', '0.5 mol/L', /^(intense |faint )?green/],
    ]
    const { flame } = bench(salts.map(([s, c]) => [s, [[s, c]]]))
    for (const [s, , want] of salts) expect(flame(s).colour, s).toMatch(want)
  })

  it('a trace of potassium leaves the flame blue; sodium shows at a far lower level', () => {
    const { flame } = bench([['k', [['aq:potassium-chloride', '0.001 mol/L']]], ['na', [['aq:sodium-chloride', '0.001 mol/L']]]])
    expect(flame('k').colour).toBe('blue')
    expect(flame('na').colour).toMatch(/yellow-orange/)
  })

  it('a little sodium hides potassium; cobalt-blue glass shows it again', () => {
    const { flame } = bench([['mix', [['aq:potassium-chloride', '0.5 mol/L'], ['aq:sodium-chloride', '0.01 mol/L']]]])
    expect(flame('mix').colour).toMatch(/yellow-orange/)
    expect(flame('mix', { view: 'cobalt-glass' }).colour).toMatch(/lilac|crimson/)
  })

  it('a wire not cleaned shows what it last held', () => {
    const { flame } = bench([['na', [['aq:sodium-chloride', '1 mol/L']]], ['k', [['aq:potassium-chloride', '0.5 mol/L']]]])
    flame('na')
    expect(flame('k', { clean: false }).colour).toMatch(/yellow-orange/)
    flame('na')
    expect(flame('k').colour).toMatch(/lilac/)
  })

  it('a spectroscope shows the lines at their wavelengths', () => {
    const { flame } = bench([['na', [['aq:sodium-chloride', '0.5 mol/L']]], ['li', [['aq:lithium-chloride', '0.5 mol/L']]]])
    const na = flame('na', { view: 'spectroscope' }).lines ?? []
    expect(Math.abs(na[0] - 589)).toBeLessThanOrEqual(3)
    const li = flame('li', { view: 'spectroscope' }).lines ?? []
    expect(Math.abs(li[0] - 671)).toBeLessThanOrEqual(3)
  })
})

// Food tests through the kernel (E11): each result follows from catalogue chemistry, not a table of
// answers. A reducing sugar reduces Benedict's copper(II) to copper(I) oxide only when heated in
// alkali, so the colour runs from blue through green and yellow to orange as the blue is used up;
// sucrose needs boiling with acid first; peptide bonds turn biuret copper violet; starch holds
// iodine blue-black; Sudan III goes into oil, which floats as a red layer.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

type Components = Array<[substance: string, conc: string]>

const REAGENTS: Record<string, Components> = {
  benedict: [['bio:benedict-copper', '69 mM'], ['aq:sodium-carbonate', '0.94 mol/L']],
  biuret: [['bio:biuret-copper', '6 mM'], ['aq:sodium-hydroxide', '0.75 mol/L']],
  iodine: [['core:iodine', '10 mM'], ['core:potassium-iodide', '60 mM']],
  sudan: [['bio:sudan-iii', '1 mM']],
  hcl: [['core:hydrochloric-acid', '1 mol/L']],
  bicarb: [['aq:sodium-hydrogencarbonate', '1 mol/L']],
  water: [],
}

/** One food in a test tube with reagents added in turn; returns what the eye sees. */
function tube(food: Components, steps: Array<[reagent: string, mL: number] | ['heat', minutes: number] | ['wait', minutes: number]>, solvent?: string): string {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'eye', 'core:visual-inspection')
  addPlace(w, cat, 'bath', 'core:water-bath')
  addSupply(w, cat, { id: 'food', label: 'food', container: 'core:reagent-bottle-250ml', amount: '50 mL', components: food.map(([substance, conc]) => ({ substance, conc })), ...(solvent ? { solvent } : {}) })
  for (const [id, components] of Object.entries(REAGENTS)) addSupply(w, cat, { id, label: id, container: 'core:reagent-bottle-250ml', amount: '50 mL', components: components.map(([substance, conc]) => ({ substance, conc })) })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as Record<string, string>
  }
  run('core:set-environment', { device: 'bath', temperature: '95 Cel' })
  run('core:fetch', { equipment: 'core:test-tube', id: 't', label: 't' })
  run('core:transfer', { source: 'food', destination: 't', volume: '2 mL' })
  for (const [what, n] of steps) {
    if (what === 'heat') {
      run('core:place-in', { container: 't', place: 'bath' })
      run('core:advance-time', { duration: `${n} min` })
      run('core:remove-from', { container: 't' })
    } else if (what === 'wait') run('core:advance-time', { duration: `${n} min` })
    else {
      run('core:transfer', { source: what, destination: 't', volume: `${n} mL` })
      run('core:mix', { container: 't', method: what === 'sudan' ? 'invert' : 'swirl', cycles: 5 })
    }
  }
  return run('core:measure', { instrument: 'eye', subject: 't' }).appearance
}

const glucose = (gPerL: number): Components => [['core:glucose', `${gPerL} g/L`]]
const benedict = (food: Components) => tube(food, [['benedict', 2], ['heat', 5]])

describe("Benedict's test", () => {
  it('goes from blue through green and yellow to orange as the glucose rises', () => {
    expect(benedict(glucose(0))).toMatch(/blue/)
    expect(benedict(glucose(0))).not.toMatch(/precipitate/)
    expect(benedict(glucose(2.5))).toMatch(/green overall/)
    expect(benedict(glucose(5))).toMatch(/yellow|orange/)
    // At 1 % every copper(II) is reduced: no blue is left.
    expect(benedict(glucose(10))).toMatch(/orange precipitate.*colourless solution/)
  })

  it('needs heat', () => {
    expect(tube(glucose(10), [['benedict', 2], ['wait', 5]])).not.toMatch(/precipitate/)
  })

  it('fructose and lactose reduce it; sucrose does not until boiled with acid and neutralised', () => {
    expect(benedict([['core:fructose', '10 g/L']])).toMatch(/precipitate/)
    expect(benedict([['core:lactose', '20 g/L']])).toMatch(/precipitate/)
    const sucrose: Components = [['core:sucrose', '20 g/L']]
    expect(benedict(sucrose)).not.toMatch(/precipitate/)
    expect(tube(sucrose, [['hcl', 1], ['heat', 3], ['bicarb', 1.5], ['benedict', 2], ['heat', 5]])).toMatch(/precipitate/)
    // Left acid (more than the reagent's carbonate takes up), it cannot work: the sugar only reacts in alkali.
    expect(tube(sucrose, [['hcl', 2], ['heat', 3], ['benedict', 1], ['heat', 5]])).not.toMatch(/precipitate/)
  })
})

describe('biuret, iodine and Sudan III', () => {
  it('biuret turns violet with protein only', () => {
    expect(tube([['bio:ovalbumin', '50 g/L']], [['biuret', 2], ['wait', 2]])).toMatch(/violet|purple/)
    expect(tube(glucose(20), [['biuret', 2], ['wait', 2]])).toMatch(/blue/)
  })

  it('iodine is blue-black with starch and stays yellow-brown without', () => {
    expect(tube([['core:starch-soluble', '10 g/L']], [['iodine', 0.1]])).toMatch(/blue-black/)
    expect(tube(glucose(20), [['iodine', 0.1]])).toMatch(/yellow/)
  })

  it('Sudan III stains oil, which floats as a red layer', () => {
    expect(tube([['core:vegetable-oil', '920 g/L']], [['water', 2], ['sudan', 0.1], ['wait', 1]], 'core:vegetable-oil')).toMatch(/red layer on top/)
    expect(tube(glucose(20), [['water', 2], ['sudan', 0.1], ['wait', 1]])).not.toMatch(/layer/)
  })
})

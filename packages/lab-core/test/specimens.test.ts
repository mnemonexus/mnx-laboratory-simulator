// Specimens under the microscope (E16): a wet mount shows the specimen laid on the slide, a stain in
// the mounting liquid gives the structures that take it up colour and contrast, and structures with
// a density are counted in each field of view (Poisson about the mean), so a root tip gives a mitotic
// index near its true value and a leaf's lower epidermis about 250 stomata per mm².
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function scope(seed = 1) {
  const w = emptyWorld(seed)
  addEquipment(w, cat, 'scope', 'core:compound-microscope')
  addSupply(w, cat, { id: 'water', label: 'water', container: 'core:dropper-bottle-10ml', amount: '10 mL', components: [] })
  addSupply(w, cat, { id: 'iodine', label: 'iodine', container: 'core:dropper-bottle-10ml', amount: '10 mL', components: [{ substance: 'core:iodine', conc: '10 mM' }, { substance: 'core:potassium-iodide', conc: '60 mM' }] })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as { appearance: string; counts: Array<[string, number]>; fieldAreaMm2: number }
  }
  const look = (slide: string, objective = '40x') => {
    run('core:configure', { instrument: 'scope', objective: '10x', lamp: 0.5, illumination: 'brightfield', condenser: 'adjusted' })
    run('core:focus', { instrument: 'scope', subject: slide, knob: 'coarse' })
    run('core:focus', { instrument: 'scope', subject: slide, knob: 'fine' })
    if (objective !== '10x') {
      run('core:configure', { instrument: 'scope', objective, lamp: 0.65 })
      run('core:focus', { instrument: 'scope', subject: slide, knob: 'fine' })
    }
    return run('core:measure', { instrument: 'scope', subject: slide })
  }
  return { run, look }
}

describe('wet mounts and stains', () => {
  it('shows onion nuclei brown in iodine, and only faintly in water', () => {
    const s = scope()
    for (const [id, liquid] of [['wet', 'water'], ['stained', 'iodine']]) {
      s.run('core:fetch', { equipment: 'core:microscope-slide', id, label: id })
      s.run('core:transfer', { source: liquid, destination: id, volume: '50 uL' })
      s.run('core:add-solid', { substance: 'core:specimen.onion-epidermis', destination: id, mass: '5 mg' })
    }
    expect(s.look('stained', '10x').appearance).toMatch(/brown nuclei/)
    const unstained = s.look('wet', '10x').appearance
    expect(unstained).toMatch(/colourless nuclei \(faint\)/)
    expect(unstained).not.toMatch(/brown/)
  })
})

describe('counting in fields of view', () => {
  it('gives a root tip a mitotic index near its true value of about 0.12', () => {
    const s = scope(3)
    s.run('core:fetch', { equipment: 'core:prepared-slide.root-tip', id: 'root', label: 'root' })
    let dividing = 0
    let all = 0
    for (let i = 0; i < 5; i++) {
      for (const [label, n] of s.look('root').counts) {
        all += n
        if (!label.includes('interphase')) dividing += n
      }
    }
    expect(dividing / all).toBeGreaterThan(0.09)
    expect(dividing / all).toBeLessThan(0.15)
  })

  it('finds about 250 stomata per mm² on the lower epidermis, several times the upper', () => {
    const s = scope(2)
    const density = (equipment: string, id: string) => {
      s.run('core:fetch', { equipment, id, label: id })
      let n = 0
      let area = 0
      for (let i = 0; i < 5; i++) {
        const v = s.look(id)
        n += v.counts.filter(([l]) => l.includes('stomata')).reduce((a, [, c]) => a + c, 0)
        area += v.fieldAreaMm2
      }
      return n / area
    }
    const lower = density('core:prepared-slide.leaf-lower-epidermis', 'lower')
    expect(lower).toBeGreaterThan(190)
    expect(lower).toBeLessThan(310)
    expect(lower).toBeGreaterThan(3 * density('core:prepared-slide.leaf-upper-epidermis', 'upper'))
  })
})

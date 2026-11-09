// Colloids, clocks and a redox dye through the kernel: casein micelles cloud milk until a protease
// digests them (and heat stops the protease); acid turns thiosulfate into colloidal sulfur that hides
// a cross, sooner when more concentrated; vitamin C reduces blue DCPIP to colourless; and in the
// iodine clock thiosulfate hides the iodine until it runs out, so the starch turns suddenly.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

type Components = Array<[substance: string, conc: string]>

function bench(supplies: Record<string, Components>) {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'eye', 'core:visual-inspection')
  addPlace(w, cat, 'bath', 'core:water-bath')
  for (const [id, components] of Object.entries(supplies)) addSupply(w, cat, { id, label: id, container: 'core:reagent-bottle-1l', amount: '500 mL', components: components.map(([substance, conc]) => ({ substance, conc })) })
  const k = createKernel(cat, w)
  const run = (op: string, params: Record<string, unknown>) => {
    const r = k.execute({ op, params })
    if (!r.ok) throw new Error(r.refusal.message)
    return r.outputs as Record<string, string>
  }
  const look = (c: string) => run('core:measure', { instrument: 'eye', subject: c }).appearance
  const fill = (id: string, equipment: string, parts: Array<[source: string, mL: number]>) => {
    run('core:fetch', { equipment, id, label: id })
    for (const [source, mL] of parts) run('core:transfer', { source, destination: id, volume: `${mL} mL` })
    run('core:mix', { container: id, method: 'swirl', cycles: 3 })
  }
  const wait = (s: number) => run('core:advance-time', { duration: `${s} s` })
  return { run, look, fill, wait }
}

describe('colloids', () => {
  it('milk is cloudy until trypsin digests its casein, and stays cloudy when the trypsin was heated first', () => {
    const b = bench({ milk: [['bio:casein', '3.5 g/L'], ['core:disodium-hydrogen-phosphate', '40 mM'], ['core:potassium-dihydrogen-phosphate', '10 mM']], trypsin: [['bio:trypsin', '1 mg/mL']] })
    b.run('core:set-environment', { device: 'bath', temperature: '35 Cel' })
    b.fill('m', 'core:test-tube', [['milk', 5], ['trypsin', 2]])
    expect(b.look('m')).toMatch(/cloudy/)
    b.run('core:place-in', { container: 'm', place: 'bath' })
    b.wait(600)
    expect(b.look('m')).not.toMatch(/cloudy/)
    // Trypsin held at 60 °C for 5 minutes first is denatured.
    b.run('core:set-environment', { device: 'bath', temperature: '60 Cel' })
    b.fill('hot', 'core:test-tube', [['trypsin', 2]])
    b.run('core:place-in', { container: 'hot', place: 'bath' })
    b.wait(300)
    b.fill('m2', 'core:test-tube', [['milk', 5]])
    b.run('core:transfer', { source: 'hot', destination: 'm2', all: true })
    b.run('core:mix', { container: 'm2', method: 'swirl', cycles: 3 })
    b.wait(600)
    expect(b.look('m2')).toMatch(/cloudy/)
  })

  it('acid clouds thiosulfate with pale yellow sulfur, sooner when more concentrated', () => {
    const timeToHide = (thioMl: number) => {
      const b = bench({ thio: [['chem:sodium-thiosulfate', '0.15 mol/L']], hcl: [['core:hydrochloric-acid', '2 mol/L']], water: [] })
      b.fill('f', 'core:conical-flask-100ml', [['thio', thioMl], ...(thioMl < 50 ? [['water', 50 - thioMl] as [string, number]] : []), ['hcl', 5]])
      for (let t = 2; t <= 300; t += 2) {
        b.wait(2)
        const seen = b.look('f')
        if (seen.includes('see through')) {
          expect(seen).toMatch(/yellow/)
          return t
        }
      }
      return Infinity
    }
    const t50 = timeToHide(50)
    const t25 = timeToHide(25)
    expect(t50).toBeLessThan(60)
    expect(t25 / t50).toBeGreaterThan(1.6)
    expect(t25 / t50).toBeLessThan(2.5)
  })
})

describe('redox colour changes', () => {
  it('vitamin C turns DCPIP from blue to colourless', () => {
    const b = bench({ dcpip: [['bio:dcpip', '3.45 mM']], vitc: [['chem:ascorbic-acid', '1 g/L']] })
    b.fill('f', 'core:conical-flask-100ml', [['dcpip', 10]])
    expect(b.look('f')).toMatch(/blue/)
    b.run('core:transfer', { source: 'vitc', destination: 'f', volume: '8 mL' })
    b.run('core:mix', { container: 'f', method: 'swirl', cycles: 3 })
    expect(b.look('f')).toBe('clear')
  })

  it('the iodine clock stays clear while thiosulfate lasts, then turns blue', () => {
    const b = bench({ ki: [['core:potassium-iodide', '0.20 mol/L']], thio: [['chem:sodium-thiosulfate', '0.010 mol/L']], pers: [['chem:potassium-persulfate', '0.10 mol/L']], starch: [['core:starch-soluble', '10 g/L']] })
    b.fill('f', 'core:conical-flask-100ml', [['ki', 10], ['thio', 5], ['starch', 1], ['pers', 10]])
    b.wait(20)
    expect(b.look('f')).not.toMatch(/blue/)
    b.wait(60)
    expect(b.look('f')).toMatch(/blue/)
  })
})

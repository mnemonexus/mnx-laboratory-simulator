// Identification tests: a selective agent that spares organisms with a marker (CFC and the
// pseudomonads), a carbon source only some can use (hexadecane), boiling lysis releasing a
// chromosome for species-specific PCR, separate streak patches, and a harmless empty eject.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'
import { coloniesOn } from '../src/models/growth.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const NA = 6.022e23

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

function world() {
  const w = emptyWorld(1)
  addPlace(w, cat, 'incubator', 'core:incubator')
  addPlace(w, cat, 'block', 'core:heating-block')
  addPlace(w, cat, 'cycler', 'core:thermal-cycler-96-tube')
  addEquipment(w, cat, 'loop', 'core:inoculating-loop-10ul')
  addEquipment(w, cat, 'p20', 'core:micropipette-p20')
  for (const [id, org] of [['pp', 'micro:pseudomonas-putida'], ['pf', 'micro:pseudomonas-fluorescens'], ['ec', 'micro:escherichia-coli-k12']]) {
    addSupply(w, cat, { id: `${id}-plate`, label: id, container: 'core:petri-dish-90mm', amount: '20 mL', preparation: 'micro:nutrient-agar', populations: [{ substance: org, total: 30 }] })
    addSupply(w, cat, { id: `${id}-flask`, label: id, container: 'core:conical-flask-100ml', amount: '40 mL', preparation: 'micro:mineral-salts-medium', components: [{ substance: 'micro:hexadecane', conc: '0.77 g/L' }], populations: [{ substance: org, perL: 1e9 }] })
  }
  addSupply(w, cat, { id: 'cfc', label: 'CFC', container: 'core:petri-dish-90mm', amount: '20 mL', preparation: 'micro:pseudomonas-cfc-agar-plate' })
  addSupply(w, cat, { id: 'lysate', label: 'lysate', container: 'core:microtube-1.5ml', amount: '30 uL', preparation: 'micro:y-per-lysis' })
  addSupply(w, cat, { id: 'pcr', label: 'pcr', container: 'core:pcr-tube-0.2ml', amount: '18 uL', preparation: 'molbio:p-putida-pcr-mix' })
  const k = createKernel(cat, w)
  run(k, 'core:set-environment', { device: 'incubator', temperature: '30 Cel' })
  run(k, 'core:set-environment', { device: 'block', temperature: '98 Cel' })
  return k
}

describe('identification tests', () => {
  it('CFC agar grows pseudomonads in separate patches and stops E. coli', () => {
    const k = world()
    for (const [plate, sector] of [['pp-plate', 1], ['pf-plate', 2], ['ec-plate', 3]] as const) {
      run(k, 'core:sterilise', { tool: 'loop' })
      run(k, 'core:pick-colony', { plate, tool: 'loop' })
      run(k, 'core:streak', { plate: 'cfc', tool: 'loop', sector, cross: false })
    }
    run(k, 'core:place-in', { container: 'cfc', place: 'incubator' })
    run(k, 'core:advance-time', { duration: '36 h' })
    const views = coloniesOn(cat, k.world.containers.cfc.contents)
    const by = (o: string) => views.find((v) => v.organism === o)
    expect(by('micro:pseudomonas-putida')?.bySector?.[0]).toBeGreaterThan(300)
    expect(by('micro:pseudomonas-fluorescens')?.bySector?.[1]).toBeGreaterThan(300)
    // Separate patches: nothing dragged from one into the next.
    expect(by('micro:pseudomonas-putida')?.bySector?.[1] ?? 0).toBe(0)
    expect(by('micro:escherichia-coli-k12')?.colonies ?? 0).toBe(0)
  })

  it('hexadecane is a carbon source only for an alkane degrader', () => {
    const k = world()
    for (const f of ['pp-flask', 'pf-flask', 'ec-flask']) run(k, 'core:place-in', { container: f, place: 'incubator' })
    const before = (f: string) => Object.values(k.world.containers[f].contents.layers[0].populations ?? {})[0].count
    const start = { pp: before('pp-flask'), pf: before('pf-flask'), ec: before('ec-flask') }
    run(k, 'core:advance-time', { duration: '48 h' })
    expect(before('pp-flask')).toBeGreaterThan(10 * start.pp)
    expect(before('pf-flask')).toBeLessThanOrEqual(start.pf * 1.001)
    expect(before('ec-flask')).toBeLessThanOrEqual(start.ec * 1.001)
  })

  it('boiled cells release their chromosome, and species-specific primers amplify it', () => {
    const k = world()
    run(k, 'core:eject-tip', { pipette: 'p20' })
    run(k, 'core:attach-tip', { pipette: 'p20' })
    run(k, 'core:pick-colony', { plate: 'pp-plate', tool: 'p20', destination: 'lysate' })
    run(k, 'core:close', { container: 'lysate' })
    run(k, 'core:place-in', { container: 'lysate', place: 'block' })
    run(k, 'core:advance-time', { duration: '5 min' })
    const layer = k.world.containers.lysate.contents.layers[0]
    expect(layer.populations ?? {}).toEqual({})
    expect((layer.species['molbio:p-putida-genome'] ?? 0) * NA).toBeGreaterThan(1e5)
    run(k, 'core:remove-from', { container: 'lysate' })
    run(k, 'core:open', { container: 'lysate' })
    run(k, 'core:eject-tip', { pipette: 'p20' })
    run(k, 'core:attach-tip', { pipette: 'p20' })
    run(k, 'core:transfer', { source: 'lysate', destination: 'pcr', volume: '2 uL', tool: 'p20' })
    run(k, 'core:place-in', { container: 'pcr', place: 'cycler' })
    run(k, 'core:thermocycle', { cycler: 'cycler', cycles: 30 })
    expect((k.world.containers.pcr.contents.layers[0].species['molbio:p-putida-amplicon'] ?? 0) * NA).toBeGreaterThan(1e11)
  })

  it('ejecting with no tip on does nothing', () => {
    const k = world()
    expect(run(k, 'core:eject-tip', { pipette: 'p20' }).event.facts.ejected).toBe(false)
  })
})

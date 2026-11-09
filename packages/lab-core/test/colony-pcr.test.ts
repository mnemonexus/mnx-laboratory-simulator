// Colony PCR and differential media: cells burst in the first denaturation and release their
// plasmids, so a colony of a strain carrying blaTEM amplifies it; too many cells inhibit. On EMB,
// E. coli's sheen tells it from other coliforms, and Gram-positives do not grow.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'
import { coloniesOn } from '../src/models/growth.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const NA = 6.022e23

function bench(): Kernel {
  const w = emptyWorld(1)
  addEquipment(w, cat, 'p20', 'core:micropipette-p20')
  addEquipment(w, cat, 'loop', 'core:inoculating-loop-10ul')
  addPlace(w, cat, 'cycler', 'core:thermal-cycler-96-tube')
  addSupply(w, cat, { id: 'resistant', label: 'R', container: 'core:petri-dish-90mm', amount: '20 mL', preparation: 'micro:nutrient-agar', populations: [{ substance: 'molbio:escherichia-coli-wild-blatem', total: 20 }] })
  addSupply(w, cat, { id: 'sensitive', label: 'S', container: 'core:petri-dish-90mm', amount: '20 mL', preparation: 'micro:nutrient-agar', populations: [{ substance: 'micro:escherichia-coli-k12', total: 20 }] })
  for (const id of ['tip-r', 'tip-s', 'loop-r']) addSupply(w, cat, { id, label: id, container: 'core:pcr-tube-0.2ml', amount: '20 uL', preparation: 'molbio:bla-tem-colony-pcr-mix' })
  return createKernel(cat, w)
}

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

const product = (k: Kernel, tube: string) => (k.world.containers[tube].contents.layers[0]?.species['molbio:bla-tem-amplicon'] ?? 0) * NA

describe('colony PCR', () => {
  it('a plate supplied with a number of colonies has that many', () => {
    const k = bench()
    expect(coloniesOn(cat, k.world.containers.resistant.contents)[0].colonies).toBe(20)
  })

  it('a colony carrying blaTEM amplifies it; a sensitive one does not; a heavy pick inhibits', () => {
    const k = bench()
    for (const [plate, tube] of [['resistant', 'tip-r'], ['sensitive', 'tip-s']]) {
      run(k, 'core:attach-tip', { pipette: 'p20' })
      run(k, 'core:pick-colony', { plate, tool: 'p20', destination: tube })
      run(k, 'core:eject-tip', { pipette: 'p20' })
    }
    // A loopful is ten times what a tip touch takes.
    run(k, 'core:pick-colony', { plate: 'resistant', tool: 'loop', destination: 'loop-r' })
    for (const t of ['tip-r', 'tip-s', 'loop-r']) run(k, 'core:place-in', { container: t, place: 'cycler' })
    run(k, 'core:thermocycle', { cycler: 'cycler', cycles: 30 })
    expect(product(k, 'tip-r')).toBeGreaterThan(1e11)
    expect(product(k, 'tip-s')).toBe(0)
    expect(product(k, 'loop-r')).toBeLessThan(0.1 * product(k, 'tip-r'))
  })
})

describe('EMB agar', () => {
  it('E. coli grows with a green sheen, Enterobacter pink-purple, Bacillus not at all', () => {
    const w = emptyWorld(1)
    addPlace(w, cat, 'incubator', 'core:incubator')
    addSupply(w, cat, {
      id: 'emb', label: 'EMB', container: 'core:petri-dish-90mm', amount: '20 mL', preparation: 'micro:emb-agar-plate',
    })
    addSupply(w, cat, {
      id: 'water', label: 'water', container: 'core:microtube-1.5ml', amount: '1 mL', preparation: 'core:water-deionised',
      populations: [{ substance: 'micro:escherichia-coli-k12', perL: 5e5 }, { substance: 'micro:enterobacter-aerogenes', perL: 5e5 }, { substance: 'micro:bacillus-subtilis', perL: 5e5 }],
    })
    addEquipment(w, cat, 'spreader', 'core:cell-spreader')
    addEquipment(w, cat, 'p200', 'core:micropipette-p200')
    const k = createKernel(cat, w)
    run(k, 'core:set-environment', { device: 'incubator', temperature: '37 Cel' })
    run(k, 'core:attach-tip', { pipette: 'p200' })
    run(k, 'core:transfer', { source: 'water', destination: 'emb', volume: '100 uL', tool: 'p200' })
    run(k, 'core:spread', { plate: 'emb', tool: 'spreader' })
    run(k, 'core:place-in', { container: 'emb', place: 'incubator' })
    run(k, 'core:advance-time', { duration: '24 h' })
    const looks = coloniesOn(cat, k.world.containers.emb.contents).filter((v) => v.colonies > 0).map((v) => [v.organism, v.appearance])
    expect(looks.find(([o]) => o === 'micro:escherichia-coli-k12')?.[1]).toMatch(/green metallic sheen/)
    expect(looks.find(([o]) => o === 'micro:enterobacter-aerogenes')?.[1]).toMatch(/pink-purple/)
    expect(looks.some(([o]) => o === 'micro:bacillus-subtilis')).toBe(false)
  })
})

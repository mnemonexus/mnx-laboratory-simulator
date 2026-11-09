// Working under an inert atmosphere: septa, nitrogen balloons, sparging, flushed and unflushed
// syringes, dissolved oxygen by Henry's law, sharps, and the oxygen practical.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addEquipment, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'
import { oxygenSaturation } from '../src/models/gases.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

function lab(): Kernel {
  const w = emptyWorld(1)
  for (const id of ['n1', 'n2']) addEquipment(w, cat, id, 'core:nitrogen-balloon')
  for (const id of ['s1', 's2']) addEquipment(w, cat, id, 'core:syringe-10ml')
  addEquipment(w, cat, 'do', 'core:do-meter')
  addSupply(w, cat, { id: 'water', label: 'water', container: 'core:reagent-bottle-1l', amount: '500 mL', components: [{ substance: 'core:oxygen', conc: '0.28 mM' }] })
  const k = createKernel(cat, w, { handlingError: 0, noise: 0 })
  run(k, 'core:fetch', { equipment: 'core:round-bottom-flask-250ml', id: 'src', label: 'src' })
  run(k, 'core:transfer', { source: 'water', destination: 'src', volume: '150 mL', tool: 'pour' })
  run(k, 'core:close', { container: 'src', cover: 'septum' })
  return k
}
const o2 = (k: Kernel, id: string) => {
  const c = k.world.containers[id].contents
  const n = c.layers.reduce((a, l) => a + (l.species['core:oxygen'] ?? 0), 0)
  return (n / c.layers.reduce((a, l) => a + l.volumeL, 0)) * 32000
}

describe("oxygen's solubility", () => {
  it('follows Henry’s law: about 8.3 mg/L in air at 25 °C, more in the cold, none under nitrogen', () => {
    expect(oxygenSaturation(cat, 298.15, 1) * 32000).toBeCloseTo(8.25, 1)
    expect(oxygenSaturation(cat, 273.15, 1) * 32000).toBeGreaterThan(14)
    expect(oxygenSaturation(cat, 298.15, 0)).toBe(0)
  })
})

describe('septa, balloons and syringes', () => {
  it('a septum keeps out anything but a needle', () => {
    const k = lab()
    const r = k.execute({ op: 'core:transfer', params: { source: 'src', destination: 'water', volume: '5 mL', tool: 'pour' } })
    expect(r.ok ? '' : r.refusal.code).toBe('SEPTUM')
    expect(k.execute({ op: 'core:purge', params: { container: 'water', balloon: 'n1' } }).ok).toBe(false)
  })

  it('sparging takes the dissolved oxygen out; purging the headspace alone does so only slowly', () => {
    const k = lab()
    run(k, 'core:purge', { container: 'src', balloon: 'n1', duration: '2 min' })
    expect(k.world.containers.src.headspaceAir!).toBeLessThan(0.01)
    expect(o2(k, 'src')).toBeGreaterThan(8)
    run(k, 'core:purge', { container: 'src', balloon: 'n1', duration: '15 min', sparge: true })
    expect(o2(k, 'src')).toBeLessThan(0.1)
  })

  it('a flushed syringe moves the water without oxygen; an unflushed one carries some in; pouring takes up much more', () => {
    const k = lab()
    run(k, 'core:purge', { container: 'src', balloon: 'n1', duration: '15 min', sparge: true })
    for (const [id, syringe, flush] of [['a', 's1', true], ['b', 's2', false]] as const) {
      run(k, 'core:fetch', { equipment: 'core:round-bottom-flask-100ml', id, label: id })
      run(k, 'core:close', { container: id, cover: 'septum' })
      run(k, 'core:purge', { container: id, balloon: 'n2', duration: '3 min' })
      if (flush) run(k, 'core:flush-syringe', { syringe, source: 'src' })
      run(k, 'core:transfer', { source: 'src', destination: id, volume: '10 mL', tool: syringe })
    }
    run(k, 'core:fetch', { equipment: 'core:beaker-100ml', id: 'c', label: 'c' })
    run(k, 'core:open', { container: 'src' })
    run(k, 'core:transfer', { source: 'src', destination: 'c', volume: '10 mL', tool: 'pour' })
    expect(o2(k, 'a')).toBeLessThan(0.2)
    expect(o2(k, 'b')).toBeGreaterThan(1.5)
    expect(o2(k, 'c')).toBeGreaterThan(o2(k, 'b'))
  })

  it('drawing from a sealed flask with no balloon lets air in behind the liquid', () => {
    const k = lab()
    run(k, 'core:purge', { container: 'src', balloon: 'n1', duration: '3 min' })
    delete k.world.containers.src.balloon
    run(k, 'core:fetch', { equipment: 'core:beaker-100ml', id: 'b', label: 'b' })
    run(k, 'core:transfer', { source: 'src', destination: 'b', volume: '10 mL', tool: 's1' })
    expect(k.world.containers.src.headspaceAir!).toBeGreaterThan(0.08)
  })

  it('a used syringe goes into the sharps bin and cannot be used again; anywhere else is an incident', () => {
    const k = lab()
    run(k, 'core:dispose', { item: 's1', stream: 'core:sharps-bin' })
    expect(k.world.incidents).toHaveLength(0)
    const again = k.execute({ op: 'core:transfer', params: { source: 'water', destination: 'src', volume: '5 mL', tool: 's1' } })
    expect(again.ok ? '' : again.refusal.code).toBe('DISCARDED')
    run(k, 'core:dispose', { item: 's2', stream: 'core:general-waste' })
    expect(k.world.incidents).toHaveLength(1)
  })

  it('the dissolved-oxygen meter reads air-saturated water near 9 mg/L at room temperature, and needs the flask open', () => {
    const k = lab()
    const sealed = k.execute({ op: 'core:measure', params: { instrument: 'do', subject: 'src' } })
    expect(sealed.ok ? '' : sealed.refusal.code).toBe('SEALED')
    run(k, 'core:open', { container: 'src' })
    const r = run(k, 'core:measure', { instrument: 'do', subject: 'src' })
    expect(Number(String(r.outputs.value).split(' ')[0])).toBeGreaterThan(8.5)
  })
})

describe('conformance: working under nitrogen', () => {
  const def = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem17-inert-atmosphere-oxygen.labx.json')) as ExperimentDefinition

  it('rehearses for several seeds', () => {
    for (const seed of [1, 2]) {
      const r = compile(def, cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 300000)
})

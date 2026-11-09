// Indirect ELISA: protein adsorbs to a high-binding plate up to its capacity, blocking takes the
// rest of the plastic, antibodies bind their targets and survive washes, and the HRP on the wall
// turns TMB over; acid stops it and turns the product yellow.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { onWall, wettedArea } from '../src/models/binding.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const elisa = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio9-indirect-elisa.labx.json')) as ExperimentDefinition
const field = (r: ReturnType<typeof compile>, f: string) => r.kernel!.world.notebook.find((e) => e.field === f)?.value
const rawA450 = (r: ReturnType<typeof compile>, well: string) => evaluate(`reading(read, 'plate/${well}')`, runEnv(r.run!)) as number

describe('conformance: indirect ELISA', () => {
  it('rehearses for several seeds: a rising standard curve, a clean no-primary control, the unknown within 25 %', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = compile(elisa, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(r.run!.decisions.background).toBe('clean')
    }
  }, 180000)

  it('without blocking, antibodies stick to bare plastic; protein in the antibody diluent blocks too', () => {
    const noBlock = structuredClone(elisa)
    noBlock.procedure!.steps = noBlock.procedure!.steps!.filter((s) => s.id !== 'blocking')
    // And with the antibodies diluted in plain buffer, nothing else covers the plastic.
    const bare = structuredClone(noBlock)
    const plain = (id: string, substance: string, conc: string) => {
      const s = bare.materials!.supplies!.find((x) => x.id === id)!
      delete s.preparation
      Object.assign(s, { contains: [{ substance, conc }], solvent: 'core:water' })
    }
    plain('primary', 'bio:mouse-anti-ovalbumin', '2 mg/L')
    plain('secondary', 'bio:goat-anti-mouse-hrp', '0.2 mg/L')
    const blocked = rawA450(compile(elisa, catalogue, { seed: 1 }), 'F1')
    const unblocked = rawA450(compile(noBlock, catalogue, { seed: 1 }), 'F1')
    const r = compile(bare, catalogue, { seed: 1 })
    expect(blocked).toBeLessThan(0.1)
    expect(unblocked).toBeGreaterThan(blocked)
    expect(rawA450(r, 'F1')).toBeGreaterThan(0.5)
    // The curve is squashed against its high blank.
    const top = (x: ReturnType<typeof compile>) => (field(x, 'A450-standards') as number[]).at(-1)!
    expect(top(r)).toBeLessThan(top(compile(elisa, catalogue, { seed: 1 })) * 0.6)
  }, 120000)
})

describe('surfaces and binding', () => {
  function well(components: Array<{ substance: string; conc: string }>) {
    const w = emptyWorld(1)
    const k = createKernel(catalogue, w)
    k.execute({ op: 'core:fetch', params: { equipment: 'core:microplate-96-elisa', id: 'p' } })
    addSupply(k.world, catalogue, { id: 's', label: 'S', container: 'core:microtube-1.5ml', amount: '1 mL', components })
    addSupply(k.world, catalogue, { id: 'pbs', label: 'PBS', container: 'core:reagent-bottle-250ml', amount: '100 mL', components: [] })
    k.execute({ op: 'core:transfer', params: { source: 's', destination: 'p/A1', volume: '100 uL' } })
    return k
  }

  it('adsorption stops at the wall capacity', () => {
    const k = well([{ substance: 'bio:ovalbumin', conc: '50 mg/L' }])
    k.execute({ op: 'core:advance-time', params: { duration: '3 h' } })
    const w = k.world.containers['p/A1']
    const ng = onWall(w, 'bio:ovalbumin') * 44300 * 1e9
    const capacityNg = 400 * wettedArea(w, 100e-6) * 1e4
    expect(ng).toBeGreaterThan(0.9 * capacityNg)
    // The well holds a little more than 100 µL, so slightly more wall is wet.
    expect(ng).toBeLessThanOrEqual(capacityNg * 1.03)
  })

  it('a wash removes what is free and keeps what is on the wall', () => {
    const k = well([{ substance: 'bio:ovalbumin', conc: '1 mg/L' }, { substance: 'core:sodium-chloride', conc: '100 mM' }])
    k.execute({ op: 'core:advance-time', params: { duration: '1 h' } })
    const w = () => k.world.containers['p/A1']
    const before = onWall(w(), 'bio:ovalbumin')
    k.execute({ op: 'core:wash', params: { target: 'p', buffer: 'pbs', volume: '300 uL', cycles: 3 } })
    expect(onWall(w(), 'bio:ovalbumin')).toBeCloseTo(before, 15)
    const salt = w().contents.layers.reduce((a, l) => a + (l.species['core:sodium-chloride'] ?? 0), 0)
    // 10 µmol started in the well; three washes leave a trace.
    expect(salt).toBeLessThan(1e-11)
  })

  it('an antibody binds its target on the wall, and not a protein it does not recognise', () => {
    const coat = (antigen: string) => {
      const k = well([{ substance: antigen, conc: '5 mg/L' }])
      k.execute({ op: 'core:advance-time', params: { duration: '1 h' } })
      addSupply(k.world, catalogue, { id: 'blk', label: 'Block', container: 'core:microtube-1.5ml', amount: '1 mL', components: [{ substance: 'bio:bovine-serum-albumin', conc: '10 g/L' }] })
      addSupply(k.world, catalogue, { id: 'ab', label: 'Ab', container: 'core:microtube-1.5ml', amount: '1 mL', components: [{ substance: 'bio:mouse-anti-ovalbumin', conc: '2 mg/L' }] })
      k.execute({ op: 'core:wash', params: { target: 'p', buffer: 'pbs', cycles: 3 } })
      k.execute({ op: 'core:transfer', params: { source: 'blk', destination: 'p/A1', volume: '200 uL' } })
      k.execute({ op: 'core:advance-time', params: { duration: '1 h' } })
      k.execute({ op: 'core:wash', params: { target: 'p', buffer: 'pbs', cycles: 3 } })
      k.execute({ op: 'core:transfer', params: { source: 'ab', destination: 'p/A1', volume: '100 uL' } })
      k.execute({ op: 'core:advance-time', params: { duration: '1 h' } })
      k.execute({ op: 'core:wash', params: { target: 'p', buffer: 'pbs', cycles: 3 } })
      return onWall(k.world.containers['p/A1'], 'bio:mouse-anti-ovalbumin')
    }
    const onOvalbumin = coat('bio:ovalbumin')
    const onLysozyme = coat('bio:lysozyme')
    expect(onOvalbumin).toBeGreaterThan(1e-13)
    expect(onLysozyme).toBeLessThan(onOvalbumin * 0.05)
  })
})

// Contamination: what settles on an uncovered plate, what an unflamed rim lets in, what fingers
// leave, and where growth shows in a stab. Only vessels explicitly uncovered are exposed.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { addEquipment, addPlace, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function bench(seed: number): Kernel {
  const w = emptyWorld(seed)
  addEquipment(w, cat, 'eye', 'core:visual-inspection')
  addEquipment(w, cat, 'loop', 'core:inoculating-loop-10ul')
  addPlace(w, cat, 'incubator', 'core:incubator')
  for (const id of ['open-plate', 'lidded', 'fingers']) addSupply(w, cat, { id, label: id, container: 'core:petri-dish-90mm', amount: '20 mL', preparation: 'micro:nutrient-agar' })
  for (const id of ['a', 'b', 'c']) addSupply(w, cat, { id, label: id, container: 'core:culture-tube-20ml', amount: '10 mL', preparation: 'micro:nutrient-broth-sterile' })
  for (const id of ['deep-e', 'deep-b']) addSupply(w, cat, { id, label: id, container: 'core:agar-deep-tube', amount: '8 mL', preparation: 'micro:nutrient-agar' })
  addSupply(w, cat, { id: 'ecoli', label: 'E. coli', container: 'core:universal-bottle-28ml', amount: '5 mL', preparation: 'micro:nutrient-broth-sterile', populations: [{ substance: 'micro:escherichia-coli-k12', perL: 1e11 }] })
  addSupply(w, cat, { id: 'bacillus', label: 'B. subtilis', container: 'core:universal-bottle-28ml', amount: '5 mL', preparation: 'micro:nutrient-broth-sterile', populations: [{ substance: 'micro:bacillus-subtilis', perL: 1e11 }] })
  const k = createKernel(cat, w)
  run(k, 'core:set-environment', { device: 'incubator', temperature: '37 Cel' })
  return k
}

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r
}

function incubate(k: Kernel, ids: string[], hours = 48) {
  for (const c of ids) run(k, 'core:place-in', { container: c, place: 'incubator' })
  run(k, 'core:advance-time', { duration: `${hours} h` })
}

const colonies = (k: Kernel, id: string) => Object.values(k.world.containers[id].contents.surface ?? {}).reduce((a, s) => a + (s.founders ?? 0), 0)
const look = (k: Kernel, id: string) => {
  run(k, 'core:measure', { instrument: 'eye', subject: id })
  const m = k.world.measurements[k.world.measurements.length - 1]
  return m.display[id]
}

describe('contamination', () => {
  it('an uncovered plate collects airborne organisms in proportion to the time; a lidded one does not', () => {
    const counts: number[] = []
    for (const seed of [1, 2, 3, 4]) {
      const k = bench(seed)
      run(k, 'core:open', { container: 'open-plate' })
      run(k, 'core:advance-time', { duration: '1 h' })
      run(k, 'core:close', { container: 'open-plate' })
      incubate(k, ['open-plate', 'lidded'])
      counts.push(colonies(k, 'open-plate'))
      expect(colonies(k, 'lidded')).toBe(0)
    }
    // 0.5 per cm² per hour over a 57 cm² plate: about 28.
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length
    expect(mean).toBeGreaterThan(15)
    expect(mean).toBeLessThan(45)
  }, 300000)

  it('fingers leave fewer organisms after washing, fewest after an antiseptic', () => {
    const k = bench(1)
    const press = (plate: string) => {
      run(k, 'core:open', { container: plate })
      run(k, 'core:press-fingers', { plate })
      run(k, 'core:close', { container: plate })
    }
    press('fingers')
    run(k, 'core:wash-hands', { method: 'antiseptic' })
    press('lidded')
    incubate(k, ['fingers', 'lidded'])
    expect(colonies(k, 'fingers')).toBeGreaterThan(80)
    expect(colonies(k, 'lidded')).toBeLessThan(15)
    expect(() => run(k, 'core:press-fingers', { plate: 'open-plate' })).toThrow(/lid/)
  }, 120000)

  it('flamed necks keep a series of transfers sterile; unflamed ones let contaminants in', () => {
    let flamedDirty = 0
    let unflamedDirty = 0
    for (const seed of [1, 2, 3]) {
      for (const flame of [true, false]) {
        const k = bench(seed)
        for (let i = 0; i < 6; i++) {
          const [a, b] = [['a', 'b'], ['b', 'c'], ['c', 'a']][i % 3]
          run(k, 'core:sterilise', { tool: 'loop' })
          for (const t of [a, b]) {
            run(k, 'core:open', { container: t })
            if (flame) run(k, 'core:flame-neck', { container: t })
          }
          run(k, 'core:transfer', { source: a, destination: b, volume: '10 uL', tool: 'loop' })
          for (const t of [a, b]) {
            if (flame) run(k, 'core:flame-neck', { container: t })
            run(k, 'core:close', { container: t })
          }
        }
        incubate(k, ['a', 'b', 'c'])
        const dirty = ['a', 'b', 'c'].filter((t) => look(k, t) !== 'clear').length
        if (flame) flamedDirty += dirty
        else unflamedDirty += dirty
      }
    }
    // Careful work can still be unlucky (0.1 % a handling), but careless work is far worse.
    expect(flamedDirty).toBeLessThanOrEqual(1)
    expect(unflamedDirty).toBeGreaterThanOrEqual(3)
  }, 300000)

  it('a stab shows the oxygen requirement: a facultative organism grows all along it, an aerobe only at the top', () => {
    const k = bench(1)
    for (const [deep, src] of [['deep-e', 'ecoli'], ['deep-b', 'bacillus']]) {
      run(k, 'core:sterilise', { tool: 'loop' })
      run(k, 'core:stab', { tube: deep, tool: 'loop', source: src })
    }
    incubate(k, ['deep-e', 'deep-b'])
    expect(look(k, 'deep-e')).toMatch(/all along the stab/)
    expect(look(k, 'deep-b')).toMatch(/only at the top/)
  }, 120000)
})

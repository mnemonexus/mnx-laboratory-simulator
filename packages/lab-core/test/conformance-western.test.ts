// Western blotting: bands blotted from an SDS gel, antibodies binding their target band by band,
// the membrane's own binding (blocking and background), and colour where the enzyme is.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { evaluate } from '../src/expr/evaluate.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { runEnv } from '../src/run/env.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const western = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio12-western-blot.labx.json')) as ExperimentDefinition
const lane = (r: ReturnType<typeof compile>, n: number) => (evaluate(`blotBands('membrane', ${n})`, runEnv(r.run!)) as unknown[]).length
const blotText = (r: ReturnType<typeof compile>) => Object.values([...r.kernel!.world.measurements].reverse().find((m) => m.settings.blot !== undefined)!.display)[0]
const without = (id: string) => {
  const def = structuredClone(western)
  def.procedure!.steps = def.procedure!.steps!.filter((s) => s.id !== id)
  return def
}

describe('conformance: Western blot', () => {
  it('rehearses for several seeds: one band at about 35 kDa in the extract and LDH lanes, none for BSA', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(western, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(r.run!.decisions.specific).toBe('specific')
      expect(lane(r, 1)).toBe(10)
    }
  }, 60000)

  it('without the primary antibody nothing is detected, though the marker still shows', () => {
    const r = compile(without('primary-step'), catalogue, { seed: 1 })
    expect(lane(r, 2)).toBe(0)
    expect(lane(r, 1)).toBe(10)
    expect(r.run!.decisions.specific).toBe('nothing')
  }, 30000)

  it('without blocking, and with antibodies in plain buffer, the whole membrane darkens', () => {
    const def = without('blocking')
    for (const id of ['primary', 'secondary']) {
      const s = def.materials!.supplies!.find((x) => x.id === id)!
      const substance = id === 'primary' ? 'bio:mouse-anti-ldh' : 'bio:goat-anti-mouse-hrp'
      delete s.preparation
      Object.assign(s, { contains: [{ substance, conc: id === 'primary' ? '1 mg/L' : '0.2 mg/L' }], solvent: 'core:water' })
    }
    const r = compile(def, catalogue, { seed: 1 })
    expect(blotText(r)).toMatch(/dark background/)
    expect(blotText(compile(western, catalogue, { seed: 1 }))).toMatch(/clean background/)
  }, 30000)
})

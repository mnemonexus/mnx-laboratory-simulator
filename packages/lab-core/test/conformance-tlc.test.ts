// Thin-layer chromatography: Rf from adsorption and eluent strength, spots read under 254 nm, and
// the classic mistakes (eluent above the origin, the wrong eluent, the wrong lamp).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { eluentStrength, rf } from '../src/models/tlc.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const tlc = readJson(join(PACKAGES, 'pack-chemistry', 'definitions', 'chem7-tlc-analgesics.labx.json')) as ExperimentDefinition
const rfs = (r: ReturnType<typeof compile>, lane: number) => r.kernel!.world.notebook.find((e) => e.field === `Rf-lane-${lane}`)?.value as number[]
const viewText = (r: ReturnType<typeof compile>) => Object.values([...r.kernel!.world.measurements].reverse().find((m) => m.subject === 'plate')!.display)[0]

function variant(change: (def: ExperimentDefinition) => void): ExperimentDefinition {
  const def = structuredClone(tlc)
  change(def)
  return def
}
const step = (def: ExperimentDefinition, id: string) => def.procedure!.steps!.find((s) => s.id === id)!

describe('conformance: TLC of analgesics', () => {
  it('rehearses for several seeds: standards in order, the tablet called right either way', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = compile(tlc, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
    }
  }, 60000)

  it('eluent above the origin dissolves the spots off the plate', () => {
    const r = compile(variant((d) => (step(d, 'fill').params!.volume = '25 mL')), catalogue, { seed: 1 })
    expect(viewText(r)).toMatch(/no spots/)
    expect(r.rehearsal!.goals[0].passed).toBe(false)
  })

  it('hexane leaves everything at the origin; ethanol carries everything to the front', () => {
    const hexane = compile(variant((d) => {
      d.materials!.supplies!.find((s) => s.id === 'eluent')!.contains = [{ substance: 'chem:hexane', conc: '655 g/L' }]
    }), catalogue, { seed: 1 })
    for (const lane of [1, 2, 3]) for (const x of rfs(hexane, lane)) expect(x).toBeLessThan(0.05)
    const ethanol = compile(variant((d) => {
      d.materials!.supplies!.find((s) => s.id === 'eluent')!.contains = [{ substance: 'core:ethanol', conc: '789 g/L' }]
    }), catalogue, { seed: 1 })
    for (const lane of [1, 2, 3]) for (const x of rfs(ethanol, lane)) expect(x).toBeGreaterThan(0.85)
  })

  it('under a long-wave lamp nothing shows', () => {
    const r = compile(variant((d) => (d.equipment!.roles![0].requires = { class: 'core:uv-lamp' })), catalogue, { seed: 1 })
    expect(viewText(r)).toMatch(/only glows under short-wave/)
  })
})

describe('TLC model', () => {
  it('Rf rises with eluent strength, and a mixture is between its solvents', () => {
    expect(rf(catalogue, 'chem:caffeine', 0.48)!).toBeLessThan(rf(catalogue, 'chem:caffeine', 0.6)!)
    expect(rf(catalogue, 'chem:aspirin', 0.48)!).toBeGreaterThan(rf(catalogue, 'chem:caffeine', 0.48)!)
    // Equal volumes of hexane and ethyl acetate.
    const mix = eluentStrength(catalogue, { 'chem:hexane': 655 / 86.18 / 2 / 1000, 'chem:ethyl-acetate': 902 / 88.11 / 2 / 1000 })!
    expect(mix).toBeCloseTo((0.01 + 0.48) / 2, 3)
  })
})

// The compound microscope practical: orientation, field of view, resolution with oil, phase
// contrast for living cells, and a clean microscope at the end. Each judgement follows from what
// the looks showed; mishandling has its consequences.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition, StepDef } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const scope = readJson(join(PACKAGES, 'pack-core', 'definitions', 'core-microscope-skills.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const goal = (r: Result, id: string) => r.rehearsal!.goals.find((g) => g.id === id)!.passed
const group = (def: ExperimentDefinition, id: string) => def.procedure!.steps!.find((s) => s.id === id)!

describe('conformance: compound microscope', () => {
  it('rehearses for several seeds with every goal met', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(scope, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.kernel!.world.incidents.length).toBe(0)
    }
  }, 120000)

  it('without the oil, 100× gives a hazy image and the platelets are never resolved', () => {
    const def = structuredClone(scope)
    const oil = group(def, 'oil')
    oil.steps = oil.steps!.filter((s) => s.id !== 'drop')
    const r = compile(def, catalogue, { seed: 1 })
    const at100 = r.kernel!.world.measurements.find((m) => m.settings.objective === '100x-oil')!
    expect(at100.flags.smear).toContain('no-oil')
    // The reference agent's answer follows the data: it no longer supports "resolution".
    expect(goal(r, 'g-oil')).toBe(false)
  }, 60000)

  it('coarse focusing at 40× drives the smear into the lens', () => {
    const def = structuredClone(scope)
    const smear = group(def, 'smear')
    smear.steps = smear.steps!.map((s: StepDef) => (s.id === 'sharpen-40x' ? { ...s, params: { ...s.params, knob: 'coarse' } } : s))
    const r = compile(def, catalogue, { seed: 1 })
    expect(goal(r, 'g-safe')).toBe(false)
    expect(r.kernel!.world.incidents[0].message).toMatch(/cracked/)
  }, 60000)

  it('left uncleaned, the 100× objective keeps its oil', () => {
    const def = structuredClone(scope)
    const oil = group(def, 'oil')
    oil.steps = oil.steps!.filter((s) => s.id !== 'clean-100x')
    const tidy = group(def, 'tidy')
    tidy.steps = tidy.steps!.filter((s) => s.id !== 'wipe')
    expect(goal(compile(def, catalogue, { seed: 1 }), 'g-clean')).toBe(false)
  }, 60000)
})

// An expression time course: whole-cell SDS-PAGE before and after IPTG, judged within lanes.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const course = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio17-induction-time-course.labx.json')) as ExperimentDefinition

describe('conformance: induction time course', () => {
  it('rehearses for several seeds: GFP appears after IPTG and matches the purified protein', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(course, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 300000)

  it('without IPTG nothing is induced, and the within-lane comparison shows it', () => {
    const def = structuredClone(course)
    def.procedure!.steps = def.procedure!.steps!.filter((s) => s.id !== 'induce')
    const r = compile(def, catalogue, { seed: 1 })
    expect(r.run!.decisions['worked']).toBe('no')
    expect(r.rehearsal!.expectedObservations[0].passed).toBe(false)
  }, 180000)
})

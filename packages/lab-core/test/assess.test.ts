import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { assess, toMnemoNexus } from '../src/assess/assess.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const bca = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio1-bca-protein-assay.labx.json')) as ExperimentDefinition

const run = (def: ExperimentDefinition, seed = 2) => {
  const r = compile(def, catalogue, { seed })
  return { r, result: assess(r.run!, { quality: r.rehearsal!.quality, context: 'practical-session' }) }
}

describe('assessment v1', () => {
  it('a good reference run is valid, meets its objectives and scores high', () => {
    const { result } = run(bca)
    expect(result.validity.verdict).toBe('valid')
    expect(result.objectives.every((o) => o.met)).toBe(true)
    expect(result.deviations).toEqual([])
    expect(result.score).toBeGreaterThan(0.95)
    expect(result.dimensions.find((d) => d.id === 'safety-practice')!.gate).toBe('passed')
    expect(result.misconceptions).toEqual([])
    const mnx = toMnemoNexus(result)
    expect(mnx.completed).toBe(true)
    expect((mnx.studyEvidence as { solvedStepIds: string[] }).solvedStepIds).toEqual(expect.arrayContaining(['standards', 'read', 'analyse', 'k-blank', 'k-waste', 'g-unknowns']))
  })

  it('as a recall drill, the same run grades 5', () => {
    const { r } = run(bca)
    expect(assess(r.run!, { quality: r.rehearsal!.quality, context: 'spaced-recall' }).quality).toBe(5)
  })

  it('wrong waste stream: a practice criterion fails and the objective is not met', () => {
    const wrong = structuredClone(bca)
    wrong.procedure!.steps!.find((s) => s.id === 'dispose')!.params!.stream = 'core:aqueous-waste'
    const { result } = run(wrong)
    expect(result.evidence.find((e) => e.id === 'k-waste')!.passed).toBe(false)
    expect(result.objectives.find((o) => o.id === 'o-safety')!.met).toBe(false)
    expect(result.validity.verdict).toBe('valid')
  })

  it('skipping the dilution and re-assay: wrong decision, extrapolation, missed objective', () => {
    const r = compile(bca, catalogue, { seed: 2, choices: { 'range-check': 'ok' } })
    const result = assess(r.run!, { quality: r.rehearsal!.quality, context: 'practical-session' })
    // The decision is judged against what the data show, not against what was chosen.
    expect(result.evidence.find((e) => e.id === 'range-check')!.passed).toBe(false)
    expect(result.evidence.find((e) => e.id === 'k-range')!.passed).toBe(false)
    expect(result.misconceptions).toContain('calibration-extrapolation')
    expect(result.validity.verdict).toBe('valid-with-limitations')
    expect(result.objectives.find((o) => o.id === 'o-range')!.met).toBe(false)
    expect(result.score).toBeLessThan(0.9)
  })

  it('without blanks the verdict is capped and the recall grade at most 3', () => {
    const noBlanks = structuredClone(bca)
    noBlanks.procedure!.steps!.find((s) => s.id === 'plate-map')!.params!.blanks = 0
    noBlanks.procedure!.steps!.find((s) => s.id === 'rework')!.steps!.find((s) => s.id === 'rmap')!.params!.blanks = 0
    const r = compile(noBlanks, catalogue, { seed: 2 })
    const result = assess(r.run!, { quality: r.rehearsal!.quality, context: 'spaced-recall' })
    expect(result.validity.verdict).toBe('partially-interpretable')
    expect(result.validity.reasons[0]).toMatch(/blank/i)
    expect(result.quality!).toBeLessThanOrEqual(3)
    expect(result.evidence.find((e) => e.id === 'k-blank')!.passed).toBe(false)
  })
})

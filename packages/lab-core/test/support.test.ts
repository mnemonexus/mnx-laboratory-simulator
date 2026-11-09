import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { resolveSupport } from '../src/support/support.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const bca = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio1-bca-protein-assay.labx.json')) as ExperimentDefinition
const step = (r: ReturnType<typeof resolveSupport>, id: string) => r.steps.find((s) => s.step === id)!

describe('adaptive support', () => {
  it('one definition, three contexts, three different profiles', () => {
    const intro = resolveSupport(bca, catalogue, 'lecture-introduction')
    const recall = resolveSupport(bca, catalogue, 'spaced-recall')
    const exam = resolveSupport(bca, catalogue, 'assessment')
    expect(intro.profile.hints.availability).toBe('proactive')
    expect(recall.profile.time).toBe('jump')
    expect(exam.profile.insight).toBe('off')
    expect(exam.profile.assessment).toBe('summative')
  })

  it('support follows competence per skill, not per learner', () => {
    // Strong at pipetting, never made a standard series: the dilution step gets a demonstration.
    const r = resolveSupport(bca, catalogue, 'practical-session', {
      bands: { 'core:micropipetting': 'proficient', 'core:dilution-planning': 'proficient', 'core:dilution-series': 'unseen', 'core:transfer-to-plate': 'proficient', 'core:dispense-reagent': 'proficient' },
    })
    expect(step(r, 'standards').guidance).toBe('demonstrate')
    expect(step(r, 'standards').band).toBe('unseen')
    expect(step(r, 'reagent').guidance).toBe('objective')
  })

  it('a beginner hears about waste mistakes at once; a competent student at review', () => {
    const novice = resolveSupport(bca, catalogue, 'practical-session', { bands: { 'core:chemical-waste': 'novice' } })
    const competent = resolveSupport(bca, catalogue, 'practical-session', { bands: { 'core:chemical-waste': 'competent' } })
    expect(step(novice, 'dispose').practiceFeedback).toBe('immediate')
    expect(step(competent, 'dispose').practiceFeedback).toBe('review')
  })

  it('a recall drill auto-performs everything but the drilled skill', () => {
    const drill: ExperimentDefinition = structuredClone(bca)
    drill.context!.objectives = [{ id: 'o-curve', kind: 'analysis', statement: 'Read unknowns from a standard curve', skills: ['core:calibration-analysis'] }]
    for (const s of drill.procedure!.steps!) delete s.objectives
    const r = resolveSupport(drill, catalogue, 'spaced-recall')
    expect(step(r, 'standards').collapsed).toBe(true)
    expect(step(r, 'load').collapsed).toBe(true)
    expect(step(r, 'analyse').collapsed).toBe(false)
  })

  it('assessment ignores competence for guidance and offers no hints', () => {
    const r = resolveSupport(bca, catalogue, 'assessment', { bands: {}, moreHelp: true })
    expect(r.steps.every((s) => s.guidance === 'objective')).toBe(true)
    expect(r.profile.hints.availability).toBe('none')
  })
})

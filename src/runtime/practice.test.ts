// Practice activities (practice-v1), headless: the catalogue MnemoNexus reads, a host-chosen launch
// through the practical runtime, and the report that comes back.
import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { validatePracticeCatalogue, validatePracticeResult, type PracticeActivity, type PracticeCatalogue, type PracticeLaunch } from '@mnemonexus/addon-sdk/practice'
import type { CriterionResult, LabResult } from '../../packages/lab-core/src/index.ts'
import { practicals } from './content'
import { launchTarget, toPracticeResult } from './practice'
import { PracticalRuntime } from './practical'
import { ScienceBackend } from './scienceBackend'
import { connectHost } from '../host/mnx'

const catalogue = JSON.parse(readFileSync('assets/practice/catalogue.json', 'utf8')) as PracticeCatalogue
const activity = (id: string) => catalogue.activities.find((a) => a.id === id)!
const launchOf = (a: PracticeActivity): PracticeLaunch => ({ version: 1, activityId: a.id, launch: a.launch ?? {}, reason: 'Matches "titration" in what you are studying', timeBudgetSeconds: a.minutes * 60 })

function memoryHost() {
  const store = new Map<string, string>()
  return { store, load: async (k: string) => store.get(k) ?? null, save: async (k: string, v: string) => void store.set(k, v) }
}

function evidence(over: Partial<CriterionResult> & { id: string }): CriterionResult {
  return { kind: 'criterion', statement: `Check ${over.id}`, passed: true, severity: 'major', dimension: 'technique-quality', skills: [], tags: [], ...over }
}

function labResult(over: Partial<LabResult> = {}): LabResult {
  return {
    result: 'lab-result',
    resultVersion: '0.1',
    run: { definition: { id: 'x', version: '1' }, context: 'practical-session', seed: 1, elapsedSeconds: 0, simulatedSeconds: 0 },
    status: 'submitted',
    validity: { verdict: 'valid', reasons: [] },
    channels: { resultAccuracy: 1, proceduralValidity: 1, calculationValidity: 1, scientificReliability: 1 },
    dimensions: [],
    score: 1,
    objectives: [],
    evidence: [],
    deviations: [],
    misconceptions: [],
    competence: [],
    support: { hintsUsed: 0, rewinds: 0, refusals: 0, demonstrations: 0, autoPerformed: [] },
    quality: null,
    disclosures: [],
    ...over,
  }
}

describe('the practice catalogue', () => {
  it('is up to date (run npm run content) and passes the contract', () => {
    expect(() => execFileSync(process.execPath, ['scripts/runtime/practice.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
    expect(() => validatePracticeCatalogue(catalogue)).not.toThrow()
  })

  it('lists every practical the launcher does, variants included', () => {
    expect(catalogue.activities.map((a) => a.id)).toEqual(practicals().map((p) => p.id))
    expect(Object.keys(catalogue.skills)).toHaveLength(85)
  })

  it('offers on recall only what fits five minutes, in the recall context', () => {
    const recall = catalogue.activities.filter((a) => a.surfaces.includes('recall'))
    expect(recall.length).toBeGreaterThan(0)
    for (const a of recall) {
      expect(a.minutes).toBeLessThanOrEqual(5)
      expect(a.launch!.contexts).toMatchObject({ recall: 'spaced-recall' })
      expect(practicals().find((p) => p.id === a.id)!.contexts).toContain('spaced-recall')
    }
  })

  it('keeps a template’s variants in one family, so they rotate', () => {
    const families = new Map<string, Set<string | undefined>>()
    for (const p of practicals()) families.set(p.base, (families.get(p.base) ?? new Set()).add(activity(p.id).family))
    for (const [base, family] of families) expect([base, family.size]).toEqual([base, 1])
    expect(new Set(catalogue.activities.map((a) => a.family)).size).toBeLessThan(catalogue.activities.length)
  })

  it('opens every activity on every surface it names', () => {
    const surface = { study: 'study', recall: 'recall', planner: 'calendar' } as const
    const failed: string[] = []
    for (const a of catalogue.activities) {
      for (const s of a.surfaces) {
        const rt = new PracticalRuntime()
        const opened = rt.launch(launchOf(a), surface[s])
        const state = rt.getSnapshot()
        if (!opened || state.phase !== 'running' || state.context !== (a.launch!.contexts as Record<string, string>)[s]) failed.push(`${a.id} on ${s}: ${state.error ?? state.phase}`)
        rt.close()
      }
    }
    expect(failed).toEqual([])
  }, 300000)
})

describe('a launch from the host', () => {
  const bca = activity('bio1-bca-protein-assay')

  it('finds the practical, its context for the surface, and a seed when one is given', () => {
    const entries = practicals()
    const study = launchTarget(launchOf(bca), 'study', entries)!
    expect(study.entry.id).toBe('bio1-bca-protein-assay')
    expect(study.context).toBe('lecture-introduction')
    expect(study.seed).toBeUndefined()
    expect(launchTarget({ ...launchOf(bca), launch: { ...bca.launch, seed: 42 } }, 'study', entries)!.seed).toBe(42)
    // A longer practical run from Recall has no recall context: it runs as it would when planned.
    const longer = catalogue.activities.find((a) => a.surfaces.includes('planner') && !a.surfaces.includes('recall'))!
    expect(launchTarget(launchOf(longer), 'recall', entries)!.context).toBe((longer.launch!.contexts as Record<string, string>).planner)
    expect(launchTarget({ ...launchOf(bca), launch: { definition: 'no-such-practical' } }, 'study', entries)).toBeNull()
  })

  it('says so rather than opening something else when the practical is missing', () => {
    const rt = new PracticalRuntime()
    expect(rt.launch({ ...launchOf(bca), launch: { definition: 'no-such-practical' } }, 'study')).toBe(false)
    expect(rt.getSnapshot().phase).toBe('idle')
    expect(rt.getSnapshot().error).toBeTruthy()
  })

  it('tells the learner why, repeats a seeded run, and leaves their saved run alone', async () => {
    const host = memoryHost()
    host.store.set('practical', 'their own run')
    const seeded = { ...launchOf(bca), launch: { ...bca.launch, seed: 7 } }
    const a = new PracticalRuntime(host)
    expect(a.launch(seeded, 'study')).toBe(true)
    expect(a.getSnapshot().notice).toBe(seeded.reason)
    a.demonstrate()
    const b = new PracticalRuntime()
    b.launch(seeded, 'study')
    b.demonstrate()
    expect(b.getSnapshot().view!.measurements).toEqual(a.getSnapshot().view!.measurements)
    a.finish()
    await Promise.resolve()
    expect(host.store.get('practical')).toBe('their own run')
  })

  it('reports a finished run, and what the host needs to record it', () => {
    const rt = new PracticalRuntime(memoryHost())
    rt.launch(launchOf(activity('drill-balance-rotor')), 'recall')
    rt.finish()
    const outcome = rt.outcome()
    expect(outcome.completed).toBe(true)
    expect(outcome.quality).toEqual(expect.any(Number))
    const practice = validatePracticeResult(outcome.practice)
    expect(practice.activityId).toBe('drill-balance-rotor')
    expect(practice.valid).toBe(true)
    expect(practice.criteria.length).toBeGreaterThan(0)
  })

  it('reports a run ended early, with what happened and valid false', () => {
    const rt = new PracticalRuntime(memoryHost())
    rt.launch(launchOf(activity('drill-balance-rotor')), 'recall')
    rt.demonstrate()
    const outcome = rt.outcome()
    expect(outcome.completed).toBe(false)
    expect(outcome.quality).toBe(0)
    const practice = validatePracticeResult(outcome.practice)
    expect(practice.valid).toBe(false)
    expect(practice.criteria.length).toBeGreaterThan(0)
    expect(practice.hintsUsed).toBe(1)
    expect(practice.note).toMatch(/left before/)
  })

  it('earns nothing for finishing at once, even where every check would pass untouched', () => {
    const rt = new PracticalRuntime(memoryHost())
    rt.launch(launchOf(activity('drill-balance-rotor')), 'recall')
    rt.finish()
    const practice = validatePracticeResult(rt.outcome().practice)
    expect(practice.valid).toBe(true)
    expect(practice.criteria.filter((c) => c.met)).toEqual([])
  })

  it('never reads a demonstrated run as the learner’s own', () => {
    const rt = new PracticalRuntime(memoryHost())
    rt.launch(launchOf(activity('micro1-gram-stain')), 'study')
    for (let i = 0; i < 10 && rt.getSnapshot().view!.current; i++) rt.demonstrate()
    rt.finish()
    const practice = validatePracticeResult(rt.outcome().practice)
    expect(practice.valid).toBe(true)
    expect(practice.hintsUsed).toBeGreaterThan(0)
    expect(practice.skills).toEqual([])
    expect(practice.note).toMatch(/reference performed/)
  })

  it('marks the run invalid when the simulation fails on the way', () => {
    const rt = new PracticalRuntime(memoryHost())
    rt.launch(launchOf(bca), 'study')
    const perform = vi.spyOn(ScienceBackend.prototype, 'perform').mockImplementationOnce(() => {
      throw new Error('The kernel broke')
    })
    expect(rt.perform('core:transfer', {})).toBe(false)
    perform.mockRestore()
    rt.finish()
    const practice = validatePracticeResult(rt.outcome().practice)
    expect(practice.valid).toBe(false)
    expect(practice.note).toMatch(/problem/)
  })

  it('still reports a run it could not assess', () => {
    const rt = new PracticalRuntime()
    const finish = vi.spyOn(ScienceBackend.prototype, 'finish').mockImplementation(() => {
      throw new Error('The assessment broke')
    })
    rt.launch(launchOf(bca), 'study')
    const practice = validatePracticeResult(rt.outcome().practice)
    finish.mockRestore()
    expect(practice).toMatchObject({ valid: false, criteria: [], activityId: bca.id })
  })

  it('every practical reports within the contract, even when nothing was done', () => {
    const problems: string[] = []
    for (const a of catalogue.activities) {
      const rt = new PracticalRuntime()
      rt.launch(launchOf(a), a.surfaces.includes('recall') ? 'recall' : 'study')
      try {
        validatePracticeResult(rt.outcome().practice)
      } catch (e) {
        problems.push(`${a.id}: ${(e as Error).message}`)
      }
      rt.close()
    }
    expect(problems).toEqual([])
  }, 300000)
})

describe('toPracticeResult', () => {
  it('maps evidence to criteria by severity, with a readable label and the first skill', () => {
    const r = toPracticeResult('a', labResult({
      evidence: [
        evidence({ id: 'major-one', statement: 'The standards were in range', skills: ['core:dilution-series', 'core:micropipetting'] }),
        evidence({ id: 'minor-one', passed: false, severity: 'minor' }),
        evidence({ id: 'fit', kind: 'checkpoint', statement: 'Step "fit" done', severity: 'minor' }),
      ],
      misconceptions: ['calibration-extrapolation'],
      competence: [{ skill: 'core:dilution-series', evidence: 0.8, weight: 0.6 }],
      support: { hintsUsed: 2, rewinds: 1, refusals: 3, demonstrations: 0, autoPerformed: [] },
    }), { steps: [{ id: 'fit', title: 'Fit the standard curve', kind: 'operation', status: 'done' }] })
    expect(r.criteria).toEqual([
      { id: 'major-one', label: 'The standards were in range', met: true, weight: 2, skill: 'core:dilution-series' },
      { id: 'minor-one', label: 'Check minor-one', met: false, weight: 1 },
      { id: 'fit', label: 'Did "Fit the standard curve"', met: true, weight: 1 },
    ])
    expect(r.skills).toEqual([{ id: 'core:dilution-series', evidence: 0.8 }])
    expect(r.misconceptions).toEqual(['calibration-extrapolation'])
    expect(r).toMatchObject({ hintsUsed: 2, attempts: 2, valid: true })
    expect(r.note).toBeUndefined()
    expect(() => validatePracticeResult(r)).not.toThrow()
  })

  it('takes valid from the verdict, and says why', () => {
    const verdict = (v: LabResult['validity']['verdict'], reasons: string[] = []) => toPracticeResult('a', labResult({ validity: { verdict: v, reasons } }))
    expect(verdict('valid').valid).toBe(true)
    expect(verdict('valid-with-limitations', ['Two wells were dropped']).valid).toBe(true)
    expect(verdict('valid-with-limitations', ['Two wells were dropped']).note).toBe('Two wells were dropped')
    expect(verdict('inconclusive', ['The controls disagree']).valid).toBe(true)
    expect(verdict('invalid', ['No blank was read']).valid).toBe(false)
    expect(verdict('invalid', ['No blank was read']).note).toBe('No blank was read')
    expect(toPracticeResult('a', labResult({ status: 'abandoned' })).valid).toBe(false)
  })

  it('makes ids and labels fit the contract, and keeps ids unique', () => {
    const r = toPracticeResult('a', labResult({
      evidence: [evidence({ id: 'standards/row[2]#1:fresh tip', statement: 'x'.repeat(500) }), evidence({ id: 'standards/row[2]#1:fresh-tip' })],
    }))
    expect(new Set(r.criteria.map((c) => c.id)).size).toBe(2)
    expect(() => validatePracticeResult(r)).not.toThrow()
  })

  it('stays within the limits without flattering the run', () => {
    const r = toPracticeResult('a', labResult({
      evidence: Array.from({ length: 200 }, (_, i) => evidence({ id: `e${i}`, passed: i >= 150 })),
      deviations: Array.from({ length: 80 }, (_, i) => ({ step: `s${i}`, kind: 'missing' as const, weight: 2, message: `Step "s${i}" was not done` })),
      competence: Array.from({ length: 30 }, (_, i) => ({ skill: `s${i}`, evidence: 0.5, weight: 1 })),
      misconceptions: Array.from({ length: 40 }, (_, i) => `m${i}`),
    }))
    expect(() => validatePracticeResult(r)).not.toThrow()
    expect(r.criteria.every((c) => !c.met)).toBe(true)
    expect(r.criteria.at(-1)).toEqual({ id: 'steps-done', label: '80 steps were not done', met: false, weight: 100 })
  })

  it('does not count a check that passed only because its step never ran', () => {
    const r = toPracticeResult('a', labResult({
      evidence: [
        evidence({ id: 'g-safe', kind: 'goal', statement: 'The rotor is balanced when the run starts', objective: 'o1' }),
        evidence({ id: 'g-yield', kind: 'goal', objective: 'o2' }),
      ],
      objectives: [{ id: 'o1', met: false, score: 0 }, { id: 'o2', met: false, score: 0.5 }],
      deviations: [{ step: 'spin', kind: 'missing', weight: 2, message: 'Step "Spin" was not done' }],
    }))
    expect(r.criteria.map((c) => [c.id, c.met])).toEqual([['g-safe', false], ['g-yield', true], ['steps-done', false]])
    expect(r.criteria[2]).toMatchObject({ label: 'Step "Spin" was not done', weight: 2 })
  })

  it('does not credit technique on a step the reference performed', () => {
    const r = toPracticeResult('a', labResult({
      evidence: [
        evidence({ id: 'standards[1]:mixed', kind: 'technique-quality', path: 'standards[1]/mix' }),
        evidence({ id: 'read:blanked', kind: 'technique-quality', path: 'read' }),
        evidence({ id: 'g-unknowns', kind: 'goal' }),
      ],
      support: { hintsUsed: 0, rewinds: 0, refusals: 0, demonstrations: 1, autoPerformed: ['standards'] },
    }))
    expect(r.criteria.map((c) => c.id)).toEqual(['read:blanked', 'g-unknowns'])
    expect(r.hintsUsed).toBe(1)
  })

  it('lets a critical safety failure hold the run down, as the lab’s own score does', () => {
    const r = toPracticeResult('a', labResult({
      evidence: [
        ...Array.from({ length: 20 }, (_, i) => evidence({ id: `ok${i}` })),
        evidence({ id: 'incident-3', passed: false, severity: 'critical', dimension: 'safety-practice', statement: 'The rotor was out of balance' }),
      ],
    }))
    const total = r.criteria.reduce((sum, c) => sum + (c.weight ?? 1), 0)
    const met = r.criteria.filter((c) => c.met).reduce((sum, c) => sum + (c.weight ?? 1), 0)
    expect(met / total).toBeLessThanOrEqual(0.4)
    expect(() => validatePracticeResult(r)).not.toThrow()
  })
})

describe('the host bridge', () => {
  it('hands over the launch and sends the report with mnx.complete', () => {
    const complete = vi.fn()
    const scope = globalThis as { mnx?: unknown }
    const practice = launchOf(activity('drill-balance-rotor'))
    scope.mnx = {
      protocolVersion: 1,
      root: {},
      props: { kind: 'experience', extensionId: 'biochemistry-lab', surface: 'recall', items: [], permissions: [], practice },
      complete,
      exit: vi.fn(),
      onUpdate: vi.fn(),
    }
    try {
      const host = connectHost()
      expect(host.practice).toBe(practice)
      expect(host.surface).toBe('recall')
      const report = toPracticeResult(practice.activityId, labResult())
      host.finish({ completed: false, quality: 0, practice: report })
      expect(complete).toHaveBeenCalledWith({ completed: false, elapsedSeconds: expect.any(Number), quality: 0, practice: report })
    } finally {
      delete scope.mnx
    }
  })
})

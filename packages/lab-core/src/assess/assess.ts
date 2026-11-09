// Assessment v1 (assessment and competency §2–§8; master-plan/09; lab result spec §1, §4).
// A pure function of the run: the event log, the final world, recorded data and the evidence
// gathered while techniques ran. No AI, no UI.
import { childEnv, evaluate, idOf, truthy, type Value } from '../expr/evaluate.ts'
import { correctOption } from '../run/agent.ts'
import type { LearningContext, StepDef, ValidityVerdict } from '../format/types.ts'
import { VALIDITY_VERDICTS } from '../format/types.ts'
import { type RunContext, runEnv } from '../run/env.ts'
import type { QualityResult } from '../run/agent.ts'
import { allSteps } from '../format/validate.ts'

export const RESULT_VERSION = '0.1'

export type RunStatus = 'submitted' | 'abandoned' | 'terminated' | 'timed-out'

export interface StepProgress {
  id: string
  done: boolean
  /** First and last event index of the step (when done). */
  first?: number
  last?: number
}

export interface Deviation {
  step: string
  kind: 'missing' | 'order'
  /** Strict dependencies and steps serving objectives weigh more than advisory ones. */
  weight: number
  message: string
}

export interface MonitorReport {
  steps: StepProgress[]
  deviations: Deviation[]
  /** 1 − weighted deviations, in [0, 1]. */
  fidelity: number
}

/**
 * The procedure monitor, prescribed modes (execution runtime §4; v1): a step is done when any
 * event was performed under it; strict dependencies must be respected in order. Plan recognition
 * for objective mode comes later.
 */
export function monitor(run: RunContext): MonitorReport {
  const steps = run.def.procedure?.steps ?? []
  const events = run.kernel.events
  const byStep = new Map<string, number[]>()
  for (const e of events) {
    const top = (e.path ?? '').split('/')[0].replace(/\[\d+\]$/, '').replace(/#\d+$/, '')
    if (!top) continue
    const list = byStep.get(top) ?? []
    list.push(e.index)
    byStep.set(top, list)
  }
  const env = runEnv(run)
  const progress: StepProgress[] = steps.map((s) => {
    const idx = byStep.get(s.id)
    const done = !!idx?.length || s.id in run.outputs || s.id in run.decisions
    return { id: s.id, done, ...(idx?.length ? { first: Math.min(...idx), last: Math.max(...idx) } : {}) }
  })
  const deviations: Deviation[] = []
  const fidelity = run.def.procedure?.fidelity ?? 'prescribed-tolerant'
  const weightOf = (s: StepDef) => ((s.objectives ?? []).length > 0 || (s.critical ?? []).length > 0 ? 2 : 1)
  for (const s of steps) {
    const p = progress.find((x) => x.id === s.id)!
    if (!p.done) {
      // A step skipped by its own condition is not missing.
      let applicable = true
      if (s.when) {
        try {
          applicable = truthy(evaluate(s.when, env))
        } catch {
          applicable = true
        }
      }
      if (applicable && s.kind !== 'checkpoint') deviations.push({ step: s.id, kind: 'missing', weight: weightOf(s), message: `Step "${s.title ?? s.id}" was not done` })
      continue
    }
    for (const dep of s.after ?? []) {
      const d = progress.find((x) => x.id === dep)
      if (!d?.done || d.last === undefined || p.first === undefined) continue
      const strict = (s.order ?? 'strict') === 'strict'
      if (p.first < d.last) {
        const w = strict ? weightOf(s) : fidelity === 'prescribed' ? 0.25 : 0
        if (w > 0) deviations.push({ step: s.id, kind: 'order', weight: w, message: `"${s.title ?? s.id}" started before "${dep}" finished` })
      }
    }
  }
  const total = steps.reduce((a, s) => a + weightOf(s), 0) || 1
  const lost = deviations.reduce((a, d) => a + d.weight, 0)
  return { steps: progress, deviations, fidelity: Math.max(0, 1 - lost / total) }
}

export interface CriterionResult {
  id: string
  kind: 'criterion' | 'technique-quality' | 'goal' | 'checkpoint' | 'decision'
  statement: string
  passed: boolean
  severity: 'critical' | 'major' | 'minor'
  dimension: DimensionId
  skills: string[]
  tags: string[]
  objective?: string
  path?: string
}

export type DimensionId = 'procedural-fidelity' | 'technique-quality' | 'outcome' | 'analysis' | 'interpretation' | 'safety-practice'

export interface LabResult {
  result: 'lab-result'
  resultVersion: string
  run: {
    definition: { id: string; version: string }
    context: LearningContext
    seed: number
    elapsedSeconds: number
    simulatedSeconds: number
  }
  status: RunStatus
  validity: { verdict: ValidityVerdict; reasons: string[] }
  channels: { resultAccuracy: number; proceduralValidity: number; calculationValidity: number; scientificReliability: number }
  dimensions: Array<{ id: DimensionId; score: number | null; weight: number; gate?: 'passed' | 'failed'; criteria: string[] }>
  score: number
  objectives: Array<{ id: string; met: boolean; score: number; goal?: string }>
  evidence: CriterionResult[]
  deviations: Deviation[]
  misconceptions: string[]
  competence: Array<{ skill: string; evidence: number; weight: number }>
  support: {
    hintsUsed: number
    rewinds: number
    refusals: number
    /** How often the learner had the reference do a step for them. */
    demonstrations: number
    /** The steps the reference performed: demonstrated, or collapsed by the support profile. */
    autoPerformed: string[]
  }
  quality: number | null
  disclosures: string[]
}

export interface AssessOptions {
  context?: LearningContext
  status?: RunStatus
  elapsedSeconds?: number
  /** Technique quality results gathered while the run executed (reference agent or runtime). */
  quality?: QualityResult[]
  hintsUsed?: number
  rewinds?: number
  demonstrations?: number
  autoPerformed?: string[]
  disclosures?: string[]
}

export const SEVERITY_WEIGHT = { critical: 3, major: 2, minor: 1 } as const

/** Evidence weight of a context: low-support contexts count more (assessment §6.2). */
const CONTEXT_WEIGHT: Record<LearningContext, number> = {
  'lecture-introduction': 0.4,
  'spaced-recall': 0.8,
  transferal: 0.8,
  'practical-session': 0.8,
  assessment: 1,
  'open-exploration': 0.3,
}

function dimensionFor(kind: string | undefined, fallback: DimensionId): DimensionId {
  switch (kind) {
    case 'procedural':
      return 'procedural-fidelity'
    case 'measurement':
    case 'calculation':
      return 'analysis'
    case 'design':
    case 'interpretive':
      return 'interpretation'
    case 'practice':
    case 'safety':
      return 'safety-practice'
    default:
      return fallback
  }
}

export function assess(run: RunContext, options: AssessOptions = {}): LabResult {
  const def = run.def
  const context = options.context ?? def.context?.intendedContexts?.[0] ?? 'practical-session'
  const status = options.status ?? 'submitted'
  const env = runEnv(run)
  const check = (expr: string): boolean => {
    try {
      return truthy(evaluate(expr, env))
    } catch {
      return false
    }
  }

  // Validity: the worst cap among applicable rules.
  let worst = 0
  const reasons: string[] = []
  for (const rule of def.assessment?.validity ?? []) {
    if (check(rule.when)) {
      worst = Math.max(worst, VALIDITY_VERDICTS.indexOf(rule.cap))
      reasons.push(rule.reason)
    }
  }
  const verdict = VALIDITY_VERDICTS[worst]

  const evidence: CriterionResult[] = []
  const objectives = def.context?.objectives ?? []
  const objectiveOfSkill = (skills: string[]) => objectives.find((o) => (o.skills ?? []).some((s) => skills.includes(s)))?.id
  for (const c of def.assessment?.criteria ?? []) {
    evidence.push({
      id: c.id,
      kind: 'criterion',
      statement: c.statement,
      passed: check(c.check),
      severity: c.severity ?? 'major',
      dimension: dimensionFor(c.feedback?.kind, 'technique-quality'),
      skills: [],
      tags: c.tags ?? [],
      ...(c.objective ? { objective: c.objective } : {}),
    })
  }
  for (const q of options.quality ?? []) {
    const tech = run.cat.technique(q.technique)
    const crit = tech?.quality?.find((x) => x.id === q.criterion)
    evidence.push({
      id: `${q.path}:${q.criterion}`,
      kind: 'technique-quality',
      statement: q.statement,
      passed: q.passed,
      severity: crit?.severity ?? 'major',
      dimension: dimensionFor(crit?.feedbackKind, 'technique-quality'),
      skills: q.skills,
      tags: crit && !q.passed ? tagsFor(tech?.errors ?? [], crit.id) : [],
      ...(objectiveOfSkill(q.skills) ? { objective: objectiveOfSkill(q.skills) } : {}),
      path: q.path,
    })
  }
  const goals = (def.goals?.predicates ?? []).map((g) => ({ id: g.id, passed: check(g.check), statement: g.statement ?? g.check }))
  for (const g of goals) {
    const objective = objectives.find((o) => o.goal === g.id)?.id
    evidence.push({ id: g.id, kind: 'goal', statement: g.statement, passed: g.passed, severity: 'major', dimension: 'outcome', skills: [], tags: [], ...(objective ? { objective } : {}) })
  }
  // Decisions: was the chosen option the correct one? (Judged on the data, per item if repeated.)
  for (const { step } of allSteps(def)) {
    if (step.kind !== 'decision' || !step.correctWhen) continue
    let items: Value[] = [null]
    if (step.forEach) {
      try {
        const v = evaluate(step.forEach.in, env)
        items = Array.isArray(v) ? v : []
      } catch {
        items = []
      }
    }
    for (const item of items) {
      const key = step.forEach ? `${step.id}:${idOf(item)}` : step.id
      const chosen = run.decisions[key]
      if (chosen === undefined) continue
      let correct: string | undefined
      try {
        correct = correctOption(step, step.forEach ? childEnv(env, { [step.forEach.var]: item }) : env)
      } catch {
        correct = undefined
      }
      evidence.push({
        id: key,
        kind: 'decision',
        statement: step.prompt ?? step.id,
        passed: correct === undefined || chosen === correct,
        severity: 'major',
        dimension: 'interpretation',
        skills: [],
        tags: [],
        ...(step.objectives?.[0] ? { objective: step.objectives[0] } : {}),
      })
    }
  }
  for (const inc of run.kernel.world.incidents) {
    const critical = inc.severity === 'instrument' || inc.severity === 'personal'
    evidence.push({
      id: `incident-${inc.event}`,
      kind: 'criterion',
      statement: inc.message,
      passed: false,
      severity: critical ? 'critical' : 'major',
      dimension: 'safety-practice',
      skills: inc.kind === 'mechanical' ? ['core:centrifuge-balancing'] : [],
      tags: inc.kind === 'mechanical' ? ['rotor-imbalance'] : [],
    })
  }
  const mon = monitor(run)
  for (const cp of def.assessment?.evidence?.checkpoints ?? []) {
    const p = mon.steps.find((s) => s.id === cp)
    evidence.push({ id: cp, kind: 'checkpoint', statement: `Step "${cp}" done`, passed: !!p?.done, severity: 'minor', dimension: 'procedural-fidelity', skills: [], tags: [] })
  }

  // Dimensions.
  const score = (dim: DimensionId): number | null => {
    const items = evidence.filter((e) => e.dimension === dim && e.kind !== 'checkpoint')
    if (items.length === 0) return null
    const total = items.reduce((a, e) => a + SEVERITY_WEIGHT[e.severity], 0)
    return items.filter((e) => e.passed).reduce((a, e) => a + SEVERITY_WEIGHT[e.severity], 0) / total
  }
  const emphasis = def.assessment?.emphasis ?? {}
  const weight = (keys: string[], fallback: number) => {
    for (const k of keys) if (typeof emphasis[k] === 'number') return emphasis[k] as number
    return fallback
  }
  const safetyFailed = evidence.some((e) => e.dimension === 'safety-practice' && !e.passed && e.severity === 'critical')
  const dims: LabResult['dimensions'] = [
    { id: 'procedural-fidelity', score: mon.fidelity, weight: weight(['procedure'], 0.2), criteria: evidence.filter((e) => e.dimension === 'procedural-fidelity').map((e) => e.id) },
    { id: 'technique-quality', score: score('technique-quality'), weight: weight(['technique'], 0.2), criteria: evidence.filter((e) => e.dimension === 'technique-quality').map((e) => e.id) },
    { id: 'outcome', score: score('outcome'), weight: weight(['outcome'], 0.25), criteria: evidence.filter((e) => e.dimension === 'outcome').map((e) => e.id) },
    { id: 'analysis', score: score('analysis'), weight: weight(['analysis'], 0.2), criteria: evidence.filter((e) => e.dimension === 'analysis').map((e) => e.id) },
    { id: 'interpretation', score: score('interpretation'), weight: weight(['interpretation'], 0.15), criteria: evidence.filter((e) => e.dimension === 'interpretation').map((e) => e.id) },
    {
      id: 'safety-practice',
      score: score('safety-practice'),
      weight: emphasis.safety === 'gate' ? 0 : weight(['safety'], 0.1),
      ...(emphasis.safety === 'gate' ? { gate: safetyFailed ? ('failed' as const) : ('passed' as const) } : {}),
      criteria: evidence.filter((e) => e.dimension === 'safety-practice').map((e) => e.id),
    },
  ]
  const scored = dims.filter((d) => d.score !== null && d.weight > 0)
  const wsum = scored.reduce((a, d) => a + d.weight, 0)
  let overall = wsum > 0 ? scored.reduce((a, d) => a + d.weight * (d.score as number), 0) / wsum : 0
  if (safetyFailed) overall = Math.min(overall, 0.4)

  // Objectives.
  // An objective is met when its evidence passes and the steps that serve it were done: a
  // criterion that passes because its step never ran proves nothing.
  const objectiveResults = objectives.map((o) => {
    const items = evidence.filter((e) => e.objective === o.id || (o.goal && e.id === o.goal))
    const serving = (def.procedure?.steps ?? []).filter((st) => (st.objectives ?? []).includes(o.id)).map((st) => mon.steps.find((p) => p.id === st.id)?.done === true)
    const doneShare = serving.length ? serving.filter(Boolean).length / serving.length : mon.steps.length ? mon.steps.filter((p) => p.done).length / mon.steps.length : 0
    const evidenceShare = items.length ? items.filter((e) => e.passed).length / items.length : doneShare
    const s = Math.min(evidenceShare, doneShare)
    return { id: o.id, met: s === 1, score: Number(s.toFixed(3)), ...(o.goal ? { goal: o.goal } : {}) }
  })

  // Competence evidence per skill.
  const w = CONTEXT_WEIGHT[context] * (1 / (1 + (options.hintsUsed ?? 0) * 0.25))
  const skillEvidence = new Map<string, number[]>()
  for (const e of evidence) for (const s of e.skills) skillEvidence.set(s, [...(skillEvidence.get(s) ?? []), e.passed ? 1 : 0])
  for (const o of objectiveResults) {
    const def0 = objectives.find((x) => x.id === o.id)
    for (const s of def0?.skills ?? []) skillEvidence.set(s, [...(skillEvidence.get(s) ?? []), o.score])
  }
  const competence = [...skillEvidence.entries()].map(([skill, xs]) => ({ skill, evidence: Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)), weight: Number(w.toFixed(3)) }))

  const misconceptions = [...new Set(evidence.filter((e) => !e.passed).flatMap((e) => e.tags))]
  const reliability: Record<ValidityVerdict, number> = { valid: 1, 'valid-with-limitations': 0.8, 'partially-interpretable': 0.5, inconclusive: 0.4, invalid: 0 }
  const calc = evidence.filter((e) => e.dimension === 'analysis')
  const result: LabResult = {
    result: 'lab-result',
    resultVersion: RESULT_VERSION,
    run: {
      definition: { id: def.id, version: def.version },
      context,
      seed: run.kernel.world.seed,
      elapsedSeconds: options.elapsedSeconds ?? 0,
      simulatedSeconds: run.kernel.world.timeS,
    },
    status,
    validity: { verdict, reasons },
    channels: {
      resultAccuracy: goals.length ? goals.filter((g) => g.passed).length / goals.length : 1,
      proceduralValidity: mon.fidelity,
      calculationValidity: calc.length ? calc.filter((e) => e.passed).length / calc.length : 1,
      scientificReliability: reliability[verdict],
    },
    dimensions: dims,
    score: Number(overall.toFixed(3)),
    objectives: objectiveResults,
    evidence,
    deviations: mon.deviations,
    misconceptions,
    competence,
    support: { hintsUsed: options.hintsUsed ?? 0, rewinds: options.rewinds ?? 0, refusals: run.kernel.attempts.length, demonstrations: options.demonstrations ?? 0, autoPerformed: options.autoPerformed ?? [] },
    quality: null,
    disclosures: options.disclosures ?? [],
  }
  result.quality = context === 'spaced-recall' ? recallQuality(result, safetyFailed) : null
  return result
}

function tagsFor(errors: Array<{ id: string; tag?: string }>, criterion: string): string[] {
  // Criteria name the mistakes they detect by the technique's error ids where they match.
  const match: Record<string, string[]> = { 'fresh-tip-stock': ['reused-tip'], 'fresh-tip-each': ['reused-tip'], 'fresh-tip-each-item': ['reused-tip'], mixed: ['unmixed'], 'mixed-each': ['unmixed'], 'end-colour': ['overshoot'] }
  const ids = match[criterion] ?? []
  return errors.filter((e) => ids.includes(e.id) && e.tag).map((e) => e.tag!)
}

/**
 * The 0–5 recall grade (master-plan/09 §10): 5 correct, valid, no hints; 4 correct with a minor
 * slip; 3 correct after one correction or one non-critical slip; 2 partly correct or hinted;
 * 1 incorrect but relevant; 0 abandoned or safety-critical. Validity caps: invalid ≤ 2,
 * partially interpretable ≤ 3. A correctly judged "inconclusive" can still earn 5.
 */
export function recallQuality(r: LabResult, safetyFailed: boolean): number {
  if (r.status !== 'submitted' || safetyFailed) return 0
  const goals = r.evidence.filter((e) => e.kind === 'goal')
  const goalFrac = goals.length ? goals.filter((g) => g.passed).length / goals.length : 1
  const majorFails = r.evidence.filter((e) => !e.passed && e.kind !== 'goal' && e.kind !== 'checkpoint' && e.severity !== 'minor').length
  const minorFails = r.evidence.filter((e) => !e.passed && e.severity === 'minor').length
  let q: number
  if (goalFrac === 1) {
    q = 5
    if (minorFails > 0 || r.support.refusals > 0) q = 4
    if (majorFails === 1 || r.support.refusals > 2) q = 3
    if (majorFails > 1 || r.support.hintsUsed > 0) q = Math.min(q, 2 + (r.support.hintsUsed === 0 ? 1 : 0))
  } else if (goalFrac >= 0.5) q = 2
  else q = 1
  if (r.support.hintsUsed > 0) q = Math.min(q, 2)
  if (r.validity.verdict === 'invalid') q = Math.min(q, 2)
  if (r.validity.verdict === 'partially-interpretable') q = Math.min(q, 3)
  return q
}

/** MnemoNexus ExperienceResult (protocol 1) from a lab result (lab result spec §4). */
export function toMnemoNexus(r: LabResult): Record<string, unknown> {
  const solved = r.evidence.filter((e) => e.passed && (e.kind === 'checkpoint' || e.kind === 'criterion' || e.kind === 'goal')).map((e) => e.id)
  return {
    completed: r.status === 'submitted',
    elapsedSeconds: Math.max(0, Math.round(r.run.elapsedSeconds)),
    ...(r.quality !== null ? { quality: r.quality } : {}),
    studyEvidence: { solvedStepIds: solved, attempts: 1, hintsUsed: r.support.hintsUsed },
  }
}

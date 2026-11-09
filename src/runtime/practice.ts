// Practice activities (practice-v1): how a launch from MnemoNexus becomes a run, and how the run
// becomes the report the host keeps. The add-on says what happened and never a grade: the host
// derives any grade from the criteria. The catalogue is scripts/runtime/practice.mjs. Nothing here
// names a particular experiment.
import type { LaunchSurface } from '@mnemonexus/addon-sdk'
import type { PracticeCriterion, PracticeLaunch, PracticeResult, PracticeSurface } from '@mnemonexus/addon-sdk/practice'
import { type CriterionResult, type LabResult, type LearningContext, SEVERITY_WEIGHT, type StepView } from '../../packages/lab-core/src/index.ts'
import type { PracticalEntry } from './content'

/** The contract's limits (PRACTICE_LIMITS). */
const MAX_CRITERIA = 64
const MAX_SKILLS = 16
const MAX_MISCONCEPTIONS = 32
const MAX_LABEL = 200
const MAX_NOTE = 600
const MAX_ID = 128
const MAX_WEIGHT = 100

/** A catalogue activity's opaque `launch`, as scripts/runtime/practice.mjs writes it. */
export interface LabLaunch {
  /** The practical, by the id the launcher lists it under. */
  definition: string
  /** The learning context for each surface it is offered on. */
  contexts: Partial<Record<PracticeSurface, LearningContext>>
  /** Repeats the same run. Without it each run draws its own, so a repeat is not a remembered answer. */
  seed?: number
}

export interface RunOutcome {
  completed?: boolean
  quality?: number
  practice?: PracticeResult
}

const SURFACE_OF: Partial<Record<LaunchSurface, PracticeSurface>> = { study: 'study', recall: 'recall', calendar: 'planner' }

/** Which practical to open, in which context, with which seed; null if this add-on does not have it. */
export function launchTarget(practice: PracticeLaunch, surface: LaunchSurface, entries: readonly PracticalEntry[]): { entry: PracticalEntry; context: LearningContext; seed?: number } | null {
  const { definition, contexts, seed } = practice.launch as Partial<LabLaunch>
  const entry = entries.find((e) => e.id === definition)
  if (!entry) return null
  // The host can run an activity somewhere its catalogue entry did not name (a longer practical from Recall).
  const named = SURFACE_OF[surface]
  const wanted = (named && contexts?.[named]) ?? contexts?.planner ?? contexts?.study ?? contexts?.recall
  return { entry, context: wanted && entry.contexts.includes(wanted) ? wanted : entry.contexts[0], ...(typeof seed === 'number' && Number.isFinite(seed) ? { seed } : {}) }
}

/** The step an evidence path belongs to (steps/forEach items carry [n] or #n), as the procedure monitor reads it. */
const topStep = (path: string) => path.split('/')[0].replace(/\[\d+\]$/, '').replace(/#\d+$/, '')

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`)

function criterionId(id: string, used: Set<string>): string {
  const base = id.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, MAX_ID - 4) || 'check'
  let unique = base
  for (let n = 2; used.has(unique); n++) unique = `${base}-${n}`
  used.add(unique)
  return unique
}

/** "Step "fit" done" names a step by its id; the learner saw its title. */
function labelOf(e: CriterionResult, steps: readonly StepView[]): string {
  const step = e.kind === 'checkpoint' ? steps.find((s) => s.id === e.id) : undefined
  return clip((step ? `Did "${step.title}"` : e.statement).trim() || e.id, MAX_LABEL)
}

/**
 * The lab's own score holds a run with a critical safety failure at 40% or below (assess.ts), so the
 * criteria must not outvote it: these failures share a weight of 1.5 times everything else.
 */
function weightsOf(items: readonly CriterionResult[]): number[] {
  const gated = (e: CriterionResult) => !e.passed && e.severity === 'critical' && e.dimension === 'safety-practice'
  const gates = items.filter(gated).length
  const rest = items.reduce((sum, e) => sum + (gated(e) ? 0 : SEVERITY_WEIGHT[e.severity]), 0)
  return items.map((e) => (gated(e) ? Math.min(MAX_WEIGHT, Math.max(SEVERITY_WEIGHT.critical, (1.5 * rest) / gates)) : SEVERITY_WEIGHT[e.severity]))
}

function criteriaFrom(result: LabResult, steps: readonly StepView[]): PracticeCriterion[] {
  // Technique judged on a step the reference performed says nothing about the learner.
  const reference = new Set(result.support.autoPerformed)
  const own = result.evidence.filter((e) => !(e.kind === 'technique-quality' && e.path && reference.has(topStep(e.path))))
  // The rule the lab's objectives follow: a check that passes because its step never ran ("the rotor
  // is balanced" with no run) proves nothing. An objective scores 0 with passing evidence only then.
  const scores = new Map(result.objectives.map((o) => [o.id, o.score]))
  const proved = own.map((e) => (e.passed && e.objective && scores.get(e.objective) === 0 ? { ...e, passed: false } : e))
  // Evidence alone cannot show a step that was skipped. One line for them all, however many there were.
  const missing = result.deviations.filter((d) => d.kind === 'missing')
  const skipped: PracticeCriterion[] = missing.length
    ? [{ id: 'steps-done', label: missing.length === 1 ? clip(missing[0].message, MAX_LABEL) : `${missing.length} steps were not done`, met: false, weight: Math.min(MAX_WEIGHT, missing.reduce((sum, d) => sum + d.weight, 0)) }]
    : []
  // Unmet checks survive the limit first, so a run can never read better than it was.
  const room = MAX_CRITERIA - skipped.length
  const kept = proved.length <= room ? proved : [...proved.filter((e) => !e.passed), ...proved.filter((e) => e.passed)].slice(0, room)
  const weights = weightsOf(kept)
  const used = new Set(skipped.map((c) => c.id))
  const judged = kept.map((e, i) => ({
    id: criterionId(e.id, used),
    label: labelOf(e, steps),
    met: e.passed,
    weight: weights[i],
    ...(e.skills[0] ? { skill: e.skills[0] } : {}),
  }))
  return [...judged, ...skipped]
}

function noteFor(result: LabResult, faulted: boolean): string | undefined {
  const parts: string[] = []
  if (faulted) parts.push('The simulation hit a problem, so this run does not count.')
  else if (result.status !== 'submitted') parts.push('The practical was left before it was finished, so this run does not count.')
  else if (result.validity.verdict !== 'valid' && result.validity.reasons[0]) parts.push(result.validity.reasons[0])
  const shown = result.support.demonstrations
  if (shown > 0) parts.push(`The reference performed ${shown === 1 ? 'one step' : `${shown} steps`}.`)
  return parts.length ? clip(parts.join(' '), MAX_NOTE) : undefined
}

/**
 * The report for one run, whether it was finished or not. `result` is missing only if the run could
 * not be assessed at all; `faulted` says the simulation itself failed on the way.
 */
export function toPracticeResult(activityId: string, result: LabResult | undefined, options: { faulted?: boolean; steps?: readonly StepView[] } = {}): PracticeResult {
  const faulted = options.faulted === true
  if (!result) {
    return { version: 1, activityId, valid: false, criteria: [], hintsUsed: 0, attempts: 0, note: 'The simulation hit a problem, so this run does not count.' }
  }
  const note = noteFor(result, faulted)
  return {
    version: 1,
    activityId,
    // A run left unfinished has no verdict to stand on, whatever its rules say about the steps it reached.
    valid: !faulted && result.status === 'submitted' && result.validity.verdict !== 'invalid',
    criteria: criteriaFrom(result, options.steps ?? []),
    // After a demonstration the skills are the reference's, not the learner's. The host then tallies skills from the learner's own criteria.
    skills: result.support.demonstrations > 0 ? [] : result.competence.slice(0, MAX_SKILLS).map((c) => ({ id: c.skill, evidence: c.evidence })),
    misconceptions: result.misconceptions.slice(0, MAX_MISCONCEPTIONS),
    // "Show me" does the step for the learner: as much help as a hint, and the host treats it so.
    hintsUsed: result.support.hintsUsed + result.support.demonstrations,
    attempts: 1 + result.support.rewinds,
    ...(note ? { note } : {}),
  }
}

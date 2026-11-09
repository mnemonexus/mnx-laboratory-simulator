// Adaptive support (adaptive support §3–§5, §9): independent axes, context presets, and
// per-step resolution from the learner's competence in each step's skills. Support changes what
// the learner is told and allowed, never how the kernel behaves (§8).
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { ExperimentDefinition, LearningContext, StepDef } from '../format/types.ts'

export type Guidance = 'none' | 'objective' | 'milestones' | 'steps' | 'steps-rationale' | 'demonstrate'
export type Timing = 'immediate' | 'step-end' | 'checkpoint' | 'review' | 'silent' | 'on-request'
export type Intervention = 'prevent' | 'confirm' | 'allow' | 'allow-severe'
export type Band = 'unseen' | 'novice' | 'developing' | 'competent' | 'proficient'

export const GUIDANCE_ORDER: Guidance[] = ['none', 'objective', 'milestones', 'steps', 'steps-rationale', 'demonstrate']
export const BANDS: Band[] = ['unseen', 'novice', 'developing', 'competent', 'proficient']

export interface SupportProfile {
  guidance: Guidance
  feedback: { procedural: Timing; measurement: Timing; practice: Timing; safety: Timing }
  intervention: { severe: Intervention }
  freedom: { fidelity: 'as-definition' | 'prescribed' | 'prescribed-tolerant' | 'objective' | 'open'; order: 'enforced' | 'monitored' | 'free' }
  scope: 'station' | 'bench' | 'room' | 'wing' | 'facility'
  logistics: { provision: 'pre-staged' | 'nearby' | 'stored'; distractors: 'none' | 'plausible'; travel: 'teleport' | 'walk-optional' | 'walk' }
  time: 'real' | 'accelerated' | 'skippable' | 'jump'
  realism: 'ideal' | 'low' | 'default' | 'high'
  faults: boolean
  analysis: 'computed' | 'scaffolded' | 'tools' | 'manual'
  hints: { availability: 'none' | 'on-request' | 'proactive'; cost: 'free' | 'costly' }
  insight: 'off' | 'on-request' | 'suggested'
  assessment: 'formative' | 'practice' | 'summative'
  recovery: 'rewind' | 'redo' | 'none'
  collapsing: 'none' | 'incidental' | 'all-but-target'
}

/** Starting presets by learning context (adaptive support §4). */
export const PRESETS: Record<LearningContext, SupportProfile> = {
  'lecture-introduction': {
    guidance: 'steps-rationale',
    feedback: { procedural: 'immediate', measurement: 'step-end', practice: 'immediate', safety: 'immediate' },
    intervention: { severe: 'prevent' },
    freedom: { fidelity: 'prescribed-tolerant', order: 'monitored' },
    scope: 'station',
    logistics: { provision: 'pre-staged', distractors: 'none', travel: 'teleport' },
    time: 'skippable',
    realism: 'low',
    faults: false,
    analysis: 'scaffolded',
    hints: { availability: 'proactive', cost: 'free' },
    insight: 'suggested',
    assessment: 'formative',
    recovery: 'rewind',
    collapsing: 'incidental',
  },
  'spaced-recall': {
    guidance: 'objective',
    feedback: { procedural: 'review', measurement: 'review', practice: 'review', safety: 'immediate' },
    intervention: { severe: 'confirm' },
    freedom: { fidelity: 'as-definition', order: 'free' },
    scope: 'station',
    logistics: { provision: 'pre-staged', distractors: 'none', travel: 'teleport' },
    time: 'jump',
    realism: 'default',
    faults: false,
    analysis: 'tools',
    hints: { availability: 'on-request', cost: 'costly' },
    insight: 'off',
    assessment: 'practice',
    recovery: 'none',
    collapsing: 'all-but-target',
  },
  transferal: {
    guidance: 'objective',
    feedback: { procedural: 'step-end', measurement: 'review', practice: 'review', safety: 'immediate' },
    intervention: { severe: 'confirm' },
    freedom: { fidelity: 'objective', order: 'free' },
    scope: 'room',
    logistics: { provision: 'stored', distractors: 'plausible', travel: 'walk-optional' },
    time: 'accelerated',
    realism: 'default',
    faults: false,
    analysis: 'tools',
    hints: { availability: 'on-request', cost: 'free' },
    insight: 'on-request',
    assessment: 'practice',
    recovery: 'redo',
    collapsing: 'incidental',
  },
  'practical-session': {
    guidance: 'steps',
    feedback: { procedural: 'step-end', measurement: 'review', practice: 'step-end', safety: 'immediate' },
    intervention: { severe: 'confirm' },
    freedom: { fidelity: 'prescribed', order: 'monitored' },
    scope: 'room',
    logistics: { provision: 'nearby', distractors: 'none', travel: 'walk-optional' },
    time: 'accelerated',
    realism: 'default',
    faults: false,
    analysis: 'scaffolded',
    hints: { availability: 'on-request', cost: 'free' },
    insight: 'on-request',
    assessment: 'practice',
    recovery: 'redo',
    collapsing: 'none',
  },
  assessment: {
    guidance: 'objective',
    feedback: { procedural: 'review', measurement: 'review', practice: 'review', safety: 'immediate' },
    intervention: { severe: 'allow' },
    freedom: { fidelity: 'as-definition', order: 'monitored' },
    scope: 'room',
    logistics: { provision: 'stored', distractors: 'plausible', travel: 'walk' },
    time: 'accelerated',
    realism: 'default',
    faults: true,
    analysis: 'tools',
    hints: { availability: 'none', cost: 'costly' },
    insight: 'off',
    assessment: 'summative',
    recovery: 'none',
    collapsing: 'none',
  },
  'open-exploration': {
    guidance: 'none',
    feedback: { procedural: 'on-request', measurement: 'on-request', practice: 'on-request', safety: 'immediate' },
    intervention: { severe: 'confirm' },
    freedom: { fidelity: 'open', order: 'free' },
    scope: 'room',
    logistics: { provision: 'stored', distractors: 'none', travel: 'walk' },
    time: 'skippable',
    realism: 'default',
    faults: false,
    analysis: 'tools',
    hints: { availability: 'on-request', cost: 'free' },
    insight: 'suggested',
    assessment: 'formative',
    recovery: 'rewind',
    collapsing: 'none',
  },
}

/** Per-band adjustments (§5): guidance, practice feedback, non-safety intervention, collapsing. */
const BAND_RULES: Record<Band, { guidance: Guidance; practice: Timing; intervention: Intervention; collapse: 'never' | 'incidental' | 'if-not-objective' }> = {
  unseen: { guidance: 'demonstrate', practice: 'immediate', intervention: 'confirm', collapse: 'never' },
  novice: { guidance: 'steps-rationale', practice: 'immediate', intervention: 'allow', collapse: 'never' },
  developing: { guidance: 'steps', practice: 'step-end', intervention: 'allow', collapse: 'never' },
  competent: { guidance: 'milestones', practice: 'review', intervention: 'allow', collapse: 'incidental' },
  proficient: { guidance: 'objective', practice: 'review', intervention: 'allow', collapse: 'if-not-objective' },
}

/** Contexts where competence adjusts guidance; recall and assessment keep their preset (§9). */
const ADAPTS: LearningContext[] = ['lecture-introduction', 'practical-session', 'transferal']

export interface LearnerProfile {
  /** Competence band per skill id. Missing skills are `unseen` (§5.2). */
  bands?: Record<string, Band>
  /** The learner asked for more help: one guidance level more where allowed (§9 item 6). */
  moreHelp?: boolean
}

export interface StepSupport {
  step: string
  skills: string[]
  /** The weakest band among the step's skills. */
  band: Band
  guidance: Guidance
  practiceFeedback: Timing
  safetyFeedback: Timing
  intervention: Intervention
  /** Auto-performed instead of done interactively (composition model §4.3). */
  collapsed: boolean
  objectiveLinked: boolean
}

export interface SupportResolution {
  context: LearningContext
  profile: SupportProfile
  steps: StepSupport[]
}

/** Skills a step exercises: its technique's or operation's skills plus its objectives' skills. */
export function stepSkills(step: StepDef, def: ExperimentDefinition, cat: Catalogue): string[] {
  const skills = new Set<string>()
  if (step.ref) {
    for (const s of cat.technique(step.ref)?.skills ?? []) skills.add(s)
    for (const s of cat.operations.get(step.ref)?.skills ?? []) skills.add(s)
  }
  for (const o of def.context?.objectives ?? []) if ((step.objectives ?? []).includes(o.id)) for (const s of o.skills ?? []) skills.add(s)
  return [...skills]
}

export function resolveSupport(def: ExperimentDefinition, cat: Catalogue, context: LearningContext, learner: LearnerProfile = {}): SupportResolution {
  const profile: SupportProfile = structuredCloneProfile(PRESETS[context])
  const objectiveSkills = new Set((def.context?.objectives ?? []).flatMap((o) => o.skills ?? []))
  const steps: StepSupport[] = []
  const visit = (list: StepDef[] | undefined) => {
    for (const step of list ?? []) {
      if (step.kind === 'group') {
        visit(step.steps)
        continue
      }
      const skills = stepSkills(step, def, cat)
      const bands = skills.map((s) => learner.bands?.[s] ?? 'unseen')
      const band = bands.length ? bands.reduce((a, b) => (BANDS.indexOf(b) < BANDS.indexOf(a) ? b : a)) : 'competent'
      const objectiveLinked = (step.objectives ?? []).length > 0 || skills.some((s) => objectiveSkills.has(s))
      const rule = BAND_RULES[band]
      let guidance = profile.guidance
      let practice = profile.feedback.practice
      let intervention: Intervention = 'allow'
      if (ADAPTS.includes(context) && skills.length > 0) {
        guidance = rule.guidance
        practice = rule.practice
        intervention = rule.intervention
        // A lecture introduction never offers less than its preset's guidance.
        if (context === 'lecture-introduction' && GUIDANCE_ORDER.indexOf(guidance) < GUIDANCE_ORDER.indexOf(profile.guidance)) guidance = profile.guidance
      }
      if (learner.moreHelp && profile.assessment !== 'summative') {
        guidance = GUIDANCE_ORDER[Math.min(GUIDANCE_ORDER.length - 1, GUIDANCE_ORDER.indexOf(guidance) + 1)]
      }
      // Collapsing: only bench techniques; never a step an objective names; never safety-critical.
      const collapsible = step.kind === 'technique' && !(step.objectives ?? []).length && !(step.critical ?? []).includes('safety')
      let collapsed = false
      if (collapsible) {
        if (profile.collapsing === 'all-but-target') collapsed = !objectiveLinked
        else if (profile.collapsing === 'incidental' && !objectiveLinked) collapsed = rule.collapse !== 'never'
        else if (ADAPTS.includes(context) && rule.collapse === 'if-not-objective' && !objectiveLinked) collapsed = true
      }
      // Safety minimums are never relaxed (§9 item 1).
      const safetyFeedback: Timing = 'immediate'
      if ((step.critical ?? []).includes('safety') && intervention === 'allow' && profile.intervention.severe !== 'allow-severe') intervention = 'confirm'
      steps.push({ step: step.id, skills, band, guidance, practiceFeedback: practice, safetyFeedback, intervention, collapsed, objectiveLinked })
    }
  }
  visit(def.procedure?.steps)
  // Definition hints narrow the preset where given (§9 item 3).
  if (def.presentation?.scope) profile.scope = def.presentation.scope
  if (def.variation?.noise && context !== 'lecture-introduction') profile.realism = def.variation.noise
  return { context, profile, steps }
}

function structuredCloneProfile(p: SupportProfile): SupportProfile {
  return JSON.parse(JSON.stringify(p)) as SupportProfile
}

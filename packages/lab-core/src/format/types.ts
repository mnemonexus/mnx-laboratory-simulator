// The experiment definition format, draft 0.1 (docs/framework/specs/experiment-definition.md).
// Quantities are strings ("25 mL"); values starting with "=" are expressions (§15).

export const FORMAT_ID = 'lab-experiment'
export const FORMAT_VERSION = '0.1'

export type LearningContext =
  | 'lecture-introduction'
  | 'spaced-recall'
  | 'transferal'
  | 'practical-session'
  | 'assessment'
  | 'open-exploration'

export const LEARNING_CONTEXTS: LearningContext[] = [
  'lecture-introduction',
  'spaced-recall',
  'transferal',
  'practical-session',
  'assessment',
  'open-exploration',
]

export type FidelityMode = 'prescribed' | 'prescribed-tolerant' | 'objective' | 'open'

export type StepKind =
  | 'operation'
  | 'technique'
  | 'purpose'
  | 'wait'
  | 'observe'
  | 'data'
  | 'decision'
  | 'design'
  | 'checkpoint'
  | 'offstage'
  | 'group'

export const STEP_KINDS: StepKind[] = ['operation', 'technique', 'purpose', 'wait', 'observe', 'data', 'decision', 'design', 'checkpoint', 'offstage', 'group']

export type ProvenanceClass =
  | 'source-explicit'
  | 'source-inferred'
  | 'reference-standard'
  | 'general-knowledge'
  | 'framework-default'
  | 'author-choice'
  | 'simulation-derived'

/** One flat step object with a kind discriminator (§8.1). Shared by definitions and techniques. */
export interface StepDef {
  id: string
  kind: StepKind
  ref?: string
  title?: string
  instructions?: string
  params?: Record<string, unknown>
  bind?: Record<string, string>
  after?: string[]
  order?: 'strict' | 'advisory'
  forEach?: { var: string; in: string; index?: string }
  repeat?: { until?: string; times?: number | string; max?: number }
  when?: string
  duration?: string
  background?: boolean
  session?: string
  critical?: Array<'safety' | 'quality' | 'irreversible'>
  fidelity?: FidelityMode
  objectives?: string[]
  prompt?: string
  options?: Array<{ id: string; label: string; then?: string }>
  correctWhen?: string
  outcome?: { model?: string; declared?: string }
  steps?: StepDef[]
  notes?: string
  /** Techniques only: local values for the step and its children (name → expression). */
  let?: Record<string, string>
  /** Techniques only: what the reference agent chooses for a learner choice. */
  reference?: Record<string, unknown>
}

export interface Objective {
  id: string
  kind: 'skill' | 'outcome' | 'reasoning' | 'concept' | 'practice' | 'design' | 'analysis'
  statement: string
  skills?: string[]
  goal?: string
  weight?: number
}

export type Varying = string | { vary: string | Array<string | number> }

/** One component of a material. Exactly one of conc, count or mass says how much there is. */
export interface ConcentrationSpec {
  substance: string
  /** "2.0 mg/mL", or { vary: "0.3..1.4 mg/mL" | [choices] } in the authoring form. */
  conc?: Varying
  /** Organisms or cells per volume ("1e9 CFU/mL"). */
  count?: Varying
  /** Mass of this component in a solid mixture ("1.0 g"). */
  mass?: Varying
  /** Purity of a solid ("99.95 %"); the rest is unspecified impurity. */
  purity?: string
  /** Counted organisms or cells: the fraction alive ("92 %"); default all. */
  viability?: Varying
}

export interface SupplyDef {
  id: string
  label: string
  role?: 'unknown' | 'standard' | 'control-positive' | 'control-negative' | 'blank' | 'specimen' | 'culture' | 'product' | 'reagent'
  contains?: ConcentrationSpec[]
  solvent?: string
  preparation?: string
  amount?: string
  container?: string
  storage?: string
  /** A wet solid (soil): the liquid it holds, which carries the components given by conc or count. */
  water?: string
  count?: number | { vary: Array<number> }
  /** Hidden truth overriding the label's composition (faults, mislabelled stocks). */
  truth?: { contains?: ConcentrationSpec[]; activityFactor?: number }
}

export interface ExperimentDefinition {
  format: typeof FORMAT_ID
  formatVersion: string
  id: string
  version: string
  title: string
  language?: string
  requires?: {
    framework?: string
    manifest?: string
    capabilities?: Array<Record<string, unknown>>
  }
  summary?: string
  briefing?: string
  context?: {
    intendedContexts?: LearningContext[]
    audience?: { level?: string; disciplines?: string[] }
    /** Catalogue search terms, the courses where the practical appears, and its topics. */
    keywords?: string[]
    curricula?: string[]
    topics?: string[]
    prerequisites?: { skills?: string[]; definitions?: string[] }
    concepts?: Array<{ id: string; label: string; xref?: string }>
    objectives?: Objective[]
  }
  materials?: {
    substances?: Array<{ id: string; ref?: string; inline?: Record<string, unknown> }>
    supplies?: SupplyDef[]
    samples?: SupplyDef[]
    waste?: Array<{ stream: string; accepts?: string[] }>
  }
  equipment?: {
    /** `truth` is hidden condition: a tool's actual systematic error ("+4 %"), whatever its specification says. */
    roles?: Array<{ id: string; requires: Record<string, unknown>; count?: number; truth?: { bias?: string } }>
    prescribed?: Array<{ role: string; asNamed?: string; class?: string; model?: string }>
    excluded?: Array<{ class: string; reason?: string }>
  }
  procedure?: {
    fidelity?: FidelityMode
    sessions?: Array<{ id: string; title?: string }>
    steps?: StepDef[]
  }
  goals?: {
    predicates?: Array<{ id: string; statement?: string; check: string }>
    expectedObservations?: Array<{ id: string; at?: string; statement: string; check?: string; source?: ProvenanceClass }>
    expectedResults?: Array<{ id?: string; quantity: string; value: string; source?: ProvenanceClass; calibrateTo?: boolean }>
  }
  data?: {
    datasets?: Array<{ id: string; from: string; description?: string }>
    notebook?: {
      sections?: string[]
      required?: Array<{ id: string; section: string; prompt: string; check?: string }>
      manualRecording?: Array<{ measurement: string; mode: 'auto' | 'manual' | 'manual-checked' }>
    }
    calculations?: Array<{
      id: string
      statement: string
      inputs?: string[]
      answer?: { unit?: string; per?: string }
      accept?: { fromOwnData?: string; fromTruth?: string }
    }>
    graphs?: Array<{ id: string; kind: string; x: string; y: string; fit?: string[]; learnerBuilds?: boolean }>
    questions?: Array<{ id: string; kind: string; prompt: string; rubric?: string; options?: string[] }>
    report?: { template: string; sections?: string[] }
  }
  assessment?: {
    emphasis?: Record<string, number | 'gate'>
    criteria?: Array<{
      id: string
      statement: string
      check: string
      objective?: string
      severity?: 'critical' | 'major' | 'minor'
      feedback?: { kind?: string; timing?: 'immediate' | 'step-end' | 'review' | 'by-competence' }
      tags?: string[]
    }>
    validity?: Array<{ when: string; cap: ValidityVerdict; reason: string }>
    evidence?: { checkpoints?: string[]; criteria?: 'all' | string[] }
  }
  variation?: {
    params?: Array<{ path: string; domain: string | Array<string | number>; step?: string }>
    constraints?: string[]
    faults?: Array<{ id: string; probability?: number; apply: Record<string, unknown>; diagnostics?: string[] }>
    noise?: 'ideal' | 'low' | 'default' | 'high'
  }
  presentation?: {
    scope?: 'station' | 'bench' | 'room' | 'wing' | 'facility'
    startAt?: { place?: string }
    insightLayers?: string[]
    time?: Record<string, string>
  }
  provenance?: {
    sources?: Array<{ id: string; kind: string; title: string; locator?: string; access?: string; date?: string }>
    defaultClass?: ProvenanceClass
    annotations?: Array<{ path: string; class: ProvenanceClass; source?: string; quote?: string; confidence?: 'high' | 'medium' | 'low'; note?: string }>
    review?: { status: ReviewStatus; generator?: { name: string; version: string }; reviewer?: string }
  }
  /** Variant parameters and the variants that set them (§23; expanded before validation). */
  parameters?: Record<string, { default: unknown; description?: string }>
  variants?: Array<{ id: string; title: string; summary?: string; briefing?: string; values?: Record<string, unknown>; keywords?: string[]; curricula?: string[] }>
  extensions?: Record<string, unknown>
}

export type ReviewStatus = 'draft' | 'generated-unreviewed' | 'validated' | 'reviewed' | 'curated'

export type ValidityVerdict = 'valid' | 'valid-with-limitations' | 'partially-interpretable' | 'invalid' | 'inconclusive'

export const VALIDITY_VERDICTS: ValidityVerdict[] = ['valid', 'valid-with-limitations', 'partially-interpretable', 'invalid', 'inconclusive']

// The compiler (compilation pipeline §2): definition → validated, sampled, staged, rehearsed
// activity plan with coverage and rehearsal reports. Stages implemented here: 1–9 and 14, plus
// the static plan tree (§3). Context and learner specialisation (stage 10 onwards) come next.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { splitRef } from '../catalogue/catalogue.ts'
import { evaluate, makeEnv, truthy, type Value } from '../expr/evaluate.ts'
import type { ExperimentDefinition, LearningContext, ProvenanceClass, StepDef, SupplyDef } from '../format/types.ts'
import { allSteps, normalise, report, validateDefinition, type ValidationReport } from '../format/validate.ts'
import { createKernel, realismOptions } from '../kernel/index.ts'
import type { Kernel } from '../kernel/kernel.ts'
import { clone, emptyWorld, type World } from '../kernel/state.ts'
import { addContainer, addEquipment, addPlace, addSupply, type SupplySpec } from '../kernel/world.ts'
import { createRng, hashString } from '../rng/rng.ts'
import { ReferenceAgent, type AgentIssue, type QualityResult, type Resolution } from '../run/agent.ts'
import { runEnv, substanceId, validity, type RunContext } from '../run/env.ts'
import type { Finding } from '../schema/findings.ts'
import { setAtPointer } from '../schema/findings.ts'
import { type LearnerProfile, resolveSupport, type SupportResolution } from '../support/support.ts'
import { parseQuantity, parseValue, type Quantity } from '../units/quantity.ts'
import { DIMENSIONS, sameDim } from '../units/units.ts'

export const PLAN_VERSION = '0.1'

export interface CompileOptions {
  context?: LearningContext
  seed?: number
  realism?: 'ideal' | 'low' | 'default' | 'high'
  /** Run the reference procedure (V4). Default true. */
  rehearse?: boolean
  /** Decisions to take instead of the correct ones (simulating a learner; "what if" runs). */
  choices?: Record<string, string>
  /** The learner's competence per skill, for support resolution (stage 10). */
  learner?: LearnerProfile
}

export type Rung = 'exact' | 'variant' | 'substitute' | 'abstracted' | 'narrated' | 'unsupported'

export interface CoverageRequirement {
  path: string
  kind: 'technique' | 'operation' | 'purpose' | 'equipment' | 'process-model' | 'offstage' | 'material'
  requested: string
  asNamed?: string
  resolved: string | null
  rung: Rung
  centrality: 'objective' | 'supporting' | 'peripheral'
  tier?: string
  reason?: string
  disclose?: boolean
}

export interface GapEntry {
  fingerprint: string
  gap: { kind: string; id?: string; purpose?: string }
  path: string
  centrality: CoverageRequirement['centrality']
}

export interface CoverageReport {
  report: 'lab-coverage'
  definition: { id: string; version: string }
  context: LearningContext
  verdict: 'fully-supported' | 'supported-with-degradation' | 'not-supported'
  requirements: CoverageRequirement[]
  gaps: GapEntry[]
  disclosures: Array<{ path: string; text: string }>
}

export interface PlanNode {
  id: string
  path: string
  kind: StepDef['kind']
  ref?: string
  resolved?: string
  title?: string
  provenance: ProvenanceClass
  objectives?: string[]
  children?: PlanNode[]
}

export interface RehearsalReport {
  report: 'lab-rehearsal'
  ok: boolean
  seed: number
  events: number
  refusals: number
  simulatedTimeS: number
  issues: AgentIssue[]
  goals: Array<{ id: string; statement: string; passed: boolean }>
  expectedObservations: Array<{ id: string; statement: string; passed: boolean | null; source?: string }>
  quality: QualityResult[]
  resolutions: Resolution[]
  decisions: Record<string, string>
  validity: string
  /** Variation values this run used (path → value). */
  sampled: Record<string, unknown>
}

export interface ActivityPlan {
  planVersion: string
  key: string
  definition: { id: string; version: string; hash: string }
  context: LearningContext
  seed: number
  tree: PlanNode[]
  bindings: Record<string, { id: string; equipment: string; kind: 'equipment' | 'place' | 'container' }>
  coverage: CoverageReport
  disclosures: Array<{ path: string; text: string }>
  /** Stage 10: the support profile for this context and learner, resolved per step. */
  support: SupportResolution
  expectations?: { goals: RehearsalReport['goals']; observations: RehearsalReport['expectedObservations'] }
}

export interface CompileResult {
  validation: ValidationReport
  definition?: ExperimentDefinition
  coverage?: CoverageReport
  plan?: ActivityPlan
  rehearsal?: RehearsalReport
  /** The staged world before the run, and the kernel after the rehearsal (for inspection and tests). */
  world?: World
  /** Definition-level equipment roles and the ids they were staged as. */
  roles?: Record<string, string>
  kernel?: Kernel
  run?: RunContext
}

export function compile(input: unknown, cat: Catalogue, options: CompileOptions = {}): CompileResult {
  const validation = validateDefinition(input, cat)
  if (validation.summary.errors > 0) return { validation }
  const seed = options.seed ?? 1
  const context = options.context ?? (input as ExperimentDefinition).context?.intendedContexts?.[0] ?? 'practical-session'
  let def = normalise(input as ExperimentDefinition)

  const sampling = sampleVariation(def, seed)
  validation.findings.push(...sampling.findings)
  if (sampling.findings.some((f) => f.severity === 'error')) return { validation: report(input, validation.findings, ['V1', 'V2', 'V3', 'V4']) }
  def = sampling.def

  const coverage = coverageOf(def, cat, context)
  const staged = stage(def, cat, seed)
  const tree = planTree(def, cat, coverage)
  const plan: ActivityPlan = {
    planVersion: PLAN_VERSION,
    key: String(hashString(`${JSON.stringify(def)}|${context}|${seed}|${PLAN_VERSION}`)),
    definition: { id: def.id, version: def.version, hash: String(hashString(JSON.stringify(input))) },
    context,
    seed,
    tree,
    bindings: staged.bindings,
    coverage,
    disclosures: coverage.disclosures,
    support: resolveSupport(def, cat, context, options.learner),
  }
  const result: CompileResult = { validation, definition: def, coverage, plan, world: clone(staged.world), roles: staged.roles }
  if (options.rehearse === false) return result

  const kernel = createKernel(cat, staged.world, realismOptions(options.realism ?? def.variation?.noise ?? plan.support.profile.realism))
  const run: RunContext = { kernel, cat, def, roles: staged.roles, outputs: {}, decisions: {} }
  const agent = new ReferenceAgent(run, { choices: options.choices })
  agent.issues.push(...staged.issues)
  // A purpose step whose technique is bound to the learner leaves the method open: there is no
  // reference to rehearse (objective-mode challenges).
  const learnerChooses = allSteps(def).some(({ step }) => step.kind === 'purpose' && Object.values(step.bind ?? {}).includes('learner'))
  const hasReference = (def.procedure?.steps ?? []).length > 0 && !learnerChooses
  if (hasReference && !staged.issues.some((i) => i.severity === 'error')) agent.runProcedure()
  const env = runEnv(run)
  const check = (expr: string): boolean | null => {
    try {
      return truthy(evaluate(expr, env))
    } catch (e) {
      agent.issues.push({ path: 'goals', code: 'EXPRESSION', message: (e as Error).message, severity: 'warning' })
      return null
    }
  }
  // Objective-mode definitions may give goals without a reference procedure: nothing proves them yet.
  if (!hasReference && (def.goals?.predicates ?? []).length > 0) {
    validation.findings.push({ code: 'ED-V4-NO-REFERENCE', level: 'V4', severity: 'info', path: '/procedure', message: 'No reference procedure: the goals are not rehearsed (objective mode)' })
  }
  const goals = hasReference ? (def.goals?.predicates ?? []).map((g) => ({ id: g.id, statement: g.statement ?? g.check, passed: check(g.check) === true })) : []
  const observations = (def.goals?.expectedObservations ?? []).map((o) => ({ id: o.id, statement: o.statement, passed: o.check ? check(o.check) : null, source: o.source }))
  const rehearsal: RehearsalReport = {
    report: 'lab-rehearsal',
    ok: !agent.issues.some((i) => i.severity === 'error') && goals.every((g) => g.passed),
    seed,
    events: kernel.events.length,
    refusals: kernel.attempts.length,
    simulatedTimeS: kernel.world.timeS,
    issues: agent.issues,
    goals,
    expectedObservations: observations,
    quality: agent.quality,
    resolutions: agent.resolutions,
    decisions: run.decisions,
    validity: validity(run),
    sampled: sampling.sampled,
  }
  validation.findings.push(...rehearsalFindings(def, rehearsal))
  plan.expectations = { goals, observations }
  return {
    ...result,
    validation: report(input, validation.findings, ['V1', 'V2', 'V3', 'V4']),
    rehearsal,
    kernel,
    run,
  }
}

function rehearsalFindings(def: ExperimentDefinition, r: RehearsalReport): Finding[] {
  const out: Finding[] = []
  for (const i of r.issues) {
    out.push({ code: `ED-V4-${i.code.startsWith('REFUSED') ? 'STEP-REFUSED' : 'STEP-FAILED'}`, level: 'V4', severity: i.severity, path: `/rehearsal/${i.path}`, message: i.message })
  }
  r.goals.forEach((g, n) => {
    if (!g.passed) out.push({ code: 'ED-V4-GOAL-UNREACHED', level: 'V4', severity: 'error', path: `/goals/predicates/${n}`, message: `The reference procedure does not reach "${g.statement}"` })
  })
  r.expectedObservations.forEach((o, n) => {
    if (o.passed === false) out.push({ code: 'ED-V4-EXPECTATION-MISMATCH', level: 'V4', severity: 'warning', path: `/goals/expectedObservations/${n}`, message: `The simulation does not reproduce "${o.statement}"` })
  })
  for (const q of r.quality) {
    if (!q.passed) out.push({ code: 'ED-V4-REFERENCE-QUALITY', level: 'V4', severity: 'warning', path: `/rehearsal/${q.path}`, message: `The reference performance fails "${q.statement}" (${q.technique})` })
  }
  void def
  return out
}

// ---- Stage 8: variation ----

function sampleVariation(def: ExperimentDefinition, seed: number): { def: ExperimentDefinition; findings: Finding[]; sampled: Record<string, unknown> } {
  const params = def.variation?.params ?? []
  const faults = def.variation?.faults ?? []
  const constraints = def.variation?.constraints ?? []
  if (params.length === 0 && faults.length === 0) return { def, findings: [], sampled: {} }
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = clone(def)
    const sampled: Record<string, unknown> = {}
    for (const p of params) {
      const rng = createRng(`${seed}|variation|${p.path}|${attempt}`)
      const value = sampleDomain(p.domain, p.step, rng.next(), rng)
      setAtPointer(candidate, p.path, value)
      sampled[p.path] = value
    }
    for (const fault of faults) {
      const rng = createRng(`${seed}|fault|${fault.id}|${attempt}`)
      if (rng.next() < (fault.probability ?? 0)) {
        applyFault(candidate, fault.apply)
        sampled[`fault:${fault.id}`] = true
      }
    }
    const env = makeEnv({}, definitionFunctions(candidate))
    const ok = constraints.every((c) => {
      try {
        return truthy(evaluate(c, env))
      } catch {
        return false
      }
    })
    if (ok) return { def: candidate, findings: [], sampled }
  }
  return {
    def,
    findings: [{ code: 'ED-V4-NO-VALID-SAMPLE', level: 'V4', severity: 'error', path: '/variation', message: 'No sampled variant satisfied the constraints in 100 attempts' }],
    sampled: {},
  }
}

function sampleDomain(domain: string | Array<string | number>, step: string | undefined, u: number, rng: ReturnType<typeof createRng>): string | number {
  if (Array.isArray(domain)) return rng.pick(domain)
  const p = parseQuantity(domain)
  if (p.kind !== 'range') return domain
  const unit = p.hi.unit ?? ''
  const lo = Number(domain.split('..')[0])
  const hi = Number(domain.split('..')[1].trim().split(/\s+/)[0])
  let v = lo + u * (hi - lo)
  if (step) {
    const s = parseValue(step)
    const sv = unit ? s.si / parseValue(`1 ${unit}`).si : s.si
    v = Math.round(v / sv) * sv
  } else v = Number(v.toPrecision(3))
  v = Number(v.toPrecision(10))
  return unit ? `${v} ${unit}` : v
}

function applyFault(def: ExperimentDefinition, apply: Record<string, unknown>): void {
  if (typeof apply.role === 'string') {
    const role = def.equipment?.roles?.find((r) => r.id === apply.role)
    const truth = apply.truth as { bias?: string } | undefined
    if (role && truth) role.truth = { ...(role.truth ?? {}), ...truth }
    return
  }
  const id = apply.supply
  const all = [...(def.materials?.supplies ?? []), ...(def.materials?.samples ?? [])]
  const s = all.find((x) => x.id === id)
  if (!s) return
  const truth = apply.truth as SupplyDef['truth'] | undefined
  if (truth) s.truth = { ...(s.truth ?? {}), ...truth }
}

/** Functions for constraints, evaluated on the definition before any world exists. */
function definitionFunctions(def: ExperimentDefinition) {
  const all = [...(def.materials?.supplies ?? []), ...(def.materials?.samples ?? [])]
  return {
    truth: ([property, sample, substance]: Value[]) => {
      if (property !== 'conc' && !(typeof property === 'object' && property && '$ref' in property && property.$ref === 'conc')) throw new Error('truth() knows "conc" only')
      const id = typeof sample === 'string' ? sample : (sample as { $ref: string }).$ref
      const sub = typeof substance === 'string' ? substance : (substance as { $ref: string }).$ref
      const s = all.find((x) => x.id === id)
      const spec = (s?.truth?.contains ?? s?.contains ?? []).find((c) => c.substance === sub || substanceId(def, c.substance) === substanceId(def, sub))
      if (!spec || typeof spec.conc !== 'string') return null
      return parseValue(spec.conc) as Value
    },
  }
}

// ---- Stages 4–7: resolution, binding and coverage ----

function centralityOf(def: ExperimentDefinition, cat: Catalogue, step: StepDef): CoverageRequirement['centrality'] {
  if ((step.objectives ?? []).length > 0) return 'objective'
  const objectiveSkills = new Set((def.context?.objectives ?? []).flatMap((o) => o.skills ?? []))
  const tech = step.ref ? cat.technique(step.ref) : undefined
  if (tech && tech.skills.some((s) => objectiveSkills.has(s))) return 'objective'
  if (step.kind === 'purpose' && step.ref?.startsWith('dispose')) return 'peripheral'
  return 'supporting'
}

export function coverageOf(def: ExperimentDefinition, cat: Catalogue, context: LearningContext): CoverageReport {
  const requirements: CoverageRequirement[] = []
  const gaps: GapEntry[] = []
  const disclosures: Array<{ path: string; text: string }> = []
  const add = (r: CoverageRequirement, gap?: GapEntry['gap']) => {
    requirements.push(r)
    if (r.rung === 'unsupported' && gap) {
      gaps.push({ fingerprint: [gap.kind, gap.purpose ?? '', gap.id ?? ''].join('|'), gap, path: r.path, centrality: r.centrality })
    }
  }
  for (const { step, path } of allSteps(def)) {
    if (!step.ref) continue
    const centrality = centralityOf(def, cat, step)
    if (step.kind === 'operation') {
      const ok = cat.operations.has(step.ref)
      add({ path, kind: 'operation', requested: step.ref, resolved: ok ? step.ref : null, rung: ok ? 'exact' : 'unsupported', centrality }, { kind: 'operation', id: step.ref })
    } else if (['technique', 'data', 'design'].includes(step.kind)) {
      const t = cat.technique(step.ref)
      const op = !t && cat.operations.has(splitRef(step.ref).id)
      add(
        { path, kind: 'technique', requested: step.ref, resolved: t ? `${t.id}@${t.version}` : op ? step.ref : null, rung: t || op ? 'exact' : 'unsupported', centrality },
        { kind: 'technique', id: splitRef(step.ref).id },
      )
    } else if (step.kind === 'purpose') {
      const providers = cat.providersOf(step.ref).filter((p) => p.kind === 'technique' && p.status !== 'stub')
      add(
        { path, kind: 'purpose', requested: step.ref, resolved: providers[0]?.id ?? null, rung: providers.length ? 'exact' : 'unsupported', centrality, reason: providers.length ? 'technique chosen by purpose' : undefined },
        { kind: 'technique', purpose: step.ref },
      )
    } else if (step.kind === 'offstage') {
      add({ path, kind: 'offstage', requested: step.outcome?.model ?? 'declared', resolved: step.outcome?.declared ? 'declared' : null, rung: 'narrated', centrality, disclose: true })
      disclosures.push({ path, text: `This step happens off-stage: ${step.title ?? step.id}.` })
    }
  }
  ;(def.equipment?.prescribed ?? []).forEach((p, i) => {
    const path = `/equipment/prescribed/${i}`
    const requested = p.model ?? p.class ?? p.asNamed ?? p.role
    if ((p.model && cat.equipment.has(p.model)) || (p.class && cat.equipment.has(p.class))) {
      add({ path, kind: 'equipment', requested, asNamed: p.asNamed, resolved: p.model ?? p.class!, rung: 'exact', centrality: 'objective' })
      if (p.asNamed) disclosures.push({ path, text: `The source names "${p.asNamed}"; this lab uses a generic ${cat.equipment.get((p.model ?? p.class)!)!.label.toLowerCase()} with the same settings.` })
      return
    }
    const role = def.equipment?.roles?.find((r) => r.id === p.role)
    const resolved = role ? resolveRoleEquipment(role.requires, cat) : undefined
    add(
      { path, kind: 'equipment', requested, asNamed: p.asNamed, resolved: resolved ?? null, rung: resolved ? 'variant' : 'unsupported', centrality: 'objective', disclose: !!resolved, reason: resolved ? 'same capability, generic model' : undefined },
      { kind: 'equipment', id: p.model ?? p.class },
    )
    if (resolved) disclosures.push({ path, text: `The source names "${p.asNamed ?? requested}"; this lab uses a ${cat.equipment.get(resolved)!.label.toLowerCase()} with the same capability.` })
  })
  ;(def.requires?.capabilities ?? []).forEach((c, i) => {
    if (typeof c.processModel !== 'string') return
    const m = cat.models.get(c.processModel)
    const min = typeof c.minTier === 'string' ? c.minTier : undefined
    const tierOk = !m || !min || Number(m.tier.slice(1)) >= Number(min.slice(1))
    add(
      { path: `/requires/capabilities/${i}`, kind: 'process-model', requested: c.processModel, resolved: m ? `${m.id}` : null, rung: m ? (tierOk ? 'exact' : 'abstracted') : 'unsupported', centrality: 'supporting', tier: m?.tier },
      { kind: 'model', id: c.processModel },
    )
  })
  const verdict = requirements.some((r) => r.rung === 'unsupported' && r.centrality === 'objective')
    ? 'not-supported'
    : requirements.some((r) => r.rung !== 'exact')
      ? 'supported-with-degradation'
      : 'fully-supported'
  return { report: 'lab-coverage', definition: { id: def.id, version: def.version }, context, verdict, requirements, gaps, disclosures }
}

/** The best equipment entry for a role's requirements: models before classes. */
export function resolveRoleEquipment(req: Record<string, unknown>, cat: Catalogue): string | undefined {
  const cls = typeof req.class === 'string' ? req.class : undefined
  if (cls && cat.equipment.has(cls)) {
    const def = cat.equipment.get(cls)!
    if (def.level === 'model') return cls
    const model = [...cat.equipment.values()].find((e) => e.level === 'model' && cat.isA(e.id, cls) && e.status !== 'stub' && cat.meets(e.id, req))
    return model?.id ?? cls
  }
  if (typeof req.purpose !== 'string') return undefined
  const fits = [...cat.equipment.values()].filter((e) => e.status !== 'stub' && cat.meets(e.id, req))
  return (fits.find((e) => e.level === 'model') ?? fits[0])?.id
}

// ---- Stage 11 (headless part): staging the world ----

const LIQUID_KIT: Array<[string, string]> = [
  ['p2', 'core:micropipette-p2'],
  ['p20', 'core:micropipette-p20'],
  ['p200', 'core:micropipette-p200'],
  ['p1000', 'core:micropipette-p1000'],
]

function defaultContainer(amount: Quantity | undefined, solid: boolean): string {
  if (solid || !amount) return 'core:reagent-bottle-50ml'
  const mL = amount.si * 1e6
  if (mL <= 1.8) return 'core:microtube-2ml'
  if (mL <= 14) return 'core:conical-tube-15ml'
  if (mL <= 55) return 'core:reagent-bottle-50ml'
  if (mL <= 280) return 'core:reagent-bottle-250ml'
  return 'core:reagent-bottle-1l'
}

function stage(def: ExperimentDefinition, cat: Catalogue, seed: number): { world: World; roles: Record<string, string>; bindings: ActivityPlan['bindings']; issues: AgentIssue[] } {
  const world = emptyWorld(seed)
  const roles: Record<string, string> = {}
  const bindings: ActivityPlan['bindings'] = {}
  const issues: AgentIssue[] = []
  for (const [id, model] of LIQUID_KIT) addEquipment(world, cat, id, model)
  addEquipment(world, cat, 'vortex', 'core:vortex-mixer')
  // Equipment roles: prescribed model if this build has it, else the best match. A prescribed
  // entry without a declared role implies one (the source naming the equipment is enough).
  const implied = (def.equipment?.prescribed ?? [])
    .filter((p) => !(def.equipment?.roles ?? []).some((r) => r.id === p.role) && (p.model ?? p.class))
    .map((p) => ({ id: p.role, requires: { class: (p.model ?? p.class)! } as Record<string, unknown> }))
  for (const role of [...(def.equipment?.roles ?? []), ...implied]) {
    const prescribed = def.equipment?.prescribed?.find((p) => p.role === role.id)
    // A role named like a piece of the standard kit (p200, vortex) is that piece, if it serves.
    const existing = world.equipment[role.id]
    if (existing) {
      if (cat.meets(existing.equipment, role.requires as Record<string, unknown>) && !(role as { truth?: unknown }).truth) {
        bindings[role.id] = { id: role.id, equipment: existing.equipment, kind: 'equipment' }
        roles[role.id] = role.id
      } else issues.push({ path: `equipment/${role.id}`, code: 'ROLE-ID-RESERVED', message: `"${role.id}" names the bench's standard ${existing.label}; give this role another id`, severity: 'error' })
      continue
    }
    let model = prescribed?.model && cat.equipment.has(prescribed.model) ? prescribed.model : undefined
    if (!model && prescribed?.class && cat.equipment.has(prescribed.class)) model = resolveRoleEquipment({ class: prescribed.class }, cat)
    model ??= resolveRoleEquipment(role.requires as Record<string, unknown>, cat)
    if (!model) {
      issues.push({ path: `equipment/${role.id}`, code: 'UNSTAGED-ROLE', message: `Nothing in this build fills equipment role "${role.id}"`, severity: 'error' })
      continue
    }
    const def0 = cat.equipment.get(model)!
    if (def0.kind === 'container' || def0.kind === 'plate') {
      addContainer(world, cat, { id: role.id, equipment: model, label: def0.label })
      bindings[role.id] = { id: role.id, equipment: model, kind: 'container' }
    } else if (def0.kind === 'place') {
      const t = typeof role.requires.temperature === 'string' ? role.requires.temperature : undefined
      addPlace(world, cat, role.id, model, undefined, t)
      bindings[role.id] = { id: role.id, equipment: model, kind: 'place' }
    } else {
      const inst = addEquipment(world, cat, role.id, model)
      // Hidden condition: a tool that is out of calibration by a stated amount.
      const bias = (role as { truth?: { bias?: string } }).truth?.bias
      if (bias && inst.state.kind === 'tool') inst.state.bias = parseValue(bias).si
      bindings[role.id] = { id: role.id, equipment: model, kind: 'equipment' }
    }
    roles[role.id] = role.id
  }
  // Equipment the procedure's techniques need that nothing staged provides: a lab has its usual
  // instruments, so they are staged under the role's name rather than demanded of the author.
  for (const need of techniqueEquipment(def, cat)) {
    const present = need.kind === 'place' ? Object.values(world.places) : Object.values(world.equipment)
    if (present.some((e) => cat.meets(e.equipment, need.requires))) continue
    const model = need.prefer.find((m) => cat.equipment.has(m) && cat.meets(m, need.requires)) ?? resolveRoleEquipment(need.requires, cat)
    const kind = model ? cat.equipment.get(model)!.kind : undefined
    if (!model || kind === 'container' || kind === 'plate' || (kind === 'place') !== (need.kind === 'place')) continue
    let id = need.name
    for (let k = 2; world.equipment[id] || world.containers[id] || world.places[id]; k++) id = `${need.name}-${k}`
    if (need.kind === 'place') addPlace(world, cat, id, model)
    else addEquipment(world, cat, id, model)
    bindings[id] = { id, equipment: model, kind: need.kind }
  }
  // Supplies and samples, with labels and hidden truth.
  for (const s of [...(def.materials?.supplies ?? []), ...(def.materials?.samples ?? [])]) {
    try {
      const spec = supplySpec(def, cat, s)
      const count = typeof s.count === 'number' ? s.count : 1
      if (spec && count > 1) {
        for (let k = 1; k <= count; k++) {
          const c = addSupply(world, cat, { ...spec, id: `${s.id}-${k}`, label: `${s.label} ${k}` })
          c.supply = s.id
          c.origins = [s.id]
        }
      } else if (spec) addSupply(world, cat, spec)
      else issues.push({ path: `materials/${s.id}`, code: 'UNSUPPORTED-MATERIAL', message: `"${s.id}" holds organisms or cells (counts), which this build cannot represent yet`, severity: 'error' })
    } catch (e) {
      issues.push({ path: `materials/${s.id}`, code: 'MATERIAL', message: (e as Error).message, severity: 'error' })
    }
  }
  return { world, roles, bindings, issues }
}

/**
 * Equipment roles of the techniques a procedure uses (directly or through other techniques)
 * that the steps do not bind. Requirements written as expressions depend on the call and are
 * left out: the staged item only has to be the right kind of thing.
 */
function techniqueEquipment(def: ExperimentDefinition, cat: Catalogue): Array<{ name: string; kind: 'equipment' | 'place'; requires: Record<string, unknown>; prefer: string[] }> {
  const out: Array<{ name: string; kind: 'equipment' | 'place'; requires: Record<string, unknown>; prefer: string[] }> = []
  const seen = new Set<string>()
  const visit = (step: StepDef) => {
    if (step.kind !== 'technique' || !step.ref) return
    const tech = cat.technique(step.ref)
    if (!tech) return
    for (const [name, role] of Object.entries(tech.roles ?? {})) {
      if ((role.kind !== 'equipment' && role.kind !== 'place') || step.bind?.[name] !== undefined || step.params?.[name] !== undefined) continue
      const requires = Object.fromEntries(Object.entries(role.requires ?? {}).filter(([, v]) => !(typeof v === 'string' && v.startsWith('='))))
      const key = `${tech.id}|${name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name, kind: role.kind, requires, prefer: role.prefer ?? [] })
    }
    if (seen.has(tech.id)) return
    seen.add(tech.id)
    const walk = (steps: StepDef[]) => steps.forEach((s) => (visit(s), walk(s.steps ?? [])))
    walk(tech.steps)
  }
  for (const { step } of allSteps(def)) visit(step)
  return out
}

/** How a definition's material becomes a supply: a solution, a solid, or a solid mixture. */
function supplySpec(def: ExperimentDefinition, cat: Catalogue, s: SupplyDef): SupplySpec | undefined {
  const contains = s.contains ?? []
  // Organisms with an organism facet become populations; anything else counted is not representable yet.
  // A fault's truth may add organisms (a contaminant): counted truth components are populations,
  // and a truth that lists only organisms leaves the labelled composition as it is.
  const truthContains = s.truth?.contains
  const truthComponents = (truthContains ?? []).filter((c) => c.count === undefined)
  const counted = [...contains, ...(truthContains ?? [])].filter((c) => c.count !== undefined)
  if (counted.some((c) => !cat.substances.get(substanceId(def, c.substance))?.organism)) return undefined
  const unlimited = s.amount === 'unlimited'
  const amountP = s.amount && !unlimited ? parseQuantity(s.amount) : undefined
  const amount = amountP && amountP.kind !== 'range' ? amountP.q : undefined
  const solid = (!!amount && sameDim(amount.dim, DIMENSIONS.mass)) || contains.some((c) => c.mass !== undefined)
  const container = s.container ?? defaultContainer(amount, solid)
  const base = { id: s.id, label: s.label, container, ...(s.role ? { role: s.role } : {}), ...(s.storage ? { temperature: s.storage } : {}) }
  if (solid) {
    // Component masses may be expressions over sibling components: mass('x').
    const masses: Record<string, number> = {}
    const env = makeEnv({}, { mass: ([x]) => ({ si: (masses[substanceId(def, String(x))] ?? 0) / 1000, dim: DIMENSIONS.mass, unit: 'g' }) as Value })
    const solids: Array<{ substance: string; massG: number }> = []
    for (const c of contains) {
      // In a wet solid, what is given by conc or count is in its water, not part of the solid.
      if (s.water && c.mass === undefined && (c.conc !== undefined || c.count !== undefined)) continue
      const sub = substanceId(def, c.substance)
      let grams: number
      if (c.mass !== undefined) {
        const v = typeof c.mass === 'string' && c.mass.startsWith('=') ? evaluate(c.mass, env) : parseValue(String(c.mass))
        grams = (v as Quantity).si * 1000
      } else {
        const total = amount ? amount.si * 1000 : 10
        const purity = c.purity ? parseValue(c.purity).si : 1
        grams = total * purity
        // What is not the named substance still weighs: an inert impurity (water in an undried standard).
        if (purity < 1) solids.push({ substance: 'core:impurity', massG: total * (1 - purity) })
      }
      masses[sub] = grams
      solids.push({ substance: sub, massG: grams })
    }
    const wet = s.water
      ? {
          amount: s.water,
          ...(s.preparation ? { preparation: s.preparation } : {}),
          components: contains.filter((c) => c.conc !== undefined).map((c) => ({ substance: substanceId(def, c.substance), conc: String(c.conc) })),
          populations: counted.map((c) => {
            const q = parseValue(String(c.count))
            return { substance: substanceId(def, c.substance), ...(q.dim.every((d) => d === 0) ? { total: q.si } : { perL: q.si / 1000 }) }
          }),
        }
      : undefined
    return { ...base, amount: s.amount ?? '10 g', solids, ...(wet ? { wet } : {}) }
  }
  const capacity = cat.property(container, 'capacity')
  const volume = unlimited ? String(capacity ?? '1 L') : (s.amount ?? '10 mL')
  const components = contains.filter((c) => c.count === undefined).map((c) => ({ substance: substanceId(def, c.substance), conc: String(c.conc) }))
  // A count per volume is a concentration; a bare number ("40 {colonies}") is how many there are
  // (on agar, colonies).
  const populations = counted.map((c) => {
    const q = parseValue(String(c.count))
    return {
      substance: substanceId(def, c.substance),
      ...(q.dim.every((d) => d === 0) ? { total: q.si } : { perL: q.si / 1000 }),
      ...(c.viability ? { viable: parseValue(String(c.viability)).si } : {}),
    }
  })
  return {
    ...base,
    amount: volume,
    ...(populations.length ? { populations } : {}),
    ...(s.preparation ? { preparation: s.preparation } : {}),
    ...(components.length || !s.preparation ? { components } : {}),
    ...(truthComponents.length ? { truth: truthComponents.map((c) => ({ substance: substanceId(def, c.substance), conc: String(c.conc) })) } : {}),
    ...(s.truth?.activityFactor !== undefined ? { activityFactor: s.truth.activityFactor } : {}),
  }
}

// ---- Plan tree (§3) ----

function provenanceOf(def: ExperimentDefinition, path: string): ProvenanceClass {
  const annotations = def.provenance?.annotations ?? []
  let best: { len: number; cls: ProvenanceClass } | undefined
  for (const a of annotations) {
    if (path === a.path || path.startsWith(`${a.path}/`)) {
      if (!best || a.path.length > best.len) best = { len: a.path.length, cls: a.class }
    }
  }
  return best?.cls ?? def.provenance?.defaultClass ?? 'author-choice'
}

function planTree(def: ExperimentDefinition, cat: Catalogue, coverage: CoverageReport): PlanNode[] {
  const resolvedAt = new Map(coverage.requirements.map((r) => [r.path, r.resolved ?? undefined]))
  const node = (step: StepDef, path: string, depth: number, fromTechnique?: string): PlanNode => {
    const n: PlanNode = {
      id: step.id,
      path,
      kind: step.kind,
      ...(step.ref ? { ref: step.ref } : {}),
      ...(resolvedAt.get(path) ? { resolved: resolvedAt.get(path) } : {}),
      ...(step.title ? { title: step.title } : {}),
      provenance: fromTechnique ? 'framework-default' : provenanceOf(def, path),
      ...(step.objectives ? { objectives: step.objectives } : {}),
    }
    if (step.steps) n.children = step.steps.map((s, i) => node(s, `${path}/steps/${i}`, depth + 1, fromTechnique))
    else if (step.ref && depth < 4) {
      const ref = step.kind === 'purpose' ? resolvedAt.get(path) : step.ref
      const tech = ref ? cat.technique(ref) : undefined
      if (tech) n.children = tech.steps.map((s, i) => node(s, `${tech.id}/steps/${i}`, depth + 1, tech.id))
    }
    return n
  }
  return (def.procedure?.steps ?? []).map((s, i) => node(s, `/procedure/steps/${i}`, 0))
}

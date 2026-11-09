// Lab sessions (execution runtime §2–§6, the headless part): one learner's run of a compiled
// definition. A host (the add-on's UI, the CLI, a test) drives it: perform operations, take
// decisions, write in the notebook, ask for a hint or a demonstration, rewind, finish. The
// session attributes actions to the step the learner is on, keeps the procedure's progress, and
// hands the run to assessment at the end. Its whole state is the seed plus the intent history,
// so it can be saved and restored exactly.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { OperationDecl } from '../catalogue/types.ts'
import { assess, type LabResult, monitor, type MonitorReport, type RunStatus, toMnemoNexus } from '../assess/assess.ts'
import { compile, type CompileOptions, type PlanNode, type RehearsalReport } from '../compile/compile.ts'
import { childEnv, evaluate, isRecord, truthy, type Value } from '../expr/evaluate.ts'
import { isExpressionValue } from '../expr/parse.ts'
import type { ExperimentDefinition, LearningContext, StepDef } from '../format/types.ts'
import type { ValidationReport } from '../format/validate.ts'
import { createKernel, realismOptions } from '../kernel/index.ts'
import type { ExecuteResult, Intent, Kernel, Refusal } from '../kernel/kernel.ts'
import { clone, type Container, liquidVolume, meanLayer, type World } from '../kernel/state.ts'
import { visibleColour } from '../models/acidbase.ts'
import { hex } from '../models/colour.ts'
import { appearance, epsilon } from '../models/measurement.ts'
import { type QualityResult, ReferenceAgent } from '../run/agent.ts'
import { type RunContext, runEnv } from '../run/env.ts'
import type { Guidance, StepSupport } from '../support/support.ts'

export type SessionOptions = Pick<CompileOptions, 'context' | 'seed' | 'realism' | 'learner'> & {
  /** Rehearse the reference first (expectations and demonstrations work either way); off for slow hosts. */
  rehearse?: boolean
}

export interface ContainerView {
  id: string
  label: string
  userLabel?: string
  equipment: string
  kind: 'container' | 'plate' | 'well'
  volumeMl: number
  capacityMl: number
  colour: string
  temperatureC: number
  place: string
  /** Position in an instrument with slots (a rotor position). */
  slot?: number
  open: boolean
  supply?: string
  role?: string
  plate?: string
  position?: string
  wells?: string[]
  /** Unmixed layers (more than one means it is stratified). */
  layers: number
  /** Undissolved solid, a pellet or crystals. */
  solid: boolean
  /**
   * What the bench draws for a vessel with liquid, from the simulation: the colour seen through it
   * (display hex), its clarity (1 clear, 0 opaque), what lies on the bottom (colour and its depth as
   * a share of the liquid's) and how hard gas is bubbling off (0 none, 1 vigorous).
   */
  look?: { liquid: string; clarity: number; sediment?: { colour: string; fraction: number }; bubbling: number }
}

export interface EquipmentView {
  id: string
  label: string
  equipment: string
  kind: 'tool' | 'instrument' | 'device'
  /** Tools: no tip, a fresh tip, or one that has touched something. */
  tip?: 'none' | 'fresh' | 'used'
  /** Tools that take disposable tips (micropipettes). */
  needsTip?: boolean
  setVolumeUl?: number
}

export interface PlaceView {
  id: string
  label: string
  equipment: string
  temperatureC: number
  adjustable: boolean
}

export interface StepView {
  id: string
  title: string
  kind: StepDef['kind']
  ref?: string
  status: 'done' | 'current' | 'pending' | 'skipped'
  instructions?: string
  objectives?: string[]
  support?: StepSupport
  children?: PlanNode[]
}

export interface GuidanceView {
  level: Guidance
  step?: { id: string; title: string; instructions?: string; why?: string }
  message: string
}

export interface SessionView {
  title: string
  briefing?: string
  timeS: number
  containers: ContainerView[]
  equipment: EquipmentView[]
  places: PlaceView[]
  measurements: Array<{
    id: string
    instrument: string
    subject: string
    display: Record<string, string>
    flags: Record<string, string[]>
    timeS: number
    /** Gel images: each band (lane = well id), and the gel's lanes and length, for drawing the image. */
    bands?: Array<{ lane: string; positionMm: number; intensity: string }>
    gel?: { lanes: string[]; lengthMm: number }
    /** TLC views: the plate's lanes, length and origin, and where the solvent front reached (mm from the origin). */
    tlc?: { lanes: number; lengthMm: number; originMm: number; frontMm: number }
    /** Developed blots: the lanes that were blotted, the gel length they came from, and which lanes hold the prestained marker. */
    blot?: { lanes: number[]; lengthMm: number; markerLanes: number[]; background: number }
    /** Curves against an axis (a real-time PCR's cycles, a melt's temperatures): one series per container, the signal's name, and any threshold or peaks the instrument drew. */
    curves?: { axis: { label: string; unit: string; values: number[] }; signal: string; series: Record<string, number[]>; threshold?: number; peaks?: Record<string, number[]> }
  }>
  notebook: Array<{ field: string; value: unknown }>
  incidents: Array<{ kind: string; severity: string; message: string }>
  steps: StepView[]
  current?: string
  fidelity: number
  refusals: number
  lastRefusal?: Refusal & { op: string }
  /** The latest events, newest last (for animating what just happened). */
  recent: Array<{ index: number; op: string; params: Record<string, unknown>; actor?: string; facts: Record<string, unknown> }>
  finished: boolean
}

export interface SessionSave {
  format: 'lab-session'
  definition: { id: string; version: string }
  options: SessionOptions
  current?: string
  completed: string[]
  history: Array<Intent & { refused?: boolean }>
  decisions: Record<string, string>
  support: { hints: number; rewinds: number; demonstrations: number }
}

export type StartResult = { ok: true; session: LabSession } | { ok: false; message: string; validation?: ValidationReport }

export class LabSession {
  readonly cat: Catalogue
  readonly definition: ExperimentDefinition
  readonly options: SessionOptions
  readonly context: LearningContext
  readonly plan: NonNullable<ReturnType<typeof compile>['plan']>
  readonly reference?: RehearsalReport
  private readonly staged: World
  private readonly roles: Record<string, string>
  private kernel: Kernel
  private runCtx: RunContext
  /** Every intent in order, refused ones too: replaying them reproduces the run exactly. */
  private history: Array<Intent & { refused?: boolean }> = []
  private completed = new Set<string>()
  private currentStep?: string
  private hints = 0
  private rewinds = 0
  private demonstrations = 0
  private lastRefusal?: Refusal & { op: string }
  private result?: LabResult
  /** Technique quality judged so far (demonstrations, collapsed steps, the learner's own technique steps). */
  private quality: QualityResult[] = []
  private demonstrated = new Set<string>()

  private constructor(cat: Catalogue, compiled: ReturnType<typeof compile>, options: SessionOptions) {
    this.cat = cat
    this.definition = compiled.definition!
    this.options = options
    this.plan = compiled.plan!
    this.context = this.plan.context
    this.reference = compiled.rehearsal
    this.staged = clone(compiled.world!)
    this.roles = compiled.roles ?? {}
    this.kernel = this.freshKernel()
    this.runCtx = this.freshRun()
    this.currentStep = this.firstOpenStep()
    this.autoPerformCollapsed()
  }

  /** Compile a definition and open a session on it, or say why it cannot run. */
  static start(input: unknown, cat: Catalogue, options: SessionOptions = {}): StartResult {
    const compiled = compile(input, cat, { ...options, rehearse: options.rehearse ?? true })
    if (!compiled.definition || !compiled.plan || !compiled.world) {
      const first = compiled.validation.findings.find((f) => f.severity === 'error')
      return { ok: false, message: first ? `${first.code}: ${first.message}` : 'The definition could not be compiled', validation: compiled.validation }
    }
    if (compiled.coverage?.verdict === 'not-supported') return { ok: false, message: 'This build cannot run this experiment yet', validation: compiled.validation }
    return { ok: true, session: new LabSession(cat, compiled, options) }
  }

  /** Reopen a saved session: the same compile, then the same intents in the same order. */
  static restore(save: SessionSave, input: unknown, cat: Catalogue): StartResult {
    const started = LabSession.start(input, cat, save.options)
    if (!started.ok) return started
    const s = started.session
    s.replay(save.history)
    s.history = [...save.history]
    for (const id of save.completed) s.completed.add(id)
    s.currentStep = save.current
    Object.assign(s.runCtx.decisions, save.decisions)
    s.hints = save.support.hints
    s.rewinds = save.support.rewinds
    s.demonstrations = save.support.demonstrations
    return started
  }

  save(): SessionSave {
    return {
      format: 'lab-session',
      definition: { id: this.definition.id, version: this.definition.version },
      options: this.options,
      ...(this.currentStep ? { current: this.currentStep } : {}),
      completed: [...this.completed],
      history: this.history.map((h) => ({ ...h })),
      decisions: { ...this.runCtx.decisions },
      support: { hints: this.hints, rewinds: this.rewinds, demonstrations: this.demonstrations },
    }
  }

  get finished(): boolean {
    return this.result !== undefined
  }

  // ---- Acting ----

  /** The operations this lab can perform, as declared in the catalogue (for building controls). */
  operations(): OperationDecl[] {
    return [...this.cat.operations.values()].filter((o) => this.kernel.has(o.id))
  }

  /** Perform an operation as the learner, attributed to the step they are on (or the one given). */
  perform(op: string, params: Record<string, unknown>, step = this.currentStep): ExecuteResult {
    if (this.finished) return { ok: false, refusal: { code: 'FINISHED', message: 'The session has ended' } }
    const intent: Intent = { op, params, actor: 'learner', ...(step ? { step, path: step } : {}) }
    const r = this.kernel.execute(intent)
    this.history.push(r.ok ? intent : { ...intent, refused: true })
    if (r.ok) {
      this.lastRefusal = undefined
      // An operation step's outputs are what later steps and goals refer to (read.out.value).
      const def = step ? this.topStep(step) : undefined
      if (def?.kind === 'operation') this.runCtx.outputs[def.id] = r.outputs
    } else this.lastRefusal = { ...r.refusal, op }
    return r
  }

  /** Check an operation without doing it (to enable or explain a control). */
  check(op: string, params: Record<string, unknown>): Refusal | null {
    return this.kernel.check({ op, params, actor: 'learner' })
  }

  /** Take a decision (once per item for a decision repeated over items). */
  decide(stepId: string, choice: string, item?: string): ExecuteResult {
    const key = item === undefined ? stepId : `${stepId}:${item}`
    this.runCtx.decisions[key] = choice
    return this.perform('core:record', { field: `decision:${key}`, value: choice }, stepId)
  }

  /** Write a value in the notebook. */
  note(field: string, value: unknown): ExecuteResult {
    return this.perform('core:record', { field, value })
  }

  /** Mark the current (or a given) step as finished and move on to the next open one. */
  completeStep(stepId = this.currentStep): void {
    if (!stepId) return
    if (!this.completed.has(stepId) && !this.demonstrated.has(stepId)) this.judgeTechnique(stepId)
    this.completed.add(stepId)
    this.currentStep = this.firstOpenStep()
    this.autoPerformCollapsed()
  }

  /** Work on another step (the learner may go out of order; the monitor will notice). */
  goTo(stepId: string): void {
    if (this.topStep(stepId)) this.currentStep = stepId
  }

  /** What the learner should do next, at the level of guidance the support profile allows. */
  hint(): GuidanceView {
    this.hints++
    return this.guidance(true)
  }

  guidance(asked = false): GuidanceView {
    const id = this.currentStep
    const step = id ? this.topStep(id) : undefined
    const support = id ? this.plan.support.steps.find((s) => s.step === id) : undefined
    const level: Guidance = asked && support?.guidance === 'none' ? 'objective' : (support?.guidance ?? this.plan.support.profile.guidance)
    if (!step) return { level, message: 'All steps are done. Check your results and finish.' }
    const title = step.title ?? this.titleOf(step)
    const instructions = step.instructions ?? (step.ref ? this.cat.technique(step.ref)?.description : undefined)
    if (level === 'none' || level === 'objective') {
      const objective = (this.definition.context?.objectives ?? []).find((o) => (step.objectives ?? []).includes(o.id))
      return { level, message: objective ? `Aim: ${objective.statement}` : 'Work towards the experiment’s aim.' }
    }
    if (level === 'milestones') return { level, step: { id: step.id, title }, message: `Next: ${title}` }
    const why = level === 'steps-rationale' || level === 'demonstrate' ? step.notes : undefined
    return { level, step: { id: step.id, title, ...(instructions ? { instructions } : {}), ...(why ? { why } : {}) }, message: instructions ? `${title}: ${instructions}` : title }
  }

  /** Let the reference perform a step (the current one by default): a demonstration. */
  demonstrate(stepId = this.currentStep): { ok: boolean; issues: string[] } {
    if (!stepId || this.finished) return { ok: false, issues: ['Nothing to demonstrate'] }
    this.demonstrations++
    const agent = new ReferenceAgent(this.runCtx)
    const before = this.kernel.nextIndex
    const ok = agent.runTopLevelStep(stepId)
    this.captureSince(before)
    this.quality.push(...agent.quality)
    this.demonstrated.add(stepId)
    if (ok) this.completeStep(stepId)
    return { ok, issues: agent.issues.map((i) => i.message) }
  }

  /** Undo the learner's last accepted action (and anything refused after it). */
  rewind(): boolean {
    let i = this.history.length - 1
    while (i >= 0 && (this.history[i].refused || this.history[i].actor !== 'learner')) i--
    if (i < 0) return false
    this.rewinds++
    const keep = this.history.slice(0, i)
    this.kernel = this.freshKernel()
    const decisions = this.runCtx.decisions
    this.runCtx = this.freshRun()
    Object.assign(this.runCtx.decisions, decisions)
    this.replay(keep)
    this.history = keep
    this.lastRefusal = undefined
    return true
  }

  /** End the run and assess it; the result is what MnemoNexus records. */
  finish(status: RunStatus = 'submitted'): { result: LabResult; mnemonexus: Record<string, unknown> } {
    if (!this.result) {
      this.result = assess(this.runCtx, { context: this.context, status, quality: this.quality, hintsUsed: this.hints, rewinds: this.rewinds, demonstrations: this.demonstrations, autoPerformed: [...this.demonstrated] })
    }
    return { result: this.result, mnemonexus: toMnemoNexus(this.result) }
  }

  // ---- Looking ----

  /** Evaluate an expression against the run (for panels that show computed values). */
  evaluate(expression: string): Value {
    return evaluate(expression, runEnv(this.runCtx))
  }

  progress(): MonitorReport {
    return monitor(this.runCtx)
  }

  view(): SessionView {
    const w = this.kernel.world
    const cat = this.cat
    const containers: ContainerView[] = Object.values(w.containers)
      .filter((c) => !c.discarded)
      .map((c) => ({
        id: c.id,
        label: c.label,
        ...(c.userLabel ? { userLabel: c.userLabel } : {}),
        equipment: c.equipment,
        kind: c.kind,
        volumeMl: liquidVolume(c.contents) * 1000,
        capacityMl: c.capacityL * 1000,
        colour: c.kind === 'plate' ? '' : visibleColour(cat, meanLayer(c.contents), c.contents.temperatureK, (s, nm) => epsilon(cat, s, nm)),
        temperatureC: c.contents.temperatureK - 273.15,
        place: c.place,
        ...(c.slot !== undefined ? { slot: c.slot } : {}),
        open: c.open,
        ...(c.supply ? { supply: c.supply } : {}),
        ...(c.role ? { role: c.role } : {}),
        ...(c.plate ? { plate: c.plate } : {}),
        ...(c.position ? { position: c.position } : {}),
        ...(c.wells ? { wells: c.wells } : {}),
        layers: c.contents.layers.length,
        solid: Object.values(c.contents.solid).some((n) => n > 0),
        ...(c.kind === 'container' ? lookOf(cat, c) : {}),
      }))
    const equipment: EquipmentView[] = Object.values(w.equipment).map((e) => {
      const base = { id: e.id, label: e.label, equipment: e.equipment, kind: e.state.kind }
      if (e.state.kind !== 'tool') return base
      const tip = e.state.tip ? (e.state.tip.touched.length ? 'used' : 'fresh') : 'none'
      const needsTip = cat.property(e.equipment, 'needsTip') === true
      return { ...base, tip, ...(needsTip ? { needsTip } : {}), ...(e.state.setVolumeL !== undefined ? { setVolumeUl: e.state.setVolumeL * 1e6 } : {}) } as EquipmentView
    })
    const places: PlaceView[] = Object.values(w.places).map((p) => ({ id: p.id, label: p.label, equipment: p.equipment, temperatureC: p.temperatureK - 273.15, adjustable: p.adjustable }))
    const progress = this.progress()
    const steps = (this.definition.procedure?.steps ?? []).map((s): StepView => {
      const support = this.plan.support.steps.find((x) => x.step === s.id)
      const done = this.completed.has(s.id) || progress.steps.find((p) => p.id === s.id)?.done === true
      const status: StepView['status'] = this.completed.has(s.id) ? 'done' : s.id === this.currentStep ? 'current' : done ? 'done' : this.applicable(s) ? 'pending' : 'skipped'
      const node = this.plan.tree.find((n) => n.id === s.id)
      const instructions = s.instructions ?? (s.ref ? this.cat.technique(s.ref)?.description : undefined)
      return {
        id: s.id,
        title: s.title ?? this.titleOf(s),
        kind: s.kind,
        ...(s.ref ? { ref: s.ref } : {}),
        status,
        ...(instructions ? { instructions } : {}),
        ...(s.objectives ? { objectives: s.objectives } : {}),
        ...(support ? { support } : {}),
        ...(node?.children ? { children: node.children } : {}),
      }
    })
    return {
      title: this.definition.title,
      ...(this.definition.briefing ? { briefing: this.definition.briefing } : {}),
      timeS: w.timeS,
      containers,
      equipment,
      places,
      measurements: w.measurements.map((m) => {
        const gel = m.bands && w.containers[m.subject]?.wells?.length ? w.containers[m.subject] : undefined
        return {
          id: m.id,
          instrument: m.instrument,
          subject: m.subject,
          display: m.display,
          flags: m.flags as Record<string, string[]>,
          timeS: m.timeS,
          ...(m.bands ? { bands: m.bands.map((b) => ({ lane: b.lane, positionMm: b.positionMm, intensity: b.intensity })) } : {}),
          ...(gel ? { gel: { lanes: gel.wells ?? [], lengthMm: Number(this.cat.property(gel.equipment, 'lengthMm') ?? 80) } } : {}),
          ...(m.settings.blot !== undefined && w.containers[m.subject]?.contents.blot
            ? {
                blot: {
                  lanes: [...new Set(w.containers[m.subject].contents.blot!.bands.map((b) => b.lane))].sort((a, b) => a - b),
                  lengthMm: Math.max(65, ...w.containers[m.subject].contents.blot!.bands.map((b) => b.positionMm + 5)),
                  markerLanes: [...new Set(w.containers[m.subject].contents.blot!.bands.filter((b) => b.prestained).map((b) => b.lane))],
                  background: Number(m.settings.background ?? 0),
                },
              }
            : {}),
          ...(m.axis && m.series
            ? {
                curves: {
                  axis: m.axis,
                  signal: String(m.settings.signal ?? m.quantity),
                  series: m.series,
                  ...(typeof m.settings.threshold === 'number' ? { threshold: m.settings.threshold } : {}),
                  ...(m.peaks ? { peaks: m.peaks } : {}),
                },
              }
            : {}),
          ...(m.settings.frontMm !== undefined && w.containers[m.subject]
            ? {
                tlc: {
                  lanes: Number(this.cat.property(w.containers[m.subject].equipment, 'lanes') ?? 5),
                  lengthMm: Number(this.cat.property(w.containers[m.subject].equipment, 'lengthMm') ?? 70),
                  originMm: Number(this.cat.property(w.containers[m.subject].equipment, 'originMm') ?? 10),
                  frontMm: Number(m.settings.frontMm),
                },
              }
            : {}),
        }
      }),
      notebook: w.notebook.map((n) => ({ field: n.field, value: n.value })),
      incidents: w.incidents.map((i) => ({ kind: i.kind, severity: i.severity, message: i.message })),
      steps,
      ...(this.currentStep ? { current: this.currentStep } : {}),
      fidelity: progress.fidelity,
      refusals: this.kernel.attempts.length,
      ...(this.lastRefusal ? { lastRefusal: this.lastRefusal } : {}),
      recent: this.kernel.events.slice(-5).map((e) => ({ index: e.index, op: e.op, params: e.params, ...(e.actor ? { actor: e.actor } : {}), facts: e.facts })),
      finished: this.finished,
    }
  }

  // ---- Internals ----

  private freshKernel(): Kernel {
    const realism = this.options.realism ?? this.definition.variation?.noise ?? this.plan.support.profile.realism
    return createKernel(this.cat, clone(this.staged), realismOptions(realism))
  }

  private freshRun(): RunContext {
    return { kernel: this.kernel, cat: this.cat, def: this.definition, roles: this.roles, outputs: {}, decisions: {} }
  }

  private replay(intents: Array<Intent & { refused?: boolean }>): void {
    for (const intent of intents) {
      const r = this.kernel.execute(intent)
      this.lastRefusal = r.ok ? undefined : { ...r.refusal, op: intent.op }
      if (r.ok && intent.step && this.topStep(intent.step)?.kind === 'operation') this.runCtx.outputs[intent.step] = r.outputs
    }
  }

  /** Record what the kernel did since an event index (a demonstration) in the history. */
  private captureSince(index: number): void {
    const done = [
      ...this.kernel.events.filter((e) => e.index >= index).map((e) => ({ i: e.index, intent: { op: e.op, params: e.params, step: e.step, path: e.path, actor: e.actor } as Intent & { refused?: boolean } })),
      ...this.kernel.attempts.filter((a) => a.index >= index).map((a) => ({ i: a.index, intent: { op: a.op, params: a.params, step: a.step, path: a.path, actor: 'reference', refused: true } as Intent & { refused?: boolean } })),
    ].sort((a, b) => a.i - b.i)
    for (const d of done) this.history.push(d.intent)
  }

  private topStep(id: string): StepDef | undefined {
    return (this.definition.procedure?.steps ?? []).find((s) => s.id === id)
  }

  private applicable(s: StepDef): boolean {
    if (!s.when) return true
    try {
      return truthy(evaluate(s.when, runEnv(this.runCtx)))
    } catch {
      return true
    }
  }

  private firstOpenStep(): string | undefined {
    const done = new Set(this.progress().steps.filter((p) => p.done).map((p) => p.id))
    return (this.definition.procedure?.steps ?? []).find((s) => !this.completed.has(s.id) && !(done.has(s.id) && s.kind === 'decision') && this.applicable(s))?.id
  }

  /** Steps the support profile collapses are performed for the learner (composition model §4.3). */
  private autoPerformCollapsed(): void {
    for (let guard = 0; guard < 50 && this.currentStep; guard++) {
      const support = this.plan.support.steps.find((s) => s.step === this.currentStep)
      if (!support?.collapsed) return
      const agent = new ReferenceAgent(this.runCtx)
      const before = this.kernel.nextIndex
      const id = this.currentStep
      agent.runTopLevelStep(id)
      for (const e of this.kernel.events) if (e.index >= before) e.actor = 'auto'
      this.captureSince(before)
      this.quality.push(...agent.quality)
      this.demonstrated.add(id)
      this.completed.add(id)
      this.currentStep = this.firstOpenStep()
    }
  }

  /**
   * A technique step the learner did by hand: judge its quality criteria with the step's own
   * parameters (criteria that need the technique's internal roles cannot be judged and are skipped).
   */
  private judgeTechnique(stepId: string): void {
    const step = this.topStep(stepId)
    const tech = step?.ref ? this.cat.technique(step.ref) : undefined
    if (!step || !tech?.quality?.length) return
    const env = runEnv(this.runCtx)
    const vars: Record<string, Value> = {}
    for (const [k, spec] of Object.entries(tech.params)) {
      const raw = step.params?.[k] ?? spec.default
      if (raw === undefined) continue
      try {
        vars[k] = (isExpressionValue(raw) ? evaluate(raw, env) : isRecord(raw) ? (raw as Value) : (raw as Value)) as Value
      } catch {
        // An unevaluable parameter leaves criteria that need it unjudged.
      }
    }
    const scoped = childEnv(env, vars)
    for (const c of tech.quality) {
      try {
        this.quality.push({ path: stepId, technique: tech.id, criterion: c.id, statement: c.statement, passed: truthy(evaluate(c.check, scoped)), skills: c.skills ?? [] })
      } catch {
        // Needs a role the learner chose by hand: not judged.
      }
    }
  }

  private titleOf(s: StepDef): string {
    if (s.ref) {
      const t = this.cat.technique(s.ref)
      if (t) return t.label
      const o = this.cat.operations.get(s.ref)
      if (o) return o.label
    }
    if (s.kind === 'decision' && s.prompt) return s.prompt
    return s.id.replace(/-/g, ' ')
  }
}

/** Ids a parameter of a given type can take in this session (for pickers). */
export function choicesFor(view: SessionView, type: string): string[] {
  if (type === 'container') return view.containers.filter((c) => c.kind !== 'plate').map((c) => c.id)
  if (type === 'equipment') return view.equipment.map((e) => e.id)
  if (type === 'place') return [...view.places.map((p) => p.id), ...view.equipment.filter((e) => e.kind === 'instrument').map((e) => e.id)]
  return []
}

/** Gas given off at this rate (mol/s, about 0.5 mL/s) looks like vigorous fizzing. */
const VIGOROUS_GAS_MOL_PER_S = 2e-5

/** The look of a vessel for the bench (ContainerView.look), from appearance(). */
export function lookOf(cat: Catalogue, c: Container): Pick<ContainerView, 'look'> {
  const a = appearance(cat, c, Number(cat.property(c.equipment, 'pathCm') ?? 1.5))
  if (!a) return {}
  const rate = c.gas?.rateMolPerS ?? 0
  return {
    look: {
      liquid: hex(a.rgb),
      clarity: 1 - a.opacity,
      ...(a.sediment ? { sediment: { colour: hex(a.sediment.rgb), fraction: Math.min(1, a.sediment.volumeMl / Math.max(1e-3, liquidVolume(c.contents) * 1000)) } } : {}),
      bubbling: Math.min(1, rate / VIGOROUS_GAS_MOL_PER_S),
    },
  }
}

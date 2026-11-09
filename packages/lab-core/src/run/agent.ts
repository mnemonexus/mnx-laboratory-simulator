// The reference agent: performs a procedure through the kernel with good technique (compilation
// pipeline §4: rehearsal). It interprets the step graph exactly as the runtime will when steps
// are auto-performed, so a definition that rehearses is a definition that can run.
import type { ParamSpec, TechniqueDef } from '../catalogue/types.ts'
import { childEnv, type Env, evaluate, idOf, isIdRef, isQuantity, isRecord, makeEnv, truthy, type Value } from '../expr/evaluate.ts'
import { analyse, isExpressionValue, parseExpression } from '../expr/parse.ts'
import type { StepDef } from '../format/types.ts'
import { refId, toQuantity } from '../kernel/kernel.ts'
import type { ToolState } from '../kernel/state.ts'
import { parseQuantity } from '../units/quantity.ts'
import { type RunContext, runEnv, runFunctions } from './env.ts'

export interface AgentIssue {
  path: string
  code: string
  message: string
  severity: 'error' | 'warning'
}

export interface QualityResult {
  path: string
  technique: string
  criterion: string
  statement: string
  passed: boolean
  skills: string[]
}

export interface Resolution {
  path: string
  purpose: string
  technique: string
  reason: string
}

interface Scope {
  vars: Record<string, Value>
  path: string
  /** Local step outputs inside a technique (step id → outputs). */
  local: Record<string, Record<string, unknown>>
  /** Path of the technique invocation, for events() and quality checks. */
  techniquePath?: string
  topLevel: boolean
}

export class AgentAbort extends Error {}

export class ReferenceAgent {
  readonly issues: AgentIssue[] = []
  readonly quality: QualityResult[] = []
  readonly resolutions: Resolution[] = []
  readonly run: RunContext
  /** Choices to make at decision steps instead of the correct one (a simulated learner). */
  private readonly choices: Record<string, string>
  private fetched = 0

  constructor(run: RunContext, options: { choices?: Record<string, string> } = {}) {
    this.run = run
    this.choices = options.choices ?? {}
  }

  runProcedure(): void {
    const steps = this.run.def.procedure?.steps ?? []
    this.runSteps(steps, { vars: {}, path: '', local: {}, topLevel: true })
  }

  /** Perform one top-level step: a demonstration, or a step the support profile collapses. */
  runTopLevelStep(stepId: string): boolean {
    const step = (this.run.def.procedure?.steps ?? []).find((s) => s.id === stepId)
    if (!step) return false
    const before = this.issues.length
    this.runSteps([step], { vars: {}, path: '', local: {}, topLevel: true })
    return !this.issues.slice(before).some((i) => i.severity === 'error')
  }

  // ---- Environment ----

  private env(scope: Scope): Env {
    const base = runEnv(this.run)
    // Parameters, roles and loop variables win over local step outputs of the same name.
    const vars: Record<string, Value> = {}
    for (const [id, out] of Object.entries(scope.local)) vars[id] = { id, out } as Value
    Object.assign(vars, scope.vars)
    return makeEnv(vars, scope.techniquePath ? runFunctions(this.run, { path: scope.techniquePath }) : {}, base)
  }

  private issue(path: string, code: string, message: string, severity: AgentIssue['severity'] = 'error'): void {
    this.issues.push({ path, code, message, severity })
  }

  /** Step ids whose execution failed: steps that need their outputs are skipped, not failed again. */
  private readonly failed = new Set<string>()

  private evalValue(value: unknown, env: Env, path: string): unknown {
    if (isExpressionValue(value)) {
      try {
        return evaluate(value, env)
      } catch (e) {
        const message = (e as Error).message
        const missing = /"([^"]+)" has no value yet/.exec(message)?.[1]
        if (missing && this.failed.has(missing)) this.issue(path, 'SKIPPED', `Skipped: it needs "${missing}", which failed`, 'warning')
        else this.issue(path, 'EXPRESSION', message)
        throw new AgentAbort()
      }
    }
    if (Array.isArray(value)) return value.map((v) => this.evalValue(v, env, path))
    if (isRecord(value)) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[k] = this.evalValue(v, env, path)
      return out
    }
    return value
  }

  private evalParams(params: Record<string, unknown> | undefined, env: Env, path: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(params ?? {})) out[k] = this.evalValue(v, env, `${path}/params/${k}`)
    return out
  }

  private predicate(expr: string, env: Env, path: string): boolean {
    try {
      return truthy(evaluate(expr, env))
    } catch (e) {
      this.issue(path, 'EXPRESSION', (e as Error).message)
      return false
    }
  }

  // ---- Steps ----

  private runSteps(steps: StepDef[], scope: Scope): void {
    for (const step of order(steps)) {
      const before = this.issues.filter((i) => i.severity === 'error').length
      try {
        this.runStep(step, scope)
      } catch (e) {
        if (!(e instanceof AgentAbort)) throw e
      }
      if (this.issues.filter((i) => i.severity === 'error').length > before) this.failed.add(step.id)
    }
  }

  private runStep(step: StepDef, scope: Scope): void {
    const path = scope.path ? `${scope.path}/${step.id}` : step.id
    if (step.forEach) {
      const env = this.env(scope)
      let items: unknown
      try {
        items = evaluate(step.forEach.in, env)
      } catch (e) {
        this.issue(path, 'EXPRESSION', (e as Error).message)
        return
      }
      if (!Array.isArray(items)) {
        this.issue(path, 'NOT-A-LIST', `forEach needs a list`)
        return
      }
      items.forEach((item, i) => {
        const vars = { ...scope.vars, [step.forEach!.var]: item as Value, ...(step.forEach!.index ? { [step.forEach!.index]: i } : {}) }
        this.runBody(step, { ...scope, vars }, `${path}[${i}]`)
      })
      return
    }
    this.runBody(step, scope, path)
  }

  private runBody(step: StepDef, scope: Scope, path: string): void {
    let inner = scope
    if (step.let) {
      const vars = { ...scope.vars }
      for (const [k, expr] of Object.entries(step.let)) vars[k] = this.evalValue(expr, this.env({ ...scope, vars }), path) as Value
      inner = { ...scope, vars }
    }
    if (step.when && !this.predicate(step.when, this.env(inner), `${path}/when`)) return
    if (step.repeat) {
      const max = step.repeat.max ?? 50
      const times = step.repeat.times !== undefined ? Number(this.evalValue(step.repeat.times, this.env(inner), path)) : undefined
      for (let i = 0; i < (times ?? max); i++) {
        this.dispatch(step, inner, `${path}#${i + 1}`)
        if (step.repeat.until && this.predicate(step.repeat.until, this.env(inner), `${path}/repeat`)) return
      }
      if (step.repeat.until) this.issue(path, 'REPEAT-LIMIT', `Stopped after ${max} repeats without reaching the condition`, 'warning')
      return
    }
    this.dispatch(step, inner, path)
  }

  private dispatch(step: StepDef, scope: Scope, path: string): void {
    const env = this.env(scope)
    const save = (outputs: Record<string, unknown>) => {
      if (scope.topLevel) this.run.outputs[step.id] = outputs
      else scope.local[step.id] = outputs
    }
    switch (step.kind) {
      case 'operation': {
        if (!step.ref) return this.issue(path, 'NO-REF', 'An operation step needs a ref')
        if (!this.run.kernel.has(step.ref)) return this.issue(path, 'UNSUPPORTED-OPERATION', `This lab cannot perform ${step.ref}`)
        const params = { ...this.evalParams(step.params, env, path), ...this.bindings(step.bind) }
        save(this.perform(step.ref, params, path))
        return
      }
      case 'technique':
      case 'data':
      case 'design': {
        if (!step.ref) return this.issue(path, 'NO-REF', `A ${step.kind} step needs a ref`)
        if (!this.run.cat.technique(step.ref) && this.run.kernel.has(step.ref)) {
          save(this.perform(step.ref, { ...this.evalParams(step.params, env, path), ...this.bindings(step.bind) }, path))
          return
        }
        const tech = this.run.cat.technique(step.ref)
        if (!tech) return this.issue(path, 'UNSUPPORTED-TECHNIQUE', `No technique ${step.ref} in this build`)
        save(this.technique(tech, step, env, path))
        return
      }
      case 'purpose': {
        if (!step.ref) return this.issue(path, 'NO-REF', 'A purpose step needs a ref')
        const tech = this.choose(step, path)
        if (!tech) return this.issue(path, 'UNSUPPORTED-PURPOSE', `Nothing in this build achieves ${step.ref}`)
        save(this.technique(tech, step, env, path))
        return
      }
      case 'wait': {
        const duration = step.duration ?? (step.params?.duration as string | undefined)
        if (!duration) return this.issue(path, 'NO-DURATION', 'A wait needs a duration')
        this.perform('core:advance-time', { duration: this.evalValue(duration, env, path) }, path)
        return
      }
      case 'decision': {
        const options = step.options ?? []
        const item = step.forEach ? scope.vars[step.forEach.var] : undefined
        const key = item === undefined ? step.id : `${step.id}:${idOf(item)}`
        let choice: string | undefined = this.choices[key] ?? this.choices[step.id]
        if (choice === undefined && step.correctWhen) {
          try {
            choice = correctOption(step, env)
          } catch (e) {
            this.issue(path, 'EXPRESSION', (e as Error).message)
          }
        }
        choice ??= (step.reference?.choice as string | undefined) ?? options[0]?.id
        if (!choice) return this.issue(path, 'NO-OPTIONS', 'A decision needs options')
        this.run.decisions[key] = choice
        this.perform('core:record', { field: `decision:${key}`, value: choice }, path)
        return
      }
      case 'observe':
        this.perform('core:record', { field: `observation:${step.id}`, value: 'observed' }, path)
        return
      case 'checkpoint':
        return
      case 'offstage': {
        // Time that passes off-stage (overnight growth): the listed containers wait in a place.
        const duration = step.duration ?? (step.params?.duration as string | undefined)
        if (duration) {
          const params = this.evalParams(step.params, env, path)
          const containers = Array.isArray(params.containers) ? params.containers : params.containers ? [params.containers] : []
          const place = params.place
          if (place) for (const c of containers) this.perform('core:place-in', { container: c, place }, path)
          this.perform('core:advance-time', { duration: this.evalValue(duration, env, path) }, path)
          if (place) for (const c of containers) this.perform('core:remove-from', { container: c }, path)
        }
        if (step.outcome?.declared) this.perform('core:record', { field: `offstage:${step.id}`, value: step.outcome.declared }, path)
        else if (!duration) this.issue(path, 'OFFSTAGE-MODEL', `Off-stage model ${step.outcome?.model ?? '?'} is not available yet; the step is narrated without data`, 'warning')
        return
      }
      case 'group':
        this.runSteps(step.steps ?? [], { ...scope, path })
        return
    }
  }

  private bindings(bind: Record<string, string> | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(bind ?? {})) out[k] = this.run.roles[v] ?? v
    return out
  }

  /** Purpose step: pick a technique that provides the purpose and accepts the given parameters. */
  private choose(step: StepDef, path: string): TechniqueDef | undefined {
    const given = new Set([...Object.keys(step.params ?? {}), ...Object.keys(step.bind ?? {})])
    const candidates = this.run.cat
      .providersOf(step.ref!)
      .filter((p) => p.kind === 'technique' && p.status !== 'stub')
      .map((p) => this.run.cat.technique(p.id)!)
    const fits = candidates.find((t) => Object.entries(t.params).every(([name, spec]) => !spec.required || given.has(name)) && [...given].every((g) => g in t.params || g in (t.roles ?? {})))
    const tech = fits ?? candidates[0]
    if (tech) this.resolutions.push({ path, purpose: step.ref!, technique: tech.id, reason: fits ? 'accepts the given parameters' : 'first provider' })
    return tech
  }

  // ---- Techniques ----

  private technique(tech: TechniqueDef, step: StepDef, callerEnv: Env, path: string): Record<string, unknown> {
    const args = this.evalParams(step.params, callerEnv, path)
    const vars: Record<string, Value> = {}
    for (const [name, spec] of Object.entries(tech.params)) {
      const raw = name in args ? args[name] : spec.default
      if (raw === undefined) {
        if (spec.required) {
          this.issue(path, 'MISSING-PARAM', `${tech.id} needs "${name}"`)
          throw new AgentAbort()
        }
        vars[name] = null
        continue
      }
      vars[name] = coerce(raw, spec) as Value
    }
    for (const [k, v] of Object.entries(args)) if (!(k in vars)) vars[k] = v as Value
    const bound = this.bindings(step.bind)
    const scope: Scope = { vars, path, local: {}, techniquePath: path, topLevel: false }
    for (const [name, role] of Object.entries(tech.roles ?? {})) {
      if (name in bound) {
        vars[name] = bound[name] as Value
        continue
      }
      if (name in args && args[name] !== null && args[name] !== undefined) continue
      vars[name] = this.allocate(name, role, this.env(scope), path) as Value
    }
    for (const [name, expr] of Object.entries(tech.derived ?? {})) vars[name] = this.evalValue(expr, this.env(scope), `${path}/derived/${name}`) as Value
    const errorsBefore = this.issues.filter((i) => i.severity === 'error').length
    this.runSteps(tech.steps, scope)
    if (this.issues.filter((i) => i.severity === 'error').length > errorsBefore) throw new AgentAbort()
    const outputs: Record<string, unknown> = {}
    const env = this.env(scope)
    for (const [name, expr] of Object.entries(tech.outputs ?? {})) {
      try {
        outputs[name] = this.evalValue(expr, env, `${path}/outputs/${name}`)
      } catch {
        outputs[name] = null
      }
    }
    for (const c of tech.quality ?? []) {
      this.quality.push({ path, technique: tech.id, criterion: c.id, statement: c.statement, passed: this.predicate(c.check, env, `${path}/quality/${c.id}`), skills: c.skills ?? [] })
    }
    return outputs
  }

  /** Fill a technique role the step did not bind: fetch vessels, find instruments and places. */
  private allocate(name: string, role: NonNullable<TechniqueDef['roles']>[string], env: Env, path: string): unknown {
    const world = this.run.kernel.world
    const cat = this.run.cat
    const req = role.requires ?? {}
    if (role.kind === 'container') {
      const model = role.prefer?.[0] ?? req.class
      if (!model) {
        this.issue(path, 'ROLE', `Role "${name}" names no container`)
        throw new AgentAbort()
      }
      const count = role.count ? Number(this.evalValue(role.count, env, path)) : 1
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const id = `${path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}-${name}-${i + 1}`
        const r = this.perform('core:fetch', { equipment: model, id, label: `${name} ${i + 1}` }, path)
        ids.push(String(r.container ?? id))
        this.fetched++
      }
      return role.count ? ids : ids[0]
    }
    if (role.kind === 'equipment') {
      const resolved: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(req)) resolved[k] = isExpressionValue(v) ? this.evalValue(v, env, path) : v
      const candidates = Object.values(world.equipment).filter((e) => cat.meets(e.equipment, resolved))
      const preferred = (role.prefer ?? []).map((p) => candidates.find((c) => cat.isA(c.equipment, p))).find(Boolean) ?? candidates[0]
      if (!preferred) {
        this.issue(path, 'NO-EQUIPMENT', `Nothing in the lab fills role "${name}" (${JSON.stringify(req)})`)
        throw new AgentAbort()
      }
      return preferred.id
    }
    if (role.kind === 'place') {
      const t = req.temperature ? toQuantity(this.evalValue(req.temperature, env, path)) : undefined
      const places = Object.values(world.places).filter((p) => {
        if (req.purpose && !cat.capabilitiesOf(p.equipment).some((c) => cat.purposeIsA(c.purpose, req.purpose))) return false
        if (t) {
          const caps = cat.capabilitiesOf(p.equipment).filter((c) => !req.purpose || cat.purposeIsA(c.purpose, req.purpose))
          return caps.some((c) => {
            const r = c.params?.temperature
            if (!r) return p.adjustable || Math.abs(p.temperatureK - t.si) < 0.5
            const range = parseQuantity(r)
            return range.kind === 'range' && t.si >= range.lo.si - 1e-9 && t.si <= range.hi.si + 1e-9
          })
        }
        return true
      })
      const exact = places.find((p) => t && Math.abs(p.temperatureK - t.si) < 0.5)
      const pick = exact ?? places[0]
      if (!pick) {
        this.issue(path, 'NO-PLACE', `No place in the lab fills role "${name}" (${JSON.stringify(req)})`)
        throw new AgentAbort()
      }
      return pick.id
    }
    // Materials must be bound by the caller.
    this.issue(path, 'ROLE', `Role "${name}" must be bound`)
    throw new AgentAbort()
  }

  // ---- Performing operations ----

  private perform(op: string, params: Record<string, unknown>, path: string): Record<string, unknown> {
    if (op === 'core:transfer' && (params.tool === undefined || params.tool === null)) {
      // A burette dispenses through its own tap, and pouring it all (or to the brim) needs no measure; everything
      // else is measured with a pipette.
      const src = this.run.kernel.world.containers[String(refId(params.source))]
      if (params.all === true || params.brim === true || (src && this.run.cat.property(src.equipment, 'dispensing') === true)) return this.exec(op, params, path)
      return this.pipette(params, path)
    }
    return this.exec(op, params, path)
  }

  private exec(op: string, params: Record<string, unknown>, path: string): Record<string, unknown> {
    const localStep = path.split('/').pop()!.replace(/\[\d+\]$/, '').replace(/#\d+$/, '')
    const r = this.run.kernel.execute({ op, params, step: localStep, path, actor: 'reference' })
    if (!r.ok) {
      this.issue(path, `REFUSED-${r.refusal.code}`, `${op}: ${r.refusal.message}`)
      throw new AgentAbort()
    }
    return r.outputs
  }

  /** Choose the smallest pipette whose range covers the volume; a fresh tip for every transfer. */
  private pipette(params: Record<string, unknown>, path: string): Record<string, unknown> {
    const q = toQuantity(params.volume)
    if (!q) {
      this.issue(path, 'BAD-VOLUME', `Not a volume: ${JSON.stringify(params.volume)}`)
      throw new AgentAbort()
    }
    const volumeL = q.si * 1000
    const world = this.run.kernel.world
    const tools = Object.values(world.equipment)
      .filter((e) => e.state.kind === 'tool' && this.run.cat.isA(e.equipment, 'core:pipette'))
      .map((e) => {
        const r = this.run.cat.property(e.equipment, 'range')
        const p = r === undefined ? undefined : parseQuantity(String(r))
        return p && p.kind === 'range' ? { id: e.id, lo: p.lo.si * 1000, hi: p.hi.si * 1000, tips: this.run.cat.property(e.equipment, 'needsTip') === true } : undefined
      })
      .filter((x): x is { id: string; lo: number; hi: number; tips: boolean } => !!x)
      .sort((a, b) => a.hi - b.hi)
    let tool = tools.find((t) => volumeL >= t.lo * (1 - 1e-9) && volumeL <= t.hi * (1 + 1e-9))
    let parts = 1
    if (!tool) {
      const biggest = tools[tools.length - 1]
      if (!biggest || volumeL < tools[0].lo) {
        this.issue(path, 'NO-PIPETTE', `No pipette here can measure ${volumeL * 1e6} µL`)
        throw new AgentAbort()
      }
      tool = biggest
      parts = Math.ceil(volumeL / biggest.hi)
    }
    let last: Record<string, unknown> = {}
    for (let i = 0; i < parts; i++) {
      // A fresh tip for every fill: a tip that has dispensed into liquid must not go back into the
      // source. (The kernel replaces the world on every action, so the tip state is read afresh.)
      if (tool.tips) {
        const state = this.run.kernel.world.equipment[tool.id].state as ToolState
        if (state.tip) this.exec('core:eject-tip', { pipette: tool.id }, path)
        this.exec('core:attach-tip', { pipette: tool.id }, path)
      }
      last = this.exec('core:transfer', { ...params, volume: `${(volumeL / parts) * 1e6} uL`, tool: tool.id }, path)
    }
    return last
  }
}

/**
 * The correct option of a decision. If `correctWhen` mentions `choice`, it is a predicate tested
 * on each option (`choice == gramClass(c)`); otherwise it names the correct option, or is true
 * when the first option is correct and false when the second is.
 */
export function correctOption(step: StepDef, env: Env): string | undefined {
  const options = step.options ?? []
  if (!step.correctWhen) return undefined
  if (analyse(parseExpression(step.correctWhen)).names.has('choice')) {
    return options.find((o) => truthy(evaluate(step.correctWhen!, childEnv(env, { choice: o.id }))))?.id
  }
  const v: Value = evaluate(step.correctWhen, env)
  return typeof v === 'string' ? v : isIdRef(v) ? v.$ref : (truthy(v) ? options[0] : options[1])?.id
}

/** Execution order: listed order, moved later only where `after` requires it. */
export function order(steps: StepDef[]): StepDef[] {
  const ids = new Set(steps.map((s) => s.id))
  const placed = new Set<string>()
  const out: StepDef[] = []
  const pending = [...steps]
  let guard = 0
  while (pending.length > 0 && guard++ < steps.length * steps.length + 10) {
    const i = pending.findIndex((s) => (s.after ?? []).every((d) => !ids.has(d) || placed.has(d)))
    const next = pending.splice(i < 0 ? 0 : i, 1)[0]
    out.push(next)
    placed.add(next.id)
  }
  return out
}

function coerce(value: unknown, spec: ParamSpec): unknown {
  if (spec.type === 'quantity' && typeof value === 'string') return toQuantity(value) ?? value
  if (spec.type === 'list' && Array.isArray(value) && spec.items?.type === 'quantity') return value.map((v) => (typeof v === 'string' ? (toQuantity(v) ?? v) : v))
  if ((spec.type === 'container' || spec.type === 'material' || spec.type === 'equipment' || spec.type === 'place') && value !== null) {
    return refId(value) ?? (isQuantity(value) ? value : idOf(value as Value) ?? value)
  }
  return value
}


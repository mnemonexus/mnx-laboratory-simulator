// Validation of experiment definitions, levels V1–V3 (format spec §18), and normalisation to
// the canonical (transport) form (§19). V4 (rehearsal) lives in the compiler.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { splitRef } from '../catalogue/catalogue.ts'
import type { ParamSpec } from '../catalogue/types.ts'
import { LIBRARY } from '../expr/evaluate.ts'
import { analyse, isExpressionValue, parseExpression } from '../expr/parse.ts'
import { RUN_FUNCTIONS } from '../run/env.ts'
import { clone } from '../kernel/state.ts'
import { childPointer, type Finding, getAtPointer, hasErrors, setAtPointer, type ValidationLevel } from '../schema/findings.ts'
import { validate as validateSchema } from '../schema/schema.ts'
import { parseQuantity } from '../units/quantity.ts'
import { type Dim, DIMENSIONS, type DimensionName, sameDim } from '../units/units.ts'
import { FORMATS } from './formats.ts'
import { DEFINITION_DEFS, definitionSchema } from './schema.ts'
import { type ExperimentDefinition, FORMAT_VERSION, type StepDef, type SupplyDef } from './types.ts'

/** Functions an expression may call: the core library, iteration forms and the run environment. */
export const KNOWN_FUNCTIONS = new Set<string>([
  ...Object.keys(LIBRARY),
  'all', 'any', 'exists', 'count', 'filter', 'map', 'sum', 'mean',
  ...RUN_FUNCTIONS,
])

export interface ValidationReport {
  report: 'lab-validation'
  definition: { id?: string; version?: string }
  levels: ValidationLevel[]
  findings: Finding[]
  summary: { errors: number; warnings: number; info: number }
}

const f = (level: ValidationLevel, severity: Finding['severity'], name: string, path: string, message: string, data?: Record<string, unknown>): Finding => ({
  code: `ED-${level}-${name}`,
  level,
  severity,
  path,
  message,
  ...(data ? { data } : {}),
})

export function report(def: unknown, findings: Finding[], levels: ValidationLevel[]): ValidationReport {
  const d = (def ?? {}) as { id?: string; version?: string }
  const summary = { errors: 0, warnings: 0, info: 0 }
  for (const x of findings) {
    if (x.severity === 'error') summary.errors++
    else if (x.severity === 'warning') summary.warnings++
    else summary.info++
  }
  return { report: 'lab-validation', definition: { id: d.id, version: d.version }, levels, findings, summary }
}

/** V1: structure, types, units and identifier syntax. */
export function validateV1(def: unknown): Finding[] {
  const out = validateSchema(def, definitionSchema, { prefix: 'ED', formats: FORMATS, defs: DEFINITION_DEFS })
  const version = (def as { formatVersion?: unknown })?.formatVersion
  if (typeof version === 'string' && /^\d+\.\d+$/.test(version)) {
    const [major, minor] = version.split('.').map(Number)
    const [ourMajor, ourMinor] = FORMAT_VERSION.split('.').map(Number)
    if (major !== ourMajor) out.push(f('V1', 'error', 'FORMAT-VERSION', '/formatVersion', `Format ${version} needs a migration; this framework reads ${FORMAT_VERSION}`))
    else if (minor > ourMinor) out.push(f('V1', 'info', 'NEWER-MINOR', '/formatVersion', `Format ${version} is newer than ${FORMAT_VERSION}: unknown fields are kept and ignored`))
  }
  return out
}

/** Every step with its JSON Pointer, depth-first. */
export function allSteps(def: ExperimentDefinition): Array<{ step: StepDef; path: string }> {
  const out: Array<{ step: StepDef; path: string }> = []
  const walk = (steps: StepDef[] | undefined, base: string) => {
    ;(steps ?? []).forEach((s, i) => {
      const path = `${base}/${i}`
      out.push({ step: s, path })
      if (s.steps) walk(s.steps, `${path}/steps`)
    })
  }
  walk(def.procedure?.steps, '/procedure/steps')
  return out
}

function suppliesWithPaths(def: ExperimentDefinition): Array<{ s: SupplyDef; path: string }> {
  return [
    ...(def.materials?.supplies ?? []).map((s, i) => ({ s, path: `/materials/supplies/${i}` })),
    ...(def.materials?.samples ?? []).map((s, i) => ({ s, path: `/materials/samples/${i}` })),
  ]
}

/** V2: every reference resolves in the catalogue (unknown capabilities become gap candidates). */
export function validateV2(def: ExperimentDefinition, cat: Catalogue): Finding[] {
  const out: Finding[] = []
  const localSubstances = new Set((def.materials?.substances ?? []).map((s) => s.id))
  const supplyIds = new Set(suppliesWithPaths(def).map((x) => x.s.id))

  ;(def.materials?.substances ?? []).forEach((s, i) => {
    const path = `/materials/substances/${i}`
    if (s.ref && !cat.substances.has(s.ref)) out.push(f('V2', 'error', 'UNKNOWN-SUBSTANCE', `${path}/ref`, `No substance "${s.ref}" in the catalogue`, { gap: { kind: 'substance', id: s.ref } }))
    if (!s.ref && !s.inline) out.push(f('V2', 'error', 'EMPTY-SUBSTANCE', path, `Substance "${s.id}" needs ref or inline`))
  })
  for (const { s, path } of suppliesWithPaths(def)) {
    const checkSubstance = (sub: string, p: string) => {
      if (localSubstances.has(sub) || cat.substances.has(sub)) return
      out.push(f('V2', 'error', 'UNKNOWN-SUBSTANCE', p, `"${sub}" is neither a material of this definition nor a catalogue substance`, { gap: { kind: 'substance', id: sub } }))
    }
    ;(s.contains ?? []).forEach((c, j) => checkSubstance(c.substance, `${path}/contains/${j}/substance`))
    ;(s.truth?.contains ?? []).forEach((c, j) => checkSubstance(c.substance, `${path}/truth/contains/${j}/substance`))
    if (s.preparation && !cat.preparations.has(s.preparation)) out.push(f('V2', 'error', 'UNKNOWN-PREPARATION', `${path}/preparation`, `No preparation "${s.preparation}"`, { gap: { kind: 'preparation', id: s.preparation } }))
    if (s.solvent && !cat.substances.has(s.solvent) && !localSubstances.has(s.solvent)) out.push(f('V2', 'error', 'UNKNOWN-SUBSTANCE', `${path}/solvent`, `Unknown solvent "${s.solvent}"`))
    if (s.container && !cat.equipment.has(s.container)) out.push(f('V2', 'error', 'UNKNOWN-EQUIPMENT', `${path}/container`, `No container "${s.container}"`, { gap: { kind: 'equipment', id: s.container } }))
    else if (s.container && !cat.isA(s.container, 'core:container')) out.push(f('V2', 'error', 'NOT-A-CONTAINER', `${path}/container`, `"${s.container}" is not a container`))
  }
  ;(def.materials?.waste ?? []).forEach((w, i) => {
    if (!cat.isWasteStream(w.stream)) out.push(f('V2', 'error', 'UNKNOWN-WASTE-STREAM', `/materials/waste/${i}/stream`, `No waste stream "${w.stream}"`))
    for (const a of w.accepts ?? []) if (!supplyIds.has(a)) out.push(f('V2', 'warning', 'UNKNOWN-MATERIAL', `/materials/waste/${i}/accepts`, `"${a}" is not a supply of this definition`))
  })
  ;(def.equipment?.roles ?? []).forEach((r, i) => {
    const cls = r.requires.class
    if (typeof cls === 'string' && !cat.equipment.has(cls)) out.push(f('V2', 'warning', 'UNKNOWN-EQUIPMENT', `/equipment/roles/${i}/requires/class`, `No equipment class "${cls}" (gap candidate)`, { gap: { kind: 'equipment', id: cls } }))
    const purpose = r.requires.purpose
    if (typeof purpose === 'string') {
      if (!cat.purposes.has(purpose)) out.push(f('V2', 'error', 'UNKNOWN-PURPOSE', `/equipment/roles/${i}/requires/purpose`, `No purpose "${purpose}"`))
      else if (!cat.providersOf(purpose).some((p) => p.kind === 'equipment' && p.status !== 'stub')) out.push(f('V2', 'warning', 'NO-PROVIDER', `/equipment/roles/${i}/requires/purpose`, `No equipment here provides ${purpose} (gap candidate)`, { gap: { kind: 'equipment', purpose } }))
    }
  })
  const roleIds = new Set((def.equipment?.roles ?? []).map((r) => r.id))
  ;(def.equipment?.prescribed ?? []).forEach((p, i) => {
    const path = `/equipment/prescribed/${i}`
    if (!roleIds.has(p.role) && !p.class && !p.model) out.push(f('V2', 'error', 'UNKNOWN-ROLE', `${path}/role`, `No equipment role "${p.role}", and no class or model to imply one`))
    for (const key of ['class', 'model'] as const) {
      const id = p[key]
      if (id && !cat.equipment.has(id)) out.push(f('V2', 'warning', 'UNKNOWN-EQUIPMENT', `${path}/${key}`, `"${id}" is not in this build: the compiler will look for a substitute`, { gap: { kind: 'equipment', id } }))
    }
  })
  for (const { step, path } of allSteps(def)) {
    const ref = step.ref
    if (!ref) continue
    if (step.kind === 'operation' && !cat.operations.has(ref)) out.push(f('V2', 'warning', 'UNKNOWN-OPERATION', `${path}/ref`, `No operation "${ref}" (gap candidate)`, { gap: { kind: 'operation', id: ref } }))
    if (['technique', 'data', 'design'].includes(step.kind)) {
      if (!cat.technique(ref) && !cat.operations.has(ref)) out.push(f('V2', 'warning', 'UNKNOWN-TECHNIQUE', `${path}/ref`, `No technique "${ref}" (gap candidate)`, { gap: { kind: 'technique', id: splitRef(ref).id } }))
      else {
        const pinned = splitRef(ref).version
        if (pinned !== undefined && !cat.technique(ref)) out.push(f('V2', 'error', 'VERSION', `${path}/ref`, `${ref}: version ${pinned} is not available`))
      }
    }
    if (step.kind === 'purpose') {
      if (!cat.purposes.has(ref)) out.push(f('V2', 'error', 'UNKNOWN-PURPOSE', `${path}/ref`, `No purpose "${ref}"`))
      else if (!cat.providersOf(ref).some((p) => p.kind === 'technique' && p.status !== 'stub')) out.push(f('V2', 'warning', 'NO-PROVIDER', `${path}/ref`, `No technique here achieves ${ref} (gap candidate)`, { gap: { kind: 'technique', purpose: ref } }))
    }
    if (step.kind === 'offstage' && step.outcome?.model && !cat.models.has(step.outcome.model)) {
      out.push(f('V2', 'warning', 'UNKNOWN-MODEL', `${path}/outcome/model`, `No model "${step.outcome.model}" (gap candidate)`, { gap: { kind: 'model', id: step.outcome.model } }))
    }
  }
  const skillPaths: Array<[string, string]> = []
  ;(def.context?.objectives ?? []).forEach((o, i) => (o.skills ?? []).forEach((s, j) => skillPaths.push([s, `/context/objectives/${i}/skills/${j}`])))
  ;(def.context?.prerequisites?.skills ?? []).forEach((s, j) => skillPaths.push([s, `/context/prerequisites/skills/${j}`]))
  for (const [s, path] of skillPaths) if (!cat.skills.has(s)) out.push(f('V2', 'warning', 'UNKNOWN-SKILL', path, `No skill "${s}" in the catalogue`))
  ;(def.requires?.capabilities ?? []).forEach((c, i) => {
    const path = `/requires/capabilities/${i}`
    if (typeof c.technique === 'string' && !cat.technique(c.technique)) out.push(f('V2', 'warning', 'UNKNOWN-TECHNIQUE', path, `Declared dependency ${c.technique} is not in this build`))
    if (typeof c.purpose === 'string' && !cat.purposes.has(c.purpose)) out.push(f('V2', 'warning', 'UNKNOWN-PURPOSE', path, `Declared dependency ${c.purpose} is not in the taxonomy`))
    if (typeof c.processModel === 'string' && !cat.models.has(c.processModel)) out.push(f('V2', 'warning', 'UNKNOWN-MODEL', path, `Declared dependency ${c.processModel} is not in this build`))
  })
  if (def.data?.report && !cat.resolve(def.data.report.template)) out.push(f('V2', 'info', 'UNKNOWN-TEMPLATE', '/data/report/template', `Report template "${def.data.report.template}" is not in this build yet`))
  return out
}

/** V3: semantics — ids, dependencies, expressions, parameters, units and capacities. */
export function validateV3(def: ExperimentDefinition, cat: Catalogue): Finding[] {
  const out: Finding[] = []
  const steps = allSteps(def)
  // Unique ids per namespace.
  const seen = new Map<string, string>()
  const unique = (id: string, path: string, kind: string) => {
    const key = `${kind}:${id}`
    if (seen.has(key)) out.push(f('V3', 'error', 'DUPLICATE-ID', path, `${kind} id "${id}" is also used at ${seen.get(key)}`))
    else seen.set(key, path)
  }
  steps.forEach(({ step, path }) => unique(step.id, `${path}/id`, 'step'))
  suppliesWithPaths(def).forEach(({ s, path }) => unique(s.id, `${path}/id`, 'material'))
  ;(def.materials?.substances ?? []).forEach((s, i) => unique(s.id, `/materials/substances/${i}/id`, 'material'))
  ;(def.context?.objectives ?? []).forEach((o, i) => unique(o.id, `/context/objectives/${i}/id`, 'objective'))
  ;(def.equipment?.roles ?? []).forEach((r, i) => unique(r.id, `/equipment/roles/${i}/id`, 'role'))

  // Dependencies resolve and are acyclic (within each sibling list).
  const stepIds = new Set(steps.map((s) => s.step.id))
  for (const { step, path } of steps) {
    for (const a of step.after ?? []) if (!stepIds.has(a)) out.push(f('V3', 'error', 'UNKNOWN-STEP', `${path}/after`, `"${a}" is not a step`))
    if (step.session && !(def.procedure?.sessions ?? []).some((s) => s.id === step.session)) out.push(f('V3', 'error', 'UNKNOWN-SESSION', `${path}/session`, `No session "${step.session}"`))
    for (const o of step.objectives ?? []) if (!(def.context?.objectives ?? []).some((x) => x.id === o)) out.push(f('V3', 'error', 'UNKNOWN-OBJECTIVE', `${path}/objectives`, `No objective "${o}"`))
    for (const opt of step.options ?? []) if (opt.then && !stepIds.has(opt.then)) out.push(f('V3', 'error', 'UNKNOWN-STEP', `${path}/options`, `Option "${opt.id}" leads to unknown step "${opt.then}"`))
  }
  const cycle = findCycle(steps.map((s) => s.step))
  if (cycle) out.push(f('V3', 'error', 'CYCLE', '/procedure/steps', `Steps depend on each other in a cycle: ${cycle.join(' → ')}`))

  // Expressions: syntax (V1 checked strings with a format), calls to known functions.
  const exprs: Array<[string, string]> = []
  for (const { step, path } of steps) {
    for (const key of ['when', 'correctWhen'] as const) if (step[key]) exprs.push([step[key]!, `${path}/${key}`])
    if (step.repeat?.until) exprs.push([step.repeat.until, `${path}/repeat/until`])
    if (step.forEach) exprs.push([step.forEach.in, `${path}/forEach/in`])
    for (const [k, v] of Object.entries(step.params ?? {})) collectExpressions(v, `${path}/params/${k}`, exprs)
  }
  ;(def.goals?.predicates ?? []).forEach((g, i) => exprs.push([g.check, `/goals/predicates/${i}/check`]))
  ;(def.goals?.expectedObservations ?? []).forEach((g, i) => g.check && exprs.push([g.check, `/goals/expectedObservations/${i}/check`]))
  ;(def.assessment?.criteria ?? []).forEach((c, i) => exprs.push([c.check, `/assessment/criteria/${i}/check`]))
  ;(def.assessment?.validity ?? []).forEach((v, i) => exprs.push([v.when, `/assessment/validity/${i}/when`]))
  ;(def.variation?.constraints ?? []).forEach((c, i) => exprs.push([c, `/variation/constraints/${i}`]))
  for (const [expr, path] of exprs) {
    let node
    try {
      node = parseExpression(expr)
    } catch (e) {
      out.push(f('V3', 'error', 'EXPRESSION', path, (e as Error).message))
      continue
    }
    for (const name of analyse(node).calls.keys()) {
      if (!KNOWN_FUNCTIONS.has(name)) out.push(f('V3', 'warning', 'UNKNOWN-FUNCTION', path, `Unknown function "${name}" (it will fail at run time)`, { function: name }))
    }
  }

  // Parameters against the referenced operation or technique.
  for (const { step, path } of steps) {
    if (!step.ref || !['operation', 'technique', 'data', 'design'].includes(step.kind)) continue
    const tech = cat.technique(step.ref)
    const op = cat.operations.get(splitRef(step.ref).id)
    const specs: Record<string, ParamSpec> | undefined = tech?.params ?? op?.params
    if (!specs) continue
    const roles = new Set(Object.keys(tech?.roles ?? {}))
    const given = { ...(step.params ?? {}) }
    for (const [name, value] of Object.entries(given)) {
      const spec = specs[name]
      if (!spec) {
        if (!roles.has(name)) out.push(f('V3', 'warning', 'UNKNOWN-PARAM', `${path}/params/${name}`, `${step.ref} has no parameter "${name}"`))
        continue
      }
      checkLiteral(value, spec, `${path}/params/${name}`, out)
    }
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.required && spec.default === undefined && !(name in given) && !(step.bind && name in step.bind)) {
        out.push(f('V3', 'error', 'MISSING-PARAM', `${path}/params`, `${step.ref} needs "${name}"`, { param: name }))
      }
    }
    for (const b of Object.keys(step.bind ?? {})) if (!roles.has(b) && !(b in specs)) out.push(f('V3', 'warning', 'UNKNOWN-ROLE', `${path}/bind/${b}`, `${step.ref} has no role "${b}"`))
  }

  // Materials: concentrations are concentrations; amounts fit their containers.
  for (const { s, path } of suppliesWithPaths(def)) {
    ;(s.contains ?? []).forEach((c, j) => {
      const given = (['conc', 'count', 'mass'] as const).filter((k) => c[k] !== undefined)
      if (given.length !== 1 && !(given.length === 0 && c.purity !== undefined)) {
        out.push(f('V3', 'error', 'COMPONENT-AMOUNT', `${path}/contains/${j}`, `Give exactly one of conc, count or mass for "${c.substance}"`))
      }
      if (typeof c.mass === 'string') {
        const m = safeQuantity(c.mass)
        if (m && !sameDim(m, DIMENSIONS.mass)) out.push(f('V3', 'error', 'UNIT-MISMATCH', `${path}/contains/${j}/mass`, `"${c.mass}" is not a mass`))
      }
      if (typeof c.conc !== 'string') return
      const q = safeQuantity(c.conc)
      if (q && !(sameDim(q, DIMENSIONS.molarConcentration) || sameDim(q, DIMENSIONS.massConcentration) || sameDim(q, DIMENSIONS.numberConcentration) || q.every((x) => x === 0))) {
        out.push(f('V3', 'error', 'UNIT-MISMATCH', `${path}/contains/${j}/conc`, `"${c.conc}" is not a concentration`))
      }
    })
    if (s.amount && s.container && cat.equipment.has(s.container)) {
      const cap = cat.property(s.container, 'capacity')
      const amount = safeValue(s.amount)
      const capacity = cap === undefined ? undefined : safeValue(String(cap))
      if (amount && capacity && sameDim(amount.dim, DIMENSIONS.volume) && amount.si > capacity.si * (1 + 1e-9)) {
        out.push(f('V3', 'error', 'VOLUME-EXCEEDS-CAPACITY', `${path}/amount`, `${s.amount} does not fit in ${s.container} (capacity ${cap})`, { requested: s.amount, capacity: cap }))
      }
    }
  }

  // Cross-references among goals, objectives, criteria and evidence.
  const goalIds = new Set((def.goals?.predicates ?? []).map((g) => g.id))
  const objectiveIds = new Set((def.context?.objectives ?? []).map((o) => o.id))
  ;(def.context?.objectives ?? []).forEach((o, i) => {
    if (o.goal && !goalIds.has(o.goal)) out.push(f('V3', 'error', 'UNKNOWN-GOAL', `/context/objectives/${i}/goal`, `No goal "${o.goal}"`))
  })
  ;(def.assessment?.criteria ?? []).forEach((c, i) => {
    if (c.objective && !objectiveIds.has(c.objective)) out.push(f('V3', 'error', 'UNKNOWN-OBJECTIVE', `/assessment/criteria/${i}/objective`, `No objective "${c.objective}"`))
  })
  ;(def.assessment?.evidence?.checkpoints ?? []).forEach((c, i) => {
    if (!stepIds.has(c)) out.push(f('V3', 'error', 'UNKNOWN-STEP', `/assessment/evidence/checkpoints/${i}`, `No step "${c}"`))
  })
  // Every objective should be assessable: a goal, a criterion, or a step that serves it.
  ;(def.context?.objectives ?? []).forEach((o, i) => {
    const linked =
      !!o.goal ||
      (def.assessment?.criteria ?? []).some((c) => c.objective === o.id) ||
      steps.some(({ step }) => (step.objectives ?? []).includes(o.id)) ||
      (o.skills ?? []).length > 0
    if (!linked) out.push(f('V3', 'warning', 'OBJECTIVE-UNASSESSED', `/context/objectives/${i}`, `Objective "${o.id}" has no goal, criterion, step or skill to assess it by`))
  })
  ;(def.variation?.params ?? []).forEach((v, i) => {
    if (getAtPointer(def, v.path) === undefined) out.push(f('V3', 'error', 'UNKNOWN-PATH', `/variation/params/${i}/path`, `Nothing at ${v.path}`))
  })
  ;(def.provenance?.annotations ?? []).forEach((a, i) => {
    if (getAtPointer(def, a.path) === undefined) out.push(f('V3', 'warning', 'UNKNOWN-PATH', `/provenance/annotations/${i}/path`, `Nothing at ${a.path}`))
    if (a.source && !(def.provenance?.sources ?? []).some((s) => s.id === a.source)) out.push(f('V3', 'error', 'UNKNOWN-SOURCE', `/provenance/annotations/${i}/source`, `No source "${a.source}"`))
  })
  return out
}

function collectExpressions(v: unknown, path: string, out: Array<[string, string]>): void {
  if (isExpressionValue(v)) out.push([v, path])
  else if (Array.isArray(v)) v.forEach((x, i) => collectExpressions(x, childPointer(path, i), out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) collectExpressions(x, childPointer(path, k), out)
}

function safeQuantity(text: string): Dim | undefined {
  try {
    const p = parseQuantity(text)
    return p.kind === 'range' ? p.lo.dim : p.q.dim
  } catch {
    return undefined
  }
}

function safeValue(text: string) {
  try {
    const p = parseQuantity(text)
    return p.kind === 'range' ? undefined : p.q
  } catch {
    return undefined
  }
}

function checkLiteral(value: unknown, spec: ParamSpec, path: string, out: Finding[]): void {
  if (isExpressionValue(value) || value === null || value === undefined) return
  if (spec.type === 'quantity') {
    if (typeof value !== 'string') {
      out.push(f('V3', 'error', 'PARAM-TYPE', path, `Expected a quantity such as "25 uL"`))
      return
    }
    let p
    try {
      p = parseQuantity(value)
    } catch (e) {
      out.push(f('V3', 'error', 'QUANTITY', path, (e as Error).message))
      return
    }
    const q = p.kind === 'range' ? p.lo : p.q
    if (spec.dimension && DIMENSIONS[spec.dimension as DimensionName] && !sameDim(q.dim, DIMENSIONS[spec.dimension as DimensionName])) {
      out.push(f('V3', 'error', 'UNIT-MISMATCH', path, `"${value}" is not a ${spec.dimension}`))
    }
  } else if (spec.type === 'enum' && spec.values && typeof value === 'string' && !spec.values.includes(value)) {
    out.push(f('V3', 'error', 'PARAM-VALUE', path, `"${value}" is not one of ${spec.values.join(', ')}`))
  } else if ((spec.type === 'number' || spec.type === 'integer') && typeof value !== 'number') {
    out.push(f('V3', 'error', 'PARAM-TYPE', path, `Expected a number`))
  } else if (spec.type === 'list' && !Array.isArray(value)) {
    out.push(f('V3', 'error', 'PARAM-TYPE', path, `Expected a list`))
  }
}

function findCycle(steps: StepDef[]): string[] | undefined {
  const deps = new Map(steps.map((s) => [s.id, s.after ?? []]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, 'visiting')
    stack.push(id)
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue
      const c = visit(d)
      if (c) return c
    }
    stack.pop()
    state.set(id, 'done')
    return undefined
  }
  for (const s of steps) {
    const c = visit(s.id)
    if (c) return c
  }
  return undefined
}

/** Validate a definition at V1–V3. Stops after V1 if the structure is broken. */
export function validateDefinition(def: unknown, cat: Catalogue): ValidationReport {
  const v1 = validateV1(def)
  if (hasErrors(v1)) return report(def, v1, ['V1'])
  const d = def as ExperimentDefinition
  const findings = [...v1, ...validateV2(d, cat), ...validateV3(d, cat)]
  return report(def, findings, ['V1', 'V2', 'V3'])
}

// ---- Normalisation (canonical / transport form) ----

/**
 * The canonical form: inline `{ vary }` values move to variation.params (the base value becomes
 * the first choice or the range's midpoint), tolerance objects become "x ± y" strings.
 */
export function normalise(input: ExperimentDefinition): ExperimentDefinition {
  const def = clone(input)
  def.language ??= 'en'
  const variation = (def.variation ??= {})
  const params = (variation.params ??= [])
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}/${i}`))
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      for (const [k, x] of Object.entries(o)) {
        const p = `${path}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`
        if (x && typeof x === 'object' && !Array.isArray(x) && 'vary' in (x as object) && Object.keys(x as object).length === 1) {
          const domain = (x as { vary: unknown }).vary as string | Array<string | number>
          params.push({ path: p, domain })
          setAtPointer(def, p, baseValue(domain))
        } else if (x && typeof x === 'object' && !Array.isArray(x) && 'value' in (x as object) && 'tolerance' in (x as object) && Object.keys(x as object).length === 2) {
          const t = x as { value: string; tolerance: string }
          setAtPointer(def, p, `${t.value} ± ${t.tolerance}`)
        } else walk(x, p)
      }
    }
  }
  walk(def.materials, '/materials')
  walk(def.procedure, '/procedure')
  if (params.length === 0) delete variation.params
  if (Object.keys(variation).length === 0) delete def.variation
  return def
}

function baseValue(domain: string | Array<string | number>): string | number {
  if (Array.isArray(domain)) return domain[0]
  const p = parseQuantity(domain)
  if (p.kind !== 'range') return domain
  const unit = p.hi.unit ?? ''
  const mid = (Number(domain.split('..')[0]) + Number(domain.split('..')[1].trim().split(/\s+/)[0])) / 2
  return unit ? `${Number(mid.toPrecision(6))} ${unit}` : mid
}

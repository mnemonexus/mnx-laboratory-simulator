// Data operations (composition model §8.4; data and analysis §1): every step from raw record
// to conclusion is an event, so analysis is replayable, reviewable and assessable.
import { type CalibrationFit, fitFirstOrder, fitFourPL, fitInhibition, fitLinear, fitMichaelisMenten, fitQuadratic, inverse, propagateUncertainty, stats } from '../analysis/analysis.ts'
import { evaluate, isQuantity, isRecord, makeEnv, type Value } from '../expr/evaluate.ts'
import { autoUnit, type Quantity } from '../units/quantity.ts'
import { fromSI, parseUnit, sameDim } from '../units/units.ts'
import { type OpContext, type OpImpl, type OpResult, refId, serialise, toQuantity } from './kernel.ts'

type Params = Record<string, unknown>
import type { MeasurementRecord } from './state.ts'

export interface LayoutEntry {
  well: string
  position: string
  group: string
  /** Index of the item within its group. */
  index: number
  /** The container that goes into the well (null for a reagent-only blank). */
  item: string | null
  role: string
  replicate: number
}

export interface Layout {
  plate: string
  entries: LayoutEntry[]
  groups: string[]
}

export interface GroupMean {
  group: string
  index: number
  item: string | null
  role: string
  wells: string[]
  values: number[]
  mean: number
  sd: number
  n: number
}

export interface CalibrationResult {
  group: string
  index: number
  item: string | null
  y: number
  /** Concentration in the calibration's unit, corrected by the dilution factor. */
  x: number
  unit: string | null
  factor: number
  inRange: boolean
}

export interface StoredFit {
  model: string
  params: Record<string, number>
  r2: number
  n: number
  residuals: number[]
  /** Unit of x as given (the standards' unit). */
  unit: string | null
  /** Unit of a second variable (an inhibitor's concentration), where the model has one. */
  zUnit?: string | null
  xRange: [number, number]
  yRange: [number, number]
}

function record(ctx: OpContext, p: Params): OpResult {
  if (typeof p.field !== 'string' || p.field === '') ctx.refuse('BAD-FIELD', 'A notebook entry needs a field name')
  const source = refId(p.source)
  ctx.world.notebook.push({ event: ctx.eventIndex, field: p.field, value: serialise(p.value), ...(source ? { source } : {}) })
  return { facts: { field: p.field } }
}

function layoutPlate(ctx: OpContext, p: Params): OpResult {
  const plate = ctx.container(p.plate, 'plate')
  if (plate.kind !== 'plate') ctx.refuse('NOT-A-PLATE', `${plate.label} is not a plate`)
  const replicates = typeof p.replicates === 'number' ? p.replicates : 1
  const blanks = typeof p.blanks === 'number' ? p.blanks : 0
  const blankSource = p.blankSource === undefined || p.blankSource === null ? null : refId(p.blankSource) ?? null
  if (!Array.isArray(p.groups)) ctx.refuse('BAD-GROUPS', 'groups must be a list')
  const wells = [...(plate.wells ?? [])]
  if (p.order === 'column') {
    const byCol = (id: string) => {
      const pos = ctx.world.containers[id].position ?? 'A1'
      return Number(pos.slice(1)) * 100 + pos.charCodeAt(0)
    }
    wells.sort((a, b) => byCol(a) - byCol(b))
  }
  const entries: LayoutEntry[] = []
  const groups: string[] = []
  let next = 0
  const take = () => {
    if (next >= wells.length) ctx.refuse('PLATE-FULL', `The layout needs more than the ${wells.length} wells of ${plate.label}`)
    return wells[next++]
  }
  const push = (group: string, index: number, item: string | null, role: string, replicate: number) => {
    const well = take()
    entries.push({ well, position: ctx.world.containers[well].position ?? '', group, index, item, role, replicate })
    ctx.world.containers[well].role = role
  }
  if (blanks > 0) {
    groups.push('blank')
    for (let r = 0; r < blanks; r++) push('blank', 0, blankSource, 'blank', r + 1)
  }
  for (const g of p.groups as unknown[]) {
    if (!isRecord(g)) ctx.refuse('BAD-GROUPS', 'Each group is { group, items, role }')
    const name = String(g.group)
    const items = Array.isArray(g.items) ? g.items : [g.items]
    const role = typeof g.role === 'string' ? g.role : name
    groups.push(name)
    items.forEach((it, i) => {
      const id = refId(it)
      if (!id || !ctx.world.containers[id]) ctx.refuse('NO-CONTAINER', `Group "${name}" names an unknown container`)
      for (let r = 0; r < replicates; r++) push(name, i, id, role, r + 1)
    })
  }
  const layout: Layout = { plate: plate.id, entries, groups }
  return { outputs: { layout }, facts: { wells: entries.length, blanks, replicates } }
}

function recordValues(ctx: OpContext, input: unknown): Record<string, number> {
  if (isRecord(input) && !('id' in input && 'event' in input)) {
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(input)) if (typeof v === 'number') out[k] = v
    return out
  }
  const id = refId(input)
  const rec = ctx.world.measurements.find((m) => m.id === id) as MeasurementRecord | undefined
  if (!rec) ctx.refuse('NO-RECORD', `There is no measurement "${String(id)}"`)
  if (rec.values) return { ...rec.values }
  if (rec.value !== undefined) return { [rec.subject]: rec.value }
  if (rec.series) return Object.fromEntries(Object.entries(rec.series).map(([k, s]) => [k, s[s.length - 1]]))
  return {}
}

function asLayout(ctx: OpContext, v: unknown): Layout {
  if (!isRecord(v) || !Array.isArray(v.entries)) ctx.refuse('BAD-LAYOUT', 'Expected a plate layout')
  return v as unknown as Layout
}

function transform(ctx: OpContext, p: Params): OpResult {
  const op = String(p.op)
  if (op === 'blank-subtract') {
    const values = recordValues(ctx, p.input)
    const layout = asLayout(ctx, p.layout)
    const blankWells = layout.entries.filter((e) => e.role === 'blank').map((e) => e.well)
    const blankValues = blankWells.map((w) => values[w]).filter((x) => typeof x === 'number')
    const blank = blankValues.length ? stats(blankValues).mean : 0
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(values)) out[k] = Number((v - blank).toFixed(6))
    return { outputs: { values: out, blank, blankCount: blankValues.length }, facts: { blankCount: blankValues.length, blank } }
  }
  if (op === 'average-replicates') {
    const values = recordValues(ctx, p.input)
    const layout = asLayout(ctx, p.layout)
    const groups: GroupMean[] = []
    for (const e of layout.entries) {
      let g = groups.find((x) => x.group === e.group && x.index === e.index)
      if (!g) {
        g = { group: e.group, index: e.index, item: e.item, role: e.role, wells: [], values: [], mean: NaN, sd: NaN, n: 0 }
        groups.push(g)
      }
      g.wells.push(e.well)
      if (typeof values[e.well] === 'number') g.values.push(values[e.well])
    }
    for (const g of groups) {
      const s = stats(g.values)
      g.mean = s.mean
      g.sd = s.sd
      g.n = s.n
    }
    return { outputs: { groups }, facts: { groups: groups.length } }
  }
  if (op === 'initial-rate') {
    // Slope of each well's series over [0, window], per minute (master-plan/04 §10).
    const id = refId(p.input)
    const rec = ctx.world.measurements.find((m) => m.id === id)
    if (!rec?.series || !rec.times) ctx.refuse('NOT-A-SERIES', 'An initial rate needs a kinetic read')
    const window = p.window === undefined ? Infinity : ctx.quantity(p.window, 'time', 'window').si
    const values: Record<string, number> = {}
    for (const [well, ys] of Object.entries(rec.series)) {
      const xs: number[] = []
      const yw: number[] = []
      rec.times.forEach((t, i) => {
        if (t <= window + 1e-9) {
          xs.push(t)
          yw.push(ys[i])
        }
      })
      if (xs.length < 2) continue
      values[well] = Number((fitLinear(xs, yw).slope * 60).toFixed(6))
    }
    return { outputs: { values, unit: 'AU/min' }, facts: { window, wells: Object.keys(values).length } }
  }
  if (op === 'scale') {
    const values = recordValues(ctx, p.input)
    const f = typeof p.factor === 'number' ? p.factor : 1
    return { outputs: { values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v * f])) } }
  }
  return ctx.refuse('BAD-TRANSFORM', `Unknown transform "${op}"`)
}

/** Numbers from a list of numbers or quantities, all in the first quantity's unit. */
function numbers(ctx: OpContext, list: unknown, what: string): { xs: number[]; unit: string | null; q?: Quantity } {
  if (!Array.isArray(list)) ctx.refuse('BAD-DATA', `${what} must be a list`)
  const qs = list.map((v) => (typeof v === 'number' ? v : toQuantity(v) ?? v))
  const first = qs.find((v) => isQuantity(v)) as Quantity | undefined
  if (!first) return { xs: qs.map((v) => (typeof v === 'number' ? v : NaN)), unit: null }
  const unit = first.unit ?? autoUnit(first) ?? null
  const u = unit ? parseUnit(unit) : undefined
  return {
    xs: qs.map((v) => {
      if (!isQuantity(v)) return NaN
      if (!sameDim(v.dim, first.dim)) ctx.refuse('BAD-DATA', `${what} mixes units`)
      return u ? fromSI(v.si, u) : v.si
    }),
    unit,
    q: first,
  }
}

function fit(ctx: OpContext, p: Params): OpResult {
  const x = numbers(ctx, p.x, 'x')
  const y = numbers(ctx, p.y, 'y')
  const pairs = x.xs.map((xi, i) => [xi, y.xs[i]] as const).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
  const xs = pairs.map((q) => q[0])
  const ys = pairs.map((q) => q[1])
  const model = String(p.model ?? 'linear')
  let stored: StoredFit
  try {
    if (model === 'inhibition') {
      // Rates at several substrate (x) and inhibitor (z) concentrations, fitted to every mechanism at once.
      const z = numbers(ctx, p.z, 'z')
      const rows = x.xs.map((xi, i) => [xi, z.xs[i], y.xs[i]] as const).filter((r) => r.every(Number.isFinite))
      const f = fitInhibition(rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]))
      const params: Record<string, number> = { vmax: f.best.vmax, km: f.best.km, margin: f.margin }
      if (f.best.ki !== undefined) params.ki = f.best.ki
      if (f.best.kiPrime !== undefined) params.kiPrime = f.best.kiPrime
      for (const m of f.models) params[`aicc-${m.mechanism}`] = m.aicc
      const ys = rows.map((r) => r[2])
      stored = { model: `inhibition-${f.best.mechanism}`, params, r2: f.best.r2, n: f.n, residuals: [], unit: x.unit, zUnit: z.unit, xRange: [Math.min(...rows.map((r) => r[0])), Math.max(...rows.map((r) => r[0]))], yRange: [Math.min(...ys), Math.max(...ys)] }
    } else if (model === 'quadratic') {
      const f = fitQuadratic(xs, ys)
      stored = { model, params: { a: f.a, b: f.b, c: f.c }, r2: f.r2, n: f.n, residuals: f.residuals, unit: x.unit, xRange: [Math.min(...xs), Math.max(...xs)], yRange: [Math.min(...ys), Math.max(...ys)] }
    } else if (model === 'four-pl') {
      const f = fitFourPL(xs, ys)
      stored = { model, params: { a: f.a, d: f.d, c: f.c, b: f.b, seA: f.seA, seD: f.seD, seC: f.seC, seB: f.seB, sy: f.sy }, r2: f.r2, n: f.n, residuals: f.residuals, unit: x.unit, xRange: [Math.min(...xs), Math.max(...xs)], yRange: [Math.min(...ys), Math.max(...ys)] }
    } else if (model === 'first-order') {
      // A kinetic trace, y = b − c·e^(−kx): k is the (pseudo-)first-order rate constant per x unit.
      const f = fitFirstOrder(xs, ys)
      stored = { model, params: { b: f.b, c: f.c, k: f.k, seK: f.seK }, r2: f.r2, n: f.n, residuals: f.residuals, unit: x.unit, xRange: [Math.min(...xs), Math.max(...xs)], yRange: [Math.min(...ys), Math.max(...ys)] }
    } else if (model === 'michaelis-menten') {
      const f = fitMichaelisMenten(xs, ys)
      stored = { model, params: { vmax: f.vmax, km: f.km, seVmax: f.seVmax, seKm: f.seKm }, r2: f.r2, n: f.n, residuals: f.residuals, unit: x.unit, xRange: [Math.min(...xs), Math.max(...xs)], yRange: [Math.min(...ys), Math.max(...ys)] }
    } else {
      const f = fitLinear(xs, ys, model === 'linear-through-origin')
      stored = {
        model: f.model,
        params: { slope: f.slope, intercept: f.intercept, seSlope: f.seSlope, seIntercept: f.seIntercept, sy: f.sy },
        r2: f.r2,
        n: f.n,
        residuals: f.residuals,
        unit: x.unit,
        xRange: [Math.min(...xs), Math.max(...xs)],
        yRange: [Math.min(...ys), Math.max(...ys)],
      }
    }
  } catch (e) {
    return ctx.refuse('FIT-FAILED', (e as Error).message)
  }
  return { outputs: { fit: stored }, facts: { model, r2: stored.r2, n: stored.n } }
}

export function calibrationOf(f: StoredFit): CalibrationFit {
  if (f.model === 'four-pl') return { model: 'four-pl', a: f.params.a, d: f.params.d, c: f.params.c, b: f.params.b, seA: f.params.seA ?? NaN, seD: f.params.seD ?? NaN, seC: f.params.seC ?? NaN, seB: f.params.seB ?? NaN, r2: f.r2, sy: f.params.sy ?? 0, n: f.n, residuals: f.residuals }
  if (f.model === 'quadratic') return { model: 'quadratic', a: f.params.a, b: f.params.b, c: f.params.c, r2: f.r2, sy: 0, n: f.n, residuals: f.residuals }
  return {
    model: f.model === 'linear-through-origin' ? 'linear-through-origin' : 'linear',
    slope: f.params.slope,
    intercept: f.params.intercept,
    seSlope: f.params.seSlope ?? 0,
    seIntercept: f.params.seIntercept ?? 0,
    r2: f.r2,
    sy: f.params.sy ?? 0,
    n: f.n,
    residuals: f.residuals,
  }
}

function interpolate(ctx: OpContext, p: Params): OpResult {
  if (!isRecord(p.fit)) ctx.refuse('BAD-FIT', 'Expected a fit')
  const f = p.fit as unknown as StoredFit
  const cal = calibrationOf(f)
  const points = Array.isArray(p.points) ? p.points : [p.points]
  const factors = isRecord(p.factors) ? (p.factors as Record<string, unknown>) : {}
  const defaultFactor = typeof p.factor === 'number' ? p.factor : 1
  const [ylo, yhi] = f.yRange
  // A four-parameter logistic is only steep enough to read between 10 and 90 % of its rise:
  // nearer the asymptotes a small change in response means a large one in concentration.
  const working = f.model === 'four-pl' ? [f.params.a + 0.1 * (f.params.d - f.params.a), f.params.a + 0.9 * (f.params.d - f.params.a)].sort((m, k) => m - k) : undefined
  const results: CalibrationResult[] = points.map((pt, i) => {
    const y = typeof pt === 'number' ? pt : isRecord(pt) && typeof pt.mean === 'number' ? pt.mean : NaN
    const group = isRecord(pt) && typeof pt.group === 'string' ? pt.group : `point-${i + 1}`
    const factor = typeof factors[group] === 'number' ? (factors[group] as number) : defaultFactor
    const x = inverse(cal, y, f.xRange)
    // Allow a small margin for noise at the ends of the range.
    const margin = (yhi - ylo) * 0.02
    return {
      group,
      index: isRecord(pt) && typeof pt.index === 'number' ? pt.index : 0,
      item: isRecord(pt) && typeof pt.item === 'string' ? pt.item : null,
      y,
      x: x * factor,
      unit: f.unit,
      factor,
      // Beyond a curve's asymptote no concentration gives the response: out of range too.
      inRange: Number.isFinite(x) && (working ? y >= working[0] && y <= working[1] : y >= ylo - margin && y <= yhi + margin),
    }
  })
  return { outputs: { results }, facts: { outOfRange: results.filter((r) => !r.inRange).length } }
}

/**
 * An uncertainty budget: an expression of named inputs, each with a standard uncertainty in its
 * own units, propagated to the result (GUM, first order). Reports the combined and expanded
 * uncertainty and each input's share, so the learner sees which measurement limits the result.
 */
function uncertainty(ctx: OpContext, p: Params): OpResult {
  if (typeof p.expression !== 'string') ctx.refuse('BAD-EXPRESSION', 'An uncertainty budget needs an expression')
  const raw = isRecord(p.values) ? (p.values as Record<string, unknown>) : {}
  const us = isRecord(p.uncertainties) ? (p.uncertainties as Record<string, unknown>) : {}
  const names = Object.keys(raw)
  const values: Value[] = names.map((n) => (typeof raw[n] === 'number' ? (raw[n] as number) : ((toQuantity(raw[n]) ?? raw[n]) as Value)))
  const u = names.map((n, i) => {
    const given = us[n]
    if (given === undefined || given === null) return 0
    const v = values[i]
    const q = typeof given === 'number' ? given : toQuantity(given)
    if (isQuantity(v)) {
      if (!isQuantity(q) || !sameDim(q.dim, v.dim)) ctx.refuse('BAD-UNCERTAINTY', `The uncertainty of ${n} must be in the same kind of unit as ${n}`)
      return (q as Quantity).si
    }
    if (typeof q !== 'number') ctx.refuse('BAD-UNCERTAINTY', `The uncertainty of ${n} must be a plain number, as ${n} is`)
    return q as number
  })
  let unit: Quantity | undefined
  const at = (dev: number[]): number => {
    const vars: Record<string, Value> = {}
    names.forEach((n, i) => {
      const v = values[i]
      vars[n] = isQuantity(v) ? { ...v, si: v.si + dev[i] } : typeof v === 'number' ? v + dev[i] : v
    })
    const r = evaluate(p.expression as string, makeEnv(vars))
    if (isQuantity(r)) {
      unit ??= r
      return r.si
    }
    if (typeof r !== 'number') throw new Error('The expression must give a number or a quantity')
    return r
  }
  let budget
  try {
    budget = propagateUncertainty(at, u)
  } catch (e) {
    return ctx.refuse('BAD-EXPRESSION', (e as Error).message)
  }
  const k = typeof p.coverage === 'number' ? p.coverage : 2
  const asResult = (x: number): Value => (unit ? { ...unit, si: x, unit: unit.unit ?? autoUnit({ ...unit, si: budget.value }) } : x)
  const contributions = Object.fromEntries(budget.contributions.map((c) => [names[c.index], Number(c.share.toFixed(4))]))
  const outputs = {
    value: serialise(asResult(budget.value)),
    u: serialise(asResult(budget.u)),
    U: serialise(asResult(k * budget.u)),
    relative: budget.value !== 0 ? budget.u / Math.abs(budget.value) : null,
    contributions,
    dominant: names[budget.dominant],
  }
  return { outputs, facts: { dominant: outputs.dominant, relative: outputs.relative } }
}

function compute(ctx: OpContext, p: Params): OpResult {
  if (typeof p.expression !== 'string') ctx.refuse('BAD-EXPRESSION', 'compute needs an expression')
  const vars = isRecord(p.values) ? (p.values as Record<string, Value>) : {}
  let value: Value
  try {
    value = evaluate(p.expression, makeEnv(vars))
  } catch (e) {
    return ctx.refuse('BAD-EXPRESSION', (e as Error).message)
  }
  if (typeof p.field === 'string') ctx.world.notebook.push({ event: ctx.eventIndex, field: p.field, value: serialise(value) })
  if (isRecord(p.report) && typeof p.report.quantity === 'string') {
    const sample = refId(p.report.sample)
    ctx.world.notebook.push({ event: ctx.eventIndex, field: `report:${p.report.quantity}:${sample}`, value: serialise(value) })
  }
  return { outputs: { value: serialise(value) }, facts: {} }
}

function conclude(ctx: OpContext, p: Params): OpResult {
  if (typeof p.claim !== 'string') ctx.refuse('BAD-CLAIM', 'A conclusion needs a claim')
  ctx.world.notebook.push({ event: ctx.eventIndex, field: 'conclusion', value: { claim: p.claim, evidence: serialise(p.evidence ?? []), validity: p.validity ?? null } })
  return { facts: { validity: p.validity ?? null } }
}

/** Optionally keep an analysis and its inputs as one atomic, replayable notebook item. */
function recorded(op: string, impl: OpImpl): OpImpl {
  return (ctx, params) => {
    const { recordAs, ...inputs } = params
    if (recordAs !== undefined && (typeof recordAs !== 'string' || !recordAs.trim())) ctx.refuse('BAD-FIELD', 'An analysis needs a notebook name')
    const result = impl(ctx, inputs)
    if (typeof recordAs === 'string') {
      const finite = (v: unknown): boolean => typeof v === 'number' ? Number.isFinite(v) : Array.isArray(v) ? v.every(finite) : v !== null && typeof v === 'object' ? Object.values(v).every(finite) : true
      if (!finite(result.outputs)) ctx.refuse('BAD-DATA', 'This analysis did not produce a finite result')
      ctx.world.notebook.push({ event: ctx.eventIndex, field: recordAs, value: serialise({ kind: 'analysis', operation: op, inputs, outputs: result.outputs ?? {} }) })
    }
    return result
  }
}

export const DATA_OPERATIONS: Record<string, OpImpl> = {
  'core:record': record,
  'core:layout-plate': layoutPlate,
  'core:transform': recorded('core:transform', transform),
  'core:fit': recorded('core:fit', fit),
  'core:interpolate': recorded('core:interpolate', interpolate),
  'core:compute': recorded('core:compute', compute),
  'core:uncertainty': uncertainty,
  'core:conclude': conclude,
}


// Evaluation of the expression language: pure, bounded, unit-checked (format spec §15.3).
import {
  add,
  compare as compareQ,
  format,
  compatible,
  divide,
  isQuantityString,
  multiply,
  negate,
  parseQuantity,
  parseValue,
  power,
  type Quantity,
  subtract,
  valueIn,
  within as withinQ,
} from '../units/quantity.ts'
import { isDimensionless, parseUnit } from '../units/units.ts'
import { type Arg, ExprError, type Node, parseExpression } from './parse.ts'

/** A reference to something by id that the environment does not bind as a value (a step id). */
export interface IdRef {
  readonly $ref: string
}

export type Value = number | string | boolean | null | Quantity | IdRef | Value[] | Record<string, unknown>

export interface CallContext {
  /** Evaluate an argument (positional arguments are pre-evaluated; this is for lazy ones). */
  readonly env: Env
  readonly source: string
  readonly pos: number
}

export type Fn = (args: Value[], named: Record<string, Value>, ctx: CallContext) => Value

export interface Env {
  /** Bound names: parameters, step outputs, materials, roles, loop variables. */
  lookup(name: string): Value | undefined
  /** Functions available beyond the core library (state queries, data queries). */
  fn(name: string): Fn | undefined
}

export const EVAL_LIMITS = { maxSteps: 200_000, maxList: 100_000 }

export function isQuantity(v: unknown): v is Quantity {
  return typeof v === 'object' && v !== null && 'si' in v && 'dim' in v && Array.isArray((v as Quantity).dim)
}

export function isIdRef(v: unknown): v is IdRef {
  return typeof v === 'object' && v !== null && '$ref' in v
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !isQuantity(v) && !isIdRef(v)
}

/** The id behind a value: a string, an IdRef or a record with an `id` field. */
export function idOf(v: Value | unknown): string | undefined {
  if (typeof v === 'string') return v
  if (isIdRef(v)) return v.$ref
  if (isRecord(v) && typeof v.id === 'string') return v.id
  return undefined
}

export function makeEnv(vars: Record<string, Value> = {}, fns: Record<string, Fn> = {}, parent?: Env): Env {
  return {
    lookup: (name) => (name in vars ? vars[name] : parent?.lookup(name)),
    fn: (name) => fns[name] ?? parent?.fn(name),
  }
}

export function childEnv(parent: Env, vars: Record<string, Value>): Env {
  return makeEnv(vars, {}, parent)
}

/** Evaluate an expression string (a leading "=" is allowed) or a parsed tree. */
export function evaluate(expr: string | Node, env: Env = makeEnv()): Value {
  const source = typeof expr === 'string' ? expr : '<expression>'
  const node = typeof expr === 'string' ? parseExpression(expr) : expr
  return new Evaluator(source).evalNode(node, env)
}

export function evaluateBoolean(expr: string | Node, env?: Env): boolean {
  return truthy(evaluate(expr, env))
}

export function truthy(v: Value): boolean {
  if (v === null || v === false || v === 0 || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (isQuantity(v)) return v.si !== 0
  return true
}

class Evaluator {
  private steps = 0
  private readonly source: string
  constructor(source: string) {
    this.source = source
  }

  fail(message: string, pos: number): never {
    throw new ExprError(message, this.source, pos)
  }

  evalNode(n: Node, env: Env): Value {
    if (++this.steps > EVAL_LIMITS.maxSteps) this.fail('Expression took too long to evaluate', n.pos)
    switch (n.t) {
      case 'num':
        if (!n.unit) return n.value
        try {
          return parseValue(`${n.value} ${n.unit}`)
        } catch (e) {
          return this.fail((e as Error).message, n.pos)
        }
      case 'str':
        return n.value
      case 'bool':
        return n.value
      case 'null':
        return null
      case 'name': {
        const v = env.lookup(n.name)
        if (v !== undefined) return v
        if (n.name === 'it') this.fail('"it" is only defined inside all(), any(), count() and similar', n.pos)
        return { $ref: n.name }
      }
      case 'list': {
        const items = n.items.map((x) => this.evalNode(x, env))
        return items
      }
      case 'member':
        return this.member(this.evalNode(n.target, env), n.name, n.pos)
      case 'index': {
        const target = this.evalNode(n.target, env)
        const index = this.evalNode(n.index, env)
        if (Array.isArray(target)) {
          const i = this.toNumber(index, n.pos)
          if (!Number.isInteger(i) || i < 0 || i >= target.length) this.fail(`Index ${i} is outside the list (length ${target.length})`, n.pos)
          return target[i]
        }
        if (isRecord(target) && typeof index === 'string') return (target[index] ?? null) as Value
        return this.fail('Only lists and records can be indexed', n.pos)
      }
      case 'unary': {
        const v = this.evalNode(n.arg, env)
        if (n.op === '!') return !truthy(v)
        if (typeof v === 'number') return -v
        if (isQuantity(v)) return negate(v)
        return this.fail(`Cannot negate ${typeOf(v)}`, n.pos)
      }
      case 'binary':
        return this.binary(n.op, n, env)
      case 'call':
        return this.call(n.name, n.args, env, n.pos)
    }
  }

  private member(target: Value, name: string, pos: number): Value {
    if (isRecord(target)) {
      const v = target[name]
      if (v === undefined) this.fail(`No field "${name}"`, pos)
      return v as Value
    }
    if (Array.isArray(target)) {
      if (name === 'length') return target.length
      // Field projection over a list: wells.id → list of ids.
      return target.map((x) => this.member(x, name, pos))
    }
    if (isIdRef(target)) this.fail(`"${target.$ref}" has no value yet, so ".${name}" is not available`, pos)
    return this.fail(`${typeOf(target)} has no field "${name}"`, pos)
  }

  private binary(op: string, n: Extract<Node, { t: 'binary' }>, env: Env): Value {
    if (op === '&&') return truthy(this.evalNode(n.left, env)) ? truthy(this.evalNode(n.right, env)) : false
    if (op === '||') return truthy(this.evalNode(n.left, env)) ? true : truthy(this.evalNode(n.right, env))
    const a = this.evalNode(n.left, env)
    const b = this.evalNode(n.right, env)
    switch (op) {
      case '==':
        return equals(coerceQuantity(a, b), coerceQuantity(b, a))
      case '!=':
        return !equals(coerceQuantity(a, b), coerceQuantity(b, a))
      case '<':
        return this.cmp(a, b, n.pos) < 0
      case '<=':
        return this.cmp(a, b, n.pos) <= 0
      case '>':
        return this.cmp(a, b, n.pos) > 0
      case '>=':
        return this.cmp(a, b, n.pos) >= 0
      case 'in':
        if (!Array.isArray(b)) return this.fail('"in" needs a list on its right', n.pos)
        return b.some((x) => equals(a, x))
      default:
        return this.arith(op, a, b, n.pos)
    }
  }

  arith(op: string, a: Value, b: Value, pos: number): Value {
    a = coerceQuantity(a, b)
    b = coerceQuantity(b, a)
    if (typeof a === 'number' && typeof b === 'number') {
      switch (op) {
        case '+':
          return a + b
        case '-':
          return a - b
        case '*':
          return a * b
        case '/':
          if (b === 0) this.fail('Division by zero', pos)
          return a / b
        case '^':
          return a ** b
      }
    }
    if (op === '+' && typeof a === 'string' && typeof b === 'string') return a + b
    if (op === '+' && Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
    const qa = this.toQuantity(a, pos)
    const qb = this.toQuantity(b, pos)
    try {
      switch (op) {
        case '+':
          return add(qa, qb)
        case '-':
          return subtract(qa, qb)
        case '*':
          return simplify(multiply(qa, qb))
        case '/':
          if (qb.si === 0) this.fail('Division by zero', pos)
          return simplify(divide(qa, qb))
        case '^':
          if (!isDimensionless(qb.dim)) this.fail('An exponent must be a plain number', pos)
          return simplify(power(qa, qb.si))
      }
    } catch (e) {
      if (e instanceof ExprError) throw e
      this.fail((e as Error).message, pos)
    }
    return this.fail(`Unknown operator ${op}`, pos)
  }

  cmp(a: Value, b: Value, pos: number): number {
    a = coerceQuantity(a, b)
    b = coerceQuantity(b, a)
    if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
    if (typeof a === 'string' && typeof b === 'string') return a === b ? 0 : a < b ? -1 : 1
    try {
      return compareQ(this.toQuantity(a, pos), this.toQuantity(b, pos))
    } catch (e) {
      if (e instanceof ExprError) throw e
      return this.fail((e as Error).message, pos)
    }
  }

  toQuantity(v: Value, pos: number): Quantity {
    if (isQuantity(v)) return v
    if (typeof v === 'number') return { si: v, dim: [0, 0, 0, 0, 0, 0] }
    if (typeof v === 'string' && isQuantityString(v)) {
      const p = parseQuantity(v)
      if (p.kind === 'value') return p.q
    }
    return this.fail(`Expected a number or quantity, found ${typeOf(v)}`, pos)
  }

  toNumber(v: Value, pos: number): number {
    if (typeof v === 'number') return v
    if (isQuantity(v) && isDimensionless(v.dim)) return v.si
    return this.fail(`Expected a plain number, found ${typeOf(v)}`, pos)
  }

  private call(name: string, args: Arg[], env: Env, pos: number): Value {
    const lazy = LAZY[name]
    if (lazy) return lazy(this, args, env, pos)
    const fn = env.fn(name) ?? LIBRARY[name]
    if (!fn) return this.fail(`Unknown function "${name}"`, pos)
    const positional: Value[] = []
    const named: Record<string, Value> = {}
    for (const a of args) {
      if (a.kind === 'positional') positional.push(this.evalNode(a.value, env))
      else if (a.kind === 'named') named[a.name] = this.evalNode(a.value, env)
      else this.fail(`"${name}" does not take "x in list: …"`, pos)
    }
    try {
      return fn(positional, named, { env, source: this.source, pos })
    } catch (e) {
      if (e instanceof ExprError) throw e
      return this.fail(`${name}(): ${(e as Error).message}`, pos)
    }
  }

  /** Iterate a predicate over a list: binder form `x in list: body` or `(list, body)` with `it`. */
  iterate(name: string, args: Arg[], env: Env, pos: number): { items: Value[]; run: (item: Value) => Value } {
    const first = args[0]
    if (!first) this.fail(`${name}() needs a list`, pos)
    if (first.kind === 'binder') {
      const items = this.list(this.evalNode(first.source, env), name, pos)
      return { items, run: (item) => this.evalNode(first.body, childEnv(env, { [first.name]: item })) }
    }
    if (first.kind !== 'positional') this.fail(`${name}() needs a list first`, pos)
    const items = this.list(this.evalNode(first.value, env), name, pos)
    const body = args[1]
    if (!body) return { items, run: (item) => item }
    if (body.kind !== 'positional') this.fail(`${name}(): unexpected argument`, pos)
    return {
      items,
      run: (item) => {
        // Inside the predicate, `it` is the item and its fields are names in scope.
        const vars: Record<string, Value> = { it: item }
        if (isRecord(item)) for (const [k, v] of Object.entries(item)) vars[k] = v as Value
        return this.evalNode(body.value, childEnv(env, vars))
      },
    }
  }

  list(v: Value, name: string, pos: number): Value[] {
    if (!Array.isArray(v)) this.fail(`${name}() needs a list, found ${typeOf(v)}`, pos)
    if (v.length > EVAL_LIMITS.maxList) this.fail('List is too long', pos)
    return v
  }
}

type LazyFn = (ev: Evaluator, args: Arg[], env: Env, pos: number) => Value

const LAZY: Record<string, LazyFn> = {
  /** if(c, a, b): only the branch taken is evaluated, so the other may be one that would fail (min() of an empty list). */
  if: (ev, args, env, pos) => {
    if (args.length < 2 || args.length > 3 || args.some((a) => a.kind !== 'positional')) ev.fail('if() takes a condition and one or two values', pos)
    const [c, a, b] = args as Array<Extract<Arg, { kind: 'positional' }>>
    const pick = truthy(ev.evalNode(c.value, env)) ? a : b
    return pick ? ev.evalNode(pick.value, env) : null
  },
  all: (ev, args, env, pos) => {
    const { items, run } = ev.iterate('all', args, env, pos)
    return items.every((x) => truthy(run(x)))
  },
  any: (ev, args, env, pos) => {
    const { items, run } = ev.iterate('any', args, env, pos)
    return items.some((x) => truthy(run(x)))
  },
  exists: (ev, args, env, pos) => {
    if (args.length === 1 && args[0].kind === 'positional') {
      const v = ev.evalNode(args[0].value, env)
      return Array.isArray(v) ? v.length > 0 : v !== null && !isIdRef(v)
    }
    const { items, run } = ev.iterate('exists', args, env, pos)
    return items.some((x) => truthy(run(x)))
  },
  count: (ev, args, env, pos) => {
    if (args.length === 1 && args[0].kind === 'positional') return ev.list(ev.evalNode(args[0].value, env), 'count', pos).length
    const { items, run } = ev.iterate('count', args, env, pos)
    return items.filter((x) => truthy(run(x))).length
  },
  filter: (ev, args, env, pos) => {
    const { items, run } = ev.iterate('filter', args, env, pos)
    return items.filter((x) => truthy(run(x)))
  },
  map: (ev, args, env, pos) => {
    const { items, run } = ev.iterate('map', args, env, pos)
    return items.map(run)
  },
  sum: (ev, args, env, pos) => {
    const { items, run } = ev.iterate('sum', args, env, pos)
    const xs = items.map(run)
    if (xs.length === 0) return 0
    return xs.slice(1).reduce<Value>((acc, x) => ev.arith('+', acc, x, pos), xs[0])
  },
  mean: (ev, args, env, pos) => {
    const { items, run } = ev.iterate('mean', args, env, pos)
    if (items.length === 0) ev.fail('mean() of an empty list', pos)
    const xs = items.map(run)
    const total = xs.slice(1).reduce<Value>((acc, x) => ev.arith('+', acc, x, pos), xs[0])
    return ev.arith('/', total, items.length, pos)
  },
}

function coerceQuantity(v: Value, other: Value): Value {
  // Quantity strings next to quantities are read as quantities ("25 mL" == volume(c)).
  if (typeof v === 'string' && isQuantity(other) && isQuantityString(v)) {
    const p = parseQuantity(v)
    if (p.kind === 'value') return p.q
  }
  return v
}

/** A dimensionless ratio without a kind is a plain number. */
function simplify(qv: Quantity): Value {
  if (isDimensionless(qv.dim) && (!qv.kind || qv.kind === 'ratio') && !qv.percent) return qv.si
  return qv
}

export function equals(a: Value, b: Value): boolean {
  if (isQuantity(a) || isQuantity(b)) {
    const qa = isQuantity(a) ? a : typeof a === 'number' ? ({ si: a, dim: [0, 0, 0, 0, 0, 0] } as Quantity) : undefined
    const qb = isQuantity(b) ? b : typeof b === 'number' ? ({ si: b, dim: [0, 0, 0, 0, 0, 0] } as Quantity) : undefined
    if (!qa || !qb || !compatible(qa, qb)) return false
    const scaleAbs = Math.max(Math.abs(qa.si), Math.abs(qb.si))
    return Math.abs(qa.si - qb.si) <= scaleAbs * 1e-9
  }
  const ia = idOf(a)
  const ib = idOf(b)
  if (ia !== undefined && ib !== undefined && (typeof a !== 'string' || typeof b !== 'string')) return ia === ib
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equals(x, b[i]))
  return a === b
}

export function typeOf(v: Value): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'a list'
  if (isQuantity(v)) return 'a quantity'
  if (isIdRef(v)) return `the name "${v.$ref}"`
  if (typeof v === 'object') return 'a record'
  return `a ${typeof v}`
}

// ---- Core library (format spec §15.2): pure functions with no state access ----

function toQ(v: Value): Quantity {
  if (isQuantity(v)) return v
  if (typeof v === 'number') return { si: v, dim: [0, 0, 0, 0, 0, 0] }
  if (typeof v === 'string') {
    const p = parseQuantity(v)
    if (p.kind === 'value') return p.q
  }
  throw new Error(`expected a number or quantity, found ${typeOf(v)}`)
}

function num(v: Value): number {
  if (typeof v === 'number') return v
  if (isQuantity(v) && isDimensionless(v.dim)) return v.si
  throw new Error(`expected a plain number, found ${typeOf(v)}`)
}

function values(args: Value[]): Value[] {
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : args
}

function extreme(args: Value[], sign: number): Value {
  const xs = values(args)
  if (xs.length === 0) throw new Error('needs at least one value')
  let best = xs[0]
  for (const x of xs.slice(1)) {
    const c = isQuantity(x) || isQuantity(best) ? compareQ(toQ(x), toQ(best)) : num(x) - num(best)
    if (c * sign > 0) best = x
  }
  return best
}

function mapNumeric(v: Value, f: (x: number) => number): Value {
  if (typeof v === 'number') return f(v)
  const qv = toQ(v)
  if (!isDimensionless(qv.dim)) throw new Error('needs a plain number')
  return f(qv.si)
}

function sd(xs: Value[]): Value {
  if (xs.length < 2) throw new Error('needs at least two values')
  const qs = xs.map(toQ)
  const mean = qs.reduce((a, b) => a + b.si, 0) / qs.length
  const v = qs.reduce((a, b) => a + (b.si - mean) ** 2, 0) / (qs.length - 1)
  return isDimensionless(qs[0].dim) && !qs[0].kind ? Math.sqrt(v) : { ...qs[0], si: Math.sqrt(v), decimals: undefined }
}

export const LIBRARY: Record<string, Fn> = {
  min: (a) => extreme(a, -1),
  max: (a) => extreme(a, 1),
  abs: ([x]) => (typeof x === 'number' ? Math.abs(x) : { ...toQ(x), si: Math.abs(toQ(x).si) }),
  floor: ([x]) => mapNumeric(x, Math.floor),
  /** mod(a, b): the remainder, always non-negative for positive b. */
  mod: ([a, b]) => {
    const x = num(a)
    const y = num(b)
    if (y === 0) throw new Error('mod by zero')
    return ((x % y) + y) % y
  },
  ceil: ([x]) => mapNumeric(x, Math.ceil),
  sqrt: ([x]) => (typeof x === 'number' ? Math.sqrt(x) : simplifyValue(power(toQ(x), 0.5))),
  log10: ([x]) => mapNumeric(x, Math.log10),
  ln: ([x]) => mapNumeric(x, Math.log),
  exp: ([x]) => mapNumeric(x, Math.exp),
  /** round(x) to an integer, or round(x, resolution): round(v, 0.5 uL). */
  round: ([x, res]) => {
    if (res === undefined) return typeof x === 'number' ? Math.round(x) : { ...toQ(x), si: Math.round(toQ(x).si) }
    const r = toQ(res)
    const qx = toQ(x)
    if (r.si <= 0) throw new Error('resolution must be positive')
    const rounded = Math.round(qx.si / r.si) * r.si
    return typeof x === 'number' ? rounded : { ...qx, si: rounded, decimals: undefined }
  },
  /** convert(x, 'mL'): the same quantity, displayed in another unit. */
  convert: ([x, unit]) => {
    const qx = toQ(x)
    if (typeof unit !== 'string') throw new Error('needs a unit as text')
    valueIn(qx, unit)
    return { ...qx, unit, decimals: undefined }
  },
  /** value(x, 'mL'): the plain number of x in a unit. */
  value: ([x, unit]) => {
    if (typeof unit !== 'string') throw new Error('needs a unit as text')
    return valueIn(toQ(x), unit)
  },
  quantity: ([text]) => {
    if (typeof text !== 'string') throw new Error('needs text such as "25 mL"')
    return parseValue(text)
  },
  list: (args) => args,
  len: ([x]) => {
    if (Array.isArray(x)) return x.length
    if (typeof x === 'string') return x.length
    throw new Error('needs a list or text')
  },
  length: ([x]) => (typeof x === 'string' ? x.length : Array.isArray(x) ? x.length : 0),
  first: ([x]) => (Array.isArray(x) && x.length ? x[0] : null),
  last: ([x]) => (Array.isArray(x) && x.length ? x[x.length - 1] : null),
  /** slice(list, start, end?): the items from index start up to (not including) end; negative counts from the end. */
  slice: ([x, start, end]) => {
    if (!Array.isArray(x)) throw new Error('slice needs a list')
    const a = num(start)
    const b = end === undefined || end === null ? x.length : num(end)
    if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error('slice needs whole-number indices')
    return x.slice(a, b)
  },
  /** range(a, b, n): n evenly spaced values from a to b. */
  range: ([a, b, n]) => {
    const count = num(n)
    if (!Number.isInteger(count) || count < 1 || count > EVAL_LIMITS.maxList) throw new Error('n must be a positive integer')
    if (count === 1) return [a]
    const qa = toQ(a)
    const qb = toQ(b)
    return Array.from({ length: count }, (_, i) => fromLike(a, qa.si + ((qb.si - qa.si) * i) / (count - 1)))
  },
  /** seq(start, factor, n): a geometric series, start × factorⁱ (dilution series). */
  seq: ([start, factor, n]) => {
    const count = num(n)
    if (!Number.isInteger(count) || count < 1 || count > EVAL_LIMITS.maxList) throw new Error('n must be a positive integer')
    const f = num(factor)
    const qs = toQ(start)
    return Array.from({ length: count }, (_, i) => fromLike(start, qs.si * f ** i))
  },
  sd: (a) => sd(values(a)),
  /**
   * within(x, target, tolerance): |x − target| ≤ tolerance (absolute, or relative when written
   * as a percentage). within(x, lo, hi) with hi > lo, or between(x, lo, hi): lo ≤ x ≤ hi.
   */
  within: ([x, a, b]) => {
    const qx = toQ(x)
    const qa = toQ(a)
    const qb = toQ(b)
    if (qb.percent || (isDimensionless(qb.dim) && !isDimensionless(qa.dim))) return withinQ(qx, qa, qb)
    if (compatible(qa, qb) && qb.si > qa.si && qb.si > Math.abs(qa.si) * 1) return compareQ(qx, qa) >= 0 && compareQ(qx, qb) <= 0
    return withinQ(qx, qa, qb)
  },
  between: ([x, lo, hi]) => compareQ(toQ(x), toQ(lo)) >= 0 && compareQ(toQ(x), toQ(hi)) <= 0,
  /** steepest(xs, ys): the x halfway across the interval where y changes fastest (an equivalence point). */
  steepest: ([xs, ys]) => {
    if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length || xs.length < 2) throw new Error('needs two lists of the same length')
    const px = xs.map(toQ)
    const py = ys.map(toQ)
    let best = 0
    let slope = -Infinity
    for (let i = 0; i + 1 < px.length; i++) {
      const dx = px[i + 1].si - px[i].si
      if (!(dx > 0)) continue
      const s = Math.abs(py[i + 1].si - py[i].si) / dx
      if (s > slope) {
        slope = s
        best = i
      }
    }
    return fromLike(xs[best], (px[best].si + px[best + 1].si) / 2)
  },
  /**
   * peaks(xs, ys, minHeight = 0): the x of each local maximum of y at or above minHeight, refined
   * by a parabola through it and its neighbours (a chromatogram's or a spectrum's peaks).
   */
  peaks: ([xs, ys, minHeight]) => {
    if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length) throw new Error('needs two lists of the same length')
    const px = xs.map(toQ)
    const py = ys.map((y) => toQ(y).si)
    const floor = minHeight === undefined || minHeight === null ? -Infinity : toQ(minHeight).si
    const out: Value[] = []
    for (let i = 0; i < py.length; i++) {
      const left = i > 0 ? py[i - 1] : -Infinity
      const right = i + 1 < py.length ? py[i + 1] : -Infinity
      if (!(py[i] > left && py[i] >= right && py[i] >= floor)) continue
      let x = px[i].si
      if (i > 0 && i + 1 < py.length) {
        // Vertex of the parabola through the three points (equally spaced or not).
        const [x0, x1, x2] = [px[i - 1].si, px[i].si, px[i + 1].si]
        const [y0, y1, y2] = [py[i - 1], py[i], py[i + 1]]
        const d = (x0 - x1) * (x0 - x2) * (x1 - x2)
        const a = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / d
        const b = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / d
        if (a < 0) x = Math.min(x2, Math.max(x0, -b / (2 * a)))
      }
      out.push(fromLike(xs[i], x))
    }
    return out
  },
  /** interpolateAt(xs, ys, x): y at x, linearly between the neighbouring points (xs ascending). */
  interpolateAt: ([xs, ys, x]) => {
    if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length || xs.length < 2) throw new Error('needs two lists of the same length')
    const px = xs.map(toQ)
    const target = toQ(x).si
    for (let i = 0; i + 1 < px.length; i++) {
      const a = px[i].si
      const b = px[i + 1].si
      if (target >= Math.min(a, b) && target <= Math.max(a, b) && b !== a) {
        const f = (target - a) / (b - a)
        const ya = toQ(ys[i]).si
        const yb = toQ(ys[i + 1]).si
        return fromLike(ys[i], ya + f * (yb - ya))
      }
    }
    throw new Error('x is outside the data')
  },
  /** closest(list, n = 2): the n values that agree best (the narrowest run once sorted). */
  closest: ([xs, n]) => {
    if (!Array.isArray(xs)) throw new Error('needs a list')
    const k = n === undefined || n === null ? 2 : Number(n)
    const items = xs.map((x) => ({ x, si: toQ(x).si })).sort((a, b) => a.si - b.si)
    if (items.length <= k) return items.map((i) => i.x)
    let best = 0
    for (let i = 1; i + k <= items.length; i++) if (items[i + k - 1].si - items[i].si < items[best + k - 1].si - items[best].si) best = i
    return items.slice(best, best + k).map((i) => i.x)
  },
  /**
   * concordant(list, tolerance, n = 2): some n of the values agree within the tolerance, which is
   * absolute ("0.10 mL") or a percentage of their mean ("0.3%").
   */
  concordant: ([xs, tol, n]) => {
    if (!Array.isArray(xs)) throw new Error('needs a list')
    const k = n === undefined || n === null ? 2 : Number(n)
    const items = xs.map(toQ).sort((a, b) => a.si - b.si)
    if (k < 1 || items.length < k) return false
    const t = toQ(tol)
    const relative = t.percent === true || (isDimensionless(t.dim) && !isDimensionless(items[0].dim))
    for (let i = 0; i + k <= items.length; i++) {
      const lo = items[i].si
      const hi = items[i + k - 1].si
      if (hi - lo <= (relative ? t.si * Math.abs((lo + hi) / 2) : t.si) * (1 + 1e-12)) return true
    }
    return false
  },
  /**
   * concordantMean(list, tolerance, n = 2): the mean of the largest set of values that agree within
   * the tolerance (absolute or a percentage, as for concordant), the narrowest such set if several
   * are as large; null when fewer than n agree. The usual way to average titres.
   */
  concordantMean: ([xs, tol, n]) => {
    if (!Array.isArray(xs)) throw new Error('needs a list')
    const k = n === undefined || n === null ? 2 : Number(n)
    const items = xs.map(toQ).sort((a, b) => a.si - b.si)
    const t = toQ(tol)
    const relative = t.percent === true || (isDimensionless(t.dim) && !isDimensionless(items[0]?.dim ?? t.dim))
    let best: { from: number; to: number } | undefined
    for (let i = 0; i < items.length; i++) {
      for (let j = items.length - 1; j >= i + k - 1; j--) {
        const lo = items[i].si
        const hi = items[j].si
        if (hi - lo > (relative ? t.si * Math.abs((lo + hi) / 2) : t.si) * (1 + 1e-12)) continue
        const size = j - i
        const span = hi - lo
        if (!best || size > best.to - best.from || (size === best.to - best.from && span < items[best.to].si - items[best.from].si)) best = { from: i, to: j }
        break
      }
    }
    if (!best) return null
    const chosen = items.slice(best.from, best.to + 1)
    return { ...chosen[0], si: chosen.reduce((a, q) => a + q.si, 0) / chosen.length, decimals: undefined }
  },
  /** monotonic(list): non-decreasing or non-increasing; monotonic(list, keys) after sorting by keys. */
  monotonic: ([xs, keys]) => {
    if (!Array.isArray(xs)) throw new Error('needs a list')
    let items = xs.map(toQ)
    if (Array.isArray(keys)) {
      const order = keys.map((k, i) => ({ k: toQ(k).si, i })).sort((p, r) => p.k - r.k)
      items = order.map((o) => items[o.i])
    }
    let up = true
    let down = true
    for (let i = 1; i < items.length; i++) {
      if (items[i].si < items[i - 1].si) up = false
      if (items[i].si > items[i - 1].si) down = false
    }
    return up || down
  },
  /** mentions(text, 'a|b|c'): case-insensitive; any alternative occurs. */
  mentions: (args, _named, ctx) => {
    const [text, pattern] = args.length === 1 ? [ctx.env.lookup('answer'), args[0]] : args
    if (typeof text !== 'string' || typeof pattern !== 'string') return false
    const lower = text.toLowerCase()
    return pattern
      .split('|')
      .map((p) => p.trim().toLowerCase())
      .some((p) => p !== '' && lower.includes(p))
  },
  /** choose(learner, reference): a value the learner sets at run time; the reference agent uses the default. */
  choose: (args) => (args.length > 1 ? args[1] : null),
  /** The first argument that is a real value (not null and not an unbound name). */
  coalesce: (args) => args.find((a) => a !== null && a !== undefined && !isIdRef(a)) ?? null,
  /** if(condition, then, else). Both branches are evaluated; use it for values, not effects. */
  if: ([c, a, b]) => (truthy(c) ? a : (b ?? null)),
  /** Readable text for a value: quantities formatted with their unit ("0.25 mg/mL"). */
  text: ([x]) => {
    if (isQuantity(x)) return format(x, x.unit ? { unit: x.unit } : {})
    if (typeof x === 'number') return String(Number(x.toPrecision(6)))
    if (isIdRef(x)) return x.$ref
    return x === null ? '' : typeof x === 'string' ? x : JSON.stringify(x)
  },
  unitOf: ([x]) => (isQuantity(x) ? (x.unit ?? null) : null),
  isQuantity: ([x]) => isQuantity(x),
  dimensionless: ([x]) => (typeof x === 'number' ? true : isDimensionless(toQ(x).dim)),
  unit: ([u]) => {
    if (typeof u !== 'string') throw new Error('needs text')
    parseUnit(u)
    return u
  },
}

function simplifyValue(qv: Quantity): Value {
  return isDimensionless(qv.dim) && (!qv.kind || qv.kind === 'ratio') ? qv.si : qv
}

function fromLike(like: Value, si: number): Value {
  if (typeof like === 'number') return si
  return { ...toQ(like), si, decimals: undefined }
}


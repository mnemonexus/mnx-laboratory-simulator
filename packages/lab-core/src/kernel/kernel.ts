// The kernel: deterministic, transactional, event-sourced (master-plan/03 §5, D3–D6; 04).
// An intent names an operation and its parameters. The operation runs on a draft of the world;
// a refusal (physically impossible) or an error discards the draft completely. Accepted intents
// become events: state = reduce(initial world, events), so replay gives the same world.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { eventRng, type Rng } from '../rng/rng.ts'
import { isIdRef, isQuantity, isRecord } from '../expr/evaluate.ts'
import { parseQuantity, type Quantity } from '../units/quantity.ts'
import { DIMENSIONS, type DimensionName, fromSI, parseUnit, sameDim } from '../units/units.ts'
import { settlePhases } from '../models/phases.ts'
import { clone, type Container, type EquipmentInstance, type Place, type World } from './state.ts'

export interface Intent {
  op: string
  params: Record<string, unknown>
  /** Where in the plan the intent came from (a step path), for evidence and review. */
  step?: string
  path?: string
  actor?: 'learner' | 'reference' | 'auto'
}

export interface Refusal {
  code: string
  message: string
  data?: Record<string, unknown>
}

export interface EventRecord {
  index: number
  timeS: number
  op: string
  params: Record<string, unknown>
  step?: string
  path?: string
  actor?: Intent['actor']
  /** Facts for evidence queries (tipFresh, delivered volume …). */
  facts: Record<string, unknown>
  outputs?: Record<string, unknown>
}

export interface Attempt {
  index: number
  timeS: number
  op: string
  params: Record<string, unknown>
  step?: string
  path?: string
  refusal: Refusal
}

export type ExecuteResult =
  | { ok: true; event: EventRecord; outputs: Record<string, unknown> }
  | { ok: false; refusal: Refusal }

export class RefusalError extends Error {
  readonly refusal: Refusal
  constructor(refusal: Refusal) {
    super(refusal.message)
    this.name = 'RefusalError'
    this.refusal = refusal
  }
}

export interface OpResult {
  outputs?: Record<string, unknown>
  facts?: Record<string, unknown>
}

export interface OpContext {
  readonly world: World
  readonly cat: Catalogue
  readonly eventIndex: number
  readonly options: KernelOptions
  rng(channel: string): Rng
  refuse(code: string, message: string, data?: Record<string, unknown>): never
  newId(prefix: string): string
  container(ref: unknown, what?: string): Container
  equipment(ref: unknown, what?: string): EquipmentInstance
  place(ref: unknown, what?: string): Place
  quantity(value: unknown, dimension: DimensionName, what?: string): Quantity
  optionalQuantity(value: unknown, dimension: DimensionName, what?: string): Quantity | undefined
}

export type OpImpl = (ctx: OpContext, params: Record<string, unknown>) => OpResult

export interface KernelOptions {
  /** Measurement noise scaling (adaptive support §3.8): ideal 0, low 0.5, default 1, high 1.5. */
  noise: number
  /** Scaling of pipetting and glassware random/systematic errors (ideal technique = 0). */
  handlingError: number
}

export const DEFAULT_OPTIONS: KernelOptions = { noise: 1, handlingError: 1 }

export function realismOptions(level: 'ideal' | 'low' | 'default' | 'high'): KernelOptions {
  switch (level) {
    case 'ideal':
      return { noise: 0, handlingError: 0 }
    case 'low':
      return { noise: 0.5, handlingError: 0.5 }
    case 'high':
      return { noise: 1.5, handlingError: 1.25 }
    default:
      return { noise: 1, handlingError: 1 }
  }
}

/** Ids from params: strings, IdRefs from expressions, or records with an id. */
export function refId(ref: unknown): string | undefined {
  if (typeof ref === 'string') return ref
  if (isIdRef(ref)) return ref.$ref
  if (isRecord(ref) && typeof ref.id === 'string') return ref.id
  return undefined
}

export class Kernel {
  private current: World
  readonly events: EventRecord[] = []
  readonly attempts: Attempt[] = []
  readonly cat: Catalogue
  readonly options: KernelOptions
  private readonly ops: Record<string, OpImpl>

  constructor(cat: Catalogue, world: World, ops: Record<string, OpImpl>, options: Partial<KernelOptions> = {}) {
    this.cat = cat
    this.current = world
    this.ops = ops
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /** The current world. Treat as read-only: change it only through intents. */
  get world(): World {
    return this.current
  }

  /** The index the next event will get (event indices count accepted and refused intents). */
  get nextIndex(): number {
    return this.events.length + this.attempts.length
  }

  has(op: string): boolean {
    return op in this.ops
  }

  /** Dry run: would this intent be accepted now? */
  check(intent: Intent): Refusal | null {
    const result = this.run(intent, true)
    return result.ok ? null : result.refusal
  }

  execute(intent: Intent): ExecuteResult {
    return this.run(intent, false)
  }

  private run(intent: Intent, dry: boolean): ExecuteResult {
    const impl = this.ops[intent.op]
    if (!impl) return { ok: false, refusal: { code: 'UNKNOWN-OPERATION', message: `This lab cannot perform "${intent.op}"` } }
    const index = this.nextIndex
    const draft = clone(this.current)
    const ctx = makeContext(draft, this.cat, index, this.options)
    let result: OpResult
    try {
      result = impl(ctx, intent.params)
      // Whatever was done, liquids that do not mix stand as separate layers.
      for (const c of Object.values(draft.containers)) if (!c.discarded) settlePhases(this.cat, c.contents)
    } catch (e) {
      const refusal: Refusal =
        e instanceof RefusalError ? e.refusal : { code: 'ERROR', message: `Operation failed: ${(e as Error).message}` }
      if (!dry) {
        this.attempts.push({ index, timeS: this.current.timeS, op: intent.op, params: serialise(intent.params) as Record<string, unknown>, step: intent.step, path: intent.path, refusal })
      }
      return { ok: false, refusal }
    }
    if (dry) return { ok: true, event: undefined as unknown as EventRecord, outputs: result.outputs ?? {} }
    this.current = draft
    const event: EventRecord = {
      index,
      timeS: draft.timeS,
      op: intent.op,
      params: serialise(intent.params) as Record<string, unknown>,
      ...(intent.step ? { step: intent.step } : {}),
      ...(intent.path ? { path: intent.path } : {}),
      ...(intent.actor ? { actor: intent.actor } : {}),
      facts: result.facts ?? {},
      ...(result.outputs ? { outputs: serialise(result.outputs) as Record<string, unknown> } : {}),
    }
    this.events.push(event)
    return { ok: true, event, outputs: result.outputs ?? {} }
  }

  /** Every intent accepted so far, for saves and replay. */
  log(): Intent[] {
    return this.events.map((e) => ({ op: e.op, params: e.params, step: e.step, path: e.path, actor: e.actor }))
  }
}

function makeContext(world: World, cat: Catalogue, eventIndex: number, options: KernelOptions): OpContext {
  const refuse = (code: string, message: string, data?: Record<string, unknown>): never => {
    throw new RefusalError({ code, message, ...(data ? { data } : {}) })
  }
  return {
    world,
    cat,
    eventIndex,
    options,
    rng: (channel) => eventRng(world.seed, eventIndex, channel),
    refuse,
    newId(prefix) {
      return `${prefix}${world.nextId++}`
    },
    container(ref, what = 'container') {
      const id = refId(ref)
      const c = id ? world.containers[id] : undefined
      if (!c || c.discarded) return refuse('NO-CONTAINER', `There is no ${what} "${id ?? String(ref)}" here`)
      return c
    },
    equipment(ref, what = 'equipment') {
      const id = refId(ref)
      const e = id ? world.equipment[id] : undefined
      if (!e) return refuse('NO-EQUIPMENT', `There is no ${what} "${id ?? String(ref)}" here`)
      return e
    },
    place(ref, what = 'place') {
      const id = refId(ref)
      const p = id ? world.places[id] : undefined
      if (!p) return refuse('NO-PLACE', `There is no ${what} "${id ?? String(ref)}" here`)
      return p
    },
    quantity(value, dimension, what = 'value') {
      const q = toQuantity(value)
      if (!q) return refuse('BAD-PARAMETER', `${what} must be a ${dimension} (got ${JSON.stringify(value)})`)
      if (!sameDim(q.dim, DIMENSIONS[dimension])) return refuse('BAD-PARAMETER', `${what} must be a ${dimension}`)
      return q
    },
    optionalQuantity(value, dimension, what) {
      if (value === undefined || value === null) return undefined
      return this.quantity(value, dimension, what)
    },
  }
}

export function toQuantity(value: unknown): Quantity | undefined {
  if (isQuantity(value)) return value
  if (typeof value === 'string') {
    try {
      const p = parseQuantity(value)
      return p.kind === 'range' ? undefined : p.q
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Params as plain JSON: quantities become strings in SI-friendly units, refs become ids. */
export function serialise(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (isQuantity(value)) return quantityText(value)
  if (isIdRef(value)) return value.$ref
  if (Array.isArray(value)) return value.map(serialise)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = serialise(v)
    return out
  }
  return value
}

function quantityText(q: Quantity): string {
  const unit = q.unit
  if (unit) {
    try {
      const u = parseUnit(unit)
      if (sameDim(u.dim, q.dim)) return `${Number(fromSI(q.si, u).toPrecision(12))} ${unit}`
    } catch {
      // fall through to SI
    }
  }
  const si: Array<[DimensionName, string, number]> = [
    ['volume', 'L', 1e-3],
    ['mass', 'g', 1e-3],
    ['time', 's', 1],
    ['temperature', 'K', 1],
    ['amount', 'mol', 1],
    ['molarConcentration', 'mol/L', 1e3],
    ['massConcentration', 'g/L', 1],
    ['length', 'm', 1],
  ]
  for (const [name, u, f] of si) if (sameDim(q.dim, DIMENSIONS[name])) return `${Number((q.si / f).toPrecision(12))} ${u}`
  return String(q.si)
}

// A small schema language. One source of truth gives:
//  - runtime validation by interpretation (no code generation, so it is sandbox-safe: no eval);
//  - the published JSON Schema (draft 2020-12), with anyOf and $ref where the authoring form needs them;
//  - the transport schema for constrained hosts (format spec §19): no anyOf/oneOf/$ref, bounded depth.
import { childPointer, type Finding, type ValidationLevel } from './findings.ts'

interface Base {
  description?: string
}

export interface StringSchema extends Base {
  type: 'string'
  enum?: readonly string[]
  pattern?: string
  minLength?: number
  maxLength?: number
  /** A named check from the validator's format registry (quantity, id, ref, expression …). */
  format?: string
  /** Extra data for the format check (e.g. the expected dimension of a quantity). */
  formatArgs?: Record<string, unknown>
}

export interface NumberSchema extends Base {
  type: 'number'
  integer?: boolean
  minimum?: number
  maximum?: number
}

export interface BooleanSchema extends Base {
  type: 'boolean'
}

export interface ArraySchema extends Base {
  type: 'array'
  items: Schema
  minItems?: number
  maxItems?: number
}

export interface ObjectSchema extends Base {
  type: 'object'
  properties: Record<string, Schema>
  required?: readonly string[]
  /**
   * Unknown properties: `true` accepts silently (extension blocks, maps), `false` reports them
   * as info (the format's rule: readers ignore and preserve unknown fields), or a schema for
   * map-like objects whose keys are free.
   */
  additional?: boolean | Schema
  /** Property name pattern for map-like objects. */
  keyPattern?: string
}

export interface UnionSchema extends Base {
  type: 'union'
  variants: Schema[]
  /** Which variant the transport profile keeps (the canonical form). */
  transport: number
}

export interface AnySchema extends Base {
  type: 'any'
}

export interface RefSchema extends Base {
  type: 'ref'
  name: string
}

export type Schema =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | ArraySchema
  | ObjectSchema
  | UnionSchema
  | AnySchema
  | RefSchema

/** Named schemas, for recursion (group steps contain steps). */
export type SchemaDefs = Record<string, Schema>

// ---- Builders ----

export const str = (opts: Omit<StringSchema, 'type'> = {}): StringSchema => ({ type: 'string', ...opts })
export const num = (opts: Omit<NumberSchema, 'type'> = {}): NumberSchema => ({ type: 'number', ...opts })
export const int = (opts: Omit<NumberSchema, 'type' | 'integer'> = {}): NumberSchema => ({ type: 'number', integer: true, ...opts })
export const bool = (opts: Omit<BooleanSchema, 'type'> = {}): BooleanSchema => ({ type: 'boolean', ...opts })
export const arr = (items: Schema, opts: Omit<ArraySchema, 'type' | 'items'> = {}): ArraySchema => ({ type: 'array', items, ...opts })
export const any = (opts: Omit<AnySchema, 'type'> = {}): AnySchema => ({ type: 'any', ...opts })
export const ref = (name: string, opts: Omit<RefSchema, 'type' | 'name'> = {}): RefSchema => ({ type: 'ref', name, ...opts })
export const union = (variants: Schema[], transport = 0, opts: Base = {}): UnionSchema => ({ type: 'union', variants, transport, ...opts })
export const enm = (values: readonly string[], opts: Omit<StringSchema, 'type' | 'enum'> = {}): StringSchema => ({ type: 'string', enum: values, ...opts })

/** An object; properties whose names end in `?` are optional. */
export function obj(props: Record<string, Schema>, opts: Omit<ObjectSchema, 'type' | 'properties' | 'required'> = {}): ObjectSchema {
  const properties: Record<string, Schema> = {}
  const required: string[] = []
  for (const [key, schema] of Object.entries(props)) {
    if (key.endsWith('?')) properties[key.slice(0, -1)] = schema
    else {
      properties[key] = schema
      required.push(key)
    }
  }
  return { type: 'object', properties, required, additional: false, ...opts }
}

export const map = (values: Schema, opts: Omit<ObjectSchema, 'type' | 'properties' | 'additional'> = {}): ObjectSchema => ({
  type: 'object',
  properties: {},
  additional: values,
  ...opts,
})

// ---- Validation ----

export type FormatCheck = (value: string, args: Record<string, unknown> | undefined) => string | null

export interface ValidateOptions {
  defs?: SchemaDefs
  formats?: Record<string, FormatCheck>
  /** Code prefix: "ED" for definitions, "CAT" for catalogue entries. */
  prefix: string
  level?: ValidationLevel
  /** Severity for unknown properties (default info: they are preserved and ignored). */
  unknownSeverity?: 'info' | 'warning' | 'error'
  maxFindings?: number
}

export function validate(value: unknown, schema: Schema, opts: ValidateOptions, path = ''): Finding[] {
  const out: Finding[] = []
  new Validator(opts, out).check(value, schema, path)
  return out
}

class Validator {
  private readonly level: ValidationLevel
  private readonly opts: ValidateOptions
  private readonly out: Finding[]
  constructor(opts: ValidateOptions, out: Finding[]) {
    this.opts = opts
    this.out = out
    this.level = opts.level ?? 'V1'
  }

  private add(name: string, path: string, message: string, severity: Finding['severity'] = 'error', data?: Record<string, unknown>) {
    if (this.out.length >= (this.opts.maxFindings ?? 500)) return
    this.out.push({ code: `${this.opts.prefix}-${this.level}-${name}`, level: this.level, severity, path, message, ...(data ? { data } : {}) })
  }

  /** Returns whether the value matched without errors. */
  check(value: unknown, schema: Schema, path: string): boolean {
    const before = this.errorCount()
    switch (schema.type) {
      case 'any':
        break
      case 'ref': {
        const target = this.opts.defs?.[schema.name]
        if (!target) throw new Error(`Unknown schema reference "${schema.name}"`)
        return this.check(value, target, path)
      }
      case 'string':
        this.checkString(value, schema, path)
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          this.add('TYPE', path, `Expected a number, found ${typeName(value)}`)
        } else {
          if (schema.integer && !Number.isInteger(value)) this.add('TYPE', path, `Expected an integer, found ${value}`)
          if (schema.minimum !== undefined && value < schema.minimum) this.add('RANGE', path, `${value} is below the minimum ${schema.minimum}`)
          if (schema.maximum !== undefined && value > schema.maximum) this.add('RANGE', path, `${value} is above the maximum ${schema.maximum}`)
        }
        break
      case 'boolean':
        if (typeof value !== 'boolean') this.add('TYPE', path, `Expected true or false, found ${typeName(value)}`)
        break
      case 'array':
        if (!Array.isArray(value)) {
          this.add('TYPE', path, `Expected a list, found ${typeName(value)}`)
          break
        }
        if (schema.minItems !== undefined && value.length < schema.minItems) this.add('SIZE', path, `Needs at least ${schema.minItems} item(s), has ${value.length}`)
        if (schema.maxItems !== undefined && value.length > schema.maxItems) this.add('SIZE', path, `Allows at most ${schema.maxItems} item(s), has ${value.length}`)
        value.forEach((item, i) => this.check(item, schema.items, childPointer(path, i)))
        break
      case 'object':
        this.checkObject(value, schema, path)
        break
      case 'union':
        this.checkUnion(value, schema, path)
        break
    }
    return this.errorCount() === before
  }

  private errorCount(): number {
    let n = 0
    for (const f of this.out) if (f.severity === 'error') n++
    return n
  }

  private checkString(value: unknown, schema: StringSchema, path: string) {
    if (typeof value !== 'string') {
      this.add('TYPE', path, `Expected text, found ${typeName(value)}`)
      return
    }
    if (schema.enum && !schema.enum.includes(value)) {
      this.add('ENUM', path, `"${value}" is not one of: ${schema.enum.join(', ')}`, 'error', { allowed: [...schema.enum] })
      return
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) this.add('SIZE', path, `Text is shorter than ${schema.minLength} characters`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) this.add('SIZE', path, `Text is longer than ${schema.maxLength} characters`)
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) this.add('PATTERN', path, `"${value}" does not match ${schema.pattern}`)
    if (schema.format) {
      const check = this.opts.formats?.[schema.format]
      if (check) {
        const problem = check(value, schema.formatArgs)
        if (problem) this.add(formatCode(schema.format), path, problem)
      }
    }
  }

  private checkObject(value: unknown, schema: ObjectSchema, path: string) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.add('TYPE', path, `Expected an object, found ${typeName(value)}`)
      return
    }
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) this.add('REQUIRED', childPointer(path, key), `Missing required field "${key}"`)
    }
    for (const [key, v] of Object.entries(record)) {
      const prop = schema.properties[key]
      if (prop) {
        if (v !== undefined) this.check(v, prop, childPointer(path, key))
        continue
      }
      if (schema.keyPattern && !new RegExp(schema.keyPattern).test(key)) {
        this.add('PATTERN', childPointer(path, key), `Key "${key}" does not match ${schema.keyPattern}`)
      }
      const additional = schema.additional ?? false
      if (additional === true) continue
      if (additional === false) {
        this.add('UNKNOWN-FIELD', childPointer(path, key), `Unknown field "${key}" (kept, but ignored)`, this.opts.unknownSeverity ?? 'info')
        continue
      }
      this.check(v, additional, childPointer(path, key))
    }
  }

  private checkUnion(value: unknown, schema: UnionSchema, path: string) {
    // Try each variant silently; report the best attempt if none fits.
    let best: Finding[] | undefined
    for (const variant of schema.variants) {
      const trial: Finding[] = []
      new Validator(this.opts, trial).check(value, variant, path)
      const errs = trial.filter((f) => f.severity === 'error')
      if (errs.length === 0) {
        this.out.push(...trial)
        return
      }
      if (!best || errs.length < best.filter((f) => f.severity === 'error').length) best = trial
    }
    // A type mismatch on every variant reads better as one message.
    if (best && best.every((f) => f.code.endsWith('-TYPE') && f.path === path)) {
      this.add('TYPE', path, `Expected ${schema.variants.map(describeSchema).join(' or ')}, found ${typeName(value)}`)
      return
    }
    this.out.push(...(best ?? []))
  }
}

function formatCode(format: string): string {
  return format.toUpperCase().replace(/[^A-Z0-9]+/g, '-')
}

export function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  if (typeof value === 'object') return 'an object'
  if (typeof value === 'string') return 'text'
  return `a ${typeof value}`
}

function describeSchema(s: Schema): string {
  switch (s.type) {
    case 'string':
      return s.format ? `${s.format} text` : 'text'
    case 'number':
      return s.integer ? 'an integer' : 'a number'
    case 'boolean':
      return 'true/false'
    case 'array':
      return 'a list'
    case 'object':
      return 'an object'
    case 'ref':
      return s.name
    default:
      return s.type
  }
}

// ---- JSON Schema export ----

export interface JsonSchemaOptions {
  id: string
  title: string
  description?: string
  defs?: SchemaDefs
  /** Transport profile: no anyOf/oneOf/$ref; recursive refs unrolled to this depth. */
  transport?: { maxRefDepth: number }
}

export type JsonSchema = Record<string, unknown>

export function toJsonSchema(root: Schema, opts: JsonSchemaOptions): JsonSchema {
  const header: JsonSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: opts.id,
    title: opts.title,
    ...(opts.description ? { description: opts.description } : {}),
  }
  if (opts.transport) {
    // The host subset has no room for metadata: only the schema itself.
    return toTransportSubset(emit(root, opts, new Map()))
  }
  const body = emit(root, opts, new Map())
  const defs: JsonSchema = {}
  for (const [name, s] of Object.entries(opts.defs ?? {})) defs[name] = emit(s, opts, new Map())
  return { ...header, ...body, ...(Object.keys(defs).length ? { $defs: defs } : {}) }
}

function emit(s: Schema, opts: JsonSchemaOptions, depth: Map<string, number>): JsonSchema {
  const desc = s.description ? { description: s.description } : {}
  switch (s.type) {
    case 'any':
      return { ...desc }
    case 'string':
      return {
        type: 'string',
        ...desc,
        ...(s.enum ? { enum: [...s.enum] } : {}),
        ...(s.pattern ? { pattern: s.pattern } : {}),
        ...(s.minLength !== undefined ? { minLength: s.minLength } : {}),
        ...(s.maxLength !== undefined ? { maxLength: s.maxLength } : {}),
        ...(s.format ? { 'x-lab-format': s.format } : {}),
      }
    case 'number':
      return {
        type: s.integer ? 'integer' : 'number',
        ...desc,
        ...(s.minimum !== undefined ? { minimum: s.minimum } : {}),
        ...(s.maximum !== undefined ? { maximum: s.maximum } : {}),
      }
    case 'boolean':
      return { type: 'boolean', ...desc }
    case 'array':
      return {
        type: 'array',
        ...desc,
        items: emit(s.items, opts, depth),
        ...(s.minItems !== undefined ? { minItems: s.minItems } : {}),
        ...(s.maxItems !== undefined ? { maxItems: s.maxItems } : {}),
      }
    case 'object': {
      const properties: JsonSchema = {}
      for (const [k, v] of Object.entries(s.properties)) {
        const emitted = emit(v, opts, depth)
        if (emitted === DROP) continue
        properties[k] = emitted
      }
      const out: JsonSchema = { type: 'object', ...desc, properties }
      const required = (s.required ?? []).filter((k) => k in properties)
      if (required.length) out.required = required
      if (s.additional === true) out.additionalProperties = true
      else if (s.additional && typeof s.additional === 'object') out.additionalProperties = emit(s.additional, opts, depth)
      if (s.keyPattern && !opts.transport) out.propertyNames = { pattern: s.keyPattern }
      return out
    }
    case 'union':
      if (opts.transport) return { ...emit(s.variants[s.transport], opts, depth), ...desc }
      return { ...desc, anyOf: s.variants.map((v) => emit(v, opts, depth)) }
    case 'ref': {
      if (!opts.transport) return { ...desc, $ref: `#/$defs/${s.name}` }
      const n = depth.get(s.name) ?? 0
      if (n >= opts.transport.maxRefDepth) return DROP
      const target = opts.defs?.[s.name]
      if (!target) throw new Error(`Unknown schema reference "${s.name}"`)
      const next = new Map(depth)
      next.set(s.name, n + 1)
      return { ...emit(target, opts, next), ...desc }
    }
  }
}

/** Marker for a property the transport profile leaves out (recursion beyond its depth). */
const DROP: JsonSchema = Object.freeze({ 'x-drop': true }) as JsonSchema

// MnemoNexus learning schemas accept only these keywords (research/R9 §2.2: type, properties,
// required, items, enum, min/max, additionalProperties:false).
const TRANSPORT_KEYS = new Set([
  'type', 'properties', 'required', 'items', 'enum', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'additionalProperties',
])

/** Strip everything outside the host subset. Free-keyed maps become open objects. */
export function toTransportSubset(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!TRANSPORT_KEYS.has(key)) continue
    if (key === 'properties') {
      const props: JsonSchema = {}
      for (const [k, v] of Object.entries(value as JsonSchema)) props[k] = toTransportSubset(v as JsonSchema)
      out.properties = props
    } else if (key === 'items') {
      out.items = toTransportSubset(value as JsonSchema)
    } else if (key === 'additionalProperties') {
      // Only `false` is allowed; omitting it leaves the object open, which is what maps need.
      if (value === false) out.additionalProperties = false
    } else {
      out[key] = value
    }
  }
  return out
}

/** Schema nesting depth: one level per descent into properties, items or additionalProperties. */
export function schemaDepth(schema: unknown): number {
  if (schema === null || typeof schema !== 'object') return 0
  const s = schema as JsonSchema
  let max = 0
  for (const v of Object.values((s.properties as JsonSchema | undefined) ?? {})) max = Math.max(max, schemaDepth(v))
  if (s.items) max = Math.max(max, schemaDepth(s.items))
  if (s.additionalProperties && typeof s.additionalProperties === 'object') max = Math.max(max, schemaDepth(s.additionalProperties))
  for (const v of Object.values((s.$defs as JsonSchema | undefined) ?? {})) max = Math.max(max, schemaDepth(v) - 1)
  return 1 + max
}

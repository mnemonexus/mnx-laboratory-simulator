// Variants (experiment definition §23): one definition, several practicals. A definition declares
// `parameters` (each with a default) and `variants`, each giving values for some of them. A string
// that is exactly "{{name}}" becomes the parameter's value (any JSON: a number, a list, a whole
// supply); "{{name}}" inside a longer string is replaced by the value's text. Expansion happens
// before validation: every variant is validated and rehearsed as the complete definition it becomes.
import type { ExperimentDefinition } from './types.ts'

export interface ParameterDecl {
  /** The value used by the definition itself and by any variant that does not set it. */
  default: unknown
  description?: string
}

export interface VariantDecl {
  /** The variant's own definition id (unique among all definitions). */
  id: string
  title: string
  summary?: string
  briefing?: string
  values?: Record<string, unknown>
  /** Search terms for the catalogue, added to the definition's own. */
  keywords?: string[]
  /** Curricula or courses where this variant appears, in place of the definition's own. */
  curricula?: string[]
}

export interface ExpansionProblem {
  path: string
  message: string
}

const WHOLE = /^\{\{([a-zA-Z][a-zA-Z0-9_-]*)\}\}$/
const INNER = /\{\{([a-zA-Z][a-zA-Z0-9_-]*)\}\}/g

function substitute(value: unknown, values: Record<string, unknown>, path: string, problems: ExpansionProblem[]): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value)
    if (whole) {
      if (!(whole[1] in values)) {
        problems.push({ path, message: `Unknown parameter "${whole[1]}"` })
        return value
      }
      return structuredClone(values[whole[1]])
    }
    return value.replace(INNER, (m, name: string) => {
      if (!(name in values)) {
        problems.push({ path, message: `Unknown parameter "${name}"` })
        return m
      }
      const v = values[name]
      return typeof v === 'string' ? v : JSON.stringify(v)
    })
  }
  if (Array.isArray(value)) return value.map((v, i) => substitute(v, values, `${path}/${i}`, problems))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, values, `${path}/${k}`, problems)
    return out
  }
  return value
}

/** Whether a definition declares variants or parameters. */
export function hasVariants(def: unknown): boolean {
  const d = def as { parameters?: unknown; variants?: unknown }
  return !!d && typeof d === 'object' && (Array.isArray(d.variants) || (!!d.parameters && typeof d.parameters === 'object'))
}

export interface ExpandedDefinition {
  id: string
  /** The definition this one came from (itself for the base). */
  base: string
  /** The variant's id, absent for the base definition. */
  variant?: string
  json: ExperimentDefinition
}

/**
 * Every practical a definition yields: the definition itself with its defaults, then each variant.
 * A definition without parameters or variants yields itself unchanged.
 */
export function expandDefinition(def: unknown): { definitions: ExpandedDefinition[]; problems: ExpansionProblem[] } {
  const problems: ExpansionProblem[] = []
  const d = def as ExperimentDefinition & { parameters?: Record<string, ParameterDecl>; variants?: VariantDecl[] }
  if (!hasVariants(d)) return { definitions: [{ id: d?.id, base: d?.id, json: d }], problems }
  const params = d.parameters ?? {}
  const defaults: Record<string, unknown> = {}
  for (const [name, p] of Object.entries(params)) {
    if (!p || typeof p !== 'object' || !('default' in p)) problems.push({ path: `/parameters/${name}`, message: 'A parameter needs a default' })
    else defaults[name] = p.default
  }
  const { parameters: _p, variants: _v, ...template } = d
  const build = (values: Record<string, unknown>, overrides: Partial<VariantDecl>, path: string): ExperimentDefinition => {
    const json = substitute(template, values, path, problems) as ExperimentDefinition & { context?: Record<string, unknown> }
    if (overrides.id) json.id = overrides.id
    if (overrides.title) json.title = overrides.title
    if (overrides.summary) json.summary = overrides.summary
    if (overrides.briefing) json.briefing = overrides.briefing
    if (overrides.keywords || overrides.curricula) {
      const context = (json.context ??= {}) as Record<string, unknown>
      if (overrides.keywords) context.keywords = [...((context.keywords as string[] | undefined) ?? []), ...overrides.keywords]
      if (overrides.curricula) context.curricula = [...overrides.curricula]
    }
    return json
  }
  const out: ExpandedDefinition[] = [{ id: d.id, base: d.id, json: build(defaults, {}, '') }]
  const seen = new Set([d.id])
  for (const [i, v] of (d.variants ?? []).entries()) {
    const path = `/variants/${i}`
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || typeof v.title !== 'string') {
      problems.push({ path, message: 'A variant needs an id and a title' })
      continue
    }
    if (seen.has(v.id)) problems.push({ path: `${path}/id`, message: `Duplicate id "${v.id}"` })
    seen.add(v.id)
    for (const name of Object.keys(v.values ?? {})) if (!(name in params)) problems.push({ path: `${path}/values/${name}`, message: `Unknown parameter "${name}"` })
    out.push({ id: v.id, base: d.id, variant: v.id, json: build({ ...defaults, ...(v.values ?? {}) }, v, path) })
  }
  return { definitions: out, problems }
}

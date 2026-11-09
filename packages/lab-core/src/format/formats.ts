// Format checks for string fields, shared by the definition and catalogue schemas.
import { parseExpression } from '../expr/parse.ts'
import { type FormatCheck } from '../schema/schema.ts'
import { describe, parseQuantity, type ParsedQuantity } from '../units/quantity.ts'
import { DIMENSIONS, type DimensionName, isUnit, sameDim } from '../units/units.ts'

/** Local identifiers inside a definition (§2). */
export const LOCAL_ID = '^[a-z0-9]+(-[a-z0-9]+)*$'
/** Catalogue references: namespace:name, optionally @version. Names may contain dots. */
export const CATALOGUE_REF = '^[a-z][a-z0-9-]*:[a-z0-9]+([.-][a-z0-9]+)*(@[0-9]+)?$'
/** Purposes are un-namespaced dotted ids (measure-out.volume). */
export const PURPOSE_ID = '^[a-z]+(-[a-z]+)*(\\.[a-z0-9]+(-[a-z0-9]+)*)*$'
export const SEMVER = '^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$'

function dimensionProblem(p: ParsedQuantity, dims: string[] | undefined, text: string): string | null {
  if (!dims || dims.length === 0) return null
  const q = p.kind === 'range' ? p.lo : p.q
  const ok = dims.some((d) => DIMENSIONS[d as DimensionName] && sameDim(DIMENSIONS[d as DimensionName], q.dim))
  return ok ? null : `"${text}" is ${describe(q)}; expected ${dims.join(' or ')}`
}

function quantityCheck(allow: Array<ParsedQuantity['kind']>): FormatCheck {
  return (value, args) => {
    let p: ParsedQuantity
    try {
      p = parseQuantity(value)
    } catch (e) {
      return (e as Error).message
    }
    if (!allow.includes(p.kind)) return `"${value}" is a ${p.kind}; expected a ${allow.join(' or ')}`
    return dimensionProblem(p, args?.dimension as string[] | undefined, value)
  }
}

function expressionCheck(value: string): string | null {
  try {
    parseExpression(value)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

export const FORMATS: Record<string, FormatCheck> = {
  quantity: quantityCheck(['value', 'tolerance']),
  'quantity-or-range': quantityCheck(['value', 'tolerance', 'range']),
  range: quantityCheck(['range']),
  unit: (value) => (isUnit(value) ? null : `Unknown unit "${value}"`),
  expression: expressionCheck,
  predicate: expressionCheck,
  /** A quantity, or an expression ("=2.0 g - mass('x')") computed when the world is staged. */
  'quantity-or-expression': (value, args) => (value.startsWith('=') ? expressionCheck(value) : quantityCheck(['value', 'tolerance'])(value, args)),
  /** A parameter value: an expression ("=…"), or anything else (checked against the parameter's spec at V3). */
  'param-value': (value) => (value.startsWith('=') ? expressionCheck(value) : null),
  pointer: (value) => (value === '' || value.startsWith('/') ? null : `"${value}" is not a JSON Pointer (it must start with "/")`),
}

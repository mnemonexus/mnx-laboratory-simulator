// Quantities: SI values with dimensions, parsed from the definition format's strings
// ("25.00 mL", "37 Cel", "25.00 mL ± 0.05 mL", "0.3..1.4 mg/mL"; format spec §2).
import {
  DIMENSIONLESS,
  type Dim,
  type DimensionName,
  type DimensionlessKind,
  DIMENSIONS,
  deltaFromSI,
  deltaToSI,
  divideDims,
  fromSI,
  isDimensionless,
  kindsCompatible,
  multiplyDims,
  parseUnit,
  powerDim,
  sameDim,
  toSI,
  UnitError,
} from './units.ts'

export interface Quantity {
  /** Value in coherent SI base units (kg, m, s, K, mol). */
  readonly si: number
  readonly dim: Dim
  readonly kind?: DimensionlessKind
  /** The unit it was written in, kept for display. */
  readonly unit?: string
  /** Decimal places as written ("25.00 mL" → 2), the resolution the author implied. */
  readonly decimals?: number
  /** Written as a percentage: a relative tolerance where one is expected. */
  readonly percent?: boolean
}

export type Tolerance = { readonly absolute: Quantity } | { readonly relative: number }

export type ParsedQuantity =
  | { readonly kind: 'value'; readonly q: Quantity }
  | { readonly kind: 'tolerance'; readonly q: Quantity; readonly tol: Tolerance }
  | { readonly kind: 'range'; readonly lo: Quantity; readonly hi: Quantity }

export class QuantityError extends Error {
  readonly text: string
  constructor(message: string, text: string) {
    super(message)
    this.name = 'QuantityError'
    this.text = text
  }
}

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`
const VALUE_RE = new RegExp(String.raw`^\s*(${NUMBER})\s*(.*?)\s*$`)

export function q(value: number, unit: string): Quantity {
  const u = parseUnit(unit)
  return { si: toSI(value, u), dim: u.dim, kind: u.kind, unit, percent: unit === '%' || undefined }
}

export function dimensionless(value: number): Quantity {
  return { si: value, dim: DIMENSIONLESS }
}

/** Parse "25.00 mL", "37 Cel", "5%", "0.452" (dimensionless). */
export function parseValue(text: string): Quantity {
  const m = VALUE_RE.exec(text)
  if (!m) throw new QuantityError(`Not a quantity: "${text}"`, text)
  const num = m[1]
  const unitText = m[2]
  const value = Number(num)
  if (!Number.isFinite(value)) throw new QuantityError(`Not a number: "${num}"`, text)
  const dot = num.replace(/[eE].*$/, '').indexOf('.')
  const decimals = dot < 0 ? 0 : num.replace(/[eE].*$/, '').length - dot - 1
  if (unitText === '') return { si: value, dim: DIMENSIONLESS, decimals }
  let u
  try {
    u = parseUnit(unitText)
  } catch (e) {
    if (e instanceof UnitError) throw new QuantityError(e.message, text)
    throw e
  }
  return {
    si: toSI(value, u),
    dim: u.dim,
    kind: u.kind,
    unit: unitText.trim(),
    decimals,
    percent: unitText.trim() === '%' || undefined,
  }
}

/** Parse a delta ("± 0.05 mL", "0.5 Cel"): temperature offsets are not applied. */
function parseDelta(text: string): Quantity {
  const m = VALUE_RE.exec(text)
  if (!m) throw new QuantityError(`Not a quantity: "${text}"`, text)
  const value = Number(m[1])
  if (m[2] === '') return { si: value, dim: DIMENSIONLESS }
  const u = parseUnit(m[2])
  return { si: deltaToSI(value, u), dim: u.dim, kind: u.kind, unit: m[2].trim(), percent: m[2].trim() === '%' || undefined }
}

/** Parse any quantity string of the definition format. */
export function parseQuantity(text: string): ParsedQuantity {
  const pm = /^(.*?)(?:±|\+\/-)(.*)$/.exec(text)
  if (pm) {
    const value = parseValue(pm[1])
    const delta = parseDelta(pm[2])
    if (delta.percent) return { kind: 'tolerance', q: value, tol: { relative: delta.si } }
    const tolUnitless = isDimensionless(delta.dim) && !delta.unit
    const abs = tolUnitless && value.unit ? { ...delta, si: deltaToSI(delta.si, value.unit), dim: value.dim, unit: value.unit } : delta
    if (!sameDim(abs.dim, value.dim)) {
      throw new QuantityError(`Tolerance "${pm[2].trim()}" has a different dimension from "${pm[1].trim()}"`, text)
    }
    return { kind: 'tolerance', q: value, tol: { absolute: abs } }
  }
  const rm = /^(.*?)\.\.(.*)$/.exec(text)
  if (rm) {
    const hi = parseValue(rm[2])
    let lo = parseValue(rm[1])
    // "0.3..1.4 mg/mL": the unit after the second number applies to both ends.
    if (!lo.unit && hi.unit) lo = parseValue(`${rm[1].trim()} ${hi.unit}`)
    if (!sameDim(lo.dim, hi.dim)) throw new QuantityError(`Range ends have different dimensions in "${text}"`, text)
    if (lo.si > hi.si) throw new QuantityError(`Range "${text}" is reversed`, text)
    return { kind: 'range', lo, hi }
  }
  return { kind: 'value', q: parseValue(text) }
}

export function isQuantityString(text: string): boolean {
  try {
    parseQuantity(text)
    return true
  } catch {
    return false
  }
}

/** The value of `quantity` expressed in `unit`. Throws if incompatible. */
export function valueIn(quantity: Quantity, unit: string): number {
  const u = parseUnit(unit)
  if (!sameDim(u.dim, quantity.dim) || !kindsCompatible(u.kind, quantity.kind)) {
    throw new QuantityError(`Cannot express ${describe(quantity)} in ${unit}`, unit)
  }
  return fromSI(quantity.si, u)
}

export function deltaIn(quantity: Quantity, unit: string): number {
  return deltaFromSI(quantity.si, parseUnit(unit))
}

export function hasDimension(quantity: Quantity, dimension: DimensionName): boolean {
  return sameDim(quantity.dim, DIMENSIONS[dimension])
}

export function compatible(a: Quantity, b: Quantity): boolean {
  return sameDim(a.dim, b.dim) && kindsCompatible(a.kind, b.kind)
}

function requireCompatible(a: Quantity, b: Quantity, op: string): void {
  if (!compatible(a, b)) throw new QuantityError(`Cannot ${op} ${describe(a)} and ${describe(b)}`, op)
}

export function add(a: Quantity, b: Quantity): Quantity {
  requireCompatible(a, b, 'add')
  return { si: a.si + b.si, dim: a.dim, kind: a.kind ?? b.kind, unit: a.unit ?? b.unit }
}

export function subtract(a: Quantity, b: Quantity): Quantity {
  requireCompatible(a, b, 'subtract')
  return { si: a.si - b.si, dim: a.dim, kind: a.kind ?? b.kind, unit: a.unit ?? b.unit }
}

export function multiply(a: Quantity, b: Quantity): Quantity {
  const dim = multiplyDims(a.dim, b.dim)
  return { si: a.si * b.si, dim, kind: isDimensionless(dim) ? (a.kind ?? b.kind) : undefined, unit: preferredUnit(a, b, dim) }
}

export function divide(a: Quantity, b: Quantity): Quantity {
  const dim = divideDims(a.dim, b.dim)
  // mL / mL is a plain ratio; AU / ratio stays absorbance.
  const kind = isDimensionless(dim) ? (sameDim(a.dim, b.dim) && !isDimensionless(a.dim) ? undefined : a.kind) : undefined
  return { si: a.si / b.si, dim, kind, unit: preferredUnit(a, b, dim) }
}

export function scale(a: Quantity, factor: number): Quantity {
  return { ...a, si: a.si * factor, decimals: undefined }
}

export function power(a: Quantity, p: number): Quantity {
  return { si: a.si ** p, dim: powerDim(a.dim, p), kind: a.kind }
}

export function negate(a: Quantity): Quantity {
  return { ...a, si: -a.si }
}

export function compare(a: Quantity, b: Quantity): number {
  requireCompatible(a, b, 'compare')
  return a.si === b.si ? 0 : a.si < b.si ? -1 : 1
}

/** |a − target| ≤ tolerance, where the tolerance is absolute or relative to the target. */
export function within(a: Quantity, target: Quantity, tol: Quantity): boolean {
  requireCompatible(a, target, 'compare')
  if (tol.percent || (isDimensionless(tol.dim) && !isDimensionless(target.dim))) {
    return Math.abs(a.si - target.si) <= Math.abs(target.si) * tol.si + 1e-15
  }
  requireCompatible(a, tol, 'compare')
  return Math.abs(a.si - target.si) <= Math.abs(tol.si) * (1 + 1e-12) + 1e-18
}

function preferredUnit(a: Quantity, b: Quantity, dim: Dim): string | undefined {
  if (a.unit && sameDim(parseUnitSafe(a.unit)?.dim ?? DIMENSIONLESS, dim)) return a.unit
  if (b.unit && sameDim(parseUnitSafe(b.unit)?.dim ?? DIMENSIONLESS, dim)) return b.unit
  return undefined
}

function parseUnitSafe(unit: string) {
  try {
    return parseUnit(unit)
  } catch {
    return undefined
  }
}

// ---- Display ----

const AUTO_UNITS: Partial<Record<DimensionName, string[]>> = {
  volume: ['L', 'mL', 'uL', 'nL'],
  mass: ['kg', 'g', 'mg', 'ug', 'ng'],
  amount: ['mol', 'mmol', 'umol', 'nmol', 'pmol'],
  molarConcentration: ['M', 'mM', 'uM', 'nM'],
  massConcentration: ['mg/mL', 'ug/mL', 'ng/mL'],
  time: ['h', 'min', 's'],
  length: ['m', 'cm', 'mm', 'um', 'nm'],
}

const DISPLAY: Record<string, string> = { uL: 'µL', ug: 'µg', umol: 'µmol', uM: 'µM', 'ug/mL': 'µg/mL', um: 'µm', Cel: '°C', '[RCF]': '× g', '[pH]': '' }

/** A unit that makes the number readable: 0.000025 L → µL. */
export function autoUnit(quantity: Quantity): string | undefined {
  const name = (Object.keys(DIMENSIONS) as DimensionName[]).find((n) => sameDim(DIMENSIONS[n], quantity.dim))
  const candidates = name ? AUTO_UNITS[name] : undefined
  if (!candidates) return quantity.unit
  const abs = Math.abs(quantity.si)
  if (abs === 0) return quantity.unit ?? candidates[1] ?? candidates[0]
  if (name === 'time') {
    if (abs >= 7200) return 'h'
    if (abs >= 120) return 'min'
    return 's'
  }
  for (const unit of candidates) if (abs / parseUnit(unit).factor >= 1) return unit
  return candidates[candidates.length - 1]
}

export interface FormatOptions {
  unit?: string
  /** Fixed decimal places in the chosen unit. */
  decimals?: number
  /** Significant figures (used when decimals is not given). */
  sig?: number
}

export function format(quantity: Quantity, opts: FormatOptions = {}): string {
  const unit = opts.unit ?? autoUnit(quantity) ?? quantity.unit
  const value = unit ? fromSI(quantity.si, parseUnit(unit)) : quantity.si
  const text =
    opts.decimals !== undefined
      ? value.toFixed(opts.decimals)
      : formatSig(value, opts.sig ?? 4)
  if (!unit || unit === '1') return text
  const shown = DISPLAY[unit] ?? unit
  if (shown === '') return text
  if (unit === '%') return `${text}%`
  return `${text} ${shown}`
}

function formatSig(value: number, sig: number): string {
  if (value === 0) return '0'
  const s = Number(value.toPrecision(sig))
  return String(s)
}

/** Canonical string form ("25 mL"), used by the transport profile. */
export function toQuantityString(quantity: Quantity, unit?: string): string {
  const u = unit ?? quantity.unit ?? autoUnit(quantity)
  if (!u) return String(Number(quantity.si.toPrecision(12)))
  return `${Number(fromSI(quantity.si, parseUnit(u)).toPrecision(12))} ${u}`
}

export function describe(quantity: Quantity): string {
  const name = (Object.keys(DIMENSIONS) as DimensionName[]).find((n) => sameDim(DIMENSIONS[n], quantity.dim))
  const kind = quantity.kind && quantity.kind !== 'ratio' ? ` (${quantity.kind})` : ''
  return `${name ?? `dimension [${quantity.dim.join(',')}]`}${kind}`
}

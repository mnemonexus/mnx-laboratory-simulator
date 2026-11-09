// Units: a UCUM subset plus the framework's domain units (state model §11; master-plan/03 D6).
// Values are held in coherent SI base units (kg, m, s, K, mol, A). Dimensionless quantities carry
// a `kind` so that, for example, absorbance cannot be added to pH.

/** Exponents of [mass, length, time, temperature, amount, electric current]. */
export type Dim = readonly [number, number, number, number, number, number]

/** Dimensionless quantities that must not mix with each other. `ratio` is the plain number. */
export type DimensionlessKind = 'ratio' | 'absorbance' | 'ph' | 'rcf' | 'count'

export interface UnitDef {
  /** Factor to SI base: value_SI = value × factor (+ offset for absolute temperatures). */
  factor: number
  dim: Dim
  kind?: DimensionlessKind
  /** Only Cel: absolute temperature with an offset. Not allowed inside compound units. */
  offset?: number
}

export const DIMENSIONLESS: Dim = [0, 0, 0, 0, 0, 0]

export const DIMENSIONS = {
  mass: [1, 0, 0, 0, 0, 0] as Dim,
  length: [0, 1, 0, 0, 0, 0] as Dim,
  volume: [0, 3, 0, 0, 0, 0] as Dim,
  time: [0, 0, 1, 0, 0, 0] as Dim,
  temperature: [0, 0, 0, 1, 0, 0] as Dim,
  amount: [0, 0, 0, 0, 1, 0] as Dim,
  molarConcentration: [0, -3, 0, 0, 1, 0] as Dim,
  massConcentration: [1, -3, 0, 0, 0, 0] as Dim,
  /** Things per volume: {copies}/uL, {cells}/mL. */
  numberConcentration: [0, -3, 0, 0, 0, 0] as Dim,
  molarMass: [1, 0, 0, 0, -1, 0] as Dim,
  frequency: [0, 0, -1, 0, 0, 0] as Dim,
  catalyticActivity: [0, 0, -1, 0, 1, 0] as Dim,
  pressure: [1, -1, -2, 0, 0, 0] as Dim,
  energy: [1, 2, -2, 0, 0, 0] as Dim,
  molarEnergy: [1, 2, -2, 0, -1, 0] as Dim,
  current: [0, 0, 0, 0, 0, 1] as Dim,
  charge: [0, 0, 1, 0, 0, 1] as Dim,
  potential: [1, 2, -3, 0, 0, -1] as Dim,
  conductivity: [-1, -3, 3, 0, 0, 2] as Dim,
  dimensionless: DIMENSIONLESS,
} as const

export type DimensionName = keyof typeof DIMENSIONS

interface Atom {
  factor: number
  dim: Dim
  kind?: DimensionlessKind
  offset?: number
  /** Whether metric prefixes may be applied. */
  metric: boolean
}

const d = (m: number, l: number, t: number, th: number, n: number, i = 0): Dim => [m, l, t, th, n, i]

// Atoms are matched before prefixes, so "min", "mol" and "h" are never read as prefixed units.
const ATOMS: Record<string, Atom> = {
  g: { factor: 1e-3, dim: d(1, 0, 0, 0, 0), metric: true },
  m: { factor: 1, dim: d(0, 1, 0, 0, 0), metric: true },
  L: { factor: 1e-3, dim: d(0, 3, 0, 0, 0), metric: true },
  l: { factor: 1e-3, dim: d(0, 3, 0, 0, 0), metric: true },
  s: { factor: 1, dim: d(0, 0, 1, 0, 0), metric: true },
  min: { factor: 60, dim: d(0, 0, 1, 0, 0), metric: false },
  h: { factor: 3600, dim: d(0, 0, 1, 0, 0), metric: false },
  d: { factor: 86400, dim: d(0, 0, 1, 0, 0), metric: false },
  K: { factor: 1, dim: d(0, 0, 0, 1, 0), metric: false },
  Cel: { factor: 1, offset: 273.15, dim: d(0, 0, 0, 1, 0), metric: false },
  mol: { factor: 1, dim: d(0, 0, 0, 0, 1), metric: true },
  // Molar (mol/L). Not UCUM, but universal in teaching labs ("100 uM", "2 mM").
  M: { factor: 1e3, dim: d(0, -3, 0, 0, 1), metric: true },
  Da: { factor: 1e-3, dim: d(1, 0, 0, 0, -1), metric: true },
  Pa: { factor: 1, dim: d(1, -1, -2, 0, 0), metric: true },
  bar: { factor: 1e5, dim: d(1, -1, -2, 0, 0), metric: true },
  J: { factor: 1, dim: d(1, 2, -2, 0, 0), metric: true },
  A: { factor: 1, dim: d(0, 0, 0, 0, 0, 1), metric: true },
  C: { factor: 1, dim: d(0, 0, 1, 0, 0, 1), metric: true },
  V: { factor: 1, dim: d(1, 2, -3, 0, 0, -1), metric: true },
  S: { factor: 1, dim: d(-1, -2, 3, 0, 0, 2), metric: true },
  // Enzyme unit: 1 µmol of substrate per minute.
  U: { factor: 1e-6 / 60, dim: d(0, 0, -1, 0, 1), metric: true },
  '%': { factor: 0.01, dim: DIMENSIONLESS, kind: 'ratio', metric: false },
  AU: { factor: 1, dim: DIMENSIONLESS, kind: 'absorbance', metric: false },
  '[pH]': { factor: 1, dim: DIMENSIONLESS, kind: 'ph', metric: false },
  '[RCF]': { factor: 1, dim: DIMENSIONLESS, kind: 'rcf', metric: false },
  CFU: { factor: 1, dim: DIMENSIONLESS, kind: 'count', metric: false },
  cells: { factor: 1, dim: DIMENSIONLESS, kind: 'count', metric: false },
  bp: { factor: 1, dim: DIMENSIONLESS, kind: 'count', metric: true },
  '1': { factor: 1, dim: DIMENSIONLESS, kind: 'ratio', metric: false },
}

const PREFIXES: Record<string, number> = {
  G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 1e1, d: 1e-1, c: 1e-2, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
}

/** Authoring conveniences normalised before parsing. */
function normaliseUnitText(text: string): string {
  return text
    .trim()
    .replace(/µ|μ/g, 'u')
    .replace(/°C|degC/g, 'Cel')
    .replace(/·/g, '.')
}

export class UnitError extends Error {
  readonly unit: string
  constructor(message: string, unit: string) {
    super(message)
    this.name = 'UnitError'
    this.unit = unit
  }
}

const cache = new Map<string, UnitDef>()

/** Parse a unit expression such as `uL`, `mg/mL`, `mol/L`, `/min`, `m2`, `10*6/mL`, `[RCF]`. */
export function parseUnit(text: string): UnitDef {
  const src = normaliseUnitText(text)
  const hit = cache.get(src)
  if (hit) return hit
  const def = new UnitParser(src).parse()
  cache.set(src, def)
  return def
}

export function isUnit(text: string): boolean {
  try {
    parseUnit(text)
    return true
  } catch {
    return false
  }
}

function mulDim(a: Dim, b: Dim, sign: number): Dim {
  return [a[0] + sign * b[0], a[1] + sign * b[1], a[2] + sign * b[2], a[3] + sign * b[3], a[4] + sign * b[4], a[5] + sign * b[5]]
}

function powDim(a: Dim, p: number): Dim {
  return [a[0] * p, a[1] * p, a[2] * p, a[3] * p, a[4] * p, a[5] * p]
}

export function sameDim(a: Dim, b: Dim): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[5] === b[5]
}

export function isDimensionless(dim: Dim): boolean {
  return sameDim(dim, DIMENSIONLESS)
}

export function dimensionName(dim: Dim): DimensionName | undefined {
  for (const [name, v] of Object.entries(DIMENSIONS)) if (sameDim(v, dim)) return name as DimensionName
  return undefined
}

export function multiplyDims(a: Dim, b: Dim): Dim {
  return mulDim(a, b, 1)
}

export function divideDims(a: Dim, b: Dim): Dim {
  return mulDim(a, b, -1)
}

export function powerDim(a: Dim, p: number): Dim {
  return powDim(a, p)
}

class UnitParser {
  private i = 0
  private readonly src: string
  constructor(src: string) {
    this.src = src
  }

  parse(): UnitDef {
    if (this.src === '') return { factor: 1, dim: DIMENSIONLESS, kind: 'ratio' }
    let acc: UnitDef = { factor: 1, dim: DIMENSIONLESS }
    let terms = 0
    if (this.peek() === '/') {
      this.i++
      acc = this.combine(acc, this.term(), -1)
      terms++
    } else {
      acc = this.term()
      terms++
    }
    while (this.i < this.src.length) {
      const op = this.src[this.i]
      if (op !== '.' && op !== '/') throw new UnitError(`Unexpected "${op}" in unit "${this.src}"`, this.src)
      this.i++
      acc = this.combine(acc, this.term(), op === '/' ? -1 : 1)
      terms++
    }
    if (acc.offset !== undefined && terms > 1) {
      throw new UnitError(`"Cel" cannot be part of a compound unit ("${this.src}"); use K`, this.src)
    }
    return acc
  }

  private peek(): string | undefined {
    return this.src[this.i]
  }

  private combine(a: UnitDef, b: UnitDef, sign: number): UnitDef {
    const kind = a.kind ?? b.kind
    return {
      factor: sign > 0 ? a.factor * b.factor : a.factor / b.factor,
      dim: mulDim(a.dim, b.dim, sign),
      kind: isDimensionless(mulDim(a.dim, b.dim, sign)) ? kind : undefined,
      offset: a.offset ?? b.offset,
    }
  }

  private term(): UnitDef {
    let base: UnitDef
    if (this.peek() === '(') {
      this.i++
      const start = this.i
      let depth = 1
      while (this.i < this.src.length && depth > 0) {
        if (this.src[this.i] === '(') depth++
        if (this.src[this.i] === ')') depth--
        this.i++
      }
      if (depth !== 0) throw new UnitError(`Unbalanced parentheses in "${this.src}"`, this.src)
      base = new UnitParser(this.src.slice(start, this.i - 1)).parse()
    } else if (this.peek() === '{') {
      // UCUM annotation: {cells}, {copies}. Dimensionless.
      const end = this.src.indexOf('}', this.i)
      if (end < 0) throw new UnitError(`Unclosed annotation in "${this.src}"`, this.src)
      this.i = end + 1
      base = { factor: 1, dim: DIMENSIONLESS, kind: 'count' }
    } else {
      base = this.atom()
    }
    const exp = this.exponent()
    if (exp === 1) return base
    if (base.offset !== undefined) throw new UnitError(`"Cel" cannot carry an exponent`, this.src)
    return { factor: base.factor ** exp, dim: powDim(base.dim, exp), kind: base.kind }
  }

  private exponent(): number {
    const m = /^\^?(-?\d+)/.exec(this.src.slice(this.i))
    if (!m) return 1
    this.i += m[0].length
    return Number(m[1])
  }

  private atom(): UnitDef {
    const rest = this.src.slice(this.i)
    // Numeric factors: 10*6, 10^6 (UCUM writes 10*6).
    const num = /^10[*^](-?\d+)/.exec(rest)
    if (num) {
      this.i += num[0].length
      return { factor: 10 ** Number(num[1]), dim: DIMENSIONLESS, kind: 'ratio' }
    }
    const bracket = /^\[[^\]]+\]/.exec(rest)
    const token = bracket ? bracket[0] : /^[A-Za-z%]+/.exec(rest)?.[0] ?? (rest.startsWith('1') ? '1' : '')
    if (!token) throw new UnitError(`Expected a unit at "${rest}" in "${this.src}"`, this.src)
    // An atom with a trailing exponent digit ("m2") is fine: the token excludes digits.
    const direct = ATOMS[token]
    if (direct) {
      this.i += token.length
      return { factor: direct.factor, dim: direct.dim, kind: direct.kind, offset: direct.offset }
    }
    for (const prefix of ['da', ...Object.keys(PREFIXES).filter((p) => p !== 'da')]) {
      if (!token.startsWith(prefix)) continue
      const atom = ATOMS[token.slice(prefix.length)]
      if (atom && atom.metric) {
        this.i += token.length
        return { factor: PREFIXES[prefix] * atom.factor, dim: atom.dim, kind: atom.kind }
      }
    }
    throw new UnitError(`Unknown unit "${token}" in "${this.src}"`, this.src)
  }
}

/** Convert a value in `unit` to SI base. */
export function toSI(value: number, unit: string | UnitDef): number {
  const u = typeof unit === 'string' ? parseUnit(unit) : unit
  return value * u.factor + (u.offset ?? 0)
}

/** Convert an SI base value to `unit`. */
export function fromSI(value: number, unit: string | UnitDef): number {
  const u = typeof unit === 'string' ? parseUnit(unit) : unit
  return (value - (u.offset ?? 0)) / u.factor
}

/** Convert a difference (no temperature offset) to SI. Used for tolerances. */
export function deltaToSI(value: number, unit: string | UnitDef): number {
  const u = typeof unit === 'string' ? parseUnit(unit) : unit
  return value * u.factor
}

export function deltaFromSI(value: number, unit: string | UnitDef): number {
  const u = typeof unit === 'string' ? parseUnit(unit) : unit
  return value / u.factor
}

/** Whether two units can be converted into each other. */
export function compatibleUnits(a: string | UnitDef, b: string | UnitDef): boolean {
  const ua = typeof a === 'string' ? parseUnit(a) : a
  const ub = typeof b === 'string' ? parseUnit(b) : b
  return sameDim(ua.dim, ub.dim) && kindsCompatible(ua.kind, ub.kind)
}

export function kindsCompatible(a: DimensionlessKind | undefined, b: DimensionlessKind | undefined): boolean {
  const ka = a ?? 'ratio'
  const kb = b ?? 'ratio'
  return ka === kb
}

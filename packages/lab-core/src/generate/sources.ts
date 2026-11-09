// Source verification for generated definitions (external generation §5.2, the generator kit):
// the deterministic cross-check that keeps a generator honest. Every detail a definition claims is
// `source-explicit` must carry a quote; the quote must occur in the source text the generator was
// given; and where the detail is a quantity, that quantity must appear in the quote (in any
// compatible unit). Inferred and assumed details need no quote, but are counted, so a report can
// say how much of a recreation came from the handbook. No AI: text matching and unit parsing only.
import type { ExperimentDefinition } from '../format/types.ts'
import { type Finding, getAtPointer } from '../schema/findings.ts'
import { parseValue, type Quantity } from '../units/quantity.ts'
import { DIMENSIONS, sameDim } from '../units/units.ts'

const MASS_CONCENTRATION = DIMENSIONS.massConcentration

/** Lower case, one space between words, and the typographic variants a PDF or Word file introduces folded. */
export function normaliseText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/­/g, '')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[µμ]/g, 'u')
    .replace(/\s+/g, ' ')
    // A stray space after a decimal point ("0. 9 ml") is typography, not two numbers.
    .replace(/(\d)\. (\d)/g, '$1.$2')
    .toLowerCase()
    .trim()
}

/** Unit words as handbooks write them, mapped to the framework's unit syntax. */
const UNIT_WORDS: Array<[RegExp, string]> = [
  [/^(ul|microlit(re|er)s?)$/, 'uL'],
  [/^(ml|millilit(re|er)s?|cm3|cc)$/, 'mL'],
  [/^(l|lit(re|er)s?|dm3)$/, 'L'],
  [/^(ug|micrograms?)$/, 'ug'],
  [/^(mg|milligrams?)$/, 'mg'],
  [/^(g|grams?)$/, 'g'],
  [/^(kg|kilograms?)$/, 'kg'],
  [/^(ng|nanograms?)$/, 'ng'],
  [/^(nm|nanomet(re|er)s?)$/, 'nm'],
  [/^(mm|millimet(re|er)s?)$/, 'mm'],
  [/^(cm|centimet(re|er)s?)$/, 'cm'],
  [/^(°c|ºc|oc|degc|celsius|degrees?\s?c|deg\s?c)$/, 'Cel'],
  [/^(k|kelvin)$/, 'K'],
  [/^(s|secs?|seconds?)$/, 's'],
  [/^(min|mins|minutes?)$/, 'min'],
  [/^(h|hr|hrs|hours?)$/, 'h'],
  [/^(d|days?)$/, 'd'],
  [/^(%|per\s?cent|percent)$/, '%'],
  [/^(mol\/l|mol\s?dm-3|m|molar)$/, 'mol/L'],
  [/^(mmol\/l|mm|millimolar)$/, 'mM'],
  [/^(umol\/l|um|micromolar)$/, 'uM'],
  [/^(nmol\/l|nm|nanomolar)$/, 'nM'],
  [/^(mg\/ml)$/, 'mg/mL'],
  [/^(ug\/ml)$/, 'ug/mL'],
  [/^(g\/l)$/, 'g/L'],
  [/^(mg\/l)$/, 'mg/L'],
  [/^(rpm)$/, '/min'],
  [/^(v|volts?)$/, 'V'],
  [/^(mv)$/, 'mV'],
]

export interface QuotedNumber {
  value: number
  /** The quantity, where a recognised unit followed the number. */
  quantity?: Quantity
  /** Every reading of an ambiguous unit word ("mm": millimetres or millimolar). */
  alternatives: Quantity[]
}

const NUMBER_WORD_VALUES: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, once: 1, twice: 2, single: 1, double: 2, half: 0.5 }
const NUMBER_WORDS = new RegExp(`\\b(${Object.keys(NUMBER_WORD_VALUES).join('|')})\\b`, 'g')

/** Numbers in a passage, each with the quantities its following word could mean. */
export function numbersIn(passage: string): QuotedNumber[] {
  // Small numbers are often written as words ("count one of the squares", "three times").
  const text = normaliseText(passage).replace(NUMBER_WORDS, (w) => String(NUMBER_WORD_VALUES[w]))
  const out: QuotedNumber[] = []
  // A number (with optional decimal part, thousands commas and an ×10ⁿ or e-notation exponent), then
  // up to three words that may be its unit.
  // A hyphen right after a digit is a range ("10-15 seconds"), not a minus sign.
  const re = /((?:(?<![\d.]\s?)-)?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.?\d+))(?:\s*(?:x|×|\*)\s*10\^?\s*(-?\d+)|e(-?\d+))?\s*([a-z°º%][a-z0-9°º%/\-.]*(?:\s(?:c|dm-3))?)?/g
  for (const m of text.matchAll(re)) {
    let value = Number(m[1].replace(/,/g, ''))
    const exp = m[2] ?? m[3]
    if (exp !== undefined) value *= 10 ** Number(exp)
    if (!Number.isFinite(value)) continue
    const word = (m[4] ?? '').replace(/[.,;:)]+$/, '')
    const alternatives: Quantity[] = []
    for (const [pattern, unit] of UNIT_WORDS) {
      if (!pattern.test(word)) continue
      try {
        alternatives.push(parseValue(`${value} ${unit}`))
      } catch {
        // A unit the parser does not know: keep the bare number.
      }
    }
    out.push({ value, ...(alternatives[0] ? { quantity: alternatives[0] } : {}), alternatives })
  }
  return out
}

/** Whether a quantity (or plain number) is stated in a passage, in any compatible unit. */
export function quoteStates(passage: string, value: unknown): boolean {
  const nums = numbersIn(passage)
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.005 * Math.max(Math.abs(a), Math.abs(b), 1e-300)
  if (typeof value === 'number') return nums.some((n) => close(n.value, value))
  if (typeof value !== 'string') return true
  let q: Quantity
  try {
    q = parseValue(value)
  } catch {
    return true
  }
  // The same quantity in any unit the passage uses, or the bare number as the definition writes it.
  // A percentage of a solid in solution is w/v by laboratory convention: 5 % is 50 g/L.
  const given = Number(value.trim().split(/\s+/)[0])
  const percentAsWv = (a: Quantity) => (a.unit === '%' && sameDim(q.dim, MASS_CONCENTRATION) ? close(a.si * 1000, q.si) : false)
  return nums.some((n) => n.alternatives.some((a) => (sameDim(a.dim, q.dim) && close(a.si, q.si)) || percentAsWv(a)) || (n.alternatives.length === 0 && Number.isFinite(given) && close(n.value, given)))
}

export interface SourceVerification {
  findings: Finding[]
  /** Annotations by provenance class, and how many explicit ones were verified. */
  counts: Record<string, number>
  verified: number
}

const vs = (severity: Finding['severity'], name: string, path: string, message: string, data?: Record<string, unknown>): Finding => ({
  code: `ED-VS-${name}`,
  level: 'VS',
  severity,
  path,
  message,
  ...(data ? { data } : {}),
})

/**
 * Check a definition's provenance against the source texts it cites (`sources`: source id → text).
 * Errors mean a claim the source does not support; warnings mean a claim that cannot be checked.
 */
export function verifySources(def: ExperimentDefinition, sources: Record<string, string>): SourceVerification {
  const findings: Finding[] = []
  const counts: Record<string, number> = {}
  let verified = 0
  const prov = def.provenance
  const declared = new Set((prov?.sources ?? []).map((s) => s.id))
  const texts = new Map(Object.entries(sources).map(([id, t]) => [id, normaliseText(t)]))
  ;(prov?.annotations ?? []).forEach((a, i) => {
    const at = `/provenance/annotations/${i}`
    counts[a.class] = (counts[a.class] ?? 0) + 1
    const target = getAtPointer(def, a.path)
    if (target === undefined) {
      findings.push(vs('error', 'PATH-NOT-FOUND', at, `"${a.path}" does not exist in the definition`))
      return
    }
    if (a.class !== 'source-explicit') return
    if (!a.source || !a.quote) {
      findings.push(vs('warning', 'NO-QUOTE', at, `${a.path} is marked source-explicit without a source and a quote, so it cannot be checked`))
      return
    }
    if (!declared.has(a.source)) {
      findings.push(vs('error', 'UNKNOWN-SOURCE', at, `Source "${a.source}" is not listed in provenance.sources`))
      return
    }
    const text = texts.get(a.source)
    if (text === undefined) {
      findings.push(vs('warning', 'NO-SOURCE-TEXT', at, `No text was supplied for source "${a.source}"`))
      return
    }
    if (!text.includes(normaliseText(a.quote))) {
      findings.push(vs('error', 'QUOTE-NOT-FOUND', at, `The quote for ${a.path} does not occur in source "${a.source}"`, { quote: a.quote }))
      return
    }
    if (!quoteStates(a.quote, target)) {
      findings.push(vs('error', 'VALUE-NOT-IN-QUOTE', at, `${a.path} is ${JSON.stringify(target)}, which its quote does not state`, { quote: a.quote, value: target }))
      return
    }
    verified++
  })
  const explicit = counts['source-explicit'] ?? 0
  findings.push(vs('info', 'SUMMARY', '/provenance', `${verified} of ${explicit} source-explicit details verified against their quotes`, { counts, verified }))
  return { findings, counts, verified }
}

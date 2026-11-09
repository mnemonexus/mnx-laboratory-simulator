import { describe, expect, it } from 'vitest'
import { analyse, evaluate, ExprError, makeEnv, parseExpression, type Value } from '../src/expr/index.ts'
import { idOf, isQuantity } from '../src/expr/evaluate.ts'
import { valueIn } from '../src/units/index.ts'

const ev = (src: string, vars: Record<string, Value> = {}) => evaluate(src, makeEnv(vars))
const inUnit = (v: Value, unit: string) => {
  if (!isQuantity(v)) throw new Error(`not a quantity: ${JSON.stringify(v)}`)
  return valueIn(v, unit)
}

describe('expression parsing', () => {
  it('parses quantities with units after numbers', () => {
    expect(inUnit(ev('100 uM'), 'mol/L')).toBeCloseTo(1e-4)
    expect(inUnit(ev('2 * 25 mL'), 'mL')).toBeCloseTo(50)
    expect(ev('5% == 0.05')).toBe(true)
  })

  it('keeps hyphenated ids as names and needs spaces for subtraction', () => {
    const node = parseExpression('decision(range-check) == "dilute"')
    expect(analyse(node).calls.has('decision')).toBe(true)
    expect(ev('a - b', { a: 5, b: 2 })).toBe(3)
    expect(ev('range-check')).toEqual({ $ref: 'range-check' })
  })

  it('reports syntax errors with positions', () => {
    expect(() => parseExpression('1 +')).toThrow(ExprError)
    expect(() => parseExpression('foo(1, 2')).toThrow(/Expected/)
    expect(() => parseExpression("'unclosed")).toThrow(/Unclosed/)
  })

  it('finds calls and free names', () => {
    const a = analyse(parseExpression('all(s in samples(role="unknown"): reading(read, s) > 0)'))
    expect([...a.calls.keys()].sort()).toEqual(['all', 'reading', 'samples'])
    expect([...a.names]).toEqual(['read'])
  })
})

describe('expression evaluation', () => {
  it('does unit-checked arithmetic', () => {
    expect(inUnit(ev('volumeEach - 25 uL', { volumeEach: ev('100 uL') }), 'uL')).toBeCloseTo(75)
    expect(() => ev('1 mL + 1 g')).toThrow(/Cannot add/)
    expect(ev('2 mL / 1 mL')).toBeCloseTo(2)
    expect(inUnit(ev('2.0 mg/mL * 50 uL'), 'ug')).toBeCloseTo(100)
  })

  it('evaluates only the branch of if() that is taken', () => {
    expect(ev('if(count(xs) == 0, 256, min(xs))', { xs: [] })).toBe(256)
    expect(ev('if(count(xs) == 0, 256, min(xs))', { xs: [4, 2] })).toBe(2)
    expect(ev('if(false, 1)')).toBe(null)
  })

  it('compares quantities across units', () => {
    expect(ev('1 mL > 999 uL')).toBe(true)
    expect(ev('volume == "25 mL"', { volume: ev('0.025 L') })).toBe(true)
    expect(() => ev('1 mL < 1 g')).toThrow()
  })

  it('supports binders and the implicit "it" form', () => {
    const samples = [
      { id: 'u1', role: 'unknown', conc: 1 },
      { id: 'u2', role: 'unknown', conc: 3 },
      { id: 's1', role: 'standard', conc: 2 },
    ]
    expect(ev('all(s in xs: s.conc > 0)', { xs: samples })).toBe(true)
    expect(ev('count(xs, role == "unknown")', { xs: samples })).toBe(2)
    expect(ev('any(xs, it.conc > 2.5)', { xs: samples })).toBe(true)
    expect(ev('exists(filter(xs, role == "blank"))', { xs: samples })).toBe(false)
    expect(ev('map(xs, id)', { xs: samples })).toEqual(['u1', 'u2', 's1'])
    expect(ev('max(map(xs, conc))', { xs: samples })).toBe(3)
  })

  it('evaluates library functions', () => {
    expect(ev('within(101 uM, 100 uM, 5%)')).toBe(true)
    expect(ev('within(1.5 mg/mL, 0.125 mg/mL, 2.0 mg/mL)')).toBe(true)
    expect(ev('within(25.06 mL, 25 mL, 0.05 mL)')).toBe(false)
    expect(inUnit(ev('round(12.34 uL, 0.1 uL)'), 'uL')).toBeCloseTo(12.3)
    const s = ev('seq(2.0 mg/mL, 0.5, 4)') as Value[]
    expect(s.map((x) => inUnit(x, 'mg/mL'))).toEqual([2, 1, 0.5, 0.25])
    expect(ev('monotonic([1, 2, 2, 5])')).toBe(true)
    expect(ev('slice([1, 2, 3, 4, 5], 0, 3)')).toEqual([1, 2, 3])
    expect(ev('slice([1, 2, 3, 4, 5], -2)')).toEqual([4, 5])
    expect(ev('mentions("The reading was above the top standard", "saturat|above the top")')).toBe(true)
    expect(ev('choose(learner, 4)')).toBe(4)
    expect(ev('"valid" in ["valid", "valid-with-limitations"]')).toBe(true)
    expect(ev('xs[1].id', { xs: [{ id: 'a' }, { id: 'b' }] })).toBe('b')
  })

  it('uses environment functions', () => {
    const env = makeEnv({}, { conc: ([c]) => (idOf(c) === 'tube1' ? (ev('0.5 mg/mL') as Value) : 0) })
    expect(evaluate('within(conc(tube1), 0.5 mg/mL, 1%)', env)).toBe(true)
  })

  it('is bounded', () => {
    expect(() => ev('map(range(1, 200000, 200000), it * 2)')).toThrow()
  })
})

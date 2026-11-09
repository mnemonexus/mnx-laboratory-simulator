import { describe, expect, it } from 'vitest'
import {
  add,
  compatible,
  divide,
  format,
  isUnit,
  multiply,
  parseQuantity,
  parseUnit,
  parseValue,
  q,
  valueIn,
  within,
} from '../src/units/index.ts'
import { createRng, eventRng } from '../src/rng/rng.ts'

describe('units', () => {
  it('parses UCUM-style units with prefixes', () => {
    expect(parseUnit('uL').factor).toBeCloseTo(1e-9)
    expect(parseUnit('µL').factor).toBeCloseTo(1e-9)
    expect(parseUnit('mL').factor).toBeCloseTo(1e-6)
    expect(parseUnit('mg/mL').factor).toBeCloseTo(1)
    expect(parseUnit('mmol/L').factor).toBeCloseTo(1)
    expect(parseUnit('mM').factor).toBeCloseTo(1)
    expect(parseUnit('min').factor).toBe(60)
    expect(parseUnit('kDa').factor).toBeCloseTo(1)
    expect(parseUnit('nm').factor).toBeCloseTo(1e-9)
    expect(parseUnit('/min').dim).toEqual([0, 0, -1, 0, 0, 0])
    expect(parseUnit('/(mg/mL)').dim).toEqual([-1, 3, 0, 0, 0, 0])
    expect(parseUnit('m2').dim).toEqual([0, 2, 0, 0, 0, 0])
    expect(parseUnit('10*6/mL').factor).toBeCloseTo(1e12)
  })

  it('rejects unknown units and Cel in compounds', () => {
    expect(isUnit('furlong')).toBe(false)
    expect(isUnit('Cel/min')).toBe(false)
    expect(isUnit('[RCF]')).toBe(true)
    expect(isUnit('[pH]')).toBe(true)
  })

  it('keeps dimensionless kinds apart', () => {
    expect(compatible(q(1, 'AU'), q(1, '[pH]'))).toBe(false)
    expect(compatible(q(1, '%'), q(0.5, '1'))).toBe(true)
    expect(() => add(q(1, 'AU'), q(7, '[pH]'))).toThrow()
  })

  it('handles temperatures with offsets', () => {
    expect(q(37, 'Cel').si).toBeCloseTo(310.15)
    expect(valueIn(q(310.15, 'K'), 'Cel')).toBeCloseTo(37)
  })
})

describe('quantities', () => {
  it('parses values and keeps the written resolution', () => {
    const v = parseValue('25.00 mL')
    expect(valueIn(v, 'L')).toBeCloseTo(0.025)
    expect(v.decimals).toBe(2)
    expect(parseValue('0.452').dim).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('parses tolerances, relative tolerances and ranges', () => {
    const t = parseQuantity('25.00 mL ± 0.05 mL')
    expect(t.kind).toBe('tolerance')
    if (t.kind === 'tolerance' && 'absolute' in t.tol) expect(valueIn(t.tol.absolute, 'mL')).toBeCloseTo(0.05)
    const r = parseQuantity('25 mL ± 2%')
    if (r.kind === 'tolerance') expect(r.tol).toEqual({ relative: 0.02 })
    const range = parseQuantity('0.3..1.4 mg/mL')
    expect(range.kind).toBe('range')
    if (range.kind === 'range') {
      expect(valueIn(range.lo, 'mg/mL')).toBeCloseTo(0.3)
      expect(valueIn(range.hi, 'mg/mL')).toBeCloseTo(1.4)
    }
    expect(() => parseQuantity('2 mL..1 mL')).toThrow()
    expect(() => parseQuantity('2 mL ± 1 g')).toThrow()
  })

  it('does arithmetic with dimensions', () => {
    const c = divide(q(2, 'mg'), q(1, 'mL'))
    expect(valueIn(c, 'mg/mL')).toBeCloseTo(2)
    const n = multiply(q(100, 'uM'), q(1, 'mL'))
    expect(valueIn(n, 'nmol')).toBeCloseTo(100)
    expect(() => add(q(1, 'mL'), q(1, 'mg'))).toThrow()
  })

  it('compares within absolute and relative tolerances', () => {
    expect(within(q(101, 'uM'), q(100, 'uM'), q(5, '%'))).toBe(true)
    expect(within(q(106, 'uM'), q(100, 'uM'), q(5, '%'))).toBe(false)
    expect(within(q(25.04, 'mL'), q(25, 'mL'), q(0.05, 'mL'))).toBe(true)
  })

  it('formats readably', () => {
    expect(format(q(25, 'uL'))).toBe('25 µL')
    expect(format(q(0.0015, 'L'))).toBe('1.5 mL')
    expect(format(q(37, 'Cel'), { unit: 'Cel', decimals: 1 })).toBe('37.0 °C')
    expect(format(q(2, 'mg/mL'), { unit: 'mg/mL', decimals: 2 })).toBe('2.00 mg/mL')
  })
})

describe('rng', () => {
  it('is deterministic per seed, event and channel', () => {
    const a = eventRng(7, 3, 'volume')
    const b = eventRng(7, 3, 'volume')
    const c = eventRng(7, 4, 'volume')
    const xs = [a.next(), a.next()]
    expect([b.next(), b.next()]).toEqual(xs)
    expect(c.next()).not.toBe(xs[0])
  })

  it('has sensible distributions', () => {
    const r = createRng(42)
    let sum = 0
    let sq = 0
    const n = 20000
    for (let i = 0; i < n; i++) {
      const z = r.normal()
      sum += z
      sq += z * z
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.03)
    expect(Math.sqrt(sq / n)).toBeGreaterThan(0.97)
    expect(Math.sqrt(sq / n)).toBeLessThan(1.03)
    let p = 0
    for (let i = 0; i < 5000; i++) p += r.poisson(4)
    expect(p / 5000).toBeGreaterThan(3.85)
    expect(p / 5000).toBeLessThan(4.15)
  })
})

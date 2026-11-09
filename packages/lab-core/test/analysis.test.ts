import { describe, expect, it } from 'vitest'
import { fitLinear, fitMichaelisMenten, fitQuadratic, initialRate, inverse, inverseSE, predict, stats, tCritical } from '../src/analysis/analysis.ts'

describe('analysis library', () => {
  it('computes replicate statistics', () => {
    const s = stats([10.1, 10.3, 9.9, 10.0, 10.2])
    expect(s.mean).toBeCloseTo(10.1, 10)
    expect(s.sd).toBeCloseTo(0.1581, 4)
    expect(s.ci95).toBeCloseTo(2.776 * (0.1581 / Math.sqrt(5)), 3)
    expect(tCritical(10)).toBeCloseTo(2.228, 3)
  })

  it('fits a line with standard errors (textbook data)', () => {
    // Miller & Miller style calibration: y = 1.93x + 1.52 approximately.
    const x = [0, 2, 4, 6, 8, 10, 12]
    const y = [2.1, 5.0, 9.0, 12.6, 17.3, 21.0, 24.7]
    const f = fitLinear(x, y)
    expect(f.slope).toBeCloseTo(1.93, 2)
    expect(f.intercept).toBeCloseTo(1.52, 2)
    expect(Math.sqrt(f.r2)).toBeCloseTo(0.9989, 4)
    expect(f.sy).toBeCloseTo(0.4329, 3)
    expect(f.seSlope).toBeCloseTo(0.0409, 3)
    expect(f.seIntercept).toBeCloseTo(0.2949, 3)
    expect(inverse(f, 13.5)).toBeCloseTo((13.5 - f.intercept) / f.slope, 10)
    expect(inverseSE(f, x, 2.9, 1)).toBeCloseTo(0.2600, 2)
  })

  it('fits a quadratic and inverts it within the calibrated range', () => {
    const x = [0, 0.25, 0.5, 1, 1.5, 2]
    const y = x.map((v) => 0.05 + 0.9 * v - 0.1 * v * v)
    const f = fitQuadratic(x, y)
    expect(f.a).toBeCloseTo(0.05, 8)
    expect(f.b).toBeCloseTo(0.9, 8)
    expect(f.c).toBeCloseTo(-0.1, 8)
    expect(inverse(f, predict(f, 1.2), [0, 2])).toBeCloseTo(1.2, 8)
  })

  it('fits Michaelis–Menten kinetics', () => {
    const vmax = 52
    const km = 0.18
    const s = [0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6]
    const v = s.map((x) => (vmax * x) / (km + x))
    const f = fitMichaelisMenten(s, v)
    expect(f.vmax).toBeCloseTo(vmax, 6)
    expect(f.km).toBeCloseTo(km, 6)
  })

  it('takes an initial-rate slope from a window', () => {
    const t = [0, 10, 20, 30, 40, 50, 60]
    const y = t.map((ti) => 1.2 - 0.004 * ti + (ti > 40 ? 0.0001 * (ti - 40) ** 2 : 0))
    const f = initialRate(t, y, 0, 40)
    expect(f.slope).toBeCloseTo(-0.004, 10)
  })
})

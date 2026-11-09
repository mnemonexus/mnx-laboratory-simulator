// Hypothesis tests against R's published outputs (the sleep, PlantGrowth and Mendel examples),
// and core:test as a kernel operation.
import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { anovaOneWay, chiSquareFit, chiSquareIndependence, pairedT, regression, studentT, tQuantile, welchT } from '../src/analysis/statistics.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { createKernel, emptyWorld } from '../src/kernel/index.ts'

const sleep1 = [0.7, -1.6, -0.2, -1.2, -0.1, 3.4, 3.7, 0.8, 0.0, 2.0]
const sleep2 = [1.9, 0.8, 1.1, 0.1, -0.1, 4.4, 5.5, 1.6, 4.6, 3.4]
const ctrl = [4.17, 5.58, 5.18, 6.11, 4.5, 4.61, 5.17, 4.53, 5.33, 5.14]
const trt1 = [4.81, 4.17, 4.41, 3.59, 5.87, 3.83, 6.03, 4.89, 4.32, 4.69]
const trt2 = [6.31, 5.12, 5.54, 5.5, 5.37, 5.29, 4.92, 6.15, 5.8, 5.26]

describe('hypothesis tests', () => {
  it('t-tests match R on the sleep data', () => {
    const w = welchT(sleep1, sleep2)
    expect(w.statistic).toBeCloseTo(-1.8608, 4)
    expect(w.df).toBeCloseTo(17.776, 3)
    expect(w.p).toBeCloseTo(0.07939, 5)
    const s = studentT(sleep1, sleep2)
    expect(s.df).toBe(18)
    expect(s.p).toBeCloseTo(0.07919, 5)
    const p = pairedT(sleep1, sleep2)
    expect(p.statistic).toBeCloseTo(-4.0621, 4)
    expect(p.p).toBeCloseTo(0.002833, 6)
    expect(tQuantile(0.05, 9)).toBeCloseTo(2.262157, 5)
  })

  it('one-way ANOVA matches R on PlantGrowth, and equals the t-test for two groups', () => {
    const a = anovaOneWay([ctrl, trt1, trt2])
    expect(a.statistic).toBeCloseTo(4.846, 3)
    expect([a.df, a.df2]).toEqual([2, 27])
    expect(a.p).toBeCloseTo(0.01591, 5)
    const two = anovaOneWay([sleep1, sleep2])
    expect(two.statistic).toBeCloseTo(studentT(sleep1, sleep2).statistic ** 2, 8)
    expect(two.p).toBeCloseTo(studentT(sleep1, sleep2).p, 8)
  })

  it('chi-square matches R on Mendel\'s dihybrid cross and a 2 × 2 table', () => {
    const m = chiSquareFit([315, 108, 101, 32], [9, 3, 3, 1])
    expect(m.statistic).toBeCloseTo(0.47002, 5)
    expect(m.df).toBe(3)
    expect(m.p).toBeCloseTo(0.9254, 4)
    const t = chiSquareIndependence([[20, 30], [30, 20]])
    expect(t.statistic).toBeCloseTo(4, 10)
    expect(t.p).toBeCloseTo(0.0455, 4)
  })

  it('regression: the slope, its test, and the same p as the correlation', () => {
    const r = regression([1, 2, 3, 4, 5], [2.1, 3.9, 6.2, 7.8, 10.1])
    expect(r.estimate).toBeCloseTo(1.99, 10)
    expect(r.intercept).toBeCloseTo(0.05, 10)
    expect(r.r2).toBeGreaterThan(0.99)
    expect(r.p).toBeLessThan(1e-4)
    expect(r.ci95![0]).toBeLessThan(1.99)
    expect(regression([1, 2, 3, 4], [3, 1, 3, 1]).p).toBeGreaterThan(0.5)
  })

  it('core:test runs a test as an operation and refuses one it cannot do', () => {
    const { catalogue } = Catalogue.build(loadAllPacks())
    const k = createKernel(catalogue, emptyWorld(1))
    const r = k.execute({ op: 'core:test', params: { test: 'welch-t', groups: [sleep1, sleep2] } })
    if (!r.ok) throw new Error(r.refusal.message)
    const out = r.outputs as { p: number; significant: boolean }
    expect(out.p).toBeCloseTo(0.07939, 5)
    expect(out.significant).toBe(false)
    expect(k.execute({ op: 'core:test', params: { test: 'welch-t', groups: [[1, 1], [2, 2]] } }).ok).toBe(false)
    expect(k.execute({ op: 'core:test', params: { test: 'anova', groups: [[1], [2]] } }).ok).toBe(false)
  })
})

// Statistical tests as data operations (data and analysis §5): the test, its statistic, degrees
// of freedom and p-value become an event, so a conclusion's evidence is replayable.
import { anovaOneWay, chiSquareFit, chiSquareIndependence, oneSampleT, pairedT, regression, studentT, type TestResult, welchT } from '../analysis/statistics.ts'
import { isQuantity } from '../expr/evaluate.ts'
import { type OpContext, type OpImpl, type OpResult, toQuantity } from './kernel.ts'

type Params = Record<string, unknown>

/** A list of plain numbers (quantities by their SI value; a test does not depend on the unit). */
function values(ctx: OpContext, list: unknown, what: string): number[] {
  if (!Array.isArray(list)) ctx.refuse('BAD-DATA', `${what} must be a list of values`)
  return list.map((v) => {
    const q = typeof v === 'number' ? v : toQuantity(v) ?? v
    const x = typeof q === 'number' ? q : isQuantity(q) ? q.si : NaN
    if (!Number.isFinite(x)) ctx.refuse('BAD-DATA', `${what} holds a value that is not a number`)
    return x
  })
}

function groupsOf(ctx: OpContext, p: Params): number[][] {
  if (!Array.isArray(p.groups)) ctx.refuse('BAD-DATA', 'groups must be a list of lists of values')
  return (p.groups as unknown[]).map((g, i) => values(ctx, g, `Group ${i + 1}`))
}

function test(ctx: OpContext, p: Params): OpResult {
  const which = String(p.test ?? '')
  const alpha = p.alpha === undefined ? 0.05 : Number(p.alpha)
  if (!(alpha > 0 && alpha < 1)) ctx.refuse('BAD-ALPHA', 'The significance level must be between 0 and 1')
  let r: TestResult
  try {
    if (which === 'welch-t' || which === 'student-t' || which === 'paired-t') {
      const g = groupsOf(ctx, p)
      if (g.length !== 2) ctx.refuse('BAD-DATA', 'A t-test compares exactly two groups')
      r = which === 'welch-t' ? welchT(g[0], g[1]) : which === 'student-t' ? studentT(g[0], g[1]) : pairedT(g[0], g[1])
    } else if (which === 'one-sample-t') {
      r = oneSampleT(values(ctx, p.x, 'x'), Number(p.mu ?? 0))
    } else if (which === 'anova') {
      r = anovaOneWay(groupsOf(ctx, p))
    } else if (which === 'regression') {
      r = regression(values(ctx, p.x, 'x'), values(ctx, p.y, 'y'))
    } else if (which === 'chi-square') {
      r = chiSquareFit(values(ctx, p.observed, 'observed'), values(ctx, p.expected, 'expected'))
    } else if (which === 'chi-square-independence') {
      r = chiSquareIndependence(groupsOf(ctx, p))
    } else return ctx.refuse('UNKNOWN-TEST', `There is no test "${which}"`)
  } catch (e) {
    return ctx.refuse('TEST-FAILED', (e as Error).message)
  }
  return { outputs: { ...r, alpha, significant: r.p < alpha }, facts: { test: which, p: r.p, significant: r.p < alpha } }
}

export const STATS_OPERATIONS: Record<string, OpImpl> = {
  'core:test': test,
}

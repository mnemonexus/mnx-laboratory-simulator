// Hypothesis tests (data and analysis §5): t-tests, one-way ANOVA, the regression slope and
// chi-square, with exact p-values from the t, F and chi-square distributions. Shared by the
// kernel's core:test, the learner's workspace and assessment, so all compute identically.

export interface TestResult {
  test: string
  /** The test statistic: t, F or chi-square. */
  statistic: number
  df: number
  /** ANOVA: the within-groups degrees of freedom (df is between groups). */
  df2?: number
  /** Two-sided for t-tests and the slope; upper tail for F and chi-square. */
  p: number
  n: number
  /** Each group's mean (t-tests, ANOVA). */
  means?: number[]
  /** The difference of means (t-tests) or the slope (regression), with its 95 % confidence interval. */
  estimate?: number
  ci95?: [number, number]
  /** Regression: intercept and r². */
  intercept?: number
  r2?: number
}

// ---- Distributions ----

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function lnGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x)
  x -= 1
  let a = c[0]
  const t = x + 7.5
  for (let i = 1; i < 9; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** The regularised incomplete beta function I_x(a, b) (continued fraction, Lentz). */
export function betaInc(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  // The fraction converges fast for x < (a + 1)/(a + b + 2); use the symmetry otherwise.
  if (x > (a + 1) / (a + b + 2)) return 1 - betaInc(1 - x, b, a)
  const tiny = 1e-300
  let f = 1
  let c = 1
  let d = 0
  for (let i = 0; i <= 400; i++) {
    const m = i >> 1
    const num = i === 0 ? 1 : i % 2 === 0 ? (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m)) : -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1))
    d = 1 + num * d
    if (Math.abs(d) < tiny) d = tiny
    d = 1 / d
    c = 1 + num / c
    if (Math.abs(c) < tiny) c = tiny
    const cd = c * d
    f *= cd
    if (Math.abs(1 - cd) < 1e-14) break
  }
  return (front * (f - 1)) / a
}

/** The regularised lower incomplete gamma function P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0
  const lnFront = -x + a * Math.log(x) - lnGamma(a)
  if (x < a + 1) {
    // Series.
    let sum = 1 / a
    let term = sum
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n)
      sum += term
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break
    }
    return sum * Math.exp(lnFront)
  }
  // Continued fraction for Q, then P = 1 − Q.
  const tiny = 1e-300
  let b = x + 1 - a
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-15) break
  }
  return 1 - Math.exp(lnFront) * h
}

/** Two-sided p for Student's t with df degrees of freedom. */
export function tP(t: number, df: number): number {
  return betaInc(df / (df + t * t), df / 2, 0.5)
}

/** Upper-tail p for F with (d1, d2) degrees of freedom. */
export function fP(f: number, d1: number, d2: number): number {
  return f <= 0 ? 1 : betaInc(d2 / (d2 + d1 * f), d2 / 2, d1 / 2)
}

/** Upper-tail p for chi-square with k degrees of freedom. */
export function chiSquareP(x: number, k: number): number {
  return x <= 0 ? 1 : 1 - gammaP(k / 2, x / 2)
}

/** The two-sided critical t (|t| exceeded with probability alpha), by bisection. */
export function tQuantile(alpha: number, df: number): number {
  let lo = 0
  let hi = 1e3
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (tP(mid, df) > alpha) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

// ---- Tests ----

const meanOf = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const varOf = (xs: readonly number[], m = meanOf(xs)) => xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)

function needs(cond: boolean, message: string): void {
  if (!cond) throw new Error(message)
}

/** Welch's t-test: two independent groups, variances not assumed equal. */
export function welchT(a: readonly number[], b: readonly number[]): TestResult {
  needs(a.length >= 2 && b.length >= 2, 'Each group needs at least two values')
  const [ma, mb] = [meanOf(a), meanOf(b)]
  const [va, vb] = [varOf(a, ma) / a.length, varOf(b, mb) / b.length]
  needs(va + vb > 0, 'The groups have no spread: a t-test cannot be done')
  const se = Math.sqrt(va + vb)
  const t = (ma - mb) / se
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1))
  const h = tQuantile(0.05, df) * se
  return { test: 'welch-t', statistic: t, df, p: tP(t, df), n: a.length + b.length, means: [ma, mb], estimate: ma - mb, ci95: [ma - mb - h, ma - mb + h] }
}

/** Student's t-test: two independent groups, equal variances pooled. */
export function studentT(a: readonly number[], b: readonly number[]): TestResult {
  needs(a.length >= 2 && b.length >= 2, 'Each group needs at least two values')
  const [ma, mb] = [meanOf(a), meanOf(b)]
  const df = a.length + b.length - 2
  const pooled = ((a.length - 1) * varOf(a, ma) + (b.length - 1) * varOf(b, mb)) / df
  needs(pooled > 0, 'The groups have no spread: a t-test cannot be done')
  const se = Math.sqrt(pooled * (1 / a.length + 1 / b.length))
  const t = (ma - mb) / se
  const h = tQuantile(0.05, df) * se
  return { test: 'student-t', statistic: t, df, p: tP(t, df), n: a.length + b.length, means: [ma, mb], estimate: ma - mb, ci95: [ma - mb - h, ma - mb + h] }
}

/** Paired t-test: the differences of matched pairs against zero. */
export function pairedT(a: readonly number[], b: readonly number[]): TestResult {
  needs(a.length === b.length, 'A paired test needs the same number of values in each group')
  const r = oneSampleT(a.map((x, i) => x - b[i]), 0)
  return { ...r, test: 'paired-t', n: a.length, means: [meanOf(a), meanOf(b)] }
}

/** One-sample t-test of a mean against mu. */
export function oneSampleT(a: readonly number[], mu: number): TestResult {
  needs(a.length >= 2, 'The test needs at least two values')
  const m = meanOf(a)
  const se = Math.sqrt(varOf(a, m) / a.length)
  needs(se > 0, 'The values have no spread: a t-test cannot be done')
  const df = a.length - 1
  const t = (m - mu) / se
  const h = tQuantile(0.05, df) * se
  return { test: 'one-sample-t', statistic: t, df, p: tP(t, df), n: a.length, means: [m], estimate: m - mu, ci95: [m - mu - h, m - mu + h] }
}

/** One-way ANOVA across two or more groups. */
export function anovaOneWay(groups: ReadonlyArray<readonly number[]>): TestResult {
  needs(groups.length >= 2, 'ANOVA needs at least two groups')
  needs(groups.every((g) => g.length >= 1), 'Every group needs a value')
  const all = groups.flat()
  const grand = meanOf(all)
  const means = groups.map((g) => meanOf(g))
  const ssB = groups.reduce((a, g, i) => a + g.length * (means[i] - grand) ** 2, 0)
  const ssW = groups.reduce((a, g, i) => a + g.reduce((s, x) => s + (x - means[i]) ** 2, 0), 0)
  const df1 = groups.length - 1
  const df2 = all.length - groups.length
  needs(df2 > 0, 'ANOVA needs replicates in at least one group')
  needs(ssW > 0, 'The groups have no spread within them: ANOVA cannot be done')
  const f = ssB / df1 / (ssW / df2)
  return { test: 'anova', statistic: f, df: df1, df2, p: fP(f, df1, df2), n: all.length, means }
}

/** Linear regression of y on x, with a t-test of the slope against zero. */
export function regression(x: readonly number[], y: readonly number[]): TestResult {
  needs(x.length === y.length, 'x and y need the same number of values')
  needs(x.length >= 3, 'Regression needs at least three points')
  const [mx, my] = [meanOf(x), meanOf(y)]
  const sxx = x.reduce((a, v) => a + (v - mx) ** 2, 0)
  needs(sxx > 0, 'x does not vary')
  const sxy = x.reduce((a, v, i) => a + (v - mx) * (y[i] - my), 0)
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const ssRes = y.reduce((a, v, i) => a + (v - intercept - slope * x[i]) ** 2, 0)
  const ssTot = y.reduce((a, v) => a + (v - my) ** 2, 0)
  const df = x.length - 2
  const se = Math.sqrt(ssRes / df / sxx)
  const t = se > 0 ? slope / se : slope === 0 ? 0 : Infinity
  const h = tQuantile(0.05, df) * se
  return { test: 'regression', statistic: t, df, p: se > 0 ? tP(t, df) : slope === 0 ? 1 : 0, n: x.length, estimate: slope, ci95: [slope - h, slope + h], intercept, r2: ssTot > 0 ? 1 - ssRes / ssTot : 1 }
}

/** Chi-square goodness of fit: observed counts against expected counts or proportions. */
export function chiSquareFit(observed: readonly number[], expected: readonly number[]): TestResult {
  needs(observed.length === expected.length && observed.length >= 2, 'Give observed and expected values for at least two categories')
  const total = observed.reduce((a, b) => a + b, 0)
  const sumE = expected.reduce((a, b) => a + b, 0)
  needs(total > 0 && sumE > 0, 'There are no counts')
  const e = expected.map((x) => (x * total) / sumE)
  needs(e.every((x) => x > 0), 'Every expected count must be above zero')
  const x2 = observed.reduce((a, o, i) => a + (o - e[i]) ** 2 / e[i], 0)
  const df = observed.length - 1
  return { test: 'chi-square', statistic: x2, df, p: chiSquareP(x2, df), n: total }
}

/** Chi-square test of independence on a contingency table (rows of counts). */
export function chiSquareIndependence(table: ReadonlyArray<readonly number[]>): TestResult {
  needs(table.length >= 2 && table.every((r) => r.length === table[0].length && r.length >= 2), 'The table needs at least two rows and two columns of equal length')
  const rows = table.map((r) => r.reduce((a, b) => a + b, 0))
  const cols = table[0].map((_, j) => table.reduce((a, r) => a + r[j], 0))
  const total = rows.reduce((a, b) => a + b, 0)
  needs(rows.every((r) => r > 0) && cols.every((c) => c > 0), 'Every row and column needs a count')
  let x2 = 0
  for (let i = 0; i < table.length; i++) for (let j = 0; j < cols.length; j++) {
    const e = (rows[i] * cols[j]) / total
    x2 += (table[i][j] - e) ** 2 / e
  }
  const df = (table.length - 1) * (cols.length - 1)
  return { test: 'chi-square-independence', statistic: x2, df, p: chiSquareP(x2, df), n: total }
}

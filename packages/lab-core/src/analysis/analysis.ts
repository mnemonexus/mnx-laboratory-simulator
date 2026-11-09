// The analysis library (master-plan/04 §10; data and analysis §5). Shared by the learner's
// workspace, the reference agent and assessment, so all three compute identically.
import { scientificNumerics } from '../models/numerics.ts'

export interface Stats {
  n: number
  mean: number
  sd: number
  sem: number
  /** Half-width of the 95 % confidence interval of the mean. */
  ci95: number
  min: number
  max: number
}

export function stats(xs: readonly number[]): Stats {
  const n = xs.length
  if (n === 0) return { n: 0, mean: NaN, sd: NaN, sem: NaN, ci95: NaN, min: NaN, max: NaN }
  const mean = xs.reduce((a, b) => a + b, 0) / n
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  const sem = n > 1 ? sd / Math.sqrt(n) : 0
  return { n, mean, sd, sem, ci95: n > 1 ? tCritical(n - 1) * sem : 0, min: Math.min(...xs), max: Math.max(...xs) }
}

/** Two-sided 95 % critical value of Student's t for `df` degrees of freedom. */
export function tCritical(df: number): number {
  const table = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086]
  if (df < 1) return NaN
  if (df <= table.length) return table[df - 1]
  if (df <= 30) return 2.086 - ((df - 20) * (2.086 - 2.042)) / 10
  if (df <= 60) return 2.042 - ((df - 30) * (2.042 - 2.0)) / 30
  return 1.96 + 2.4 / df
}

export interface LinearFit {
  model: 'linear' | 'linear-through-origin'
  slope: number
  intercept: number
  seSlope: number
  seIntercept: number
  r2: number
  /** Residual standard deviation. */
  sy: number
  n: number
  residuals: number[]
}

export function fitLinear(xs: readonly number[], ys: readonly number[], throughOrigin = false): LinearFit {
  const n = Math.min(xs.length, ys.length)
  if (n < 2) throw new Error('A line needs at least two points')
  if (throughOrigin) {
    let sxy = 0
    let sxx = 0
    for (let i = 0; i < n; i++) {
      sxy += xs[i] * ys[i]
      sxx += xs[i] * xs[i]
    }
    if (sxx === 0) throw new Error('All x values are zero')
    const slope = sxy / sxx
    const residuals = ys.slice(0, n).map((y, i) => y - slope * xs[i])
    const sse = residuals.reduce((a, r) => a + r * r, 0)
    const sy = Math.sqrt(sse / Math.max(1, n - 1))
    const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n
    const sst = ys.slice(0, n).reduce((a, y) => a + (y - my) ** 2, 0)
    return { model: 'linear-through-origin', slope, intercept: 0, seSlope: sy / Math.sqrt(sxx), seIntercept: 0, r2: sst > 0 ? 1 - sse / sst : 1, sy, n, residuals }
  }
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
    syy += (ys[i] - my) ** 2
  }
  if (sxx === 0) throw new Error('All x values are the same')
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const residuals = ys.slice(0, n).map((y, i) => y - (intercept + slope * xs[i]))
  const sse = residuals.reduce((a, r) => a + r * r, 0)
  const sy = n > 2 ? Math.sqrt(sse / (n - 2)) : 0
  const sumX2 = xs.slice(0, n).reduce((a, x) => a + x * x, 0)
  return {
    model: 'linear',
    slope,
    intercept,
    seSlope: sy / Math.sqrt(sxx),
    seIntercept: sy * Math.sqrt(sumX2 / (n * sxx)),
    r2: syy > 0 ? 1 - sse / syy : 1,
    sy,
    n,
    residuals,
  }
}

export interface QuadraticFit {
  model: 'quadratic'
  /** y = a + b·x + c·x² */
  a: number
  b: number
  c: number
  r2: number
  sy: number
  n: number
  residuals: number[]
}

export function fitQuadratic(xs: readonly number[], ys: readonly number[]): QuadraticFit {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) throw new Error('A quadratic needs at least three points')
  // Normal equations for [a, b, c].
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0
  for (let i = 0; i < n; i++) {
    const x = xs[i]
    const y = ys[i]
    s0 += 1
    s1 += x
    s2 += x * x
    s3 += x ** 3
    s4 += x ** 4
    t0 += y
    t1 += x * y
    t2 += x * x * y
  }
  const [a, b, c] = solve3(
    [
      [s0, s1, s2],
      [s1, s2, s3],
      [s2, s3, s4],
    ],
    [t0, t1, t2],
  )
  const residuals = ys.slice(0, n).map((y, i) => y - (a + b * xs[i] + c * xs[i] * xs[i]))
  const my = t0 / n
  const sse = residuals.reduce((acc, r) => acc + r * r, 0)
  const sst = ys.slice(0, n).reduce((acc, y) => acc + (y - my) ** 2, 0)
  return { model: 'quadratic', a, b, c, r2: sst > 0 ? 1 - sse / sst : 1, sy: n > 3 ? Math.sqrt(sse / (n - 3)) : 0, n, residuals }
}

function solve3(m: number[][], v: number[]): [number, number, number] {
  const det = (q: number[][]) =>
    q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) - q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) + q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0])
  const d = det(m)
  if (Math.abs(d) < 1e-300) throw new Error('The points do not determine a quadratic')
  const col = (k: number) => m.map((row, i) => row.map((x, j) => (j === k ? v[i] : x)))
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d]
}

export interface FourPLFit {
  model: 'four-pl'
  /** y = d + (a − d) / (1 + (x/c)^b): a at no analyte, d at saturation, c the midpoint (EC50), b the slope. */
  a: number
  d: number
  c: number
  b: number
  seA: number
  seD: number
  seC: number
  seB: number
  r2: number
  sy: number
  n: number
  residuals: number[]
}

const fourPL = (a: number, d: number, c: number, b: number, x: number) => (x <= 0 ? a : d + (a - d) / (1 + Math.pow(x / c, b)))

/**
 * Four-parameter logistic by Levenberg–Marquardt over (a, d, ln c, b), started from the data's
 * extremes and the concentration nearest half-way. Standard errors come from the Jacobian at the
 * optimum. Needs at least five points, with positive x values spread across the rise.
 */
export function fitFourPL(xs: readonly number[], ys: readonly number[]): FourPLFit {
  const n = Math.min(xs.length, ys.length)
  if (n < 5) throw new Error('A four-parameter logistic needs at least five points')
  const X = xs.slice(0, n)
  const Y = ys.slice(0, n)
  const positive = X.filter((x) => x > 0)
  if (positive.length < 3) throw new Error('A four-parameter logistic needs at least three positive concentrations')
  const rust = scientificNumerics()
  if (rust) return rust.fitFourPL(X, Y)
  const order = X.map((_, i) => i).sort((i, j) => X[i] - X[j])
  const lowY = Y[order[0]]
  const highY = Y[order[n - 1]]
  // Start: the extremes, the concentration whose response is nearest half-way, and a slope of 1.
  const half = (lowY + highY) / 2
  let start = order.find((i) => X[i] > 0)!
  for (const i of order) if (X[i] > 0 && Math.abs(Y[i] - half) < Math.abs(Y[start] - half)) start = i
  let p = [lowY, highY, Math.log(X[start]), 1]
  const model = (q: number[], x: number) => fourPL(q[0], q[1], Math.exp(q[2]), q[3], x)
  const sseOf = (q: number[]) => X.reduce((acc, x, i) => acc + (Y[i] - model(q, x)) ** 2, 0)
  const jacobian = (q: number[]) =>
    X.map((x) => {
      const [a, d, lc, b] = q
      if (x <= 0) return [1, 0, 0, 0]
      const u = Math.pow(x / Math.exp(lc), b)
      const den = 1 + u
      // ∂y/∂a = 1/den; ∂y/∂d = 1 − 1/den; ∂y/∂ln c = (a − d)·u·b/den²; ∂y/∂b = −(a − d)·u·ln(x/c)/den².
      return [1 / den, 1 - 1 / den, ((a - d) * u * b) / (den * den), (-(a - d) * u * (Math.log(x) - lc)) / (den * den)]
    })
  let lambda = 1e-3
  let sse = sseOf(p)
  for (let iter = 0; iter < 500; iter++) {
    const J = jacobian(p)
    const r = X.map((x, i) => Y[i] - model(p, x))
    const JtJ = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => J.reduce((acc, row) => acc + row[i] * row[j], 0)))
    const Jtr = [0, 1, 2, 3].map((i) => J.reduce((acc, row, k) => acc + row[i] * r[k], 0))
    let improved = false
    for (let tries = 0; tries < 20 && !improved; tries++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)))
      const step = solveN(A, Jtr)
      if (!step) {
        lambda *= 10
        continue
      }
      const next = p.map((v, i) => v + step[i])
      const nextSse = sseOf(next)
      if (Number.isFinite(nextSse) && nextSse < sse) {
        const gain = sse - nextSse
        p = next
        sse = nextSse
        lambda = Math.max(1e-12, lambda / 10)
        improved = true
        if (gain < 1e-15 * (1 + sse)) iter = 500
      } else lambda *= 10
    }
    if (!improved) break
  }
  const [a, d, lc, b] = p
  const c = Math.exp(lc)
  const residuals = X.map((x, i) => Y[i] - fourPL(a, d, c, b, x))
  const my = Y.reduce((acc, y) => acc + y, 0) / n
  const sst = Y.reduce((acc, y) => acc + (y - my) ** 2, 0)
  const s2 = n > 4 ? sse / (n - 4) : 0
  const J = jacobian(p)
  const JtJ = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => J.reduce((acc, row) => acc + row[i] * row[j], 0)))
  const cov = [0, 1, 2, 3].map((k) => solveN(JtJ, [0, 1, 2, 3].map((i) => (i === k ? 1 : 0))))
  const se = (k: number) => (cov[k] && cov[k]![k] > 0 ? Math.sqrt(s2 * cov[k]![k]) : NaN)
  return { model: 'four-pl', a, d, c, b, seA: se(0), seD: se(1), seC: se(2) * c, seB: se(3), r2: sst > 0 ? 1 - sse / sst : 1, sy: Math.sqrt(s2), n, residuals }
}

/** Solve a small dense system (Gaussian elimination with partial pivoting); undefined if singular. */
function solveN(a: number[][], b: number[]): number[] | undefined {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r
    if (Math.abs(m[piv][col]) < 1e-300) return undefined
    ;[m[col], m[piv]] = [m[piv], m[col]]
    for (let r = col + 1; r < n; r++) {
      const f = m[r][col] / m[col][col]
      for (let k = col; k <= n; k++) m[r][k] -= f * m[col][k]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let acc = m[r][n]
    for (let k = r + 1; k < n; k++) acc -= m[r][k] * x[k]
    x[r] = acc / m[r][r]
  }
  return x.every(Number.isFinite) ? x : undefined
}

export type CalibrationFit = LinearFit | QuadraticFit | FourPLFit

export function predict(fit: CalibrationFit, x: number): number {
  if (fit.model === 'quadratic') return fit.a + fit.b * x + fit.c * x * x
  if (fit.model === 'four-pl') return fourPL(fit.a, fit.d, fit.c, fit.b, x)
  return fit.intercept + fit.slope * x
}

/** x for a measured y (inverse prediction), choosing the root within the calibrated x range. */
export function inverse(fit: CalibrationFit, y: number, xRange?: [number, number]): number {
  if (fit.model === 'four-pl') {
    // Only between the asymptotes: beyond them no concentration gives that response.
    const t = (fit.a - fit.d) / (y - fit.d) - 1
    if (!(t > 0) || !Number.isFinite(t)) return y === fit.a ? 0 : NaN
    return fit.c * Math.pow(t, 1 / fit.b)
  }
  if (fit.model !== 'quadratic') {
    if (fit.slope === 0) return NaN
    return (y - fit.intercept) / fit.slope
  }
  const { a, b, c } = fit
  if (Math.abs(c) < 1e-15) return (y - a) / b
  const disc = b * b - 4 * c * (a - y)
  if (disc < 0) return NaN
  const r1 = (-b + Math.sqrt(disc)) / (2 * c)
  const r2 = (-b - Math.sqrt(disc)) / (2 * c)
  if (!xRange) return Math.abs(r1) < Math.abs(r2) ? r1 : r2
  const [lo, hi] = xRange
  const span = hi - lo
  const score = (r: number) => (r < lo ? lo - r : r > hi ? r - hi : 0) / (span || 1)
  return score(r1) <= score(r2) ? r1 : r2
}

/** Standard error of an x read from a linear calibration from m replicate y readings. */
export function inverseSE(fit: LinearFit, xs: readonly number[], yMean: number, m: number): number {
  const n = fit.n
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0)
  const ys = xs.map((x) => fit.intercept + fit.slope * x)
  const my = ys.reduce((a, b) => a + b, 0) / n
  return (fit.sy / Math.abs(fit.slope)) * Math.sqrt(1 / m + 1 / n + (yMean - my) ** 2 / (fit.slope ** 2 * sxx))
}

export interface MichaelisMentenFit {
  model: 'michaelis-menten'
  vmax: number
  km: number
  seVmax: number
  seKm: number
  r2: number
  n: number
  residuals: number[]
}

/** Michaelis–Menten by grid search on Km, then Gauss–Newton refinement (robust from any start). */
export function fitMichaelisMenten(s: readonly number[], v: readonly number[]): MichaelisMentenFit {
  const pts = s.map((x, i) => [x, v[i]] as const).filter(([x, y]) => x > 0 && Number.isFinite(y))
  const n = pts.length
  if (n < 3) throw new Error('Michaelis–Menten needs at least three substrate concentrations')
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const rust = scientificNumerics()
  if (rust) return rust.fitMichaelisMenten(xs, ys)
  // For fixed Km the best Vmax is linear least squares: Vmax = Σ y·f / Σ f², f = S/(Km + S).
  const sseFor = (km: number) => {
    let fy = 0
    let ff = 0
    for (let i = 0; i < n; i++) {
      const f = xs[i] / (km + xs[i])
      fy += f * ys[i]
      ff += f * f
    }
    const vmax = ff > 0 ? fy / ff : 0
    let sse = 0
    for (let i = 0; i < n; i++) sse += (ys[i] - (vmax * xs[i]) / (km + xs[i])) ** 2
    return { vmax, sse }
  }
  const lo = Math.min(...xs) / 20
  const hi = Math.max(...xs) * 20
  let bestKm = lo
  let best = sseFor(lo)
  for (let i = 0; i <= 400; i++) {
    const km = lo * Math.pow(hi / lo, i / 400)
    const r = sseFor(km)
    if (r.sse < best.sse) {
      best = r
      bestKm = km
    }
  }
  let vmax = best.vmax
  let km = bestKm
  for (let iter = 0; iter < 50; iter++) {
    let jvv = 0, jkk = 0, jvk = 0, gv = 0, gk = 0
    for (let i = 0; i < n; i++) {
      const d = km + xs[i]
      const r = ys[i] - (vmax * xs[i]) / d
      const dv = xs[i] / d
      const dk = (-vmax * xs[i]) / (d * d)
      jvv += dv * dv
      jkk += dk * dk
      jvk += dv * dk
      gv += r * dv
      gk += r * dk
    }
    const det = jvv * jkk - jvk * jvk
    if (Math.abs(det) < 1e-300) break
    const stepV = (gv * jkk - gk * jvk) / det
    const stepK = (gk * jvv - gv * jvk) / det
    const nv = vmax + stepV
    const nk = km + stepK
    if (!(nk > 0) || !(nv > 0)) break
    vmax = nv
    km = nk
    if (Math.abs(stepV) < 1e-12 * Math.abs(vmax) && Math.abs(stepK) < 1e-12 * Math.abs(km)) break
  }
  const residuals = ys.map((y, i) => y - (vmax * xs[i]) / (km + xs[i]))
  const sse = residuals.reduce((a, r) => a + r * r, 0)
  const my = ys.reduce((a, b) => a + b, 0) / n
  const sst = ys.reduce((a, y) => a + (y - my) ** 2, 0)
  // Standard errors from the Jacobian at the optimum.
  let jvv = 0, jkk = 0, jvk = 0
  for (let i = 0; i < n; i++) {
    const d = km + xs[i]
    const dv = xs[i] / d
    const dk = (-vmax * xs[i]) / (d * d)
    jvv += dv * dv
    jkk += dk * dk
    jvk += dv * dk
  }
  const det = jvv * jkk - jvk * jvk
  const s2 = n > 2 ? sse / (n - 2) : 0
  return {
    model: 'michaelis-menten',
    vmax,
    km,
    seVmax: det > 0 ? Math.sqrt((s2 * jkk) / det) : NaN,
    seKm: det > 0 ? Math.sqrt((s2 * jvv) / det) : NaN,
    r2: sst > 0 ? 1 - sse / sst : 1,
    n,
    residuals,
  }
}

export type InhibitionMechanism = 'competitive' | 'uncompetitive' | 'noncompetitive' | 'mixed'

export interface InhibitionModelFit {
  mechanism: InhibitionMechanism
  vmax: number
  km: number
  /** Dissociation constant from the free enzyme (competitive, non-competitive and mixed). */
  ki?: number
  /** Dissociation constant from the enzyme–substrate complex (uncompetitive, non-competitive and mixed). */
  kiPrime?: number
  sse: number
  /** Small-sample Akaike information criterion: lower is better, with a penalty per parameter. */
  aicc: number
  r2: number
}

export interface InhibitionFit {
  best: InhibitionModelFit
  /** Every mechanism, best first. */
  models: InhibitionModelFit[]
  /** How much worse (in AICc) the runner-up is: above about 4, the choice is clear. */
  margin: number
  n: number
}

const rateFor = (m: InhibitionMechanism, q: number[], s: number, i: number) => {
  const [vmax, km, kA, kB] = q.map(Math.exp)
  switch (m) {
    case 'competitive':
      return (vmax * s) / (km * (1 + i / kA) + s)
    case 'uncompetitive':
      return (vmax * s) / (km + s * (1 + i / kA))
    case 'noncompetitive':
      return (vmax * s) / ((km + s) * (1 + i / kA))
    case 'mixed':
      return (vmax * s) / (km * (1 + i / kA) + s * (1 + i / kB))
  }
}

/**
 * Global fit of rates at several substrate and inhibitor concentrations to each inhibition
 * mechanism (Levenberg–Marquardt over log parameters, numerical Jacobian), ranked by AICc. All
 * the data constrain every parameter at once, which separate Michaelis–Menten fits cannot.
 */
export function fitInhibition(s: readonly number[], inh: readonly number[], v: readonly number[]): InhibitionFit {
  const pts = s.map((x, k) => [x, inh[k], v[k]] as const).filter(([x, i, y]) => x > 0 && i >= 0 && Number.isFinite(y))
  const n = pts.length
  if (n < 6) throw new Error('A global inhibition fit needs at least six rates')
  const withI = pts.filter((p) => p[1] > 0)
  if (withI.length < 2) throw new Error('Some rates must be measured with the inhibitor present')
  const free = pts.filter((p) => p[1] === 0)
  const mm = fitMichaelisMenten(free.map((p) => p[0]), free.map((p) => p[2]))
  const iMid = withI.map((p) => p[1]).sort((x, y) => x - y)[Math.floor(withI.length / 2)]
  const my = pts.reduce((acc, p) => acc + p[2], 0) / n
  const sst = pts.reduce((acc, p) => acc + (p[2] - my) ** 2, 0)
  const fitOne = (m: InhibitionMechanism): InhibitionModelFit => {
    const k = m === 'mixed' ? 4 : 3
    let q = [Math.log(mm.vmax), Math.log(mm.km), Math.log(iMid), Math.log(iMid)].slice(0, k)
    const sseOf = (r: number[]) => pts.reduce((acc, [x, i, y]) => acc + (y - rateFor(m, r, x, i)) ** 2, 0)
    let sse = sseOf(q)
    let lambda = 1e-3
    for (let iter = 0; iter < 300; iter++) {
      const J = pts.map(([x, i]) =>
        q.map((_, j) => {
          const h = 1e-6
          const up = [...q]
          up[j] += h
          return (rateFor(m, up, x, i) - rateFor(m, q, x, i)) / h
        }),
      )
      const res = pts.map(([x, i, y]) => y - rateFor(m, q, x, i))
      const JtJ = q.map((_, a) => q.map((__, c) => J.reduce((acc, row) => acc + row[a] * row[c], 0)))
      const Jtr = q.map((_, a) => J.reduce((acc, row, r) => acc + row[a] * res[r], 0))
      let improved = false
      for (let tries = 0; tries < 20 && !improved; tries++) {
        const step = solveN(JtJ.map((row, a) => row.map((val, c) => (a === c ? val * (1 + lambda) + 1e-12 : val))), Jtr)
        if (!step) {
          lambda *= 10
          continue
        }
        const next = q.map((val, j) => val + Math.max(-3, Math.min(3, step[j])))
        const nextSse = sseOf(next)
        if (Number.isFinite(nextSse) && nextSse < sse) {
          const gain = sse - nextSse
          q = next
          sse = nextSse
          lambda = Math.max(1e-12, lambda / 10)
          improved = true
          if (gain < 1e-14 * (1 + sse)) iter = 300
        } else lambda *= 10
      }
      if (!improved) break
    }
    const e = q.map(Math.exp)
    const aicc = n * Math.log(Math.max(sse, 1e-300) / n) + 2 * k + (n - k - 1 > 0 ? (2 * k * (k + 1)) / (n - k - 1) : Infinity)
    const out: InhibitionModelFit = { mechanism: m, vmax: e[0], km: e[1], sse, aicc, r2: sst > 0 ? 1 - sse / sst : 1 }
    if (m === 'competitive') out.ki = e[2]
    if (m === 'uncompetitive') out.kiPrime = e[2]
    if (m === 'noncompetitive') {
      out.ki = e[2]
      out.kiPrime = e[2]
    }
    if (m === 'mixed') {
      out.ki = e[2]
      out.kiPrime = e[3]
    }
    return out
  }
  const models = (['competitive', 'uncompetitive', 'noncompetitive', 'mixed'] as const).map(fitOne).sort((x, y) => x.aicc - y.aicc)
  return { best: models[0], models, margin: models[1].aicc - models[0].aicc, n }
}

export interface UncertaintyBudget {
  value: number
  /** Combined standard uncertainty. */
  u: number
  /** Each input's sensitivity coefficient and its share of the combined variance (shares sum to 1). */
  contributions: Array<{ index: number; sensitivity: number; share: number }>
  /** The input contributing most. */
  dominant: number
}

/**
 * Law of propagation of uncertainty (GUM, first order, uncorrelated inputs): each sensitivity
 * ∂f/∂xᵢ by a central difference of ± its standard uncertainty, u_c² = Σ (cᵢ uᵢ)². `f` takes the
 * deviation of each input from its value.
 */
export function propagateUncertainty(f: (deviations: number[]) => number, u: readonly number[]): UncertaintyBudget {
  const zero = u.map(() => 0)
  const value = f(zero)
  const terms = u.map((ui, i) => {
    if (!(ui > 0)) return { index: i, sensitivity: 0, variance: 0 }
    const up = [...zero]
    const down = [...zero]
    up[i] = ui
    down[i] = -ui
    const c = (f(up) - f(down)) / (2 * ui)
    return { index: i, sensitivity: c, variance: (c * ui) ** 2 }
  })
  const total = terms.reduce((acc, t) => acc + t.variance, 0)
  const contributions = terms.map((t) => ({ index: t.index, sensitivity: t.sensitivity, share: total > 0 ? t.variance / total : 0 }))
  const dominant = contributions.reduce((best, c) => (c.share > contributions[best].share ? c.index : best), 0)
  return { value, u: Math.sqrt(total), contributions, dominant }
}

/** Initial rate: OLS slope over the window [t0, t1] (master-plan/04 §10). */
export function initialRate(t: readonly number[], y: readonly number[], t0: number, t1: number): LinearFit {
  const xs: number[] = []
  const ys: number[] = []
  t.forEach((ti, i) => {
    if (ti >= t0 && ti <= t1) {
      xs.push(ti)
      ys.push(y[i])
    }
  })
  return fitLinear(xs, ys)
}

export interface FirstOrderFit {
  model: 'first-order'
  /** y = b − c·e^(−k x): the end value, the amplitude and the rate constant (per x unit). */
  b: number
  c: number
  k: number
  seK: number
  r2: number
  n: number
  residuals: number[]
}

/**
 * A first-order rise (or fall), y = b − c·e^(−kx), as in a pseudo-first-order kinetic trace. For a
 * fixed k, b and c are ordinary least squares on e^(−kx), so k is found by a grid on log k across
 * the data's time scale and refined by golden-section search; its standard error comes from the
 * curvature of the residual sum of squares.
 */
export function fitFirstOrder(x: readonly number[], y: readonly number[]): FirstOrderFit {
  const pts = x.map((xi, i) => [xi, y[i]] as const).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
  const n = pts.length
  if (n < 4) throw new Error('A first-order fit needs at least four points')
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const span = Math.max(...xs) - Math.min(...xs)
  if (!(span > 0)) throw new Error('The x values must spread out')
  const solve = (k: number) => {
    const u = xs.map((xi) => Math.exp(-k * xi))
    const mu = u.reduce((a, b) => a + b, 0) / n
    const my = ys.reduce((a, b) => a + b, 0) / n
    let suy = 0
    let suu = 0
    for (let i = 0; i < n; i++) {
      suy += (u[i] - mu) * (ys[i] - my)
      suu += (u[i] - mu) ** 2
    }
    const slope = suu > 0 ? suy / suu : 0
    const b = my - slope * mu
    let sse = 0
    for (let i = 0; i < n; i++) sse += (ys[i] - (b + slope * u[i])) ** 2
    return { b, c: -slope, sse }
  }
  let lo = Math.log(0.01 / span)
  let hi = Math.log(200 / span)
  let best = lo
  let bestSse = Infinity
  for (let i = 0; i <= 300; i++) {
    const lk = lo + ((hi - lo) * i) / 300
    const s = solve(Math.exp(lk)).sse
    if (s < bestSse) {
      bestSse = s
      best = lk
    }
  }
  const step = (hi - lo) / 300
  lo = best - step
  hi = best + step
  const g = (Math.sqrt(5) - 1) / 2
  for (let i = 0; i < 80; i++) {
    const a = hi - g * (hi - lo)
    const b = lo + g * (hi - lo)
    if (solve(Math.exp(a)).sse < solve(Math.exp(b)).sse) hi = b
    else lo = a
  }
  const k = Math.exp((lo + hi) / 2)
  const f = solve(k)
  const residuals = ys.map((yi, i) => yi - (f.b - f.c * Math.exp(-k * xs[i])))
  const my = ys.reduce((a, b) => a + b, 0) / n
  const sst = ys.reduce((a, yi) => a + (yi - my) ** 2, 0)
  // The standard error of k from the curvature of SSE(k): var(k) ≈ 2 s² / SSE''(k).
  const h = k * 1e-3
  const curv = (solve(k + h).sse - 2 * f.sse + solve(k - h).sse) / (h * h)
  const s2 = n > 3 ? f.sse / (n - 3) : 0
  return { model: 'first-order', b: f.b, c: f.c, k, seK: curv > 0 ? Math.sqrt((2 * s2) / curv) : NaN, r2: sst > 0 ? 1 - f.sse / sst : 1, n, residuals }
}

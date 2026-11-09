// Complexation (contract equilibrium.complexation, T3): metal ions and ligands forming 1:1
// complexes, from substance facets alone. A salt declares the cation it releases (`cation`); a
// ligand declares its formation constants with ions (`complexes`), and, through its acid–base
// facet, how much of it is in the fully deprotonated form that binds. At a given pH each complex
// has a conditional constant K' = K · α(L), so EDTA binds far less in acid. The free and bound
// concentrations are the minimum of a convex function (the mass balances are its gradient), so a
// damped Newton step converges for any mixture. Complexing releases the ligand's protons, which
// the pH solver counts (models/acidbase.ts), so an unbuffered EDTA titration turns acid.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Layer } from '../kernel/state.ts'
import { scientificNumerics } from './numerics.ts'

const LN10 = Math.LN10

export interface ComplexSystem {
  ligands: Array<{ substance: string; total: number; pKa: number[] }>
  ions: Array<{ ion: string; total: number }>
  /** Complexes: ligand index, ion index, log10 of the formation constant. */
  pairs: Array<{ ligand: number; ion: number; logK: number }>
}

/** The complexing ligands and metal ions in a layer, if any ligand meets an ion it binds. */
export function complexSystemIn(cat: Catalogue, layer: Layer): ComplexSystem | undefined {
  if (layer.volumeL <= 0) return undefined
  const ions = new Map<string, number>()
  const ligands: ComplexSystem['ligands'] = []
  for (const [s, n] of Object.entries(layer.species)) {
    if (!(n > 0)) continue
    const def = cat.substances.get(s)
    if (def?.cation) ions.set(def.cation.ion, (ions.get(def.cation.ion) ?? 0) + (n * (def.cation.count ?? 1)) / layer.volumeL)
    if (def?.complexes?.length) ligands.push({ substance: s, total: n / layer.volumeL, pKa: [...(def.acidBase?.pKa ?? [])].sort((a, b) => a - b) })
  }
  if (ligands.length === 0 || ions.size === 0) return undefined
  const ionList = [...ions].map(([ion, total]) => ({ ion, total }))
  const pairs: ComplexSystem['pairs'] = []
  ligands.forEach((l, i) => {
    for (const c of cat.substances.get(l.substance)!.complexes!) {
      const j = ionList.findIndex((x) => x.ion === c.ion)
      if (j >= 0) pairs.push({ ligand: i, ion: j, logK: c.logK })
    }
  })
  return pairs.length ? { ligands, ions: ionList, pairs } : undefined
}

/** Share of a ligand in its fully deprotonated (binding) form at a pH. */
function bindingShare(pKa: readonly number[], pH: number): number {
  if (pKa.length === 0) return 1
  // log of each form relative to the fully protonated one; the binding form is the last.
  const logs = [0]
  for (let i = 0; i < pKa.length; i++) logs.push(logs[i] + (pH - pKa[i]) * LN10)
  const max = Math.max(...logs)
  const sum = logs.reduce((a, l) => a + Math.exp(l - max), 0)
  return Math.exp(logs[logs.length - 1] - max) / sum
}

export interface Speciation {
  /** For each ligand (by substance): the share of it bound to each ion. */
  bound: Record<string, Record<string, number>>
  /** Free concentration of each ion (mol/L). */
  freeIon: Record<string, number>
}

/** Solve n×n linear equations (small, dense) by Gaussian elimination with partial pivoting. */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r
    ;[m[c], m[p]] = [m[p], m[c]]
    const piv = m[c][c] || 1e-300
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / piv
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n]
    for (let k = r + 1; k < n; k++) s -= m[r][k] * x[k]
    x[r] = s / (m[r][r] || 1e-300)
  }
  return x
}

/**
 * Free and bound amounts at a pH. `warm` carries the last solution between calls (the pH solver
 * asks at many nearby pH values), so each solve starts close and takes a few steps.
 */
export function speciate(cs: ComplexSystem, pH: number, warm?: { z?: number[] }): Speciation {
  const rust = scientificNumerics()
  if (rust) return rust.speciate(cs, pH, warm)
  const nL = cs.ligands.length
  const totals = [...cs.ligands.map((l) => l.total), ...cs.ions.map((i) => i.total)]
  const n = totals.length
  // Conditional constants (as natural logs) at this pH.
  const lnK = cs.pairs.map((p) => p.logK * LN10 + Math.log(Math.max(1e-300, bindingShare(cs.ligands[p.ligand].pKa, pH))))
  const comp = (p: { ligand: number; ion: number }) => [p.ligand, nL + p.ion] as const
  // Unknowns: ln of each free concentration (a ligand's free total over its protonation forms).
  let z = warm?.z?.length === totals.length ? [...warm.z] : totals.map((t) => Math.log(t))
  const F = (v: number[]) => {
    let f = 0
    for (let i = 0; i < n; i++) f += Math.exp(v[i]) - totals[i] * v[i]
    cs.pairs.forEach((p, k) => {
      const [a, b] = comp(p)
      f += Math.exp(lnK[k] + v[a] + v[b])
    })
    return f
  }
  for (let iter = 0; iter < 200; iter++) {
    const c = cs.pairs.map((p, k) => {
      const [a, b] = comp(p)
      return Math.exp(lnK[k] + z[a] + z[b])
    })
    const g = z.map((v, i) => Math.exp(v) - totals[i])
    const H = z.map((v, i) => z.map((_, j) => (i === j ? Math.exp(v) : 0)))
    cs.pairs.forEach((p, k) => {
      const [a, b] = comp(p)
      g[a] += c[k]
      g[b] += c[k]
      H[a][a] += c[k]
      H[b][b] += c[k]
      H[a][b] += c[k]
      H[b][a] += c[k]
    })
    if (g.every((x, i) => Math.abs(x) <= 1e-10 * totals[i] + 1e-30)) break
    const step = solveLinear(H, g.map((x) => -x))
    // Converged when the step no longer moves any concentration by a part in 10¹⁰.
    const big = Math.max(...step.map(Math.abs))
    if (big < 1e-10) break
    // Backtrack until the convex objective falls (steps capped at 5 natural-log units), allowing
    // for rounding: near the minimum its change is below what a double resolves.
    let t = big > 5 ? 5 / big : 1
    const f0 = F(z)
    const slack = 1e-13 * (Math.abs(f0) + totals.reduce((x, y) => x + y, 0))
    let next = z.map((v, i) => v + t * step[i])
    while (F(next) > f0 + slack && t > 1e-8) {
      t /= 2
      next = z.map((v, i) => v + t * step[i])
    }
    z = next
  }
  if (warm) warm.z = z
  const bound: Speciation['bound'] = {}
  cs.ligands.forEach((l) => (bound[l.substance] = {}))
  cs.pairs.forEach((p, k) => {
    const [a, b] = comp(p)
    const lig = cs.ligands[p.ligand]
    const share = Math.exp(lnK[k] + z[a] + z[b]) / lig.total
    bound[lig.substance][cs.ions[p.ion].ion] = (bound[lig.substance][cs.ions[p.ion].ion] ?? 0) + share
  })
  const freeIon: Speciation['freeIon'] = {}
  cs.ions.forEach((ion, j) => (freeIon[ion.ion] = Math.exp(z[nL + j])))
  return { bound, freeIon }
}

/** The total share of a ligand bound to any ion. */
export function boundShare(sp: Speciation | undefined, ligand: string): number {
  const b = sp?.bound[ligand]
  if (!b) return 0
  let s = 0
  for (const v of Object.values(b)) s += v
  return Math.min(1, s)
}

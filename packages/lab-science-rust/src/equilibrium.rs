//! General aqueous equilibrium (the tableau method of chemical speciation codes). Each species is
//! formed from components (free H⁺, free metal ions, fully deprotonated ligands …) with a formation
//! constant: ln c_k = ln β_k + Σ_j a_kj z_j, where z_j is the log free concentration of component j.
//! Solids are limited by their solubility products: b_s · z ≤ ln K_s.
//!
//! This is the convex dual of the mass-action problem: minimise
//!     F(z) = Σ_k exp(ln β_k + a_k · z) − T · z   subject to   b_s · z ≤ ln K_s,
//! whose stationarity conditions are the mass balances (∂F/∂z_j = Σ_k a_kj c_k − T_j, plus the
//! solids) and whose constraint multipliers are the amounts of each solid. Solved by Newton's method
//! on the KKT system with an active set of saturated solids: a solid joins when the solution is
//! supersaturated in it and leaves when its amount would be negative. Concentrations in mol/L;
//! component totals may be negative (H⁺ with excess base).
//!
//! Activities (`solve_activity`): z is then the log *activity* of each component, mass action and
//! solubility products hold for activities, and a species' concentration is its activity over its
//! activity coefficient γ: ln c_k = ln β_k − ln γ_k + a_k · z. For fixed γ that is the same convex
//! problem with shifted ln β; γ follows the ionic strength by the Davies equation (as PHREEQC's
//! default for species without ion-size parameters), iterated to a fixed point:
//!     log γ = −A q² (√I / (1 + √I) − 0.3 I),   log γ = 0.1 I for uncharged species,
//! with q a species' charge (Σ_j a_kj q_j over the components) and I = ½ Σ c_k q_k².

use crate::complexation::solve_linear;

#[derive(Clone)]
pub struct Species {
    pub ln_beta: f64,
    pub terms: Vec<(usize, f64)>,
}

#[derive(Clone)]
pub struct Solid {
    pub ln_k: f64,
    pub terms: Vec<(usize, f64)>,
}

pub struct Problem {
    pub totals: Vec<f64>,
    pub species: Vec<Species>,
    pub solids: Vec<Solid>,
}

/// Activity model: each component's charge and the Davies A (log₁₀ units; about 0.51 at 25 °C).
/// A of zero is an ideal solution.
pub struct Activity {
    pub charges: Vec<f64>,
    pub a: f64,
}

pub struct Solution {
    pub z: Vec<f64>,
    pub conc: Vec<f64>,
    pub solid: Vec<f64>,
    pub converged: bool,
}

fn dot(terms: &[(usize, f64)], z: &[f64]) -> f64 {
    terms.iter().map(|(j, a)| a * z[*j]).sum()
}

fn concentrations(p: &Problem, z: &[f64]) -> Vec<f64> {
    p.species.iter().map(|s| (s.ln_beta + dot(&s.terms, z)).min(700.0).exp()).collect()
}

/// Mass-balance residuals with the active solids' amounts, and each component's scale.
fn residuals(p: &Problem, conc: &[f64], active: &[usize], m: &[f64]) -> (Vec<f64>, Vec<f64>) {
    let n = p.totals.len();
    let mut g: Vec<f64> = p.totals.iter().map(|t| -t).collect();
    let mut scale: Vec<f64> = p.totals.iter().map(|t| t.abs()).collect();
    for (s, c) in p.species.iter().zip(conc) {
        for (j, a) in &s.terms {
            g[*j] += a * c;
            scale[*j] += (a * c).abs();
        }
    }
    for (k, &s) in active.iter().enumerate() {
        for (j, b) in &p.solids[s].terms {
            g[*j] += b * m[k];
            scale[*j] += (b * m[k]).abs();
        }
    }
    for j in 0..n {
        scale[j] += 1e-30;
    }
    (g, scale)
}

/// The convex objective F(z) = Σ_k c_k(z) − T · z.
fn objective(p: &Problem, z: &[f64]) -> f64 {
    let mut f: f64 = p.species.iter().map(|s| (s.ln_beta + dot(&s.terms, z)).min(700.0).exp()).sum();
    for (t, v) in p.totals.iter().zip(z) {
        f -= t * v;
    }
    f
}

/// Move z the shortest way onto the active solids' saturation planes (B z = ln K).
fn project(p: &Problem, z: &mut [f64], active: &[usize]) {
    let na = active.len();
    if na == 0 {
        return;
    }
    let n = z.len();
    let rows: Vec<Vec<f64>> = active
        .iter()
        .map(|&s| {
            let mut row = vec![0.0; n];
            for (j, b) in &p.solids[s].terms {
                row[*j] += b;
            }
            row
        })
        .collect();
    let gram: Vec<Vec<f64>> = (0..na).map(|a| (0..na).map(|b| rows[a].iter().zip(&rows[b]).map(|(x, y)| x * y).sum()).collect()).collect();
    let r: Vec<f64> = active.iter().map(|&s| dot(&p.solids[s].terms, z) - p.solids[s].ln_k).collect();
    let y = solve_linear(gram, r);
    for (k, row) in rows.iter().enumerate() {
        for j in 0..n {
            z[j] -= row[j] * y[k];
        }
    }
}

/// Newton's method for the problem with a fixed active set: a feasible start on the saturation
/// planes, steps within them (the KKT system), and a line search on the convex objective, which
/// makes it converge from any start. Returns z, the active solids' amounts, and convergence.
fn newton(p: &Problem, z0: &[f64], active: &[usize]) -> (Vec<f64>, Vec<f64>, bool) {
    let n = p.totals.len();
    let na = active.len();
    let mut z = z0.to_vec();
    project(p, &mut z, active);
    let mut m = vec![0.0; na];
    for _ in 0..500 {
        let conc = concentrations(p, &z);
        let (g_free, scale) = residuals(p, &conc, &[], &[]);
        // KKT system: [H Bᵀ; B 0] [dz; m] = [−g; 0] (z is already on the planes).
        let size = n + na;
        let mut matrix = vec![vec![0.0; size]; size];
        for (s, c) in p.species.iter().zip(&conc) {
            for (i, ai) in &s.terms {
                for (j, aj) in &s.terms {
                    matrix[*i][*j] += ai * aj * c;
                }
            }
        }
        // Keep the Hessian positive definite where a component has little weight.
        for j in 0..n {
            matrix[j][j] += 1e-30 + 1e-14 * scale[j];
        }
        for (k, &s) in active.iter().enumerate() {
            for (j, b) in &p.solids[s].terms {
                matrix[*j][n + k] = *b;
                matrix[n + k][*j] = *b;
            }
        }
        let mut rhs = vec![0.0; size];
        for j in 0..n {
            rhs[j] = -g_free[j];
        }
        let x = solve_linear(matrix, rhs);
        if x.iter().any(|v| !v.is_finite()) {
            return (z, m, false);
        }
        let dz = &x[..n];
        m = x[n..].to_vec();
        // Converged when the mass balances (with the solids) close.
        let mut closed = true;
        for j in 0..n {
            let mut r = g_free[j];
            for (k, &s) in active.iter().enumerate() {
                for (jj, b) in &p.solids[s].terms {
                    if *jj == j {
                        r += b * m[k];
                    }
                }
            }
            if r.abs() > 1e-10 * scale[j] {
                closed = false;
                break;
            }
        }
        if closed {
            return (z, m, true);
        }
        let big = dz.iter().map(|d| d.abs()).fold(0.0_f64, f64::max);
        if big < 1e-14 {
            return (z, m, true);
        }
        // Close to the solution Newton converges quadratically, and the objective's change is lost in
        // rounding: take the full step.
        if big < 1e-6 {
            for (a, d) in z.iter_mut().zip(dz) {
                *a += d;
            }
            continue;
        }
        let slope: f64 = g_free.iter().zip(dz).map(|(g, d)| g * d).sum();
        let f0 = objective(p, &z);
        let mut t = if big > 4.0 { 4.0 / big } else { 1.0 };
        loop {
            let zt: Vec<f64> = z.iter().zip(dz).map(|(a, d)| a + t * d).collect();
            if objective(p, &zt) <= f0 + 1e-4 * t * slope || t < 1e-12 {
                z = zt;
                break;
            }
            t *= 0.5;
        }
    }
    (z, m, false)
}

/// Solve a problem. `warm` (log free concentrations of the components) speeds repeated solves.
pub fn solve(p: &Problem, warm: Option<&[f64]>) -> Solution {
    solve_from(p, warm, Vec::new()).0
}

/// Solve from a starting active set of saturated solids (the last solve's, when repeating with
/// small changes); returns the solution and the final active set.
fn solve_from(p: &Problem, warm: Option<&[f64]>, start: Vec<usize>) -> (Solution, Vec<usize>) {
    let n = p.totals.len();
    let mut z: Vec<f64> = match warm {
        Some(w) if w.len() == n && w.iter().all(|v| v.is_finite()) => w.to_vec(),
        // A dilute start: nothing absurdly saturated (polynuclear hydroxo complexes at pH 7 would be).
        _ => p.totals.iter().enumerate().map(|(j, t)| if j > 0 && *t > 0.0 { t.ln() - 10.0 } else { (1e-7_f64).ln() }).collect(),
    };
    let mut active: Vec<usize> = start.into_iter().filter(|&s| s < p.solids.len()).collect();
    let mut amounts: Vec<f64> = Vec::new();
    let mut converged = false;
    for _ in 0..(4 * p.solids.len() + 8) {
        let (zn, m, ok) = newton(p, &z, &active);
        z = zn;
        amounts = m;
        if !ok {
            converged = false;
            break;
        }
        // A solid whose amount would be negative is not present: drop the most negative.
        if let Some((k, _)) = amounts.iter().enumerate().filter(|(_, a)| **a < -1e-14).min_by(|a, b| a.1.partial_cmp(b.1).unwrap()) {
            active.remove(k);
            amounts.remove(k);
            continue;
        }
        // A supersaturated solid that is absent joins: the most supersaturated per unit of stoichiometry.
        let mut best: Option<(usize, f64)> = None;
        for (s, solid) in p.solids.iter().enumerate() {
            if active.contains(&s) {
                continue;
            }
            let weight: f64 = solid.terms.iter().map(|(_, b)| b.abs()).sum::<f64>().max(1.0);
            let si = (dot(&solid.terms, &z) - solid.ln_k) / weight;
            if si > 1e-9 && best.map_or(true, |(_, b)| si > b) {
                best = Some((s, si));
            }
        }
        match best {
            Some((s, _)) => active.push(s),
            None => {
                converged = true;
                break;
            }
        }
    }
    let mut solid = vec![0.0; p.solids.len()];
    for (k, &s) in active.iter().enumerate() {
        solid[s] = amounts.get(k).copied().unwrap_or(0.0).max(0.0);
    }
    let conc = concentrations(p, &z);
    (Solution { z, conc, solid, converged }, active)
}

/// Ionic strength beyond which the Davies equation is not extrapolated (mol/L).
const DAVIES_MAX_I: f64 = 1.0;

/// Solve with activity coefficients: Davies γ from the ionic strength, iterated with warm starts.
pub fn solve_activity(p: &Problem, act: &Activity, warm: Option<&[f64]>) -> Solution {
    if !(act.a > 0.0) {
        return solve(p, warm);
    }
    let ln10 = core::f64::consts::LN_10;
    let charge: Vec<f64> = p.species.iter().map(|s| s.terms.iter().map(|(j, a)| a * act.charges.get(*j).copied().unwrap_or(0.0)).sum()).collect();
    let mut ln_gamma = vec![0.0; p.species.len()];
    let mut start: Option<Vec<f64>> = warm.map(|w| w.to_vec());
    let mut shifted = Problem { totals: p.totals.clone(), species: p.species.clone(), solids: p.solids.clone() };
    let mut last: Option<Solution> = None;
    // Each iteration starts from the last one's activities and saturated solids.
    let mut active: Vec<usize> = Vec::new();
    for _ in 0..60 {
        for (k, s) in shifted.species.iter_mut().enumerate() {
            s.ln_beta = p.species[k].ln_beta - ln_gamma[k];
        }
        let (warm_sol, now_active) = solve_from(&shifted, start.as_deref(), active.clone());
        let sol = if warm_sol.converged {
            active = now_active;
            warm_sol
        } else {
            // A warm start that fails is retried from the beginning.
            let (cold, cold_active) = solve_from(&shifted, None, Vec::new());
            if !cold.converged {
                return cold;
            }
            active = cold_active;
            cold
        };
        let i = (0.5 * sol.conc.iter().zip(&charge).map(|(c, q)| c * q * q).sum::<f64>()).min(DAVIES_MAX_I);
        let root = i.sqrt();
        let mut change = 0.0_f64;
        for (g, q) in ln_gamma.iter_mut().zip(&charge) {
            let target = if q.abs() < 1e-9 { ln10 * 0.1 * i } else { -ln10 * act.a * q * q * (root / (1.0 + root) - 0.3 * i) };
            change = change.max((target - *g).abs());
            *g = target;
        }
        start = Some(sol.z.clone());
        last = Some(sol);
        if change < 1e-8 {
            break;
        }
    }
    last.expect("at least one solve")
}

#[cfg(test)]
mod tests {
    use super::*;
    const LN10: f64 = core::f64::consts::LN_10;

    fn sp(log_beta: f64, terms: &[(usize, f64)]) -> Species {
        Species { ln_beta: log_beta * LN10, terms: terms.to_vec() }
    }
    fn so(log_k: f64, terms: &[(usize, f64)]) -> Solid {
        Solid { ln_k: log_k * LN10, terms: terms.to_vec() }
    }
    /// Water: H⁺ (component 0) and OH⁻.
    fn water() -> Vec<Species> {
        vec![sp(0.0, &[(0, 1.0)]), sp(-14.0, &[(0, -1.0)])]
    }
    fn ph(s: &Solution) -> f64 {
        -s.z[0] / LN10
    }

    #[test]
    fn pure_water_and_strong_acid() {
        let p = Problem { totals: vec![0.0], species: water(), solids: vec![] };
        let s = solve(&p, None);
        assert!(s.converged);
        assert!((ph(&s) - 7.0).abs() < 1e-9);
        // 0.01 M HCl: chloride is a spectator component (1) carrying one proton each.
        let mut species = water();
        species.push(sp(0.0, &[(1, 1.0)]));
        let p = Problem { totals: vec![0.01, 0.01], species, solids: vec![] };
        let s = solve(&p, None);
        assert!((ph(&s) - 2.0).abs() < 1e-6);
    }

    #[test]
    fn weak_acid_matches_the_quadratic() {
        // 0.1 M acetic acid, pKa 4.76: components H⁺ and acetate.
        let mut species = water();
        species.push(sp(0.0, &[(1, 1.0)]));
        species.push(sp(4.76, &[(1, 1.0), (0, 1.0)]));
        let p = Problem { totals: vec![0.1, 0.1], species, solids: vec![] };
        let s = solve(&p, None);
        let ka = 10f64.powf(-4.76);
        let h = (-ka + (ka * ka + 4.0 * ka * 0.1).sqrt()) / 2.0;
        assert!((ph(&s) + h.log10()).abs() < 1e-4);
    }

    #[test]
    fn silver_chloride_and_the_common_ion() {
        // Components: H⁺, Ag⁺, Cl⁻ (spectator counter-ions omitted: they take part in nothing).
        let ksp = -9.75; // log Ksp of AgCl at 25 °C
        let build = |ag: f64, cl: f64| {
            let mut species = water();
            species.push(sp(0.0, &[(1, 1.0)]));
            species.push(sp(0.0, &[(2, 1.0)]));
            Problem { totals: vec![0.0, ag, cl], species, solids: vec![so(ksp, &[(1, 1.0), (2, 1.0)])] }
        };
        let s = solve(&build(0.01, 0.01), None);
        assert!(s.converged);
        let free = 10f64.powf(ksp / 2.0);
        assert!((s.conc[2] - free).abs() / free < 1e-6);
        assert!((s.solid[0] - (0.01 - free)).abs() < 1e-9);
        // Excess chloride (0.1 M) pushes free silver down to Ksp / [Cl⁻].
        let s = solve(&build(0.01, 0.1), None);
        let cl = s.conc[3];
        assert!((s.conc[2] * cl / 10f64.powf(ksp) - 1.0).abs() < 1e-6);
        assert!((s.solid[0] + s.conc[2] - 0.01).abs() < 1e-12);
        // Too little to reach Ksp: no solid.
        let s = solve(&build(1e-6, 1e-6), None);
        assert_eq!(s.solid[0], 0.0);
    }

    #[test]
    fn copper_hydroxide_precipitates_and_releases_acid() {
        // 0.01 M Cu²⁺ with 0.015 M NaOH (H⁺ total −0.015): Cu(OH)₂ takes up all the hydroxide.
        // A solid is limited by Π (free component)^b ≤ K, with b its composition in components.
        // Components: H⁺, Cu²⁺. Cu(OH)₂(s) = Cu²⁺ − 2H⁺ (+2H₂O): log K = log Ksp − 2 log Kw = −19.7 + 28.
        let mut species = water();
        species.push(sp(0.0, &[(1, 1.0)]));
        species.push(sp(-7.5, &[(1, 1.0), (0, -1.0)])); // CuOH⁺
        let p = Problem { totals: vec![-0.015, 0.01], species, solids: vec![so(-19.7 + 28.0, &[(1, 1.0), (0, -2.0)])] };
        let s = solve(&p, None);
        assert!(s.converged);
        assert!((s.solid[0] - 0.0075).abs() < 1e-4, "solid {}", s.solid[0]);
        assert!(ph(&s) < 7.0 && ph(&s) > 4.0, "pH {}", ph(&s));
    }

    #[test]
    fn amphoteric_zinc_hydroxide_dissolves_in_excess_alkali() {
        // Components H⁺, Zn²⁺; hydroxo complexes Zn(OH)ₙ with log βₙ (Zn + n OH) = 5.0, 11.1, 13.6, 14.8.
        let zn = |naoh: f64| {
            let mut species = water();
            species.push(sp(0.0, &[(1, 1.0)]));
            for (n, lb) in [(1.0, 5.0), (2.0, 11.1), (3.0, 13.6), (4.0, 14.8)] {
                species.push(sp(lb - 14.0 * n, &[(1, 1.0), (0, -n)]));
            }
            // Zn(OH)₂(s) + 2H⁺ ⇌ Zn²⁺ + 2H₂O: log K = log Ksp − 2 log Kw = −16.5 + 28.
            let p = Problem { totals: vec![-naoh, 0.01], species, solids: vec![so(-16.5 + 28.0, &[(1, 1.0), (0, -2.0)])] };
            solve(&p, None)
        };
        let some = zn(0.02);
        assert!(some.converged && some.solid[0] > 0.009, "two hydroxides each: mostly solid ({})", some.solid[0]);
        let excess = zn(2.0);
        assert!(excess.converged && excess.solid[0] == 0.0, "zincate in 2 M hydroxide: {}", excess.solid[0]);
    }

    #[test]
    fn ammonia_dissolves_silver_chloride_but_not_silver_iodide() {
        // Components H⁺, Ag⁺, Cl⁻, I⁻, NH₃. NH₄⁺ pKa 9.25; Ag(NH₃)₂⁺ log β₂ 7.2.
        let run = |halide_log_ksp: f64| {
            let mut species = water();
            species.push(sp(0.0, &[(1, 1.0)]));
            species.push(sp(0.0, &[(2, 1.0)]));
            species.push(sp(0.0, &[(3, 1.0)]));
            species.push(sp(9.25, &[(3, 1.0), (0, 1.0)]));
            species.push(sp(7.2, &[(1, 1.0), (3, 2.0)]));
            let p = Problem { totals: vec![0.0, 0.01, 0.01, 2.0], species, solids: vec![so(halide_log_ksp, &[(1, 1.0), (2, 1.0)])] };
            solve(&p, None)
        };
        let agcl = run(-9.75);
        assert!(agcl.converged && agcl.solid[0] == 0.0, "AgCl dissolves: {}", agcl.solid[0]);
        let agi = run(-16.08);
        assert!(agi.converged && agi.solid[0] > 0.0099, "AgI stays: {}", agi.solid[0]);
    }

    #[test]
    fn davies_activity_coefficients_follow_the_ionic_strength() {
        // 0.1 M NaCl: components H⁺, Na⁺, Cl⁻. Free sodium stays 0.1 M; its activity is γ × 0.1.
        let mut species = water();
        species.push(sp(0.0, &[(1, 1.0)]));
        species.push(sp(0.0, &[(2, 1.0)]));
        let p = Problem { totals: vec![0.0, 0.1, 0.1], species, solids: vec![] };
        let act = Activity { charges: vec![1.0, 1.0, -1.0], a: 0.51 };
        let s = solve_activity(&p, &act, None);
        assert!(s.converged);
        assert!((s.conc[2] - 0.1).abs() < 1e-12);
        let i: f64 = 0.1;
        let gamma = 10f64.powf(-0.51 * (i.sqrt() / (1.0 + i.sqrt()) - 0.3 * i));
        assert!((s.z[1] - (0.1 * gamma).ln()).abs() < 1e-7, "ln a(Na+) {}", s.z[1]);
        // Water's ion product holds for activities: pH stays 7, the concentrations rise.
        assert!((ph(&s) - 7.0).abs() < 1e-9);
        assert!(s.conc[0] > 1.2e-7);
    }

    #[test]
    fn activities_raise_the_solubility_of_a_salt() {
        // Portlandite, Ca(OH)₂ = Ca²⁺ − 2H⁺ (+2H₂O), log K 22.8: in water, ideal and with Davies.
        let mut species = water();
        species.push(sp(0.0, &[(1, 1.0)]));
        let p = Problem { totals: vec![-0.1, 0.05], species, solids: vec![so(22.8, &[(1, 1.0), (0, -2.0)])] };
        let ideal = solve(&p, None);
        let real = solve_activity(&p, &Activity { charges: vec![1.0, 2.0], a: 0.51 }, None);
        assert!(ideal.converged && real.converged, "ideal {} {:?} real {} {:?}", ideal.converged, ideal.conc, real.converged, real.conc);
        let (ci, cr) = (ideal.conc[2], real.conc[2]);
        // Ideal: 4s³ = Ksp/Kw² → s ≈ 0.0116 M; activity coefficients bring it near the measured 0.02 M.
        assert!((ci - 0.0116).abs() < 0.0005, "ideal {ci}");
        assert!(cr > 0.017 && cr < 0.024, "with activities {cr}");
        assert!((real.solid[0] + cr - 0.05).abs() < 1e-9);
    }

    #[test]
    fn the_less_soluble_halide_precipitates_first() {
        // 1 mM each of Cl⁻ and I⁻ with 1.5 mM Ag⁺: all the iodide and half the chloride come out.
        let mut species = water();
        for c in 1..4 {
            species.push(sp(0.0, &[(c, 1.0)]));
        }
        let p = Problem {
            totals: vec![0.0, 0.0015, 0.001, 0.001],
            species,
            solids: vec![so(-9.75, &[(1, 1.0), (2, 1.0)]), so(-16.08, &[(1, 1.0), (3, 1.0)])],
        };
        let s = solve(&p, None);
        assert!(s.converged);
        assert!((s.solid[1] - 0.001).abs() < 1e-8, "AgI {}", s.solid[1]);
        assert!((s.solid[0] - 0.0005).abs() < 1e-6, "AgCl {}", s.solid[0]);
    }
}

/// ABI v6 packed problem (all f64): nComponents, totals[n], charges[n], Davies A (0: ideal); nSpecies, then per species
/// lnβ, nTerms, (component, coefficient)×nTerms; nSolids, then per solid lnK, nTerms, terms;
/// nWarm (0 or n), warm[nWarm]. Output from the input's end: converged (1/0), z[n],
/// concentrations[nSpecies], solid amounts[nSolids]. Malformed input returns 0.
pub fn read_problem(values: &[f64]) -> Option<(Problem, Activity, Vec<f64>)> {
    let mut cursor = 0usize;
    let mut next = || -> Option<f64> {
        let v = *values.get(cursor)?;
        cursor += 1;
        v.is_finite().then_some(v)
    };
    let count = |v: f64, max: usize| -> Option<usize> { (v >= 0.0 && v.fract() == 0.0 && v <= max as f64).then_some(v as usize) };
    let n = count(next()?, 512)?;
    if n == 0 {
        return None;
    }
    let mut totals = Vec::with_capacity(n);
    for _ in 0..n {
        totals.push(next()?);
    }
    let mut charges = Vec::with_capacity(n);
    for _ in 0..n {
        charges.push(next()?);
    }
    let a = next()?;
    if !(0.0..=2.0).contains(&a) {
        return None;
    }
    let mut terms_of = |next: &mut dyn FnMut() -> Option<f64>| -> Option<Vec<(usize, f64)>> {
        let k = count(next()?, n)?;
        let mut terms = Vec::with_capacity(k);
        for _ in 0..k {
            let j = count(next()?, n - 1)?;
            terms.push((j, next()?));
        }
        Some(terms)
    };
    let ns = count(next()?, 8192)?;
    let mut species = Vec::with_capacity(ns);
    for _ in 0..ns {
        let ln_beta = next()?;
        let terms = terms_of(&mut next)?;
        species.push(Species { ln_beta, terms });
    }
    let nsol = count(next()?, 1024)?;
    let mut solids = Vec::with_capacity(nsol);
    for _ in 0..nsol {
        let ln_k = next()?;
        let terms = terms_of(&mut next)?;
        solids.push(Solid { ln_k, terms });
    }
    let nw = count(next()?, n)?;
    if nw != 0 && nw != n {
        return None;
    }
    let mut warm = Vec::with_capacity(nw);
    for _ in 0..nw {
        warm.push(next()?);
    }
    if cursor != values.len() {
        return None;
    }
    Some((Problem { totals, species, solids }, Activity { charges, a }, warm))
}

#[no_mangle]
pub extern "C" fn lab_equilibrium(length: u32) -> u32 {
    let length = length as usize;
    if length > crate::CAPACITY {
        return 0;
    }
    let values = unsafe { core::slice::from_raw_parts(crate::lab_scratch_ptr(), length) };
    let Some((problem, activity, warm)) = read_problem(values) else {
        return 0;
    };
    let solution = solve_activity(&problem, &activity, if warm.is_empty() { None } else { Some(&warm) });
    let out: Vec<f64> = core::iter::once(if solution.converged { 1.0 } else { 0.0 })
        .chain(solution.z)
        .chain(solution.conc)
        .chain(solution.solid)
        .collect();
    if out.iter().any(|v| !v.is_finite()) || length + out.len() > crate::CAPACITY {
        return 0;
    }
    unsafe {
        core::slice::from_raw_parts_mut(crate::lab_scratch_ptr().add(length), out.len()).copy_from_slice(&out);
    }
    1
}

#[cfg(test)]
mod abi_tests {
    use super::*;
    #[test]
    fn reads_a_packed_problem_and_rejects_malformed_ones() {
        // Water plus AgCl with 10 mM each of Ag⁺ and Cl⁻.
        let ln10 = core::f64::consts::LN_10;
        let packed = [
            3.0, 0.0, 0.01, 0.01, // components and totals
            1.0, 1.0, -1.0, 0.0, // their charges, ideal
            4.0, 0.0, 1.0, 0.0, 1.0, -14.0 * ln10, 1.0, 0.0, -1.0, 0.0, 1.0, 1.0, 1.0, 0.0, 1.0, 2.0, 1.0, // species
            1.0, -9.75 * ln10, 2.0, 1.0, 1.0, 2.0, 1.0, // one solid
            0.0, // no warm start
        ];
        let (p, _, warm) = read_problem(&packed).expect("well formed");
        assert_eq!((p.totals.len(), p.species.len(), p.solids.len(), warm.len()), (3, 4, 1, 0));
        let s = solve(&p, None);
        assert!(s.converged && (s.solid[0] - 0.01).abs() < 1e-4);
        assert!(read_problem(&packed[..packed.len() - 1]).is_none(), "truncated");
        let mut bad = packed.to_vec();
        bad[10] = 9.0; // a component index beyond the components
        assert!(read_problem(&bad).is_none());
        assert!(read_problem(&[0.0]).is_none(), "no components");
    }
}

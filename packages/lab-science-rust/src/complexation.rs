//! Ideal 1:1 metal/ligand equilibrium. Same convex objective, damped Newton
//! iteration and tolerances as the independent TypeScript reference model.
use crate::AcidSystem;

pub struct Ligand<'a> {
    pub total: f64,
    pub pka: &'a [f64],
}
pub struct Pair {
    pub ligand: usize,
    pub ion: usize,
    pub log_k: f64,
}
pub struct ComplexSystem<'a> {
    pub ligands: Vec<Ligand<'a>>,
    pub ions: Vec<f64>,
    pub pairs: Vec<Pair>,
}
pub struct Speciation {
    pub z: Vec<f64>,
    pub shares: Vec<f64>,
    pub free_ions: Vec<f64>,
}

fn binding_share(pka: &[f64], ph: f64) -> f64 {
    let mut logs = vec![0.0_f64];
    for pk in pka {
        logs.push(logs.last().unwrap() + (ph - pk) * core::f64::consts::LN_10);
    }
    let maximum = logs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let sum: f64 = logs.iter().map(|v| (v - maximum).exp()).sum();
    (logs.last().unwrap() - maximum).exp() / sum
}

pub(crate) fn solve_linear(mut matrix: Vec<Vec<f64>>, rhs: Vec<f64>) -> Vec<f64> {
    let n = rhs.len();
    for (row, value) in matrix.iter_mut().zip(rhs) {
        row.push(value);
    }
    for c in 0..n {
        let mut pivot = c;
        for r in c + 1..n {
            if matrix[r][c].abs() > matrix[pivot][c].abs() {
                pivot = r;
            }
        }
        matrix.swap(c, pivot);
        let divisor = if matrix[c][c] == 0.0 {
            1e-300
        } else {
            matrix[c][c]
        };
        for r in c + 1..n {
            let factor = matrix[r][c] / divisor;
            for k in c..=n {
                matrix[r][k] -= factor * matrix[c][k];
            }
        }
    }
    let mut x = vec![0.0; n];
    for r in (0..n).rev() {
        let mut value = matrix[r][n];
        for k in r + 1..n {
            value -= matrix[r][k] * x[k];
        }
        x[r] = value
            / if matrix[r][r] == 0.0 {
                1e-300
            } else {
                matrix[r][r]
            };
    }
    x
}

pub fn speciate(cs: &ComplexSystem<'_>, ph: f64, warm: &[f64]) -> Speciation {
    let nl = cs.ligands.len();
    let totals: Vec<_> = cs
        .ligands
        .iter()
        .map(|l| l.total)
        .chain(cs.ions.iter().copied())
        .collect();
    let n = totals.len();
    let ln_k: Vec<_> = cs
        .pairs
        .iter()
        .map(|p| {
            p.log_k * core::f64::consts::LN_10
                + binding_share(cs.ligands[p.ligand].pka, ph).max(1e-300).ln()
        })
        .collect();
    let mut z = if warm.len() == n {
        warm.to_vec()
    } else {
        totals.iter().map(|t| t.ln()).collect()
    };
    let objective = |v: &[f64]| {
        let mut f = 0.0;
        for i in 0..n {
            f += v[i].exp() - totals[i] * v[i];
        }
        for (k, p) in cs.pairs.iter().enumerate() {
            f += (ln_k[k] + v[p.ligand] + v[nl + p.ion]).exp();
        }
        f
    };
    for _ in 0..200 {
        let mut gradient: Vec<_> = z.iter().zip(&totals).map(|(v, t)| v.exp() - t).collect();
        let mut hessian = vec![vec![0.0; n]; n];
        for i in 0..n {
            hessian[i][i] = z[i].exp();
        }
        for (k, p) in cs.pairs.iter().enumerate() {
            let (a, b) = (p.ligand, nl + p.ion);
            let c = (ln_k[k] + z[a] + z[b]).exp();
            gradient[a] += c;
            gradient[b] += c;
            hessian[a][a] += c;
            hessian[b][b] += c;
            hessian[a][b] += c;
            hessian[b][a] += c;
        }
        if gradient
            .iter()
            .zip(&totals)
            .all(|(g, t)| g.abs() <= 1e-10 * t + 1e-30)
        {
            break;
        }
        let step = solve_linear(hessian, gradient.iter().map(|g| -g).collect());
        let big = step.iter().map(|s| s.abs()).fold(0.0_f64, f64::max);
        if big < 1e-10 {
            break;
        }
        let mut t = if big > 5.0 { 5.0 / big } else { 1.0 };
        let f0 = objective(&z);
        let slack = 1e-13 * (f0.abs() + totals.iter().sum::<f64>());
        let next_step = |t| {
            z.iter()
                .zip(&step)
                .map(|(v, s)| v + t * s)
                .collect::<Vec<_>>()
        };
        let mut next = next_step(t);
        while objective(&next) > f0 + slack && t > 1e-8 {
            t /= 2.0;
            next = next_step(t);
        }
        z = next;
    }
    let shares = cs
        .pairs
        .iter()
        .enumerate()
        .map(|(k, p)| (ln_k[k] + z[p.ligand] + z[nl + p.ion]).exp() / cs.ligands[p.ligand].total)
        .collect();
    let free_ions = z[nl..].iter().map(|v| v.exp()).collect();
    Speciation {
        z,
        shares,
        free_ions,
    }
}

pub fn solve_ph(
    systems: &[AcidSystem<'_>],
    links: &[Option<usize>],
    cs: &ComplexSystem<'_>,
    temperature_k: f64,
    warm: &mut Vec<f64>,
) -> f64 {
    let ln10 = core::f64::consts::LN_10;
    let kw_log = -(14.0 + (55800.0 / (ln10 * 8.314)) * (1.0 / temperature_k - 1.0 / 298.15));
    let mut charge = |ph: f64| {
        let sp = speciate(cs, ph, warm);
        *warm = sp.z;
        let mut bound = vec![0.0_f64; cs.ligands.len()];
        for (p, share) in cs.pairs.iter().zip(sp.shares) {
            bound[p.ligand] += share;
        }
        let mut q = 10.0_f64.powf(-ph);
        let mut solute = 0.0;
        for (s, link) in systems.iter().zip(links) {
            solute += s.total * s.spectator;
            let mut logs = vec![0.0_f64];
            for pk in s.pka {
                logs.push(logs.last().unwrap() + (ph - pk) * ln10);
            }
            let maximum = logs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let terms: Vec<_> = logs.iter().map(|v| (v - maximum).exp()).collect();
            let sum: f64 = terms.iter().sum();
            let mut mean = 0.0;
            for (i, value) in terms.iter().enumerate() {
                mean += value / sum * (s.charge - i as f64);
            }
            let b = link.map_or(0.0, |index| bound[index].min(1.0));
            solute += s.total * ((1.0 - b) * mean + b * (s.charge - s.pka.len() as f64));
        }
        q += solute;
        q - 10.0_f64.powf(kw_log + ph)
    };
    let (mut lo, mut hi) = (-2.0, 16.0);
    while hi - lo > 0.5 {
        let mid = (lo + hi) / 2.0;
        if charge(mid) > 0.0 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let (mut flo, mut fhi) = (charge(lo), charge(hi));
    let mut side = 0;
    for _ in 0..60 {
        if hi - lo <= 1e-10 {
            break;
        }
        let x = if flo == fhi {
            (lo + hi) / 2.0
        } else {
            hi - fhi * (hi - lo) / (fhi - flo)
        };
        let fx = charge(x);
        if fx == 0.0 {
            return x;
        }
        if fx > 0.0 {
            lo = x;
            flo = fx;
            if side == -1 {
                fhi /= 2.0;
            }
            side = -1;
        } else {
            hi = x;
            fhi = fx;
            if side == 1 {
                flo /= 2.0;
            }
            side = 1;
        }
        if fx.abs() < 1e-15 {
            return x;
        }
    }
    (lo + hi) / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_to_one_analytic_limit_and_inventory() {
        let cs = ComplexSystem {
            ligands: vec![Ligand {
                total: 1e-3,
                pka: &[],
            }],
            ions: vec![1e-3],
            pairs: vec![Pair {
                ligand: 0,
                ion: 0,
                log_k: 6.0,
            }],
        };
        let sp = speciate(&cs, 7.0, &[]);
        // K*f^2 + f - C = 0 for equal initial concentrations.
        let free = 2.0 * 1e-3 / (1.0 + (1.0_f64 + 4.0 * 1e6 * 1e-3).sqrt());
        assert!((sp.free_ions[0] - free).abs() < 1e-12);
        assert!((sp.shares[0] * 1e-3 + sp.free_ions[0] - 1e-3).abs() < 1e-12);
    }
}

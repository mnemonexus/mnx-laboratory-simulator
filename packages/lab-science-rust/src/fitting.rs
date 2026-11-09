//! Nonlinear least squares using the existing analysis library's methods and
//! stopping rules. Standard errors remain NaN when covariance is unidentified.

fn solve4(a: [[f64; 4]; 4], b: [f64; 4]) -> Option<[f64; 4]> {
    let mut m = [[0.0; 5]; 4];
    for r in 0..4 {
        m[r][..4].copy_from_slice(&a[r]);
        m[r][4] = b[r];
    }
    for col in 0..4 {
        let mut pivot = col;
        for r in col + 1..4 {
            if m[r][col].abs() > m[pivot][col].abs() {
                pivot = r;
            }
        }
        if m[pivot][col].abs() < 1e-300 {
            return None;
        }
        m.swap(col, pivot);
        for r in col + 1..4 {
            let factor = m[r][col] / m[col][col];
            for k in col..5 {
                m[r][k] -= factor * m[col][k];
            }
        }
    }
    let mut x = [0.0; 4];
    for r in (0..4).rev() {
        let mut value = m[r][4];
        for k in r + 1..4 {
            value -= m[r][k] * x[k];
        }
        x[r] = value / m[r][r];
    }
    x.iter().all(|v| v.is_finite()).then_some(x)
}

fn four_pl(p: &[f64; 4], x: f64) -> f64 {
    if x <= 0.0 {
        p[0]
    } else {
        p[1] + (p[0] - p[1]) / (1.0 + (x / p[2].exp()).powf(p[3]))
    }
}
fn jacobian(p: &[f64; 4], xs: &[f64]) -> Vec<[f64; 4]> {
    let [a, d, lc, b] = *p;
    xs.iter()
        .map(|&x| {
            if x <= 0.0 {
                return [1.0, 0.0, 0.0, 0.0];
            }
            let u = (x / lc.exp()).powf(b);
            let den = 1.0 + u;
            [
                1.0 / den,
                1.0 - 1.0 / den,
                (a - d) * u * b / (den * den),
                -(a - d) * u * (x.ln() - lc) / (den * den),
            ]
        })
        .collect()
}
fn normal_matrix(j: &[[f64; 4]]) -> [[f64; 4]; 4] {
    let mut matrix = [[0.0; 4]; 4];
    for i in 0..4 {
        for k in 0..4 {
            for row in j {
                matrix[i][k] += row[i] * row[k];
            }
        }
    }
    matrix
}

/// a,d,c,b,seA,seD,seC,seB,r2,sy, followed by residuals.
pub fn fit_four_pl(xs: &[f64], ys: &[f64]) -> Vec<f64> {
    let n = xs.len();
    let mut order: Vec<_> = (0..n).collect();
    order.sort_by(|&i, &j| xs[i].partial_cmp(&xs[j]).unwrap());
    let (low, high) = (ys[order[0]], ys[order[n - 1]]);
    let half = (low + high) / 2.0;
    let mut start = *order.iter().find(|&&i| xs[i] > 0.0).unwrap();
    for &i in &order {
        if xs[i] > 0.0 && (ys[i] - half).abs() < (ys[start] - half).abs() {
            start = i;
        }
    }
    let mut p = [low, high, xs[start].ln(), 1.0];
    let sse_of = |q: &[f64; 4]| {
        xs.iter()
            .zip(ys)
            .map(|(&x, &y)| (y - four_pl(q, x)).powi(2))
            .sum::<f64>()
    };
    let mut lambda = 1e-3;
    let mut sse = sse_of(&p);
    for _ in 0..500 {
        let j = jacobian(&p, xs);
        let residuals: Vec<_> = xs
            .iter()
            .zip(ys)
            .map(|(&x, &y)| y - four_pl(&p, x))
            .collect();
        let matrix = normal_matrix(&j);
        let mut gradient = [0.0; 4];
        for i in 0..4 {
            for (row, r) in j.iter().zip(&residuals) {
                gradient[i] += row[i] * r;
            }
        }
        let (mut improved, mut converged) = (false, false);
        for _ in 0..20 {
            let mut damped = matrix;
            for i in 0..4 {
                damped[i][i] = damped[i][i] * (1.0 + lambda) + 1e-12;
            }
            let Some(step) = solve4(damped, gradient) else {
                lambda *= 10.0;
                continue;
            };
            let next = core::array::from_fn(|i| p[i] + step[i]);
            let next_sse = sse_of(&next);
            if next_sse.is_finite() && next_sse < sse {
                let gain = sse - next_sse;
                p = next;
                sse = next_sse;
                lambda = (lambda / 10.0).max(1e-12);
                improved = true;
                converged = gain < 1e-15 * (1.0 + sse);
                break;
            }
            lambda *= 10.0;
        }
        if !improved || converged {
            break;
        }
    }
    let [a, d, lc, b] = p;
    let c = lc.exp();
    let residuals: Vec<_> = xs
        .iter()
        .zip(ys)
        .map(|(&x, &y)| y - four_pl(&p, x))
        .collect();
    let mean = ys.iter().sum::<f64>() / n as f64;
    let sst = ys.iter().map(|y| (y - mean).powi(2)).sum::<f64>();
    let s2 = sse / (n - 4) as f64;
    let matrix = normal_matrix(&jacobian(&p, xs));
    let se = |k| {
        let rhs = core::array::from_fn(|i| if i == k { 1.0 } else { 0.0 });
        match solve4(matrix, rhs) {
            Some(cov) if cov[k] > 0.0 => (s2 * cov[k]).sqrt(),
            _ => f64::NAN,
        }
    };
    let mut out = vec![
        a,
        d,
        c,
        b,
        se(0),
        se(1),
        se(2) * c,
        se(3),
        if sst > 0.0 { 1.0 - sse / sst } else { 1.0 },
        s2.sqrt(),
    ];
    out.extend(residuals);
    out
}

/// vmax,km,seVmax,seKm,r2, followed by residuals. Input has already been
/// filtered to positive substrate concentrations and finite measured rates.
pub fn fit_michaelis_menten(xs: &[f64], ys: &[f64]) -> Vec<f64> {
    let n = xs.len();
    let sse_for = |km: f64| {
        let (mut fy, mut ff) = (0.0, 0.0);
        for (&x, &y) in xs.iter().zip(ys) {
            let f = x / (km + x);
            fy += f * y;
            ff += f * f;
        }
        let vmax = if ff > 0.0 { fy / ff } else { 0.0 };
        let sse = xs
            .iter()
            .zip(ys)
            .map(|(&x, &y)| (y - vmax * x / (km + x)).powi(2))
            .sum::<f64>();
        (vmax, sse)
    };
    let lo = xs.iter().copied().fold(f64::INFINITY, f64::min) / 20.0;
    let hi = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max) * 20.0;
    let mut km = lo;
    let mut best = sse_for(lo);
    for i in 0..=400 {
        let candidate = lo * (hi / lo).powf(i as f64 / 400.0);
        let fit = sse_for(candidate);
        if fit.1 < best.1 {
            best = fit;
            km = candidate;
        }
    }
    let mut vmax = best.0;
    for _ in 0..50 {
        let (mut jvv, mut jkk, mut jvk, mut gv, mut gk) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for (&x, &y) in xs.iter().zip(ys) {
            let d = km + x;
            let r = y - vmax * x / d;
            let dv = x / d;
            let dk = -vmax * x / (d * d);
            jvv += dv * dv;
            jkk += dk * dk;
            jvk += dv * dk;
            gv += r * dv;
            gk += r * dk;
        }
        let det = jvv * jkk - jvk * jvk;
        if det.abs() < 1e-300 {
            break;
        }
        let step_v = (gv * jkk - gk * jvk) / det;
        let step_k = (gk * jvv - gv * jvk) / det;
        let (nv, nk) = (vmax + step_v, km + step_k);
        if nk <= 0.0 || nv <= 0.0 || nk.is_nan() || nv.is_nan() {
            break;
        }
        vmax = nv;
        km = nk;
        if step_v.abs() < 1e-12 * vmax.abs() && step_k.abs() < 1e-12 * km.abs() {
            break;
        }
    }
    let residuals: Vec<_> = xs
        .iter()
        .zip(ys)
        .map(|(&x, &y)| y - vmax * x / (km + x))
        .collect();
    let sse = residuals.iter().map(|r| r * r).sum::<f64>();
    let mean = ys.iter().sum::<f64>() / n as f64;
    let sst = ys.iter().map(|y| (y - mean).powi(2)).sum::<f64>();
    let (mut jvv, mut jkk, mut jvk) = (0.0, 0.0, 0.0);
    for &x in xs {
        let d = km + x;
        let dv = x / d;
        let dk = -vmax * x / (d * d);
        jvv += dv * dv;
        jkk += dk * dk;
        jvk += dv * dk;
    }
    let det = jvv * jkk - jvk * jvk;
    let s2 = sse / (n - 2) as f64;
    let mut out = vec![
        vmax,
        km,
        if det > 0.0 {
            (s2 * jkk / det).sqrt()
        } else {
            f64::NAN
        },
        if det > 0.0 {
            (s2 * jvv / det).sqrt()
        } else {
            f64::NAN
        },
        if sst > 0.0 { 1.0 - sse / sst } else { 1.0 },
    ];
    out.extend(residuals);
    out
}

fn batch(count: u32, four: bool) -> u32 {
    let n = count as usize;
    let fields = if four { 10 } else { 5 };
    // Check before multiplication on wasm32; input and output share scratch.
    if n > (crate::CAPACITY - fields) / 3 || n < if four { 5 } else { 3 } {
        return 0;
    }
    let input = unsafe { core::slice::from_raw_parts(crate::lab_scratch_ptr(), 2 * n) };
    if input.iter().any(|v| !v.is_finite()) {
        return 0;
    }
    let xs: Vec<_> = input.chunks_exact(2).map(|p| p[0]).collect();
    let ys: Vec<_> = input.chunks_exact(2).map(|p| p[1]).collect();
    if four && xs.iter().filter(|&&x| x > 0.0).count() < 3 || !four && xs.iter().any(|&x| x <= 0.0)
    {
        return 0;
    }
    let output = if four {
        fit_four_pl(&xs, &ys)
    } else {
        fit_michaelis_menten(&xs, &ys)
    };
    let required: &[usize] = if four {
        &[0, 1, 2, 3, 8, 9]
    } else {
        &[0, 1, 4]
    };
    if required.iter().any(|&i| !output[i].is_finite())
        || output[fields..].iter().any(|v| !v.is_finite())
    {
        return 0;
    }
    unsafe {
        core::slice::from_raw_parts_mut(crate::lab_scratch_ptr().add(2 * n), output.len())
            .copy_from_slice(&output);
    }
    1
}

#[no_mangle]
pub extern "C" fn lab_fit_four_pl(count: u32) -> u32 {
    batch(count, true)
}
#[no_mangle]
pub extern "C" fn lab_fit_michaelis_menten(count: u32) -> u32 {
    batch(count, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovers_known_four_pl_curve() {
        let xs = [0.0, 0.1, 0.3, 1.0, 3.0, 10.0, 30.0];
        let p = [0.05, 2.2, 2.0_f64.ln(), 1.3];
        let ys: Vec<_> = xs.iter().map(|&x| four_pl(&p, x)).collect();
        let out = fit_four_pl(&xs, &ys);
        for (i, expected) in [0.05, 2.2, 2.0, 1.3].iter().enumerate() {
            assert!((out[i] - expected).abs() < 1e-7);
        }
        assert!(out[10..].iter().all(|r| r.abs() < 1e-8));
    }
    #[test]
    fn recovers_known_enzyme_and_reports_unidentified_errors() {
        let xs = [0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6];
        let ys: Vec<_> = xs.iter().map(|x| 52.0 * x / (0.18 + x)).collect();
        let out = fit_michaelis_menten(&xs, &ys);
        assert!((out[0] - 52.0).abs() < 1e-8 && (out[1] - 0.18).abs() < 1e-8);
        let zero = fit_michaelis_menten(&xs, &[0.0; 7]);
        assert_eq!(zero[0], 0.0);
        assert!(zero[2].is_nan() && zero[3].is_nan());
    }
}

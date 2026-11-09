//! Nernst equilibrium with conserved electron inventory. Protons are in excess;
//! this deliberately preserves the teaching model's existing assumptions.
pub struct Couple {
    pub n: f64,
    pub e0: f64,
    pub protons: f64,
    pub k: f64,
    pub ox: f64,
    pub red: f64,
}
impl Couple {
    fn total(&self) -> f64 {
        self.ox + self.red / self.k
    }
    fn formal(&self, ph: f64, slope: f64) -> f64 {
        self.e0 - self.protons / self.n * slope * ph
    }
    fn trace(&self, ph: f64, slope: f64, volume: f64) -> f64 {
        let total = self.total();
        let ox = self.ox.max(1e-3 * total) / volume;
        let red = self.red.max(1e-3 * self.k * total) / volume;
        self.formal(ph, slope) + slope / self.n * (ox / red.powf(self.k)).log10()
    }
    fn reduced(&self, potential: f64, ph: f64, slope: f64, volume: f64) -> f64 {
        let x = self.n * (potential - self.formal(ph, slope)) / slope;
        let total = self.total();
        if self.k == 1.0 {
            if x > 300.0 {
                return 0.0;
            }
            if x < -300.0 {
                return total;
            }
            return total / (1.0 + 10.0_f64.powf(x));
        }
        let t = total / volume;
        let q = if x > 300.0 {
            f64::INFINITY
        } else if x < -300.0 {
            0.0
        } else {
            10.0_f64.powf(x)
        };
        let r = if self.k == 2.0 {
            2.0 * t / (0.5 + (0.25 + 4.0 * q * t).sqrt())
        } else {
            let (mut lo, mut hi) = (0.0, self.k * t);
            for _ in 0..80 {
                let mid = (lo + hi) / 2.0;
                if q * mid.powf(self.k) + mid / self.k > t {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            (lo + hi) / 2.0
        };
        if r.is_finite() {
            r * volume
        } else {
            0.0
        }
    }
}

pub struct Equilibrium {
    pub potential: f64,
    pub reduced: Option<Vec<f64>>,
}
pub fn equilibrate(couples: &[Couple], ph: f64, temperature_k: f64, volume: f64) -> Equilibrium {
    let slope = 8.314462618 * temperature_k * core::f64::consts::LN_10 / 96485.33212;
    if couples.len() == 1 {
        return Equilibrium {
            potential: couples[0].trace(ph, slope, volume),
            reduced: None,
        };
    }
    let electrons: f64 = couples.iter().map(|c| c.n * c.red / c.k).sum();
    let capacity: f64 = couples.iter().map(|c| c.n * c.total()).sum();
    if electrons >= capacity * (1.0 - 1e-12) {
        return Equilibrium {
            potential: couples
                .iter()
                .map(|c| c.trace(ph, slope, volume))
                .fold(f64::INFINITY, f64::min),
            reduced: None,
        };
    }
    if electrons <= capacity * 1e-12 {
        return Equilibrium {
            potential: couples
                .iter()
                .map(|c| c.trace(ph, slope, volume))
                .fold(f64::NEG_INFINITY, f64::max),
            reduced: None,
        };
    }
    let (mut lo, mut hi) = (-4.0, 4.0);
    for _ in 0..64 {
        let mid = (lo + hi) / 2.0;
        let held: f64 = couples
            .iter()
            .map(|c| c.n * c.reduced(mid, ph, slope, volume) / c.k)
            .sum();
        if held > electrons {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let potential = (lo + hi) / 2.0;
    Equilibrium {
        potential,
        reduced: Some(
            couples
                .iter()
                .map(|c| c.reduced(potential, ph, slope, volume))
                .collect(),
        ),
    }
}

/// Packed six-value records: n,e0,protons,k,oxMol,redMol. Output at input
/// length: potential, redistribution flag, reduced amounts (when flagged).
#[no_mangle]
pub extern "C" fn lab_redox(length: u32, ph: f64, temperature_k: f64, volume: f64) -> u32 {
    let length = length as usize;
    if length == 0
        || length > crate::CAPACITY
        || length % 6 != 0
        || length + 2 + length / 6 > crate::CAPACITY
        || !ph.is_finite()
        || !temperature_k.is_finite()
        || temperature_k <= 0.0
        || !volume.is_finite()
        || volume <= 0.0
    {
        return 0;
    }
    let values = unsafe { core::slice::from_raw_parts(crate::lab_scratch_ptr(), length) };
    let mut couples = Vec::new();
    for r in values.chunks_exact(6) {
        if r.iter().any(|v| !v.is_finite())
            || r[0] <= 0.0
            || r[3] <= 0.0
            || r[4] < 0.0
            || r[5] < 0.0
            || r[4] + r[5] <= 0.0
        {
            return 0;
        }
        couples.push(Couple {
            n: r[0],
            e0: r[1],
            protons: r[2],
            k: r[3],
            ox: r[4],
            red: r[5],
        });
    }
    let result = equilibrate(&couples, ph, temperature_k, volume);
    if !result.potential.is_finite()
        || result
            .reduced
            .as_ref()
            .is_some_and(|v| v.iter().any(|r| !r.is_finite()))
    {
        return 0;
    }
    let mut output = vec![
        result.potential,
        if result.reduced.is_some() { 1.0 } else { 0.0 },
    ];
    if let Some(reduced) = result.reduced {
        output.extend(reduced);
    }
    unsafe {
        core::slice::from_raw_parts_mut(crate::lab_scratch_ptr().add(length), output.len())
            .copy_from_slice(&output);
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn equal_forms_and_electron_balance() {
        let iron = Couple {
            n: 1.0,
            e0: 0.68,
            protons: 0.0,
            k: 1.0,
            ox: 1e-3,
            red: 1e-3,
        };
        assert!((equilibrate(&[iron], 0.0, 298.15, 0.05).potential - 0.68).abs() < 1e-12);
        let pairs = [
            Couple {
                n: 1.0,
                e0: 0.68,
                protons: 0.0,
                k: 1.0,
                ox: 0.0,
                red: 2.5e-3,
            },
            Couple {
                n: 5.0,
                e0: 1.51,
                protons: 8.0,
                k: 1.0,
                ox: 0.4e-3,
                red: 0.0,
            },
        ];
        let r = equilibrate(&pairs, 0.0, 298.15, 0.05).reduced.unwrap();
        assert!((r[0] + 5.0 * r[1] - 2.5e-3).abs() < 1e-12);
        assert!((r[1] - 0.4e-3).abs() < 1e-12);
    }
}

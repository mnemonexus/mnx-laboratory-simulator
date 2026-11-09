//! Numerical science ABI v6 (v5 adds the general equilibrium solver, `lab_equilibrium`; v6 its activity coefficients). f64 concentrations in mol/L, temperatures in K,
//! population counts and logical time in seconds. Same ideal-solution model as
//! the existing core. Complexation and redox are explicit separate model modules.
mod complex_abi;
mod complexation;
mod equilibrium;
mod fitting;
mod redox;
mod thermochem;
pub(crate) const CAPACITY: usize = 65536;
static mut SCRATCH: [f64; CAPACITY] = [0.0; CAPACITY];

#[no_mangle]
pub extern "C" fn lab_api_version() -> u32 {
    6
}
#[no_mangle]
pub extern "C" fn lab_scratch_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(SCRATCH).cast()
}
#[no_mangle]
pub extern "C" fn lab_scratch_capacity() -> u32 {
    CAPACITY as u32
}

pub struct AcidSystem<'a> {
    pub total: f64,
    pub charge: f64,
    pub spectator: f64,
    pub pka: &'a [f64],
}

pub fn solve_ph(systems: &[AcidSystem<'_>], temperature_k: f64) -> f64 {
    if !temperature_k.is_finite() || temperature_k <= 0.0 {
        return f64::NAN;
    }
    let ln10 = core::f64::consts::LN_10;
    let pkw = 14.0 + (55800.0 / (ln10 * 8.314)) * (1.0 / temperature_k - 1.0 / 298.15);
    let charge = |ph: f64| {
        let mut q = 10.0_f64.powf(-ph) - 10.0_f64.powf(-pkw + ph);
        for s in systems {
            let mut log = 0.0_f64;
            let mut maximum = 0.0_f64;
            for pka in s.pka {
                log += (ph - pka) * ln10;
                maximum = maximum.max(log);
            }
            let mut term = (-maximum).exp();
            let mut sum = term;
            let mut mean = term * s.charge;
            log = 0.0;
            for (i, pka) in s.pka.iter().enumerate() {
                log += (ph - pka) * ln10;
                term = (log - maximum).exp();
                sum += term;
                mean += term * (s.charge - (i + 1) as f64);
            }
            q += s.total * (s.spectator + mean / sum);
        }
        q
    };
    let (mut lo, mut hi) = (-2.0, 16.0);
    for _ in 0..60 {
        let mid = (lo + hi) / 2.0;
        if charge(mid) > 0.0 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo + hi) / 2.0
}

/// Packed records: total, charge, spectator, pKa count, then pKa values.
/// Only the owned scratch region is read. Invalid bounds/parameters return NaN.
#[no_mangle]
pub extern "C" fn lab_solve_ph(length: u32, temperature_k: f64) -> f64 {
    let length = length as usize;
    if length > CAPACITY {
        return f64::NAN;
    }
    let values = unsafe { core::slice::from_raw_parts(lab_scratch_ptr(), length) };
    let mut systems = Vec::new();
    let mut cursor = 0;
    while cursor < values.len() {
        if cursor + 4 > values.len() {
            return f64::NAN;
        }
        let count = values[cursor + 3];
        if !count.is_finite() || count < 0.0 || count.fract() != 0.0 || count > 64.0 {
            return f64::NAN;
        }
        let end = cursor + 4 + count as usize;
        if end > values.len()
            || values[cursor..end].iter().any(|x| !x.is_finite())
            || values[cursor] < 0.0
        {
            return f64::NAN;
        }
        systems.push(AcidSystem {
            total: values[cursor],
            charge: values[cursor + 1],
            spectator: values[cursor + 2],
            pka: &values[cursor + 4..end],
        });
        cursor = end;
    }
    solve_ph(&systems, temperature_k)
}

/// Existing population model's explicit step, constrained by available growth factors.
#[no_mangle]
pub extern "C" fn lab_population_delta(
    viable: f64,
    net_rate_per_s: f64,
    dt_s: f64,
    available_cells: f64,
) -> f64 {
    if !viable.is_finite()
        || viable < 0.0
        || !net_rate_per_s.is_finite()
        || !dt_s.is_finite()
        || dt_s < 0.0
        || available_cells.is_nan()
        || available_cells < 0.0
    {
        return f64::NAN;
    }
    if net_rate_per_s < 0.0 {
        viable * ((net_rate_per_s * dt_s).exp() - 1.0)
    } else {
        (viable * net_rate_per_s * dt_s).min(available_cells)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn neutral_water() {
        assert!((solve_ph(&[], 298.15) - 7.0).abs() < 1e-12);
    }
    #[test]
    fn acetate_buffer_and_strong_acid() {
        let pka = [4.76];
        let buffer = [
            AcidSystem {
                total: 0.05,
                charge: 0.0,
                spectator: 0.0,
                pka: &pka,
            },
            AcidSystem {
                total: 0.05,
                charge: 0.0,
                spectator: 1.0,
                pka: &pka,
            },
        ];
        assert!((solve_ph(&buffer, 298.15) - 4.76).abs() < 0.001);
        assert!(
            (solve_ph(
                &[AcidSystem {
                    total: 0.01,
                    charge: 0.0,
                    spectator: -1.0,
                    pka: &[]
                }],
                298.15
            ) - 2.0)
                .abs()
                < 1e-8
        );
    }
    #[test]
    fn population_conservation_and_limits() {
        assert_eq!(lab_population_delta(100.0, 0.01, 10.0, f64::INFINITY), 10.0);
        assert_eq!(lab_population_delta(100.0, 0.01, 10.0, 3.0), 3.0);
        let dead = lab_population_delta(100.0, -0.01, 100.0, f64::INFINITY);
        assert!(dead >= -100.0 && dead <= 0.0);
        assert!(lab_population_delta(-1.0, 1.0, 1.0, 1.0).is_nan());
    }
}

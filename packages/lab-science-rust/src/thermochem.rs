//! Proton-transfer chemical enthalpy in joules. This is a state function;
//! inventory transactions and heat-capacity updates remain with the coordinator.
//! Packed records: moles, site count, then (pKa, ionisation J/mol) pairs.
pub fn enthalpy(values: &[f64], volume_l: f64, temperature_k: f64, ph: f64) -> f64 {
    if !volume_l.is_finite()
        || volume_l < 0.0
        || !temperature_k.is_finite()
        || temperature_k <= 0.0
        || !ph.is_finite()
    {
        return f64::NAN;
    }
    let pkw = 14.0
        + (55800.0 / (core::f64::consts::LN_10 * 8.314)) * (1.0 / temperature_k - 1.0 / 298.15);
    let mut h = 55800.0 * 10.0_f64.powf(ph - pkw) * volume_l;
    let mut cursor = 0;
    while cursor < values.len() {
        if cursor + 2 > values.len() {
            return f64::NAN;
        }
        let (moles, count) = (values[cursor], values[cursor + 1]);
        if !moles.is_finite()
            || moles < 0.0
            || !count.is_finite()
            || count < 0.0
            || count.fract() != 0.0
            || count > 64.0
        {
            return f64::NAN;
        }
        let end = cursor + 2 + 2 * count as usize;
        if end > values.len() || values[cursor..end].iter().any(|x| !x.is_finite()) {
            return f64::NAN;
        }
        let mut sites: Vec<_> = values[cursor + 2..end]
            .chunks_exact(2)
            .map(|p| (p[0], p[1]))
            .collect();
        sites.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut logs = vec![0.0_f64];
        for (pk, _) in &sites {
            logs.push(logs.last().unwrap() + (ph - pk) * core::f64::consts::LN_10);
        }
        let maximum = logs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let terms: Vec<_> = logs.iter().map(|v| (v - maximum).exp()).collect();
        let sum: f64 = terms.iter().sum();
        let mut held = 0.0;
        for (i, (_, dh)) in sites.iter().enumerate() {
            held += terms[i] / sum;
            h += moles * held * -dh;
        }
        cursor = end;
    }
    h
}

#[no_mangle]
pub extern "C" fn lab_enthalpy(length: u32, volume_l: f64, temperature_k: f64, ph: f64) -> f64 {
    if length as usize > crate::CAPACITY {
        return f64::NAN;
    }
    let values = unsafe { core::slice::from_raw_parts(crate::lab_scratch_ptr(), length as usize) };
    enthalpy(values, volume_l, temperature_k, ph)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn water_and_single_acid_site_limits() {
        assert!((enthalpy(&[], 1.0, 298.15, 7.0) - 0.00558).abs() < 1e-12);
        // At pH = pKa half the sites retain their proton.
        let water = enthalpy(&[], 0.1, 298.15, 9.25);
        assert!(
            (enthalpy(&[0.01, 1.0, 9.25, 3600.0], 0.1, 298.15, 9.25) - water + 18.0).abs() < 1e-12
        );
    }
    #[test]
    fn malformed_site_batches_are_rejected() {
        for batch in [
            &[0.01][..],
            &[0.01, 1.5][..],
            &[0.01, 1.0, 9.25][..],
            &[-1.0, 0.0][..],
        ] {
            assert!(enthalpy(batch, 1.0, 298.15, 7.0).is_nan());
        }
        assert!(enthalpy(&[], 1.0, 0.0, 7.0).is_nan());
    }
}

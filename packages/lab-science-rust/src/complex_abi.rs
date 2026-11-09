//! ABI v2 packed equilibrium batch (all numbers f64):
//! nL,nI,nP; [ligand total,nKa,pKas]; ion totals; [pair L,I,logK];
//! nWarm,warm; nAcids; [acid total,charge,spectator,nKa,pKas,ligand|-1].
//! Output starts at input length: free log concentrations, pair shares, free ions.
use crate::{
    complexation::{self, ComplexSystem, Ligand, Pair, Speciation},
    AcidSystem, CAPACITY,
};

struct Reader<'a> {
    values: &'a [f64],
    cursor: usize,
}
impl<'a> Reader<'a> {
    fn number(&mut self) -> Option<f64> {
        let value = *self.values.get(self.cursor)?;
        self.cursor += 1;
        value.is_finite().then_some(value)
    }
    fn count(&mut self, maximum: usize) -> Option<usize> {
        let value = self.number()?;
        (value >= 0.0 && value.fract() == 0.0 && value <= maximum as f64).then_some(value as usize)
    }
    fn positive(&mut self) -> Option<f64> {
        self.number().filter(|v| *v > 0.0)
    }
    fn array(&mut self, n: usize) -> Option<&'a [f64]> {
        let values = self.values.get(self.cursor..self.cursor.checked_add(n)?)?;
        self.cursor += n;
        values.iter().all(|v| v.is_finite()).then_some(values)
    }
    fn pka(&mut self) -> Option<&'a [f64]> {
        let count = self.count(64)?;
        self.array(count)
    }
}
struct Batch<'a> {
    cs: ComplexSystem<'a>,
    warm: Vec<f64>,
    acids: Vec<AcidSystem<'a>>,
    links: Vec<Option<usize>>,
}
fn read(values: &[f64]) -> Option<Batch<'_>> {
    let mut r = Reader { values, cursor: 0 };
    let (nl, ni, np) = (r.count(128)?, r.count(128)?, r.count(4096)?);
    if nl + ni > 128 {
        return None;
    }
    let mut ligands = Vec::new();
    for _ in 0..nl {
        ligands.push(Ligand {
            total: r.positive()?,
            pka: r.pka()?,
        });
    }
    let mut ions = Vec::new();
    for _ in 0..ni {
        ions.push(r.positive()?);
    }
    let mut pairs = Vec::new();
    for _ in 0..np {
        let (ligand, ion, log_k) = (r.count(nl)?, r.count(ni)?, r.number()?);
        if ligand >= nl || ion >= ni {
            return None;
        }
        pairs.push(Pair { ligand, ion, log_k });
    }
    let nw = r.count(nl + ni)?;
    if nw != 0 && nw != nl + ni {
        return None;
    }
    let warm = r.array(nw)?.to_vec();
    let na = r.count(4096)?;
    let (mut acids, mut links) = (Vec::new(), Vec::new());
    for _ in 0..na {
        let (total, charge, spectator) = (r.number()?, r.number()?, r.number()?);
        if total < 0.0 {
            return None;
        }
        let pka = r.pka()?;
        let link = r.number()?;
        if link != -1.0 && (link < 0.0 || link.fract() != 0.0 || link >= nl as f64) {
            return None;
        }
        acids.push(AcidSystem {
            total,
            charge,
            spectator,
            pka,
        });
        links.push(if link == -1.0 {
            None
        } else {
            Some(link as usize)
        });
    }
    let output_length = nl + 2 * ni + np;
    if r.cursor != values.len() || values.len().checked_add(output_length)? > CAPACITY {
        return None;
    }
    Some(Batch {
        cs: ComplexSystem {
            ligands,
            ions,
            pairs,
        },
        warm,
        acids,
        links,
    })
}
fn output(length: usize, sp: Speciation) -> bool {
    let values: Vec<_> =
        sp.z.into_iter()
            .chain(sp.shares)
            .chain(sp.free_ions)
            .collect();
    if values.iter().any(|v| !v.is_finite()) || length + values.len() > CAPACITY {
        return false;
    }
    unsafe {
        core::slice::from_raw_parts_mut(crate::lab_scratch_ptr().add(length), values.len())
            .copy_from_slice(&values);
    }
    true
}

#[no_mangle]
pub extern "C" fn lab_speciate(length: u32, ph: f64) -> u32 {
    if length as usize > CAPACITY || !ph.is_finite() {
        return 0;
    }
    let values = unsafe { core::slice::from_raw_parts(crate::lab_scratch_ptr(), length as usize) };
    let Some(batch) = read(values) else {
        return 0;
    };
    let sp = complexation::speciate(&batch.cs, ph, &batch.warm);
    output(length as usize, sp) as u32
}

#[no_mangle]
pub extern "C" fn lab_solve_complex_ph(length: u32, temperature_k: f64) -> f64 {
    if length as usize > CAPACITY || !temperature_k.is_finite() || temperature_k <= 0.0 {
        return f64::NAN;
    }
    let values = unsafe { core::slice::from_raw_parts(crate::lab_scratch_ptr(), length as usize) };
    let Some(mut batch) = read(values) else {
        return f64::NAN;
    };
    let ph = complexation::solve_ph(
        &batch.acids,
        &batch.links,
        &batch.cs,
        temperature_k,
        &mut batch.warm,
    );
    let sp = complexation::speciate(&batch.cs, ph, &batch.warm);
    if output(length as usize, sp) {
        ph
    } else {
        f64::NAN
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_malformed_bounds_and_indices() {
        assert!(read(&[129.0, 0.0, 0.0]).is_none());
        assert!(read(&[1.0, 1.0, 1.0, 0.001, 0.0, 0.001, 1.0, 0.0, 6.0, 0.0, 0.0]).is_none());
        assert!(read(&[1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0]).is_none());
        assert!(read(&[1.0, 0.0, 0.0, 0.001, 0.0, 0.0, 0.0]).is_some());
        assert!(read(&[0.0, 0.0, 0.0, 0.0, 0.0, 123.0]).is_none());
    }
}

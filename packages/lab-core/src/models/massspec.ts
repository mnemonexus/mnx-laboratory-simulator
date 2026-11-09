// Electrospray mass spectrometry (contract measurement.mass-spectrometry, T2). Each species in a
// sample gives ions [M + zH]^z+ in positive mode or [M − zH]^z− in negative mode, seen at
// m/z = (M ± z·1.00728)/z. Small molecules carry one or two charges; a protein sprayed from an acidic,
// organic (denaturing) solution unfolds and carries a broad envelope of charges centred near
// z ≈ M/1400 (lysozyme, 14.3 kDa, around +10), and fewer, from a native solution. How well a species
// ionises in each mode follows its groups: bases and peptides take protons, acids, phosphates and
// nucleic acids give them up; a catalogue `ms` facet can say so directly.
// Ideal: average masses, no isotope envelopes, adducts or fragmentation; signal in proportion to amount.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { molarMass } from '../kernel/materials.ts'
import type { Contents } from '../kernel/state.ts'

export const PROTON = 1.00728
const MZ_MIN = 100
const MZ_MAX = 4000
/** Peaks weaker than this share of the base peak are lost in the noise. */
const THRESHOLD = 0.02
/** Ion counts per µM of a species that ionises fully (an infusion's total ion current). */
const COUNTS_PER_UM = 1e5

export type Polarity = 'positive' | 'negative'

export interface MsPeak {
  mz: number
  /** Relative to the base peak (100). */
  intensity: number
}

/** How readily a species ionises in each mode (0..1). */
export function ionisation(cat: Catalogue, s: string, polarity: Polarity): number {
  const def = cat.substances.get(s)
  const declared = def?.ms?.[polarity]
  if (declared !== undefined) return declared
  const cls = def?.identity.class
  if (cls === 'nucleic-acid') return polarity === 'negative' ? 1 : 0.05
  if (cls === 'protein' || cls === 'enzyme') return polarity === 'positive' ? 1 : 0.3
  if (cls === 'salt' || cls === 'ion' || cls === 'solvent' || cls === 'organism' || cls === 'cell-line' || cls === 'particle' || cls === 'matrix') return 0
  const ab = def?.acidBase
  if (ab) {
    const acidic = ab.pKa.some((p, i) => p < 7 && (ab.charge ?? 0) - i <= 0)
    const basic = ab.pKa.some((p, i) => p > 7 && (ab.charge ?? 0) - i >= 1)
    if (acidic && !basic) return polarity === 'negative' ? 1 : 0.15
    if (basic && !acidic) return polarity === 'positive' ? 1 : 0.1
  }
  return 0.4
}

/**
 * The charge states a species of mass M (g/mol) shows, with their shares of its signal: a small
 * molecule one or two; a protein an envelope (near M/1400 unfolded, 0.078√M native); a nucleic acid,
 * its phosphates' charges, near M/700.
 */
export function chargeStates(massDa: number, kind: 'small' | 'protein' | 'nucleic-acid', native: boolean, polarity: Polarity = 'positive'): Array<{ z: number; share: number }> {
  if (kind === 'small' || massDa < 3000) {
    // One charge mostly; a second where the molecule is big enough to hold it.
    return massDa > 600 ? [{ z: 1, share: 0.7 }, { z: 2, share: 0.3 }] : [{ z: 1, share: 1 }]
  }
  // In the mode against its nature a macromolecule holds fewer charges.
  const against = (kind === 'protein' && polarity === 'negative') || (kind === 'nucleic-acid' && polarity === 'positive')
  const centre = (kind === 'nucleic-acid' ? massDa / 700 : native ? 0.078 * Math.sqrt(massDa) : massDa / 1400) * (against ? 0.6 : 1)
  const width = Math.max(0.8, centre * (native ? 0.08 : 0.2))
  const out: Array<{ z: number; share: number }> = []
  for (let z = Math.max(1, Math.floor(centre - 4 * width)); z <= Math.ceil(centre + 4 * width); z++) out.push({ z, share: Math.exp(-0.5 * ((z - centre) / width) ** 2) })
  const total = out.reduce((a, x) => a + x.share, 0)
  return out.map((x) => ({ z: x.z, share: x.share / total }))
}

/**
 * The true spectrum of a sample: peaks in m/z order, intensities relative to the base peak, and the
 * total ion count (how strong the signal is, which normalising to the base peak hides).
 */
export function esiSpectrum(cat: Catalogue, c: Contents, polarity: Polarity, native: boolean): { peaks: MsPeak[]; tic: number } {
  const amounts: Record<string, number> = {}
  let volume = 0
  for (const l of c.layers) {
    volume += l.volumeL
    for (const [s, n] of Object.entries(l.species)) if (n > 0) amounts[s] = (amounts[s] ?? 0) + n
  }
  if (!(volume > 0)) return { peaks: [], tic: 0 }
  const raw: MsPeak[] = []
  for (const [s, n] of Object.entries(amounts)) {
    const eff = ionisation(cat, s, polarity)
    const m = molarMass(cat, s)
    if (!(eff > 0) || !m) continue
    const cls = cat.substances.get(s)?.identity.class
    const kind = cls === 'protein' || cls === 'enzyme' ? 'protein' : cls === 'nucleic-acid' ? 'nucleic-acid' : 'small'
    for (const { z, share } of chargeStates(m, kind, native, polarity)) {
      const mz = polarity === 'positive' ? (m + z * PROTON) / z : (m - z * PROTON) / z
      if (mz < MZ_MIN || mz > MZ_MAX) continue
      raw.push({ mz, intensity: COUNTS_PER_UM * ((n / volume) * 1e6) * eff * share })
    }
  }
  const tic = raw.reduce((a, p) => a + p.intensity, 0)
  const base = Math.max(0, ...raw.map((p) => p.intensity))
  if (!(base > 0)) return { peaks: [], tic: 0 }
  const peaks = raw
    .map((p) => ({ mz: p.mz, intensity: (100 * p.intensity) / base }))
    .filter((p) => p.intensity >= 100 * THRESHOLD)
    .sort((a, b) => a.mz - b.mz)
  return { peaks, tic }
}

// Real-time PCR (contract amplification.real-time, T2). A dsDNA dye (SYBR Green I) fluoresces only
// when bound, so a cycler that reads each well after every cycle sees the dsDNA the PCR has made
// (models/pcr.ts steps it cycle by cycle). The instrument subtracts each well's baseline (its
// early, flat cycles) and reports the cycle at which the corrected signal crosses a threshold
// (Cq). Heating the products afterwards melts each duplex at its own temperature, so the negative
// derivative of the signal has a peak per product: one for a clean amplicon, a lower one for
// primer-dimers.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Layer } from '../kernel/state.ts'
import type { Rng } from '../rng/rng.ts'
import { duplexTmK } from './pcr.ts'

const NA = 6.022e23
const K0 = 273.15

/** Signal per bp/L of dsDNA at the dye's working concentration, so a typical product plateaus near 1.8. */
const PER_BP_PER_L = 2.1e-19
/** The dye's working (1×) concentration (mol/L): less dye, proportionally less signal. */
const DYE_WORKING_M = 2e-6
/** Unbound dye and the plastic: a raw background, a slow bleach per cycle, and the read noise. */
const BACKGROUND = 0.8
const BLEACH_PER_CYCLE = 0.0015
const READ_NOISE = 0.003
/** Bound dye loses brightness as it warms (per K), and the background a little. */
const QUENCH_PER_K = 0.012
/** The largest duplexes counted as products in a melt; genomic DNA and plasmids melt too broadly to show. */
const MELT_MAX_BP = 2000

/** How much of the working signal the dye in this reaction gives (0 without a dsDNA dye). */
export function dyeFactor(cat: Catalogue, layer: Layer): number {
  if (layer.volumeL <= 0) return 0
  let m = 0
  for (const [s, n] of Object.entries(layer.species)) if (n > 0 && cat.substances.get(s)?.pcr?.role === 'dsdna-dye') m += n / layer.volumeL
  return Math.min(1, m / DYE_WORKING_M)
}

/** Raw fluorescence after each cycle (index 0 is cycle 1), from the dsDNA after each cycle. */
export function amplificationReads(dsBp: number[], volumeL: number, dye: number, rng: Rng): number[] {
  const reads: number[] = []
  for (let c = 1; c < dsBp.length; c++) {
    const bound = dye * PER_BP_PER_L * (dsBp[c] / Math.max(volumeL, 1e-9))
    reads.push(BACKGROUND * (1 - BLEACH_PER_CYCLE * c) + bound + rng.normal(0, READ_NOISE))
  }
  return reads
}

/**
 * Baseline-corrected signal (ΔRn): a straight line through cycles 3 to 15 is subtracted, ending
 * earlier when the well has already started rising (as instrument software sets it automatically).
 */
export function baselineCorrect(reads: number[]): number[] {
  if (reads.length < 6) return reads.map(() => 0)
  const start = 2
  let end = Math.min(14, reads.length - 1)
  // Stop the baseline three cycles before the signal climbs clearly above the first reads.
  const ref = reads[start]
  const rise = reads.findIndex((r, i) => i > start && r - ref > 20 * READ_NOISE)
  if (rise > 0) end = Math.max(start + 2, Math.min(end, rise - 3))
  const xs: number[] = []
  const ys: number[] = []
  for (let i = start; i <= end; i++) {
    xs.push(i)
    ys.push(reads[i])
  }
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length
  const my = ys.reduce((a, b) => a + b, 0) / ys.length
  let sxy = 0
  let sxx = 0
  xs.forEach((x, k) => {
    sxy += (x - mx) * (ys[k] - my)
    sxx += (x - mx) ** 2
  })
  const slope = sxx > 0 ? sxy / sxx : 0
  return reads.map((r, i) => r - (my + slope * (i - mx)))
}

/** The fractional cycle where the corrected signal first crosses the threshold and stays above it. */
export function quantificationCycle(delta: number[], threshold: number): number | undefined {
  for (let i = 1; i < delta.length; i++) {
    if (delta[i] < threshold || delta[i - 1] >= threshold) continue
    if (delta.slice(i, i + 3).some((d) => d < threshold)) continue
    // Cycles are numbered from 1; interpolate on the log of the signal, as it grows geometrically.
    const a = Math.log(Math.max(delta[i - 1], 1e-6))
    const b = Math.log(delta[i])
    const t = Math.log(threshold)
    return i + (b > a ? (t - a) / (b - a) : 1)
  }
  return undefined
}

export interface MeltCurve {
  /** Temperatures (°C) and the negative derivative of the signal (per K) at each. */
  temperaturesC: number[]
  derivative: number[]
  /** Peaks (°C), largest first, at least a tenth of the largest and clear of the noise. */
  peaksC: number[]
}

/** Heat the reaction from `fromK` to `toK`, reading every 0.5 K. */
export function meltCurve(cat: Catalogue, layer: Layer, dye: number, fromK: number, toK: number, rng: Rng): MeltCurve {
  const duplexes: Array<{ bpPerL: number; tmK: number; widthK: number }> = []
  for (const [s, n] of Object.entries(layer.species)) {
    const def = cat.substances.get(s)
    const bp = def?.dna?.lengthBp
    if (!(n > 0) || !bp || bp > MELT_MAX_BP || def?.pcr) continue
    duplexes.push({ bpPerL: (n * NA * bp) / Math.max(layer.volumeL, 1e-9), tmK: duplexTmK(cat, s), widthK: bp < 80 ? 1.2 : 0.6 })
  }
  const step = 0.5
  const temps: number[] = []
  for (let T = fromK; T <= toK + 1e-9; T += step) temps.push(T)
  const signal = temps.map((T) => {
    const quench = 1 - QUENCH_PER_K * (T - fromK)
    let bound = 0
    for (const d of duplexes) bound += d.bpPerL / (1 + Math.exp((T - d.tmK) / d.widthK))
    return dye * PER_BP_PER_L * bound * quench + BACKGROUND * (1 - 0.003 * (T - fromK)) + rng.normal(0, READ_NOISE / 3)
  })
  const derivative = temps.map((_, i) => {
    const a = signal[Math.max(0, i - 1)]
    const b = signal[Math.min(temps.length - 1, i + 1)]
    const span = (Math.min(temps.length - 1, i + 1) - Math.max(0, i - 1)) * step
    return -(b - a) / span
  })
  // Peaks: local maxima clear of the quenching slope and the noise, refined by a parabola.
  const top = Math.max(0, ...derivative)
  const floor = Math.max(0.02, 0.1 * top)
  const peaks: Array<{ T: number; h: number }> = []
  for (let i = 2; i < derivative.length - 2; i++) {
    const h = derivative[i]
    if (h < floor || h < derivative[i - 1] || h < derivative[i + 1] || h < derivative[i - 2] || h < derivative[i + 2]) continue
    const y0 = derivative[i - 1]
    const y2 = derivative[i + 1]
    const den = y0 - 2 * h + y2
    const off = den !== 0 ? (0.5 * (y0 - y2)) / den : 0
    peaks.push({ T: temps[i] + off * step, h })
  }
  peaks.sort((a, b) => b.h - a.h)
  return {
    temperaturesC: temps.map((T) => T - K0),
    derivative,
    peaksC: peaks.map((p) => p.T - K0),
  }
}

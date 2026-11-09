// Electrospray mass spectrometry: charge envelopes, m/z from mass and charge, ion modes by chemistry,
// and the protein-mass practical.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { chargeStates, esiSpectrum, ionisation, PROTON } from '../src/models/massspec.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const sample = (substance: string, uM = 20) => ({ layers: [{ volumeL: 1e-4, species: { [substance]: uM * 1e-6 * 1e-4 } }], solid: {}, temperatureK: 294 })

describe('electrospray', () => {
  it('an unfolded protein carries an envelope of charges around M/1400; a small molecule one or two', () => {
    const z = chargeStates(14300, 'protein', false)
    const top = z.reduce((a, b) => (b.share > a.share ? b : a))
    expect(top.z).toBe(10)
    expect(z.length).toBeGreaterThan(5)
    expect(chargeStates(900, 'small', false).map((x) => x.z)).toEqual([1, 2])
    expect(chargeStates(14300, 'protein', true).reduce((a, b) => (b.share > a.share ? b : a)).z).toBeLessThan(top.z)
  })

  it('puts each ion at (M + zH)/z, so two neighbouring peaks give back the mass', () => {
    const { peaks } = esiSpectrum(cat, sample('bio:lysozyme'), 'positive', false)
    const base = peaks.reduce((a, b) => (b.intensity > a.intensity ? b : a))
    const q = peaks[peaks.indexOf(base) - 1]
    const zb = Math.round((q.mz - PROTON) / (base.mz - q.mz))
    expect(zb * (base.mz - PROTON)).toBeCloseTo(14300, 0)
  })

  it('basic proteins favour positive mode, nucleic acids negative', () => {
    expect(ionisation(cat, 'bio:lysozyme', 'positive')).toBeGreaterThan(ionisation(cat, 'bio:lysozyme', 'negative'))
    const neg = esiSpectrum(cat, sample('molbio:gfp-forward-primer'), 'negative', false)
    const pos = esiSpectrum(cat, sample('molbio:gfp-forward-primer'), 'positive', false)
    expect(neg.tic).toBeGreaterThan(5 * pos.tic)
    expect(esiSpectrum(cat, sample('core:sodium-chloride'), 'positive', false).peaks).toHaveLength(0)
  })
})

describe('conformance: masses by electrospray', () => {
  it('rehearses for several seeds', () => {
    const def = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio24-esi-protein-masses.labx.json')) as ExperimentDefinition
    for (const seed of [1, 2]) {
      const r = compile(def, cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 120000)
})

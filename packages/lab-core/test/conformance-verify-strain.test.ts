// Is it what the label says? Two products sold as P. putida: classical tests show both are
// pseudomonads; growth on hexadecane and a species-specific PCR tell them apart.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const verify = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro12-verify-a-strain.labx.json')) as ExperimentDefinition

describe('conformance: verifying a strain', () => {
  it('rehearses for several seeds: A confirmed, B another pseudomonad', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(verify, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 300000)

  it('without the hexadecane, nothing grows in mineral medium and the genuine product can no longer be confirmed', () => {
    const def = structuredClone(verify)
    const alkane = def.procedure!.steps!.find((s) => s.id === 'alkane')!
    alkane.steps = alkane.steps!.filter((s) => s.id !== 'h-oil')
    const r = compile(def, catalogue, { seed: 1 })
    expect(r.run!.decisions['verdict-a']).toBe('pseudomonad')
    expect(r.rehearsal!.goals[0].passed).toBe(false)
  }, 180000)
})

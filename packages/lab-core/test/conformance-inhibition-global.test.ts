// Global inhibition fits: every rate at once against each mechanism, chosen by AICc. The ALP
// practical finds L-phenylalanine uncompetitive; swap in phosphate and the same pipeline finds a
// competitive inhibitor, because the answer comes from the simulated rates, not the definition.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { fitInhibition, type InhibitionMechanism } from '../src/analysis/analysis.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const global = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio15-inhibition-global-fit.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const noted = (r: Result, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)?.value

const synthetic = (mech: InhibitionMechanism) => {
  const s: number[] = []
  const i: number[] = []
  const v: number[] = []
  let k = 0
  for (const ii of [0, 1, 3])
    for (const ss of [0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4]) {
      const [V, Km, Ki, Kip] = [10, 0.5, 1, mech === 'mixed' ? 4 : 1]
      const rate = {
        competitive: (V * ss) / (Km * (1 + ii / Ki) + ss),
        uncompetitive: (V * ss) / (Km + ss * (1 + ii / Kip)),
        noncompetitive: (V * ss) / ((Km + ss) * (1 + ii / Ki)),
        mixed: (V * ss) / (Km * (1 + ii / Ki) + ss * (1 + ii / Kip)),
      }[mech]
      s.push(ss)
      i.push(ii)
      v.push(rate * (1 + 0.02 * Math.sin(++k * 2.7)))
    }
  return { s, i, v }
}

describe('global inhibition fit', () => {
  for (const mech of ['competitive', 'uncompetitive', 'noncompetitive', 'mixed'] as const) {
    it(`identifies ${mech} inhibition and its constants`, () => {
      const { s, i, v } = synthetic(mech)
      const f = fitInhibition(s, i, v)
      expect(f.best.mechanism).toBe(mech)
      expect(f.best.km).toBeCloseTo(0.5, 1)
      if (mech === 'mixed') expect(f.best.kiPrime!).toBeCloseTo(4, 0)
      expect(f.margin).toBeGreaterThan(2)
    })
  }

  it('needs rates with the inhibitor present', () => {
    expect(() => fitInhibition([0.1, 0.2, 0.4, 0.8, 1.6, 3.2], [0, 0, 0, 0, 0, 0], [1, 2, 3, 4, 5, 6])).toThrow(/inhibitor/)
  })
})

describe('conformance: alkaline phosphatase and L-phenylalanine', () => {
  it('rehearses for several seeds: uncompetitive, with Ki′ near 1.5 mM', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(global, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      expect(noted(r, 'mechanism')).toBe('inhibition-uncompetitive')
    }
  }, 240000)

  it('with phosphate instead, the same analysis finds a competitive inhibitor', () => {
    const def = structuredClone(global)
    for (const id of ['phe20', 'phe60']) def.materials!.supplies!.find((s) => s.id === id)!.contains![0].substance = 'bio:phosphate'
    const r = compile(def, catalogue, { seed: 1 })
    expect(noted(r, 'mechanism')).toBe('inhibition-competitive')
    expect(r.run!.decisions.type).toBe('competitive')
    expect(r.rehearsal!.goals.find((g) => g.id === 'g-type')!.passed).toBe(false)
  }, 120000)
})

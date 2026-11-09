// Composition: the Bradford assay reuses every BCA technique; only one step and the chemistry differ.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { allSteps } from '../src/format/validate.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import type { StoredFit } from '../src/kernel/ops-data.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const load = (name: string) => readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', name)) as ExperimentDefinition
const bradford = load('bio3-bradford-protein-assay.labx.json')
const bca = load('bio1-bca-protein-assay.labx.json')
const refs = (d: ExperimentDefinition) => new Set(allSteps(d).map((s) => s.step.ref).filter((r): r is string => !!r))

describe('conformance: Bradford assay', () => {
  it('uses only techniques the BCA assay also uses', () => {
    const shared = [...refs(bradford)].filter((r) => refs(bca).has(r))
    expect(shared.sort()).toEqual([...refs(bradford)].sort())
  })

  for (const seed of [1, 2, 3]) {
    it(`rehearses to the right answer (seed ${seed})`, () => {
      const r = compile(bradford, catalogue, { seed })
      expect(r.validation.findings.filter((f) => f.severity !== 'info')).toEqual([])
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
    })
  }

  it('bends far more than the BCA curve, from the chemistry alone', () => {
    const fb = compile(bradford, catalogue, { seed: 1, realism: 'ideal' }).run!.outputs.analyse.fit as StoredFit
    const fc = compile(bca, catalogue, { seed: 1, realism: 'ideal' }).run!.outputs.analyse.fit as StoredFit
    // Relative curvature at the top of each range: |c| × xmax / b.
    const bend = (f: StoredFit) => (Math.abs(f.params.c) * f.xRange[1]) / f.params.b
    expect(bend(fb)).toBeGreaterThan(2 * bend(fc))
  })
})

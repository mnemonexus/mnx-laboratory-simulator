// Supplied-data workshops (analysis of data generated from known parameters): each practical's
// reference run reaches its goal and expected observations.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())
const DATA_PRACTICALS: Array<[string, string]> = [
  ['pack-biochemistry', 'bio26-binding-constants-and-energetics'],
  ['pack-biochemistry', 'bio27-sedimentation-equilibrium'],
  ['pack-biochemistry', 'bio28-immune-response-data'],
  ['pack-biochemistry', 'bio29-single-molecule-and-nmr-data'],
  ['pack-biochemistry', 'bio31-finding-a-binding-partner'],
  ['pack-biochemistry', 'bio32-reading-protein-structures'],
  ['pack-molecular-biology', 'molbio14-replication-origins-data'],
  ['pack-molecular-biology', 'molbio15-prophage-genes-from-data'],
]

describe('conformance: supplied-data workshops', () => {
  for (const [pack, id] of DATA_PRACTICALS) {
    it(`${id} reaches its goals`, () => {
      const r = compile(readJson(join(PACKAGES, pack, 'definitions', `${id}.labx.json`)) as ExperimentDefinition, cat, { seed: 1 })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }, 60000)
  }
})

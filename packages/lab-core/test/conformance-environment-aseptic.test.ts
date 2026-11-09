// Microbes everywhere: settle plates, fingertips, aseptic broth transfers, pond water at two
// temperatures and stab cultures. Each judgement follows from the plates and tubes; careless
// handling shows up two days later.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const env = readJson(join(PACKAGES, 'pack-microbiology', 'definitions', 'micro9-environment-aseptic.labx.json')) as ExperimentDefinition
type Result = ReturnType<typeof compile>
const noted = (r: Result, field: string) => r.kernel!.world.notebook.find((e) => e.field === field)?.value

describe('conformance: microbes everywhere', () => {
  it('rehearses for several seeds with every goal met and the transfers sterile', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(env, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      for (const t of ['broth-a', 'broth-b', 'broth-c', 'broth-control']) expect(noted(r, t)).toBe('clear')
      expect(noted(r, 'count-pond-25') as number).toBeGreaterThan(3 * (noted(r, 'count-pond-37') as number))
    }
  }, 240000)

  it('without flaming the necks, the transfer broths are contaminated on some seeds and the control never is', () => {
    const def = structuredClone(env)
    const transfers = def.procedure!.steps!.find((s) => s.id === 'transfers')!
    transfers.steps = transfers.steps!.filter((s) => s.ref !== 'core:flame-neck')
    let dirty = 0
    for (const seed of [1, 2, 3]) {
      const r = compile(def, catalogue, { seed })
      dirty += ['broth-a', 'broth-b', 'broth-c'].filter((t) => noted(r, t) !== 'clear').length
      expect(noted(r, 'broth-control')).toBe('clear')
    }
    expect(dirty).toBeGreaterThan(0)
  }, 240000)
})

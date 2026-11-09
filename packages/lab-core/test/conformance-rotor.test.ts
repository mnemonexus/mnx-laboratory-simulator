// A recall drill with structural variation and a safety gate (spec example 1).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { assess } from '../src/assess/assess.ts'
import { createKernel } from '../src/kernel/index.ts'
import type { RunContext } from '../src/run/env.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const drill = readJson(join(PACKAGES, 'pack-core', 'definitions', 'drill-balance-rotor.labx.json')) as ExperimentDefinition

describe('conformance: balance the rotor (recall drill)', () => {
  it('varies the number of tubes and always rehearses to a balanced run', () => {
    const counts = new Set<unknown>()
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = compile(drill, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      counts.add(r.rehearsal!.sampled['/materials/samples/0/count'])
      const result = assess(r.run!, { quality: r.rehearsal!.quality, context: 'spaced-recall' })
      expect(result.quality).toBe(5)
    }
    expect(counts.size).toBeGreaterThan(1)
  })

  it('a learner who loads the tubes side by side gets an incident and a recall grade of 0', () => {
    const staged = compile(drill, catalogue, { seed: 3, rehearse: false })
    const kernel = createKernel(catalogue, staged.world!)
    const tubes = Object.values(kernel.world.containers).filter((c) => c.supply === 's').map((c) => c.id)
    tubes.forEach((t, i) => {
      kernel.execute({ op: 'core:close', params: { container: t }, path: 'load' })
      expect(kernel.execute({ op: 'core:place-in', params: { container: t, place: 'cfg', position: i + 1 }, path: 'load' }).ok).toBe(true)
    })
    const spin = kernel.execute({ op: 'core:centrifuge', params: { rcf: '12000 [RCF]', duration: '1 min' }, path: 'spin' })
    expect(spin.ok && spin.event.facts.ran).toBe(false)
    expect(kernel.world.incidents[0].kind).toBe('mechanical')
    const run: RunContext = { kernel, cat: catalogue, def: staged.definition!, roles: { cfg: 'cfg' }, outputs: {}, decisions: {} }
    const result = assess(run, { context: 'spaced-recall' })
    expect(result.dimensions.find((d) => d.id === 'safety-practice')!.gate).toBe('failed')
    expect(result.misconceptions).toContain('rotor-imbalance')
    expect(result.quality).toBe(0)
  })

  it('the kernel refuses a tube that does not fit or a taken position', () => {
    const staged = compile(drill, catalogue, { seed: 3, rehearse: false })
    const kernel = createKernel(catalogue, staged.world!)
    const [a, b] = Object.values(kernel.world.containers).filter((c) => c.supply === 's').map((c) => c.id)
    kernel.execute({ op: 'core:place-in', params: { container: a, place: 'cfg', position: 1 } })
    expect(kernel.execute({ op: 'core:place-in', params: { container: b, place: 'cfg', position: 1 } })).toMatchObject({ ok: false, refusal: { code: 'SLOT-TAKEN' } })
    kernel.execute({ op: 'core:fetch', params: { equipment: 'core:conical-tube-50ml', id: 'big' } })
    expect(kernel.execute({ op: 'core:place-in', params: { container: 'big', place: 'cfg', position: 5 } })).toMatchObject({ ok: false, refusal: { code: 'DOES-NOT-FIT' } })
  })
})

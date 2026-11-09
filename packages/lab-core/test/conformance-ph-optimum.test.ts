// The pH optimum of alkaline phosphatase: an enzyme whose activity follows its ionisable groups,
// a product that is coloured only when deprotonated, and a stop solution that fixes both.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addSupply, createKernel, emptyWorld } from '../src/kernel/index.ts'
import { layerPH } from '../src/models/acidbase.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const alp = readJson(join(PACKAGES, 'pack-biochemistry', 'definitions', 'bio5-phosphatase-ph-optimum.labx.json')) as ExperimentDefinition
const readings = (r: ReturnType<typeof compile>) => r.kernel!.world.notebook.filter((e) => e.field === 'A405').map((e) => e.value as number)

describe('conformance: pH optimum of alkaline phosphatase', () => {
  it('rehearses for several seeds: a bell-shaped curve with its top at pH 9.5 to 10', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = compile(alp, catalogue, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((o) => o.passed)).toBe(true)
      const a = readings(r)
      const top = a.indexOf(Math.max(...a))
      expect([4, 5]).toContain(top)
      // Rising to the top and falling after it.
      for (let i = 1; i <= top; i++) expect(a[i]).toBeGreaterThan(a[i - 1])
      for (let i = top + 2; i < a.length; i++) expect(a[i]).toBeLessThan(a[i - 1])
    }
  }, 30000)

  it('without the stop solution, the low-pH tubes under-read: their product is partly colourless', () => {
    const def = structuredClone(alp)
    def.procedure!.steps = def.procedure!.steps!.filter((s) => s.id !== 'stopping')
    // Without the 100 µL of stop solution there is only 1 mL in each tube to read from.
    def.procedure!.steps.find((s) => s.id === 'blank-fill')!.params!.volume = '900 uL'
    def.procedure!.steps.find((s) => s.id === 'reading')!.steps!.find((s) => s.id === 'fill')!.params!.volume = '900 uL'
    const stopped = readings(compile(alp, catalogue, { seed: 1 }))
    const unstopped = readings(compile(def, catalogue, { seed: 1 }))
    // At pH 7.5 about a third of p-nitrophenol (pKa 7.15) is still protonated; at pH 10 none is.
    expect(unstopped[0] / stopped[0]).toBeLessThan(0.85)
    expect(unstopped[5] / stopped[5]).toBeGreaterThan(1)
  })
})

describe('enzyme pH profile', () => {
  it('scales the rate by 1 / (1 + 10^(pKa1 − pH) + 10^(pH − pKa2)) at the layer\'s own pH', () => {
    const product = (buffer: string) => {
      const w = emptyWorld(1)
      const prep = catalogue.preparations.get(buffer)!
      addSupply(w, catalogue, {
        id: 't', label: 'Reaction', container: 'core:microtube-1.5ml', amount: '1 mL',
        components: [...prep.components, { substance: 'bio:pnpp', conc: '5 mM' }, { substance: 'bio:alkaline-phosphatase', conc: '0.1 mg/L' }],
      })
      const k = createKernel(catalogue, w)
      const pH = layerPH(catalogue, k.world.containers.t.contents.layers[0], k.world.containers.t.contents.temperatureK)!
      k.execute({ op: 'core:advance-time', params: { duration: '60 s' } })
      return { pH, made: k.world.containers.t.contents.layers[0].species['bio:p-nitrophenol'] ?? 0 }
    }
    const f = (pH: number) => 1 / (1 + 10 ** (8.6 - pH) + 10 ** (pH - 10.8))
    const lo = product('bio:tris-hcl-50mm-ph8.0')
    const hi = product('bio:glycine-naoh-50mm-ph10.0')
    expect(lo.pH).toBeCloseTo(8.0, 1)
    expect(hi.pH).toBeCloseTo(10.0, 1)
    expect(lo.made / hi.made).toBeCloseTo(f(lo.pH) / f(hi.pH), 2)
  })
})

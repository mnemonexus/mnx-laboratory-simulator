import { describe, expect, it } from 'vitest'
import { loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'

const { catalogue, findings } = Catalogue.build(loadAllPacks())

describe('catalogue packs', () => {
  it('load without errors or warnings', () => {
    const problems = findings.filter((f) => f.severity !== 'info')
    expect(problems.map((f) => `${f.code} ${f.path}: ${f.message}`)).toEqual([])
  })

  it('contain the expected registries', () => {
    const c = catalogue.counts()
    expect(c.purposes).toBeGreaterThan(100)
    expect(c.operations).toBeGreaterThan(20)
    expect(c.techniques).toBeGreaterThanOrEqual(9)
    expect(catalogue.packs.map((p) => p.id)).toEqual(['core', 'aq', 'bio', 'chem', 'micro', 'molbio'])
  })

  it('resolves equipment lineage and inherited properties', () => {
    expect(catalogue.isA('core:micropipette-p200', 'core:pipette')).toBe(true)
    expect(catalogue.property('core:micropipette-p200', 'needsTip')).toBe(true)
    expect(catalogue.property('core:microtube-1.5ml', 'material')).toBe('polypropylene')
    expect(catalogue.isWasteStream('core:chemical-waste.heavy-metal')).toBe(true)
    expect(catalogue.isWasteStream('core:microtube-1.5ml')).toBe(false)
  })

  it('finds providers of a purpose through the taxonomy', () => {
    const providers = catalogue.providersOf('measure-out.volume').map((p) => p.id)
    expect(providers).toContain('core:micropipette-p200')
    expect(providers).toContain('core:transfer')
    expect(catalogue.providersOf('prepare.standard-series').map((p) => p.id)).toContain('core:dilution-series')
    expect(catalogue.purposeIsA('measure-out.volume.dispense-variable', 'measure-out')).toBe(true)
  })

  it('reports broken references', () => {
    const packs = loadAllPacks()
    const bad = structuredClone(packs)
    bad[0].techniques![0].skills.push('core:no-such-skill')
    bad[0].equipment!.push({ id: 'core:thing', label: 'x', level: 'model', kind: 'tool', capabilities: [], representation: 'full', status: 'stub' })
    const { findings: f } = Catalogue.build(bad)
    expect(f.map((x) => x.code)).toContain('CAT-V2-UNKNOWN-SKILL')
    expect(f.map((x) => x.code)).toContain('CAT-V2-MODEL-WITHOUT-CLASS')
  })
})

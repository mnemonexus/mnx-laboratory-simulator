// The format spec's examples must stay valid against the implemented schema (V1), and those the
// build fully supports must also rehearse: an example that is "supported" but cannot run is a bug.
import { describe, expect, it } from 'vitest'
import { docExamples, loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import { validateV1 } from '../src/format/validate.ts'

const { catalogue } = Catalogue.build(loadAllPacks())

describe('documentation examples', () => {
  const defs = docExamples()
  it('the spec has complete examples', () => expect(defs.length).toBeGreaterThanOrEqual(8))
  for (const d of defs) {
    it(`${d.source}: "${d.title}" is valid at V1`, () => {
      const findings = validateV1(d.json).filter((f) => f.severity === 'error')
      expect(findings.map((f) => `${f.code} ${f.path}: ${f.message}`)).toEqual([])
    })
  }
  it('every fully supported example rehearses to its goals', () => {
    let supported = 0
    for (const d of defs) {
      const r = compile(d.json, catalogue, { seed: 1 })
      if (r.coverage?.verdict !== 'fully-supported') continue
      supported++
      const errors = (r.rehearsal?.issues ?? []).filter((i) => i.severity === 'error').map((i) => `${i.path}: ${i.message}`)
      expect({ title: d.title, errors, ok: r.rehearsal?.ok }).toEqual({ title: d.title, errors: [], ok: true })
    }
    expect(supported).toBeGreaterThanOrEqual(5)
  })
})

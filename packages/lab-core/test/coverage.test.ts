import { describe, expect, it } from 'vitest'
import { curatedDefinitions, docExamples, loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { analyseCoverage, gapReport, unlockAnalysis } from '../src/compile/coverage.ts'
import type { CoverageReport } from '../src/compile/compile.ts'

const { catalogue } = Catalogue.build(loadAllPacks())
const corpus = [...curatedDefinitions().map((d) => d.json), ...docExamples().map((d) => d.json)]
const coverages = corpus.map((d) => analyseCoverage(d, catalogue).coverage!).filter(Boolean)

describe('coverage and gaps', () => {
  it('every curated definition is fully supported', () => {
    for (const d of curatedDefinitions()) expect(analyseCoverage(d.json, catalogue).coverage!.verdict, d.name).toBe('fully-supported')
  })

  it('corpus v0 has no gaps left', () => {
    expect(gapReport(coverages, 'test').entries).toEqual([])
  })

  it('names missing capabilities canonically, in catalogue terms', () => {
    const probe = {
      format: 'lab-experiment', formatVersion: '0.1', id: 'gap-probe', version: '1.0.0', title: 'Gap probe',
      context: { intendedContexts: ['practical-session'], objectives: [{ id: 'o', kind: 'skill', statement: 'Distil' }] },
      materials: { supplies: [{ id: 'x', label: 'X', contains: [{ substance: 'chem:unobtainium', conc: '1 mM' }] }] },
      procedure: { fidelity: 'prescribed', steps: [
        { id: 'd', kind: 'technique', ref: 'chem:fractional-distillation', objectives: ['o'] },
        { id: 'p', kind: 'purpose', ref: 'separate.by-volatility' },
      ] },
    }
    const report = gapReport([analyseCoverage(probe, catalogue).coverage!], 'test')
    const prints = report.entries.map((e) => e.fingerprint)
    expect(prints).toContain('technique||chem:fractional-distillation')
    expect(prints).toContain('material||chem:unobtainium')
    expect(prints).toContain('technique|separate.by-volatility|')
    expect(prints.every((p) => /^[a-z-]+\|[a-z.-]*\|[a-z0-9:.-]*$/.test(p))).toBe(true)
  })

  it('merges the same gap from different definitions', () => {
    const fake = (id: string, prints: string[]): CoverageReport => ({
      report: 'lab-coverage', definition: { id, version: '1.0.0' }, context: 'practical-session', verdict: 'not-supported',
      requirements: [], disclosures: [],
      gaps: prints.map((p) => ({ fingerprint: p, gap: { kind: p.split('|')[0], id: p.split('|')[2] }, path: '/x', centrality: 'objective' as const })),
    })
    const report = gapReport([fake('a', ['technique||chem:distillation']), fake('b', ['technique||chem:distillation', 'model||chem:vle'])], 't')
    expect(report.entries[0]).toMatchObject({ fingerprint: 'technique||chem:distillation' })
    expect(report.entries[0].occurrences.length).toBe(2)
  })

  it('ranks gaps by what they unlock, not by frequency alone', () => {
    const fake = (id: string, prints: string[]): CoverageReport => ({
      report: 'lab-coverage', definition: { id, version: '1' }, context: 'practical-session', verdict: 'not-supported', requirements: [], disclosures: [],
      gaps: prints.map((p) => ({ fingerprint: p, gap: { kind: 'technique', id: p }, path: '/', centrality: 'objective' as const })),
    })
    // "common" is needed by four definitions but always with something else; "solo" alone blocks two.
    const rows = unlockAnalysis([
      fake('1', ['common', 'x1']), fake('2', ['common', 'x2']), fake('3', ['common', 'x3']), fake('4', ['common', 'x4']),
      fake('5', ['solo']), fake('6', ['solo']),
    ])
    expect(rows[0].fingerprint).toBe('solo')
    expect(rows[0].unlockedCumulative).toBe(2)
    expect(rows.find((r) => r.fingerprint === 'common')!.definitions).toBe(4)
    expect(rows[rows.length - 1].unlockedCumulative).toBe(6)
  })
})

// Sequences: local alignment and the differences it shows, what they do to a coding sequence, a
// sequencer's read of a tube (mixed and too-little templates), and the reference search.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadAllPacks, PACKAGES, readJson } from '../../../apps/cli/fs-packs.ts'
import { alignLocal, cleanSequence, consequences, differences, identity, proteinChange, reverseComplement, translate } from '../src/analysis/sequence.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { compile } from '../src/compile/compile.ts'
import type { ExperimentDefinition } from '../src/format/types.ts'
import { addEquipment, addSupply, createKernel, emptyWorld, type Kernel } from '../src/kernel/index.ts'

const { catalogue: cat } = Catalogue.build(loadAllPacks())

function run(k: Kernel, op: string, params: Record<string, unknown>) {
  const r = k.execute({ op, params })
  if (!r.ok) throw new Error(`${op}: ${r.refusal.message}`)
  return r.outputs as Record<string, unknown>
}

// A small coding sequence: Met-Leu-Ala-Arg-Ala-Arg-Lys-Gly-Phe-Glu, then a stop, between flanks.
const UP = 'TTGACAGGTCAGGAATTCAA'
const CDS = 'ATGCTCGCGCGCGCGCGCAAAGGCTTTGAATAA'
const DOWN = 'GGATCCTTAGCATTCGACCTAGG'
const REF = UP + CDS + DOWN
const at = UP.length

describe('alignment and mutation effects', () => {
  it('reads FASTA and translates', () => {
    expect(cleanSequence('>read 1\nacgt\nNNac\n')).toBe('ACGTNNAC')
    expect(translate(CDS)).toBe('MLARARKGFE*')
    expect(reverseComplement('AACGTT')).toBe('AACGTT')
  })

  it('a substitution is missense, silent or nonsense by what the codon becomes', () => {
    const effectOf = (pos: number, base: string) => {
      const q = REF.slice(0, pos) + base + REF.slice(pos + 1)
      const a = alignLocal(q, REF)
      return consequences(REF, differences(a), [at, at + CDS.length])[0]
    }
    // Codon 2 CTC (Leu): CCC is Pro, CTT is still Leu; codon 7 AAA (Lys): TAA is a stop.
    expect(effectOf(at + 4, 'C')).toMatchObject({ codon: 2, effect: 'missense', description: 'Leu2Pro (CTC→CCC)' })
    expect(effectOf(at + 5, 'T').effect).toBe('silent')
    expect(effectOf(at + 18, 'T').effect).toBe('nonsense')
  })

  it('a base lost is a frameshift; three lost keep the frame', () => {
    const minus1 = REF.slice(0, at + 6) + REF.slice(at + 7)
    const a = alignLocal(minus1, REF)
    expect(identity(a)).toBeGreaterThan(0.97)
    const [d] = differences(a)
    expect(d.kind).toBe('deletion')
    const [c] = consequences(REF, [d], [at, at + CDS.length])
    expect(c.effect).toBe('frameshift')
    const minus3 = REF.slice(0, at + 6) + REF.slice(at + 9)
    const [c3] = consequences(REF, differences(alignLocal(minus3, REF)), [at, at + CDS.length])
    expect(c3.effect).toBe('in-frame-deletion')
  })

  it('reads changes together: two substitutions in one codon, and frameshifts that cancel', () => {
    const cds: [number, number] = [at, at + CDS.length]
    // Codon 2 CTC → TCC by two changes: one codon, Ser.
    const two = REF.slice(0, at + 3) + 'TC' + REF.slice(at + 5)
    const d2 = differences(alignLocal(two, REF))
    expect(d2).toHaveLength(2)
    expect(consequences(REF, d2, cds).map((c) => c.description)).toEqual(['Leu2Ser (CTC→TCC)', 'Leu2Ser (CTC→TCC)'])
    expect(proteinChange(REF, d2, cds)).toEqual({ effect: 'substituted', description: 'Leu2Ser' })
    // A base gained before codon 3 and one lost in the GC run: the frame is back after it.
    const both = REF.slice(0, at + 6) + 'G' + REF.slice(at + 6, at + 12) + REF.slice(at + 13)
    const db = differences(alignLocal(both, REF))
    expect(proteinChange(REF, db, cds).effect).toBe('local-change')
    // The loss alone shifts the frame, which reads on past the old stop to one downstream.
    const lost = REF.slice(0, at + 12) + REF.slice(at + 13)
    expect(proteinChange(REF, differences(alignLocal(lost, REF)), cds)).toMatchObject({ effect: 'extended' })
  })

  it('finds a read given as its reverse complement', () => {
    const k = createKernel(cat, emptyWorld(1))
    const hit = run(k, 'core:search-sequences', { query: reverseComplement(String(cat.substances.get('molbio:ta1535-hisg-amplicon')!.dna!.sequence)) })
    expect((hit.top as { strand: string; id: string }).strand).toBe('minus')
    expect(hit.gene).toBe('hisG')
  })
})

describe('sequencing and the reference search', () => {
  function bench(contains: Array<{ substance: string; conc: string }>) {
    const w = emptyWorld(1)
    addEquipment(w, cat, 'seq', 'core:sequencer')
    addSupply(w, cat, { id: 'tube', label: 'tube', container: 'core:pcr-tube-0.2ml', amount: '15 uL', preparation: 'core:water-deionised', components: contains })
    return createKernel(cat, w)
  }

  it('reads the template a tube holds, and finds its gene with one difference from the reference', () => {
    const k = bench([{ substance: 'molbio:ta1538-hisd-amplicon', conc: '20 ug/mL' }])
    const read = run(k, 'core:measure', { instrument: 'seq', subject: 'tube' })
    expect(read.sequence).toBe(cat.substances.get('molbio:ta1538-hisd-amplicon')!.dna!.sequence)
    const s = run(k, 'core:search-sequences', { query: read.fasta })
    const hits = s.hits as Array<{ id: string; identity: number; coverage: number; genes: string[] }>
    expect(hits[0].id).toBe('molbio:salmonella-his-reference')
    expect(hits[0].identity).toBeCloseTo(99.89, 1)
    expect(hits[0].coverage).toBe(100)
    expect(hits[0].genes).toEqual(['hisD'])
    // The other serovar comes next, the E. coli homologue far behind.
    expect(hits[1].id).toBe('molbio:salmonella-his-relative')
    expect(hits[2].identity).toBeLessThan(90)
    const al = run(k, 'core:align-sequences', { query: read.sequence, subject: 'molbio:salmonella-his-reference' })
    expect(al.gene).toBe('hisD')
    expect((al.first as { effect: string; codon: number }).effect).toBe('frameshift')
    expect((al.first as { codon: number }).codon).toBe(290)
    expect(al.protein).toBe('truncated')
  })

  it('two templates give double peaks; too little DNA gives no read', () => {
    const mixed = run(bench([{ substance: 'molbio:ta1538-hisd-amplicon', conc: '10 ug/mL' }, { substance: 'molbio:ta1538-insertion-revertant-hisd-amplicon', conc: '15 ug/mL' }]), 'core:measure', { instrument: 'seq', subject: 'tube' })
    expect(String(mixed.display)).toContain('double peaks')
    expect(String(mixed.sequence)).toContain('N')
    const faint = run(bench([{ substance: 'molbio:ta1538-hisd-amplicon', conc: '0.1 ug/mL' }]), 'core:measure', { instrument: 'seq', subject: 'tube' })
    expect(faint.sequence).toBeNull()
  })
})

describe('conformance: mutations by sequencing', () => {
  const def = readJson(join(PACKAGES, 'pack-molecular-biology', 'definitions', 'molbio12-mutations-by-sequencing.labx.json')) as ExperimentDefinition

  it('rehearses for several seeds', () => {
    for (const seed of [1, 2, 3]) {
      const r = compile(def, cat, { seed })
      expect(r.rehearsal!.ok).toBe(true)
      expect(r.rehearsal!.goals.every((g) => g.passed)).toBe(true)
      expect(r.rehearsal!.expectedObservations.every((e) => e.passed)).toBe(true)
    }
  }, 300000)

  it('a revertant colony picked clean gives a clean read', () => {
    const clean = JSON.parse(JSON.stringify(def)) as ExperimentDefinition
    const r3 = clean.materials!.samples!.find((s) => s.id === 'r3')!
    r3.contains = [r3.contains![0]]
    expect(compile(clean, cat, { seed: 1 }).run!.decisions['r3']).toBe('fine')
  }, 300000)
})

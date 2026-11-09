// Sequencing and sequence analysis (data and analysis §5). A sequencer (a Sanger service) reads
// the DNA in a sample; a search compares a read with the catalogue's reference sequences (an
// offline stand-in for BLAST); an alignment lists the differences between two sequences and what
// they do to a coding sequence. The sequences are the simulation's: a read shows what is really in
// the tube, whatever its label says.
import { alignLocal, cleanSequence, consequences, differences, identity, type LocalAlignment, proteinChange, reverseComplement } from '../analysis/sequence.ts'
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { SubstanceDef } from '../catalogue/types.ts'
import { type OpContext, type OpImpl, type OpResult } from './kernel.ts'
import { type Container, type MeasurementRecord, meanLayer } from './state.ts'

type Params = Record<string, unknown>

/** Grams per mole of base pairs of double-stranded DNA. */
const BP_G_PER_MOL = 650
/** A Sanger read needs about this much template (ng); less gives no readable trace. */
const MIN_TEMPLATE_NG = 5
/** A second template above this share of the DNA shows as double peaks. */
const MIXED_SHARE = 0.2
/** Reads stop after about this many bases. */
const READ_LENGTH = 1000
/** Seed length for the search's word filter (BLASTN's megablast uses 28; 11 is its sensitive word). */
const WORD = 11

function sequenceOf(def: SubstanceDef | undefined): string | undefined {
  return def?.dna?.sequence
}

/** Read the DNA in a sample: the sequence of the template it mostly holds. */
export function readSequence(ctx: OpContext, id: string, c: Container): OpResult {
  const layer = meanLayer(c.contents)
  const templates: Array<{ substance: string; ng: number; seq: string }> = []
  for (const [s, n] of Object.entries(layer.species)) {
    const seq = n > 0 ? sequenceOf(ctx.cat.substances.get(s)) : undefined
    if (seq) templates.push({ substance: s, ng: n * seq.length * BP_G_PER_MOL * 1e9, seq })
  }
  templates.sort((a, b) => b.ng - a.ng)
  const total = templates.reduce((a, t) => a + t.ng, 0)
  const flags: MeasurementRecord['flags'][string] = []
  let read = ''
  let display: string
  if (total < MIN_TEMPLATE_NG) {
    flags.push('no-signal')
    display = 'no readable sequence: too little template'
  } else {
    read = templates[0].seq.slice(0, READ_LENGTH)
    display = `${read.length} bases`
    const second = templates[1]
    if (second && second.ng / total > MIXED_SHARE) {
      flags.push('mixed')
      // Where the two templates differ the trace shows two peaks: called N.
      read = read.split('').map((b, i) => (second.seq[i] !== undefined && second.seq[i] !== b ? 'N' : b)).join('')
      display += `; double peaks along the trace (a second template, about ${Math.round((100 * second.ng) / total)} % of the DNA)`
    }
  }
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: {},
    subject: c.id,
    kind: 'sequence',
    quantity: 'sequence',
    unit: 'nt',
    ...(read ? { value: read.length, sequence: read } : {}),
    display: { [c.id]: display },
    flags: flags.length ? { [c.id]: flags } : {},
    uncertainty: {},
  }
  ctx.world.measurements.push(record)
  const fasta = read ? `>${c.label}\n${read.match(/.{1,70}/g)!.join('\n')}` : ''
  return { outputs: { record: record.id, sequence: read || null, fasta: fasta || null, length: read.length, display }, facts: { record: record.id, length: read.length, mixed: flags.includes('mixed') } }
}

function queryOf(ctx: OpContext, v: unknown, what: string): string {
  if (typeof v !== 'string') ctx.refuse('BAD-SEQUENCE', `${what} must be a sequence (text)`)
  const s = cleanSequence(v)
  if (s.length < 20) ctx.refuse('BAD-SEQUENCE', `${what} has too few bases to align`)
  return s
}

const referenceCache = new WeakMap<Catalogue, Array<{ id: string; def: SubstanceDef; seq: string; words: Set<string> }>>()

/** The searchable sequences: catalogue DNA marked as a reference, with their words for the seed filter. */
function references(cat: Catalogue) {
  let list = referenceCache.get(cat)
  if (!list) {
    list = []
    for (const def of cat.substances.values()) {
      const seq = def.dna?.reference ? def.dna.sequence : undefined
      if (!seq) continue
      const words = new Set<string>()
      for (let i = 0; i + WORD <= seq.length; i++) words.add(seq.slice(i, i + WORD))
      list.push({ id: def.id, def, seq, words })
    }
    referenceCache.set(cat, list)
  }
  return list
}

function sharesWord(q: string, words: Set<string>): boolean {
  for (let i = 0; i + WORD <= q.length; i += 3) if (words.has(q.slice(i, i + WORD))) return true
  return false
}

/** Align a query on both strands; the better one, with its strand. */
function bestStrand(q: string, subject: string): { a: LocalAlignment; strand: 'plus' | 'minus'; query: string } {
  const plus = alignLocal(q, subject)
  const rc = reverseComplement(q)
  const minus = alignLocal(rc, subject)
  return minus.score > plus.score ? { a: minus, strand: 'minus', query: rc } : { a: plus, strand: 'plus', query: q }
}

/** Genes of a reference that an aligned span (0-based, end exclusive) overlaps. */
function genesIn(def: SubstanceDef, from: number, to: number): string[] {
  return (def.dna?.features ?? []).filter((f) => f.start - 1 < to && f.end > from).map((f) => f.gene)
}

/**
 * Search the reference sequences: hits ranked by score, each with its identity and the share of the
 * query it covers (BLAST's two columns), and the annotated genes its alignment falls in.
 */
function searchSequences(ctx: OpContext, p: Params): OpResult {
  const q = queryOf(ctx, p.query, 'The query')
  const most = p.maxHits === undefined ? 10 : Math.max(1, Math.floor(Number(p.maxHits)))
  const rc = reverseComplement(q)
  const hits = references(ctx.cat)
    .filter((r) => sharesWord(q, r.words) || sharesWord(rc, r.words))
    .map((r) => {
      const { a, strand } = bestStrand(q, r.seq)
      return {
        id: r.id,
        title: r.def.dna?.source ?? r.def.identity.name,
        score: a.score,
        identity: Math.round(identity(a) * 10000) / 100,
        coverage: Math.round(((a.queryEnd - a.queryStart) / q.length) * 1000) / 10,
        strand,
        subjectStart: a.subjectStart + 1,
        subjectEnd: a.subjectEnd,
        genes: genesIn(r.def, a.subjectStart, a.subjectEnd),
        differences: differences(a).length,
      }
    })
    .filter((h) => h.score > 40)
    .sort((a, b) => b.score - a.score || b.identity - a.identity)
    .slice(0, most)
  return { outputs: { hits, top: hits[0] ?? null, gene: hits[0]?.genes[0] ?? null, count: hits.length }, facts: { hits: hits.length, top: hits[0]?.id ?? null } }
}

/**
 * Align two sequences ("pairwise with dots for identities"): the differences, numbered in each, and
 * (when the subject is a catalogue reference with a coding sequence there) what each does to it and
 * what they do to the protein together.
 */
function align(ctx: OpContext, p: Params): OpResult {
  const q = queryOf(ctx, p.query, 'The query')
  let subject: string
  let def: SubstanceDef | undefined
  if (typeof p.subject === 'string' && ctx.cat.substances.get(p.subject)?.dna?.sequence) {
    def = ctx.cat.substances.get(p.subject)
    subject = def!.dna!.sequence!
  } else subject = queryOf(ctx, p.subject, 'The subject')
  const { a, strand } = bestStrand(q, subject)
  const diffs = differences(a)
  // The coding sequence the alignment falls in, if the subject is annotated.
  const cds = (def?.dna?.features ?? []).find((f) => f.start - 1 < a.subjectEnd && f.end > a.subjectStart && (p.gene === undefined || f.gene === p.gene))
  const effects = cds ? consequences(subject, diffs, [cds.start - 1, cds.end]) : []
  const overall = cds ? proteinChange(subject, diffs, [cds.start - 1, cds.end]) : undefined
  const listed = diffs.map((d, i) => ({ ...d, ...(effects[i]?.codon !== undefined ? { codon: effects[i].codon } : {}), ...(effects[i] ? { effect: effects[i].effect, description: effects[i].description } : {}) }))
  const each = [...new Set(listed.map((d) => d.description ?? `${d.kind} at query ${d.queryPos} / subject ${d.subjectPos}`))]
  const summary = listed.length === 0 ? 'identical over the aligned region' : each.join('; ') + (overall && each.length > 1 ? `. Together: ${overall.description}` : '')
  return {
    outputs: {
      identity: Math.round(identity(a) * 10000) / 100,
      coverage: Math.round(((a.queryEnd - a.queryStart) / q.length) * 1000) / 10,
      strand,
      queryStart: a.queryStart + 1,
      queryEnd: a.queryEnd,
      subjectStart: a.subjectStart + 1,
      subjectEnd: a.subjectEnd,
      differences: listed,
      first: listed[0] ?? null,
      gene: cds?.gene ?? null,
      summary,
      ...(overall ? { protein: overall.effect, proteinChange: overall.description } : {}),
    },
    facts: { differences: listed.length, gene: cds?.gene ?? null },
  }
}

export const SEQUENCE_OPERATIONS: Record<string, OpImpl> = {
  'core:search-sequences': searchSequences,
  'core:align-sequences': align,
}

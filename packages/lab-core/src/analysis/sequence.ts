// Nucleotide sequences (data and analysis): reading FASTA, local alignment (Smith–Waterman with
// affine gaps, BLASTN's scores), the differences an alignment shows, and what they do to a coding
// sequence. Pure functions: the kernel's search and alignment operations are built on them.

/** A sequence from FASTA or plain text: header lines and anything but bases dropped, upper case. */
export function cleanSequence(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !l.startsWith('>'))
    .join('')
    .toUpperCase()
    .replace(/[^ACGTN]/g, '')
}

const COMPLEMENT: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' }

export function reverseComplement(s: string): string {
  let out = ''
  for (let i = s.length - 1; i >= 0; i--) out += COMPLEMENT[s[i]] ?? 'N'
  return out
}

const CODE = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG'
const BASE: Record<string, number> = { T: 0, C: 1, A: 2, G: 3 }

/** The amino acid a codon encodes (standard code; '*' a stop, 'X' if it holds an N). */
export function codonToAmino(codon: string): string {
  const [a, b, c] = [BASE[codon[0]], BASE[codon[1]], BASE[codon[2]]]
  return a === undefined || b === undefined || c === undefined ? 'X' : CODE[a * 16 + b * 4 + c]
}

export function translate(s: string, from = 0): string {
  let p = ''
  for (let i = from; i + 3 <= s.length; i += 3) p += codonToAmino(s.slice(i, i + 3))
  return p
}

const THREE: Record<string, string> = {
  A: 'Ala', R: 'Arg', N: 'Asn', D: 'Asp', C: 'Cys', Q: 'Gln', E: 'Glu', G: 'Gly', H: 'His', I: 'Ile', L: 'Leu', K: 'Lys', M: 'Met',
  F: 'Phe', P: 'Pro', S: 'Ser', T: 'Thr', W: 'Trp', Y: 'Tyr', V: 'Val', '*': 'Stop', X: 'Xaa',
}
export const threeLetter = (a: string): string => THREE[a] ?? a

/** BLASTN's default scores: match +2, mismatch −3, a gap −5 to open and −2 for each base. */
const MATCH = 2
const MISMATCH = -3
const GAP_OPEN = -5
const GAP_EXTEND = -2

export interface LocalAlignment {
  score: number
  /** Aligned spans, 0-based, end exclusive. */
  queryStart: number
  queryEnd: number
  subjectStart: number
  subjectEnd: number
  /** The aligned rows, '-' for a gap. */
  query: string
  subject: string
}

/**
 * The best local alignment of two sequences (Gotoh's affine-gap Smith–Waterman). Ties in the
 * traceback prefer a match, so a gap in a repeat is placed at the repeat's 5′ end.
 */
export function alignLocal(query: string, subject: string): LocalAlignment {
  const n = query.length
  const m = subject.length
  const NEG = -1e9
  // H: best ending in a match/mismatch or start; E: ending in a gap in the query (subject base
  // against '-'); F: ending in a gap in the subject. Directions kept for the traceback.
  let Hp = new Float64Array(m + 1)
  let Ep = new Float64Array(m + 1).fill(NEG)
  let H = new Float64Array(m + 1)
  let E = new Float64Array(m + 1)
  const dirH = new Uint8Array((n + 1) * (m + 1)) // 0 stop, 1 diagonal, 2 from E, 3 from F
  const dirE = new Uint8Array((n + 1) * (m + 1)) // 1 opened from H, 2 extended
  const dirF = new Uint8Array((n + 1) * (m + 1))
  let best = 0
  let bi = 0
  let bj = 0
  for (let i = 1; i <= n; i++) {
    H[0] = 0
    E[0] = NEG
    let F = NEG
    const qi = query.charCodeAt(i - 1)
    for (let j = 1; j <= m; j++) {
      const k = i * (m + 1) + j
      // E runs down the column (the query advances): a gap in the subject.
      const eOpen = Hp[j] + GAP_OPEN + GAP_EXTEND
      const eExt = Ep[j] + GAP_EXTEND
      E[j] = eExt > eOpen ? eExt : eOpen
      dirE[k] = eExt > eOpen ? 2 : 1
      // F runs along the row (subject advances): a gap in the query.
      const fo = H[j - 1] + GAP_OPEN + GAP_EXTEND
      const fe = F + GAP_EXTEND
      F = fe > fo ? fe : fo
      dirF[k] = fe > fo ? 2 : 1
      const diag = Hp[j - 1] + (qi === subject.charCodeAt(j - 1) && qi !== 78 ? MATCH : MISMATCH)
      let h = 0
      let d = 0
      if (diag > h) {
        h = diag
        d = 1
      }
      if (E[j] > h) {
        h = E[j]
        d = 2
      }
      if (F > h) {
        h = F
        d = 3
      }
      H[j] = h
      dirH[k] = d
      if (h > best) {
        best = h
        bi = i
        bj = j
      }
    }
    ;[Hp, H] = [H, Hp]
    ;[Ep, E] = [E, Ep]
  }
  // Traceback.
  let i = bi
  let j = bj
  let state = 0 // 0 in H, 2 in E, 3 in F
  let q = ''
  let s = ''
  while (i > 0 && j > 0) {
    const k = i * (m + 1) + j
    if (state === 0) {
      const d = dirH[k]
      if (d === 0) break
      if (d === 1) {
        q = query[i - 1] + q
        s = subject[j - 1] + s
        i--
        j--
      } else state = d
    } else if (state === 2) {
      q = query[i - 1] + q
      s = '-' + s
      const d = dirE[k]
      i--
      if (d === 1) state = 0
    } else {
      q = '-' + q
      s = subject[j - 1] + s
      const d = dirF[k]
      j--
      if (d === 1) state = 0
    }
  }
  return { score: best, queryStart: i, queryEnd: bi, subjectStart: j, subjectEnd: bj, query: q, subject: s }
}

export interface Difference {
  kind: 'substitution' | 'insertion' | 'deletion'
  /** 1-based positions where the difference starts in each sequence (an insertion: the query bases; a deletion: the subject bases). */
  queryPos: number
  subjectPos: number
  query: string
  subject: string
}

/** The differences an alignment shows, runs of gaps taken as one insertion or deletion. */
export function differences(a: LocalAlignment): Difference[] {
  const out: Difference[] = []
  let qp = a.queryStart
  let sp = a.subjectStart
  let k = 0
  while (k < a.query.length) {
    const qc = a.query[k]
    const sc = a.subject[k]
    if (qc !== '-' && sc !== '-') {
      if (qc !== sc) out.push({ kind: 'substitution', queryPos: qp + 1, subjectPos: sp + 1, query: qc, subject: sc })
      qp++
      sp++
      k++
    } else if (sc === '-') {
      let ins = ''
      const start = qp
      while (k < a.query.length && a.subject[k] === '-') {
        ins += a.query[k]
        qp++
        k++
      }
      out.push({ kind: 'insertion', queryPos: start + 1, subjectPos: sp, query: ins, subject: '' })
    } else {
      let del = ''
      const start = sp
      while (k < a.query.length && a.query[k] === '-') {
        del += a.subject[k]
        sp++
        k++
      }
      out.push({ kind: 'deletion', queryPos: qp, subjectPos: start + 1, query: '', subject: del })
    }
  }
  return out
}

/** Share of aligned columns that match (0..1), and share of the query aligned. */
export function identity(a: LocalAlignment): number {
  let same = 0
  for (let k = 0; k < a.query.length; k++) if (a.query[k] === a.subject[k] && a.query[k] !== '-') same++
  return a.query.length ? same / a.query.length : 0
}

export interface Consequence {
  difference: Difference
  /** The codon (1-based) of the coding sequence where it starts; undefined outside it. */
  codon?: number
  effect: 'silent' | 'missense' | 'nonsense' | 'frameshift' | 'in-frame-deletion' | 'in-frame-insertion' | 'non-coding'
  /** E.g. "Leu69Pro", "frameshift at codon 290, stop after 12 altered residues", "in-frame loss of Arg291". */
  description: string
}

/** Where a difference falls in a coding sequence (0-based offset; an insertion's is the base it goes before). */
function offsetIn(d: Difference, start: number): number {
  return d.kind === 'insertion' ? d.subjectPos - start : d.subjectPos - 1 - start
}

/** A coding sequence with some of the differences made in it. */
function mutate(ref: string, diffs: Difference[], start: number): string {
  // From the 3′ end back, so earlier offsets stay valid.
  let s = ref
  for (const d of [...diffs].sort((a, b) => offsetIn(b, start) - offsetIn(a, start))) {
    const at = offsetIn(d, start)
    if (at < 0 || at > s.length) continue
    if (d.kind === 'substitution') s = s.slice(0, at) + d.query + s.slice(at + 1)
    else if (d.kind === 'deletion') s = s.slice(0, at) + s.slice(at + d.subject.length)
    else s = s.slice(0, at) + d.query + s.slice(at)
  }
  return s
}

/** The protein up to its first stop. */
const protein = (cds: string) => {
  const p = translate(cds)
  const stop = p.indexOf('*')
  return stop < 0 ? p : p.slice(0, stop)
}

/**
 * What the differences do to a coding sequence in the subject (`cds`: 0-based start and end
 * exclusive, forward strand), one by one: substitutions in the same codon are read together (CCC
 * from CTC by two changes is one codon, TCC); an insertion or deletion alone is a frameshift (with
 * the residues it changes before a stop) or an in-frame gain or loss. See `proteinChange` for what
 * they do together.
 */
export function consequences(subject: string, diffs: Difference[], cds: [number, number]): Consequence[] {
  const [start, end] = cds
  const ref = subject.slice(start, end)
  // Proteins are read on past the coding sequence's end: a shifted frame stops wherever it meets a stop.
  const full = subject.slice(start)
  const p0 = protein(full)
  return diffs.map((d) => {
    const at = offsetIn(d, start)
    if (at < 0 || at >= end - start) return { difference: d, effect: 'non-coding', description: 'outside the coding sequence' }
    const codon = Math.floor(at / 3) + 1
    if (d.kind === 'substitution') {
      const c0 = (codon - 1) * 3
      const same = diffs.filter((x) => x.kind === 'substitution' && Math.floor(offsetIn(x, start) / 3) === codon - 1)
      const before = ref.slice(c0, c0 + 3)
      const after = mutate(ref, same, start).slice(c0, c0 + 3)
      const a0 = codonToAmino(before)
      const a1 = codonToAmino(after)
      const effect = a0 === a1 ? 'silent' : a1 === '*' ? 'nonsense' : 'missense'
      return { difference: d, codon, effect, description: effect === 'silent' ? `${threeLetter(a0)}${codon} unchanged (${before}→${after})` : `${threeLetter(a0)}${codon}${threeLetter(a1)} (${before}→${after})` }
    }
    const len = d.kind === 'deletion' ? d.subject.length : d.query.length
    const mutant = mutate(ref, [d], start)
    if (len % 3 === 0) {
      const effect = d.kind === 'deletion' ? 'in-frame-deletion' : 'in-frame-insertion'
      // The residues round it, from the codon before, in each: one or more fewer (or more) in the mutant.
      const shift = (d.kind === 'deletion' ? -len : len) / 3
      const seg = (p: string, n: number) => p.slice(Math.max(0, codon - 2), codon + 4 + n).split('').map(threeLetter).join('-')
      return { difference: d, codon, effect, description: `in-frame ${d.kind === 'deletion' ? 'loss' : 'gain'} of ${len / 3} codon${len > 3 ? 's' : ''} at codon ${codon}: …${seg(translate(ref), 0)}… becomes …${seg(translate(mutant), shift)}…` }
    }
    // The shifted reading frame: residues that differ, then a stop.
    const p1 = protein(mutate(full, [d], start))
    let first = 0
    while (first < p1.length && p1[first] === p0[first]) first++
    const altered = p1.length - first
    return { difference: d, codon, effect: 'frameshift', description: `${d.kind === 'deletion' ? `−${len}` : `+${len}`} frameshift at codon ${codon}: the protein changes from residue ${first + 1}${altered > 0 ? ` and stops after ${altered} altered residue${altered === 1 ? '' : 's'}` : ', where it stops'}` }
  })
}

export interface ProteinChange {
  effect: 'unchanged' | 'substituted' | 'truncated' | 'local-change' | 'extended'
  description: string
}

/**
 * What all the differences in a coding sequence do to its protein together: unchanged; residues
 * substituted; cut short by an early stop (a frameshift or nonsense); or changed only locally with
 * the frame restored (an in-frame loss or gain, or two frameshifts that cancel).
 */
export function proteinChange(subject: string, diffs: Difference[], cds: [number, number]): ProteinChange {
  const [start, end] = cds
  const full = subject.slice(start)
  const inside = diffs.filter((d) => offsetIn(d, start) >= 0 && offsetIn(d, start) < end - start)
  const p0 = protein(full)
  const p1 = protein(mutate(full, inside, start))
  if (p1 === p0) return { effect: 'unchanged', description: inside.length ? 'the protein is unchanged' : 'no change in the coding sequence' }
  let first = 0
  while (first < Math.min(p0.length, p1.length) && p0[first] === p1[first]) first++
  // The last residues that differ, counted from the ends.
  let tail = 0
  while (tail < Math.min(p0.length, p1.length) - first && p0[p0.length - 1 - tail] === p1[p1.length - 1 - tail]) tail++
  const from0 = p0.slice(first, p0.length - tail)
  const from1 = p1.slice(first, p1.length - tail)
  const three = (p: string) => (p.length ? p.split('').map(threeLetter).join('-') : 'nothing')
  if (p1.length < p0.length && tail === 0) return { effect: 'truncated', description: `the protein stops at residue ${p1.length + 1} instead of ${p0.length + 1}${p1.length > first ? `, with residues ${first + 1}–${p1.length} altered` : ''}` }
  // Substitutions alone change residues; insertions and deletions that keep the frame change a stretch.
  if (p1.length === p0.length && inside.every((d) => d.kind === 'substitution')) {
    const changes = [...from0].map((a, i) => (a === from1[i] ? '' : `${threeLetter(a)}${first + 1 + i}${threeLetter(from1[i])}`)).filter(Boolean)
    if (changes.length <= 3) return { effect: 'substituted', description: changes.join(', ') }
  }
  if (p1.length > p0.length && tail === 0) return { effect: 'extended', description: `the protein runs on past its stop, to ${p1.length} residues` }
  return { effect: 'local-change', description: `residues ${first + 1}–${p0.length - tail} (${three(from0)}) become ${three(from1)}; the rest of the protein is in frame and unchanged` }
}

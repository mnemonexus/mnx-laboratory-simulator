// Mendelian genetics of a sexually reproducing animal (contract genetics.mendelian, T1): flies in a
// vial carry two copies of each chromosome (one X in a male, with a Y), each holding alleles at loci
// at map positions (cM). A parent passes on one copy of each chromosome, crossing over between two
// loci with probability equal to their distance / 100 (to at most 0.5; none in males where the
// species says so, as in Drosophila), so loci on different chromosomes assort independently. Once a
// vial has held both sexes for a generation's time, each female leaves a brood of offspring drawn at
// random from the parents' gametes; they are kept apart from the parents, as when the parents are
// cleared before the progeny emerge. A phenotype shows each locus's dominant allele.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { GeneticsDef } from '../catalogue/types.ts'
import type { Contents, Flies } from '../kernel/state.ts'
import { createRng } from '../rng/rng.ts'

export type Haplotype = Record<string, string>
/** One fly's genotype: for each chromosome, its two copies (a male's second X copy is the Y, null). */
export type Genotype = Record<string, [Haplotype, Haplotype | null]>

const WILD = '+'

/** The species' genetics (from the substance that declares it). */
export function geneticsOf(cat: Catalogue, species: string): GeneticsDef | undefined {
  return cat.substances.get(species)?.genetics
}

/** The chromosomes of a species and their loci in map order. */
function chromosomes(g: GeneticsDef): Map<string, Array<{ id: string; position: number }>> {
  const out = new Map<string, Array<{ id: string; position: number }>>()
  for (const l of g.loci) {
    const list = out.get(l.chromosome) ?? []
    list.push({ id: l.id, position: l.position })
    out.set(l.chromosome, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.position - b.position)
  return out
}

/** A strain's genotype (homozygous, the sex chromosome hemizygous in males), wild type where it says nothing. */
export function strainGenotype(g: GeneticsDef, alleles: Record<string, string>, sex: 'female' | 'male'): Genotype {
  const out: Genotype = {}
  for (const [chrom, loci] of chromosomes(g)) {
    const hap: Haplotype = {}
    for (const l of loci) hap[l.id] = alleles[l.id] ?? WILD
    out[chrom] = [hap, chrom === g.sexChromosome && sex === 'male' ? null : { ...hap }]
  }
  return out
}

/** A stable key for a genotype and sex (copies of each chromosome in a fixed order). */
export function genotypeKey(sex: 'female' | 'male', gt: Genotype): string {
  const parts = Object.keys(gt).sort().map((c) => {
    const [a, b] = gt[c]
    const hs = [a, b].map((h) => (h ? Object.keys(h).sort().map((k) => `${k}=${h[k]}`).join(',') : 'Y'))
    return `${c}:${hs.sort().join('/')}`
  })
  return `${sex}|${parts.join(';')}`
}

export function parseKey(key: string): { sex: 'female' | 'male'; genotype: Genotype } {
  const [sex, rest] = key.split('|') as ['female' | 'male', string]
  const genotype: Genotype = {}
  for (const part of rest ? rest.split(';') : []) {
    const [c, haps] = part.split(':')
    const [a, b] = haps.split('/').map((h) => (h === 'Y' ? null : Object.fromEntries(h.split(',').filter(Boolean).map((kv) => kv.split('=') as [string, string]))))
    genotype[c] = [a ?? b!, a ? b : null]
  }
  return { sex, genotype }
}

/** The gametes a fly makes, with their probabilities (a male's Y-bearing ones carry no X loci). */
function gametes(g: GeneticsDef, sex: 'female' | 'male', gt: Genotype): Array<{ p: number; chroms: Record<string, Haplotype | null> }> {
  let out: Array<{ p: number; chroms: Record<string, Haplotype | null> }> = [{ p: 1, chroms: {} }]
  const recombines = sex === 'female' || g.maleRecombination !== false
  for (const [chrom, loci] of chromosomes(g)) {
    const [a, b] = gt[chrom]
    let options: Array<{ p: number; hap: Haplotype | null }>
    if (!b) options = [{ p: 0.5, hap: a }, { p: 0.5, hap: null }]
    else {
      // Walk along the chromosome from either copy, switching copy with each crossover.
      options = []
      for (const start of [a, b]) {
        let paths: Array<{ p: number; hap: Haplotype; on: Haplotype }> = [{ p: 0.5, hap: {}, on: start }]
        loci.forEach((l, i) => {
          if (i > 0 && recombines) {
            const r = Math.min(0.5, (l.position - loci[i - 1].position) / 100)
            paths = paths.flatMap((x) => [{ ...x, p: x.p * (1 - r) }, { ...x, p: x.p * r, on: x.on === a ? b : a }])
          }
          for (const x of paths) x.hap = { ...x.hap, [l.id]: x.on[l.id] }
        })
        for (const x of paths) if (x.p > 0) options.push({ p: x.p, hap: x.hap })
      }
    }
    out = out.flatMap((gm) => options.map((o) => ({ p: gm.p * o.p, chroms: { ...gm.chroms, [chrom]: o.hap } })))
  }
  return out
}

/** The probability of each offspring (key) from random mating among the adults. */
export function offspringDistribution(g: GeneticsDef, adults: Record<string, number>): Map<string, number> {
  const pool = (sex: 'female' | 'male') => {
    const total = Object.entries(adults).filter(([k]) => k.startsWith(`${sex}|`)).reduce((a, [, n]) => a + n, 0)
    const out: Array<{ p: number; chroms: Record<string, Haplotype | null> }> = []
    for (const [k, n] of Object.entries(adults)) {
      if (!k.startsWith(`${sex}|`) || !(n > 0)) continue
      const { genotype } = parseKey(k)
      for (const gm of gametes(g, sex, genotype)) out.push({ p: (gm.p * n) / total, chroms: gm.chroms })
    }
    return out
  }
  const eggs = pool('female')
  const sperm = pool('male')
  const dist = new Map<string, number>()
  for (const e of eggs) {
    for (const s of sperm) {
      const gt: Genotype = {}
      let male = false
      for (const chrom of Object.keys(e.chroms)) {
        const fromMum = e.chroms[chrom]!
        const fromDad = s.chroms[chrom]
        if (chrom === g.sexChromosome && !fromDad) male = true
        gt[chrom] = [fromMum, fromDad ?? null]
      }
      const key = genotypeKey(male ? 'male' : 'female', gt)
      dist.set(key, (dist.get(key) ?? 0) + e.p * s.p)
    }
  }
  return dist
}

/** What a fly looks like, as it is scored: the mutant traits it shows (or "wild type"). */
export function phenotype(g: GeneticsDef, key: string): string {
  const { genotype } = parseKey(key)
  const traits: string[] = []
  for (const l of g.loci) {
    const [a, b] = genotype[l.chromosome]
    const alleles = [a[l.id], b ? b[l.id] : undefined].filter((x): x is string => x !== undefined)
    const mutant = alleles.filter((x) => x !== WILD).length
    // Recessive: shows only with no wild copy (one copy in a hemizygous male); dominant: with one.
    if (l.dominant ? mutant > 0 : mutant === alleles.length) traits.push(l.mutantTrait)
  }
  return traits.length ? traits.join(', ') : 'wild type'
}

export function sexOf(key: string): 'female' | 'male' {
  return key.startsWith('male|') ? 'male' : 'female'
}

/**
 * Time passing for flies in a vial: once both sexes have been together for a generation, the
 * females' broods emerge (sampled from the offspring distribution) as the vial's progeny.
 */
export function breed(cat: Catalogue, seed: number, vialId: string, contents: Contents, nowS: number, dt: number): void {
  const f = contents.flies as Flies
  const species = f.species
  const g = geneticsOf(cat, species)
  if (!g) return
  const females = Object.entries(f.adults).filter(([k]) => k.startsWith('female|')).reduce((a, [, n]) => a + n, 0)
  const males = Object.entries(f.adults).filter(([k]) => k.startsWith('male|')).reduce((a, [, n]) => a + n, 0)
  if (!(females > 0 && males > 0) || f.bredAtS !== undefined) return
  // Development runs at the species' pace at its reference temperature, slower when colder (Q10 2).
  const rate = Math.pow(2, (contents.temperatureK - 298.15) / 10)
  f.developedS = (f.developedS ?? 0) + dt * rate
  if (f.developedS < g.generationDays * 86400) return
  const dist = offspringDistribution(g, f.adults)
  const rng = createRng(`${seed}|brood|${vialId}|${Math.round(nowS)}`)
  // Each female's brood: Poisson about the species' mean; then each offspring drawn from the distribution.
  let n = 0
  for (let i = 0; i < females; i++) n += rng.poisson(g.brood)
  const keys = [...dist.keys()]
  const cum: number[] = []
  let acc = 0
  for (const k of keys) cum.push((acc += dist.get(k)!))
  const progeny: Record<string, number> = {}
  for (let i = 0; i < n; i++) {
    const u = rng.next() * acc
    let j = cum.findIndex((c) => u < c)
    if (j < 0) j = keys.length - 1
    progeny[keys[j]] = (progeny[keys[j]] ?? 0) + 1
  }
  f.progeny = progeny
  f.bredAtS = nowS
}

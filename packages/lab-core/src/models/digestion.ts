// Restriction digestion (contract cleavage.restriction, T2): each enzyme cuts the sites its
// substrates declare, with Michaelis–Menten kinetics in sites and an activity set by its units.
// It needs its metal cofactor (Mg²⁺) free of chelators, so a buffer is required and EDTA (in
// loading dye) stops it; above its optimum the enzyme only unfolds (its stability declares a Tm).
// Sites are cut independently, so a partial digest is a mixture whose fragments follow from the
// share of each site that is cut: the gel shows the extra, longer bands of an incomplete digest.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Contents, Layer } from '../kernel/state.ts'
import { activeAmount } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'

const K0 = 273.15
/** Km for a recognition site (mol/L). */
const KM_SITES = 2e-9
/**
 * The unit definition: 1 U cuts 1 µg of λ DNA (48 502 bp, five EcoRI sites) completely (99 %) in
 * 1 h at the optimum in 50 µL. With Michaelis–Menten kinetics that needs a Vmax of
 * (S₀ + Km ln 100) × 50 µL per hour, S₀ being λ's site concentration.
 */
const LAMBDA_SITES_MOL = (5 * 1e-6) / (48502 * 650)
const VMAX_PER_UNIT = (LAMBDA_SITES_MOL + KM_SITES * 50e-6 * Math.log(100)) / 3600
/** Below the optimum activity halves every 10 °C. */
const Q10 = 2
/** Half-saturating free cofactor (mol/L). */
const COFACTOR_HALF = 1e-3

interface Enzyme {
  id: string
  unitsPerMol: number
  cofactor: string
  optimumK: number
}

interface Params {
  enzymes: Enzyme[]
  /** Substances with sites, by enzyme. */
  substrates: Map<string, Array<{ substance: string; positions: number[] }>>
  chelators: Map<string, string[]>
}

const cache = new WeakMap<Catalogue, Params>()

function params(cat: Catalogue): Params {
  const hit = cache.get(cat)
  if (hit) return hit
  const enzymes: Enzyme[] = []
  const substrates = new Map<string, Array<{ substance: string; positions: number[] }>>()
  const chelators = new Map<string, string[]>()
  for (const s of cat.substances.values()) {
    if (s.restriction) {
      const mm = s.physical?.molarMass ? parseValue(s.physical.molarMass).si * 1000 : 30000
      enzymes.push({
        id: s.id,
        unitsPerMol: s.restriction.unitsPerMg * mm * 1000,
        cofactor: s.restriction.cofactor,
        optimumK: s.restriction.optimum ? parseValue(s.restriction.optimum).si : 37 + K0,
      })
    }
    for (const [enzyme, positions] of Object.entries(s.dna?.sites ?? {})) {
      if (!positions.length) continue
      const list = substrates.get(enzyme) ?? []
      list.push({ substance: s.id, positions })
      substrates.set(enzyme, list)
    }
    if (s.chelates?.length) chelators.set(s.id, s.chelates)
  }
  const out = { enzymes, substrates, chelators }
  cache.set(cat, out)
  return out
}

export const siteKey = (substance: string, enzyme: string, position: number) => `${substance}|${enzyme}|${position}`

/** Free cofactor (mol/L): what the chelators present have not bound. */
function freeCofactor(layer: Layer, p: Params, cofactor: string): number {
  let n = layer.species[cofactor] ?? 0
  for (const [chelator, binds] of p.chelators) if (binds.includes(cofactor)) n -= layer.species[chelator] ?? 0
  return Math.max(0, n) / layer.volumeL
}

/** Digest for dt seconds at temperature T: every enzyme present cuts its uncut sites. */
export function digest(cat: Catalogue, layer: Layer, T: number, dt: number): void {
  const p = params(cat)
  if (p.enzymes.length === 0 || layer.volumeL <= 0) return
  for (const e of p.enzymes) {
    const units = activeAmount(layer, e.id) * e.unitsPerMol
    if (!(units > 0)) continue
    const sites = (p.substrates.get(e.id) ?? []).filter((x) => (layer.species[x.substance] ?? 0) > 0)
    if (!sites.length) continue
    const mg = freeCofactor(layer, p, e.cofactor)
    const fT = T >= e.optimumK ? 1 : Math.pow(Q10, (T - e.optimumK) / 10)
    const vmax = units * VMAX_PER_UNIT * fT * (mg / (mg + COFACTOR_HALF))
    if (!(vmax > 0)) continue
    // Uncut sites (mol), all competing for the enzyme.
    const uncut: Array<{ key: string; n: number }> = []
    for (const x of sites) {
      const total = layer.species[x.substance]
      for (const pos of x.positions) {
        const key = siteKey(x.substance, e.id, pos)
        uncut.push({ key, n: Math.max(0, total - (layer.cut?.[key] ?? 0)) })
      }
    }
    let s = uncut.reduce((a, u) => a + u.n, 0)
    if (!(s > 0)) continue
    // Integrated Michaelis–Menten in sub-steps (mol, over the layer's volume).
    const km = KM_SITES * layer.volumeL
    const s0 = s
    let t = 0
    while (t < dt - 1e-12 && s > 1e-30) {
      const h = Math.min(dt - t, Math.max(0.01, (0.05 * (s + km)) / vmax))
      s = Math.max(0, s - (vmax * s * h) / (km + s))
      t += h
    }
    const share = s0 > 0 ? 1 - s / s0 : 0
    if (!(share > 0)) continue
    layer.cut ??= {}
    for (const u of uncut) layer.cut[u.key] = (layer.cut[u.key] ?? 0) + u.n * share
  }
}

export type DnaForm = 'linear' | 'supercoiled' | 'open-circle'

export interface DnaPiece {
  key: string
  /** True length (bp) and the length it runs alongside in a gel. */
  bp: number
  apparentBp: number
  form: DnaForm
  ng: number
}

/** A supercoiled plasmid runs ahead of its linear length, a nicked one behind it (1 % agarose). */
const SUPERCOILED_APPARENT = 0.65
const OPEN_CIRCLE_APPARENT = 1.7
const NICKED_DEFAULT = 0.1
const NG_PER_MOL_BP = 650 * 1e9

/**
 * The pieces of one DNA substance (mol in total) given the cut share of each site: with sites cut
 * independently, a fragment between two cuts with every site between them uncut has abundance
 * p_a p_b Π(1 − p_k). A circle with no cut stays circular; one with one cut is full-length linear.
 */
export function piecesOf(cat: Catalogue, substance: string, mol: number, cut: Record<string, number>): DnaPiece[] {
  const dna = cat.substances.get(substance)?.dna
  const length = dna?.lengthBp
  if (!dna || !length || !(mol > 0)) return []
  const sites: Array<{ pos: number; p: number }> = []
  for (const [enzyme, positions] of Object.entries(dna.sites ?? {})) {
    for (const pos of positions) sites.push({ pos, p: Math.min(1, Math.max(0, (cut[siteKey(substance, enzyme, pos)] ?? 0) / mol)) })
  }
  sites.sort((a, b) => a.pos - b.pos)
  const circular = dna.topology === 'circular'
  const out: DnaPiece[] = []
  const add = (key: string, bp: number, form: DnaForm, share: number) => {
    if (!(share > 1e-9) || bp <= 0) return
    const apparentBp = form === 'supercoiled' ? bp * SUPERCOILED_APPARENT : form === 'open-circle' ? bp * OPEN_CIRCLE_APPARENT : bp
    const existing = out.find((x) => x.key === key)
    const ng = mol * share * bp * NG_PER_MOL_BP
    if (existing) existing.ng += ng
    else out.push({ key, bp, apparentBp, form, ng })
  }
  const live = sites.filter((x) => x.p > 0)
  if (live.length === 0) {
    if (circular) {
      const nicked = dna.nicked ?? NICKED_DEFAULT
      add(`${substance}#sc`, length, 'supercoiled', 1 - nicked)
      add(`${substance}#oc`, length, 'open-circle', nicked)
    } else add(substance, length, 'linear', 1)
    return out
  }
  const uncutBetween = (from: number, to: number, n: number) => {
    // Product of (1 − p) over the sites strictly between indices from and to, going forwards.
    let f = 1
    for (let k = (from + 1) % n; k !== to; k = (k + 1) % n) f *= 1 - live[k].p
    return f
  }
  const n = live.length
  if (circular) {
    const none = live.reduce((a, x) => a * (1 - x.p), 1)
    if (none > 0) {
      const nicked = dna.nicked ?? NICKED_DEFAULT
      add(`${substance}#sc`, length, 'supercoiled', none * (1 - nicked))
      add(`${substance}#oc`, length, 'open-circle', none * nicked)
    }
    for (let i = 0; i < n; i++) {
      // Cut only here: the whole circle opened into one linear piece.
      const others = live.reduce((a, x, k) => (k === i ? a : a * (1 - x.p)), 1)
      add(`${substance}#linear`, length, 'linear', live[i].p * others)
      if (n < 2) continue
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const bp = (live[j].pos - live[i].pos + length) % length
        add(`${substance}#${live[i].pos}-${live[j].pos}`, bp, 'linear', live[i].p * live[j].p * uncutBetween(i, j, n))
      }
    }
    return out
  }
  // Linear: the ends are always "cut".
  const ends = [{ pos: 0, p: 1 }, ...live, { pos: length, p: 1 }]
  for (let i = 0; i < ends.length; i++) {
    let between = 1
    for (let j = i + 1; j < ends.length; j++) {
      add(`${substance}#${ends[i].pos}-${ends[j].pos}`, ends[j].pos - ends[i].pos, 'linear', ends[i].p * ends[j].p * between)
      between *= 1 - ends[j].p
    }
  }
  return out
}

/** The pieces of one DNA substance in some contents (summed over the layers). */
export function digestPieces(cat: Catalogue, c: Contents, substance: string): DnaPiece[] {
  let mol = 0
  const cut: Record<string, number> = {}
  for (const l of c.layers) {
    mol += l.species[substance] ?? 0
    for (const [k, n] of Object.entries(l.cut ?? {})) if (k.startsWith(`${substance}|`)) cut[k] = (cut[k] ?? 0) + n
  }
  return piecesOf(cat, substance, mol, cut)
}

/** Mean share of a substance's sites that are cut (0..1), or null if it has none. */
export function cutShare(cat: Catalogue, c: Contents, substance: string, enzyme?: string): number | null {
  const dna = cat.substances.get(substance)?.dna
  let mol = 0
  for (const l of c.layers) mol += l.species[substance] ?? 0
  const shares: number[] = []
  for (const [e, positions] of Object.entries(dna?.sites ?? {})) {
    if (enzyme && e !== enzyme) continue
    for (const pos of positions) {
      const key = siteKey(substance, e, pos)
      const n = c.layers.reduce((a, l) => a + (l.cut?.[key] ?? 0), 0)
      shares.push(mol > 0 ? Math.min(1, n / mol) : 0)
    }
  }
  return shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : null
}

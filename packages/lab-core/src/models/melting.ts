// Melting point (contract melting-point, T2): the range over which a solid sample melts.
// Impurities that dissolve in the melt depress and broaden it (ideal freezing-point depression,
// ΔT = R·Tm²/ΔHfus · x); salts do not dissolve in an organic melt and stay behind as a residue;
// water in a wet sample acts as a large impurity. The learner sees a range, never a purity.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { type Contents, liquidVolume } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'

const R = 8.314
/** Classes that do not dissolve in an organic melt. */
const INSOLUBLE_IN_MELT = new Set(['salt', 'ion', 'particle', 'matrix'])
/** Water held by a wet sample, mol per litre of liquid. */
const WATER_MOL_PER_L = 55.5
/** The ideal law is only good for small x; beyond this the sample just melts low and broad. */
const X_CAP = 0.15

export interface MeltingRange {
  /** The substance that melts (most of the sample by mass). */
  substance: string
  onsetK: number
  clearK: number
  /** Something that does not melt stays in the capillary. */
  residue: boolean
  wet: boolean
}

/** The true melting range of what is in a container, or undefined if nothing in it melts. */
export function meltingRange(cat: Catalogue, c: Contents): MeltingRange | undefined {
  const mol: Record<string, number> = {}
  for (const [s, n] of Object.entries(c.solid)) if (n > 0) mol[s] = (mol[s] ?? 0) + n
  for (const l of c.layers) for (const [s, n] of Object.entries(l.species)) if (n > 0) mol[s] = (mol[s] ?? 0) + n
  const grams = (s: string) => mol[s] * (cat.substances.get(s)?.physical?.molarMass ? parseValue(cat.substances.get(s)!.physical!.molarMass!).si * 1000 : 0)
  const candidates = Object.keys(mol).filter((s) => cat.substances.get(s)?.physical?.meltingPoint)
  if (candidates.length === 0) return undefined
  const main = candidates.reduce((a, b) => (grams(b) > grams(a) ? b : a))
  const def = cat.substances.get(main)!
  const tm = parseValue(def.physical!.meltingPoint!).si
  const dH = def.physical?.enthalpyOfFusion ? parseValue(def.physical.enthalpyOfFusion).si : 20000
  const mainG = grams(main)
  let impurity = 0
  let insolubleG = 0
  for (const s of Object.keys(mol)) {
    if (s === main || s === 'core:water') continue
    const cls = cat.substances.get(s)?.identity.class
    if (cls && INSOLUBLE_IN_MELT.has(cls)) insolubleG += grams(s)
    else impurity += mol[s]
  }
  const waterMol = liquidVolume(c) * WATER_MOL_PER_L
  const wet = waterMol * 18.015 > 0.01 * mainG
  impurity += waterMol
  const x = Math.min(X_CAP, impurity / (impurity + mol[main]))
  const k = (R * tm * tm) / dH
  const clearK = tm - k * x
  // A pure compound melts over about half a kelvin; impurity broadens the range from below
  // (2 mol % of a soluble impurity: about 2 K low and 3 K wide).
  const onsetK = clearK - (0.5 + 1.5 * k * x)
  return { substance: main, onsetK, clearK, residue: insolubleG > 0.01 * mainG, wet }
}

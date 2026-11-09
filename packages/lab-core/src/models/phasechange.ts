// Melting and freezing (contract heat.phase-change, T2): a solid with a melting point and an
// enthalpy of fusion melts once the contents are warmer than its melting point, and its liquid
// freezes once they are colder, the latent heat holding the temperature at the melting point while
// both phases are there (the plateaus of heating and cooling curves). Ice melts into the water around
// it (its `meltsTo`), whose freezing point dissolved solutes lower by 1.86 K per osmol/kg; a solid
// that melts into itself (stearic acid) forms its own liquid layer and freezes only out of a layer
// that is mostly itself, never out of a solution it is merely dissolved in.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { type Contents, emptyLayer, type Layer } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'
import { molarVolume, waterMol } from './distillation.ts'
import { heatCapacityJK } from './thermochem.ts'
import { osmolarity } from './tissue.ts'

const WATER = 'core:water'
const WATER_L_PER_MOL = 0.018015
/** Water's cryoscopic constant, K kg/mol. */
const KF_WATER = 1.86

interface Fusion {
  meltK: number
  dHJ: number
  /** What it melts into: water, or its own liquid. */
  into: 'water' | 'self'
}

const cache = new WeakMap<Catalogue, Map<string, Fusion>>()

/** Solids that melt and freeze: a melting point, an enthalpy of fusion, and somewhere for the melt to go. */
function fusions(cat: Catalogue): Map<string, Fusion> {
  const hit = cache.get(cat)
  if (hit) return hit
  const out = new Map<string, Fusion>()
  for (const s of cat.substances.values()) {
    const p = s.physical
    if (!p?.meltingPoint || !p.enthalpyOfFusion) continue
    const into = p.meltsTo === WATER ? 'water' : !p.meltsTo && p.density ? 'self' : undefined
    if (!into) continue
    out.set(s.id, { meltK: parseValue(p.meltingPoint).si, dHJ: parseValue(p.enthalpyOfFusion).si, into })
  }
  cache.set(cat, out)
  return out
}

/** Whether anything in the contents can melt or freeze. */
export function canChangePhase(cat: Catalogue, c: Contents): boolean {
  const f = fusions(cat)
  if (f.size === 0) return false
  for (const [s, n] of Object.entries(c.solid)) if (n > 0 && f.has(s)) return true
  for (const fu of f.values()) if (fu.into === 'water' && c.layers.some((l) => l.volumeL > 0) && c.temperatureK < fu.meltK + 0.5) return true
  for (const l of c.layers) for (const s of Object.keys(l.species)) if (f.get(s)?.into === 'self') return true
  return false
}

/** Water's freezing point under the solutes of a layer. */
function waterFreezingK(cat: Catalogue, meltK: number, layer: Layer | undefined): number {
  return layer ? meltK - KF_WATER * osmolarity(cat, layer) : meltK
}

/** A layer that is mostly this substance (its melt), if there is one. */
function meltLayer(cat: Catalogue, c: Contents, s: string): Layer | undefined {
  return c.layers.find((l) => l.volumeL > 0 && (l.species[s] ?? 0) * molarVolume(cat, s) > 0.5 * l.volumeL)
}

/** Bring melting and freezing to balance with the contents' heat: the latent heat sets the temperature back towards the melting point. */
export function phaseChange(cat: Catalogue, c: Contents): void {
  const f = fusions(cat)
  for (const [s, fu] of f) {
    const C = heatCapacityJK(cat, c)
    const bottom = c.layers[c.layers.length - 1]
    if (fu.into === 'water') {
      const meltK = waterFreezingK(cat, fu.meltK, bottom)
      const ice = c.solid[s] ?? 0
      if (c.temperatureK > meltK && ice > 0) {
        // Ice melts, taking its latent heat from the water around it.
        const above = (c.temperatureK - meltK) * C
        const n = Math.min(ice, above / fu.dHJ)
        c.solid[s] = ice - n
        if (bottom) bottom.volumeL += n * WATER_L_PER_MOL
        else c.layers.push({ ...emptyLayer(), volumeL: n * WATER_L_PER_MOL })
        // Energy kept: what was held above the melting point, less the latent heat, over what the contents now hold.
        c.temperatureK = meltK + (above - n * fu.dHJ) / heatCapacityJK(cat, c)
      } else if (c.temperatureK < meltK && bottom && bottom.volumeL > 0) {
        // Water freezes, giving out its latent heat; what is dissolved stays in what is left.
        const below = (meltK - c.temperatureK) * C
        const n = Math.min(waterMol(cat, bottom) * 0.98, below / fu.dHJ)
        if (!(n > 0)) continue
        bottom.volumeL -= n * WATER_L_PER_MOL
        c.solid[s] = (c.solid[s] ?? 0) + n
        c.temperatureK = meltK - (below - n * fu.dHJ) / heatCapacityJK(cat, c)
      }
      continue
    }
    const solid = c.solid[s] ?? 0
    if (c.temperatureK > fu.meltK && solid > 0) {
      // A solid that melts into its own liquid layer.
      const above = (c.temperatureK - fu.meltK) * C
      const n = Math.min(solid, above / fu.dHJ)
      c.solid[s] = solid - n
      const layer = meltLayer(cat, c, s)
      if (layer) {
        layer.species[s] = (layer.species[s] ?? 0) + n
        layer.volumeL += n * molarVolume(cat, s)
      } else c.layers.unshift({ ...emptyLayer(), volumeL: n * molarVolume(cat, s), species: { [s]: n } })
      c.temperatureK = fu.meltK + (above - n * fu.dHJ) / heatCapacityJK(cat, c)
    } else if (c.temperatureK < fu.meltK) {
      const layer = meltLayer(cat, c, s)
      const liquid = layer?.species[s] ?? 0
      if (!layer || !(liquid > 0)) continue
      // Its melt freezes, the latent heat holding the temperature at the melting point.
      const below = (fu.meltK - c.temperatureK) * C
      const n = Math.min(liquid, below / fu.dHJ)
      layer.species[s] = liquid - n
      layer.volumeL = Math.max(0, layer.volumeL - n * molarVolume(cat, s))
      c.solid[s] = (c.solid[s] ?? 0) + n
      c.temperatureK = fu.meltK - (below - n * fu.dHJ) / heatCapacityJK(cat, c)
    }
  }
  c.layers = c.layers.filter((l) => l.volumeL > 1e-12 || Object.values(l.species).some((n) => n > 0))
}

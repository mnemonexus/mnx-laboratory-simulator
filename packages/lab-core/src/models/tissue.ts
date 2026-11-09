// Plant tissue in a liquid (contract membranes.tissue, T2): pieces of tissue (potato cylinders,
// beetroot discs) take up or lose water by the difference in water potential between their cells
// and the liquid, and leak their pigment once heat or a solvent has damaged their membranes.
// - The cells' water potential is turgor minus their sap's osmotic pressure. Turgor rises linearly
//   with the water above incipient plasmolysis (the wall's modulus ε) and is zero below it, where
//   the protoplasts only shrink. The sap's solutes are fixed, so losing water concentrates them.
// - The liquid's osmotic pressure is cRT from everything dissolved in it, each ion of a salt counted.
// - Water moves towards equilibrium with a time constant that grows with the size of a piece
//   (diffusion: as its mass^(2/3)). The water lost or gained comes from the liquid's volume.
// - Membranes are damaged irreversibly above about 50 °C (a steep Arrhenius-like rise) and by
//   organic solvents above a threshold volume fraction (at the midpoint about a tenth of the
//   membranes go each minute); pigment diffuses out of damaged cells over about an hour, out of
//   intact ones over about a week.
// Pieces of one tissue in a vessel are pooled (their mean size kept from the pieces added).
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Contents, Layer, TissueState } from '../kernel/state.ts'
import { liquidVolume } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'

const R = 8.314
const WATER_G_PER_L = 997
/** Molar volume of an organic solvent in water when its own density is not given, L/mol. */
const SOLVENT_MOLAR_L = 0.058

interface TissueModel {
  waterFraction: number
  /** Sap solutes, osmol per g of fresh tissue. */
  osmolPerG: number
  /** Water potential of fresh tissue, MPa (negative). */
  psi0: number
  /** Wall modulus, MPa. */
  modulus: number
  /** Time constant for a 1 g piece, s. */
  tau1g: number
  pigment?: { substance: string; molPerG: number }
  /** Membrane damage: midpoint temperature (K), steepness (K per e-fold), solvents and their damaging volume fraction. */
  tmK: number
  widthK: number
  solvents: Record<string, number>
}

function model(cat: Catalogue, substance: string): TissueModel | undefined {
  const t = cat.substances.get(substance)?.tissue
  if (!t) return undefined
  const waterFraction = t.water
  return {
    waterFraction,
    osmolPerG: (t.osmolality * waterFraction) / 1000,
    psi0: t.waterPotential,
    modulus: t.modulus ?? 5,
    tau1g: t.exchangeTime ? parseValue(t.exchangeTime).si : 1800,
    ...(t.pigment ? { pigment: { substance: t.pigment.substance, molPerG: t.pigment.molPerG } } : {}),
    tmK: t.membranes?.tm ? parseValue(t.membranes.tm).si : 333,
    widthK: t.membranes?.width ?? 4,
    solvents: t.membranes?.solvents ?? {},
  }
}

/** New pieces of fresh tissue: their state, for `grams` of it. */
export function freshTissue(cat: Catalogue, substance: string, grams: number): TissueState | undefined {
  const m = model(cat, substance)
  if (!m) return undefined
  return { dryG: grams * (1 - m.waterFraction), osmol: grams * m.osmolPerG, damage: 0, pigmentMol: m.pigment ? grams * m.pigment.molPerG : 0, pieceG: grams }
}

/** Move a share of a vessel's tissue (with its state) to another. */
export function moveTissue(from: Contents, to: Contents, substance: string, fraction: number): void {
  const t = from.tissue?.[substance]
  if (!t || !(fraction > 0)) return
  const f = Math.min(1, fraction)
  const moved: TissueState = { dryG: t.dryG * f, osmol: t.osmol * f, damage: t.damage, pigmentMol: t.pigmentMol * f, pieceG: t.pieceG }
  addTissue(to, substance, moved)
  t.dryG -= moved.dryG
  t.osmol -= moved.osmol
  t.pigmentMol -= moved.pigmentMol
  if (f >= 1) delete from.tissue![substance]
}

/** Pool tissue into a vessel's: the damage is the mass-weighted mean. */
export function addTissue(c: Contents, substance: string, add: TissueState): void {
  const t = (c.tissue ??= {})[substance]
  if (!t) {
    c.tissue[substance] = { ...add }
    return
  }
  const w = t.dryG + add.dryG
  t.damage = w > 0 ? (t.damage * t.dryG + add.damage * add.dryG) / w : 0
  t.dryG = w
  t.osmol += add.osmol
  t.pigmentMol += add.pigmentMol
  t.pieceG = add.pieceG
}

/** Osmolarity of a liquid layer (osmol/L): every dissolved species, a salt counted by its ions. */
export function osmolarity(cat: Catalogue, layer: Layer): number {
  if (!(layer.volumeL > 0)) return 0
  let osm = 0
  for (const [s, n] of Object.entries(layer.species)) {
    if (!(n > 0) || s === 'core:water') continue
    const def = cat.substances.get(s)
    if (def?.physical?.phase === 'liquid' && def.identity.class === 'solvent') continue
    const ions = def?.ions ? Object.values(def.ions).reduce((a, k) => a + k, 0) : 0
    const spectators = def?.acidBase?.spectator ?? 0
    osm += n * (ions > 0 ? ions : 1 + spectators)
  }
  return osm / layer.volumeL
}

/** The water at which the cells just lose turgor (incipient plasmolysis), g. */
function plasmolysisWaterG(m: TissueModel, t: TissueState, T: number): number {
  const w0 = (t.dryG / (1 - m.waterFraction)) * m.waterFraction
  const pi0 = ((t.osmol / (w0 / 1000)) * R * T) / 1000
  return w0 / (1 + Math.max(0, pi0 + m.psi0) / m.modulus)
}

/** The cells' water potential (MPa) holding `waterG` of water. */
function cellPsi(m: TissueModel, t: TissueState, waterG: number, T: number): number {
  const wp = plasmolysisWaterG(m, t, T)
  const pressure = waterG > wp ? (m.modulus * (waterG - wp)) / wp : 0
  const pi = (t.osmol / (Math.max(waterG, 1e-6) / 1000)) * R * T / 1000
  return pressure - pi
}

/** The water each tissue would hold at equilibrium with ψ outside. */
function equilibriumWaterG(m: TissueModel, t: TissueState, psiOut: number, T: number): number {
  const fresh = t.dryG / (1 - m.waterFraction)
  let lo = fresh * m.waterFraction * 0.05
  let hi = fresh * m.waterFraction * 3
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (cellPsi(m, t, mid, T) > psiOut) hi = mid
    else lo = mid
  }
  return (lo + hi) / 2
}

/** Time passing for the tissue in a vessel: water exchange, membrane damage and pigment leakage. */
export function tissueStep(cat: Catalogue, c: Contents, dt: number): void {
  if (!c.tissue) return
  const volume = liquidVolume(c)
  const layer = c.layers[c.layers.length - 1]
  const T = c.temperatureK
  for (const [substance, t] of Object.entries(c.tissue)) {
    const m = model(cat, substance)
    const grams = c.solid[substance] ?? 0
    if (!m || !(grams > 0) || !(t.dryG > 0)) continue
    const waterG = grams - t.dryG
    if (volume > 0 && layer) {
      // Water exchange with the liquid the pieces lie in (a damaged membrane no longer holds solutes, so turgor is lost).
      const psiOut = -(osmolarity(cat, layer) * R * T) / 1000
      const intact = 1 - t.damage
      const target = intact * equilibriumWaterG(m, t, psiOut, T) + (1 - intact) * Math.min(waterG, plasmolysisWaterG(m, t, T))
      const tau = m.tau1g * Math.pow(Math.max(t.pieceG, 0.05), 2 / 3)
      let dW = (target - waterG) * (1 - Math.exp(-dt / tau))
      // Water taken up comes out of the liquid (never more than there is).
      if (dW > 0) dW = Math.min(dW, layer.volumeL * WATER_G_PER_L * 0.9)
      c.solid[substance] = grams + dW
      layer.volumeL = Math.max(0, layer.volumeL - dW / WATER_G_PER_L)
    }
    // Membranes: heat above the midpoint and solvents above their threshold damage them for good.
    let k = Math.exp((T - m.tmK) / m.widthK) / 600
    if (layer && volume > 0) {
      for (const [solvent, threshold] of Object.entries(m.solvents)) {
        const n = layer.species[solvent] ?? 0
        const fraction = (n * solventMolarL(cat, solvent)) / layer.volumeL
        if (fraction > threshold) k += ((fraction - threshold) / threshold) ** 2 / 60
      }
    }
    t.damage = 1 - (1 - t.damage) * Math.exp(-k * dt)
    // Pigment diffuses out of damaged cells over about an hour (out of a whole piece), from intact ones over about a week.
    if (m.pigment && t.pigmentMol > 0 && layer && volume > 0) {
      const kLeak = 1 / 604800 + t.damage / 3600
      const out = t.pigmentMol * (1 - Math.exp(-kLeak * dt))
      t.pigmentMol -= out
      layer.species[m.pigment.substance] = (layer.species[m.pigment.substance] ?? 0) + out
    }
  }
}

/**
 * The share of a tissue's cells that are plasmolysed in a vessel's liquid (seen on a wet mount):
 * a cell plasmolyses when the liquid's osmotic pressure exceeds its sap's at incipient plasmolysis.
 * Cells differ (a spread of about 15 % in their sap), so the share rises over a range of
 * concentrations and is a half at the mean.
 */
export function plasmolysedShare(cat: Catalogue, substance: string, c: { contents: Contents }): number {
  const m = model(cat, substance)
  const layer = c.contents.layers[c.contents.layers.length - 1]
  if (!m || !layer || !(layer.volumeL > 0)) return 0
  const T = c.contents.temperatureK
  const pi0 = (m.osmolPerG / m.waterFraction) * 1000 * R * T / 1000
  const piP = pi0 * (1 + Math.max(0, pi0 + m.psi0) / m.modulus)
  const piOut = (osmolarity(cat, layer) * R * T) / 1000
  const z = (piOut - piP) / (0.15 * piP)
  return 1 / (1 + Math.exp(-1.7 * z))
}

function solventMolarL(cat: Catalogue, s: string): number {
  const p = cat.substances.get(s)?.physical
  if (p?.density && p.molarMass) return (parseValue(p.molarMass).si / parseValue(p.density).si) * 1000
  return SOLVENT_MOLAR_L
}

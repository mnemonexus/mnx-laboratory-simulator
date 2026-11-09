// Bench operations (composition model §5; master-plan/04 §3). Each refuses only the physically
// impossible; unwise actions are carried out and their consequences flow from the state.
import { advance } from '../models/processes.ts'
import { contentsMassKg } from './materials.ts'
import { oilContact, observeSlide } from './ops-microscope.ts'
import { readSequence } from './ops-sequence.ts'
import { inspect } from './ops-micro.ts'
import { rimContact } from '../models/contamination.ts'
import { meltingRange } from '../models/melting.ts'
import { gellingAgent } from '../models/gelling.ts'
import { dissolveShares, samePhase } from '../models/phases.ts'
import { gasParams, headspaceAir, headspaceL, OXYGEN, oxygenSaturation, relaxOxygen } from '../models/gases.ts'
import { measureDissolvedOxygen } from './ops-atmosphere.ts'
import { bandText, irSpectrum } from '../models/infrared.ts'
import { esiSpectrum, type Polarity } from '../models/massspec.ts'
import { emissionSpectrum } from '../models/fluorescence.ts'
import { backgroundLawn, coloniesOn, depositOnSurface, describeSectors, isolatedSector, laidSpots, pelletCells, resuspendCells, sectorCounts, spotOnSurface as spotCells } from '../models/growth.ts'
import { gelMatrix, laneBands } from '../models/electrophoresis.ts'
import { laneSpots } from '../models/tlc.ts'
import { heatCapacityJK, releaseHeat, settledEnthalpyJ } from '../models/thermochem.ts'
import { countSquares } from '../models/counting.ts'
import { addTissue, freshTissue, moveTissue } from '../models/tissue.ts'
import { viscosityMPaS } from '../models/viscosity.ts'
import { DISC_MM, zonesOn } from '../models/discdiffusion.ts'
import { equilibrate, pellet, resuspend, solubilityLimits } from '../models/solubility.ts'
import { ionicEquilibrate } from '../models/ionic.ts'
import { readGasSyringe } from './ops-gas.ts'
import { measureConductivity, measureVoltage } from './ops-electro.ts'
import { measureFilm, measurePressure, readGasSample } from './ops-gaslaws.ts'
import { scoreFlies } from './ops-genetics.ts'
import { countChamberAnimals } from './ops-behaviour.ts'
import { balanceSpec, loadKg, observeAbsorbance, observeMass, photometerSpec, sampleAbsorbance, vesselAbsorbance, wellAbsorbance } from '../models/measurement.ts'
import { parseQuantity, parseValue } from '../units/quantity.ts'
import { type OpContext, type OpImpl, type OpResult, refId } from './kernel.ts'

type Params = Record<string, unknown>
import { labelledFrom, layerFrom, molarMass, preparationComponents } from './materials.ts'
import { createRng } from '../rng/rng.ts'
import { layerPH, layerSpeciation } from '../models/acidbase.ts'
import { addContainer } from './world.ts'
import {
  addInto,
  addOnTop,
  type Container,
  type Contents,
  drawFromTop,
  drawProportional,
  emptyLayer,
  homogeneity,
  type Layer,
  liquidVolume,
  meanLayer,
  type InstrumentState,
  type MeasurementRecord,
  relaxLayers,
  scaleLayer,
  type ToolState,
} from './state.ts'

const UL = 1e-6

function fmtL(l: number): string {
  if (l < 1e-3) return `${Number((l / UL).toPrecision(4))} µL`
  return `${Number((l * 1000).toPrecision(4))} mL`
}

function toolState(ctx: OpContext, ref: unknown, what: string): { id: string; equipment: string; state: ToolState } {
  const e = ctx.equipment(ref, what)
  if (e.state.kind !== 'tool') ctx.refuse('NOT-A-TOOL', `${e.label} is not a liquid-handling tool`)
  return e as { id: string; equipment: string; state: ToolState }
}

function rangeL(ctx: OpContext, equipment: string): [number, number] | undefined {
  const r = ctx.cat.property(equipment, 'range')
  if (r === undefined) return undefined
  const p = parseQuantity(String(r))
  if (p.kind !== 'range') return undefined
  return [p.lo.si * 1000, p.hi.si * 1000]
}

/** Systematic and random relative errors (fractions) at a volume, interpolated from the tool's table. */
function errorAt(ctx: OpContext, equipment: string, volumeL: number): { sys: number; rand: number } {
  for (const e of ctx.cat.lineage(equipment)) {
    if (!e.errors || e.errors.length === 0) continue
    const pts = e.errors.map((p) => ({ v: parseValue(p.volume).si * 1000, sys: p.systematic / 100, rand: p.random / 100 })).sort((a, b) => a.v - b.v)
    if (volumeL <= pts[0].v) return { sys: pts[0].sys, rand: pts[0].rand }
    if (volumeL >= pts[pts.length - 1].v) return { sys: pts[pts.length - 1].sys, rand: pts[pts.length - 1].rand }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      if (volumeL >= a.v && volumeL <= b.v) {
        // Absolute errors interpolate linearly in volume, as ISO 8655 tables do.
        const f = (volumeL - a.v) / (b.v - a.v)
        const sysAbs = a.sys * a.v + f * (b.sys * b.v - a.sys * a.v)
        const randAbs = a.rand * a.v + f * (b.rand * b.v - a.rand * a.v)
        return { sys: sysAbs / volumeL, rand: randAbs / volumeL }
      }
    }
  }
  const nominal = ctx.cat.property(equipment, 'nominal')
  const tol = ctx.cat.property(equipment, 'tolerance')
  if (nominal !== undefined && tol !== undefined) {
    const rel = parseValue(String(tol)).si / parseValue(String(nominal)).si
    return { sys: rel / 2, rand: rel / 3 }
  }
  return { sys: 0.02, rand: 0.03 }
}

function mergeIntoTop(c: Container, layer: Layer): void {
  if (layer.volumeL <= 0 && Object.keys(layer.species).length === 0) return
  if (c.contents.layers.length === 0) c.contents.layers.push(layer)
  else addInto(c.contents.layers[0], layer, 1)
}

export function addOrigins(to: Container, from: Container): void {
  const set = new Set([...(to.origins ?? []), ...(from.origins ?? [])])
  if (set.size > 0) to.origins = [...set]
}

export function requireOpen(ctx: OpContext, c: Container): void {
  if (!c.open) ctx.refuse('CLOSED', `${c.label} is closed`)
}

function notPlate(ctx: OpContext, c: Container): void {
  if (c.kind === 'plate') ctx.refuse('PLATE-NOT-WELL', `Choose a well of ${c.label}, not the plate`)
}

// ---- Logistics ----

function fetchItem(ctx: OpContext, p: Params): OpResult {
  const equipment = refId(p.equipment)
  const def = equipment ? ctx.cat.equipment.get(equipment) : undefined
  if (!def || (def.kind !== 'container' && def.kind !== 'plate')) ctx.refuse('NOT-A-CONSUMABLE', `"${String(equipment)}" is not a container that can be fetched`)
  const requested = refId(p.id)
  const id = requested ?? ctx.newId('c')
  if (ctx.world.containers[id]) ctx.refuse('ID-TAKEN', `"${id}" already exists`)
  const c = addContainer(ctx.world, ctx.cat, { id, equipment: def.id, label: typeof p.label === 'string' ? p.label : def.label })
  // Optionally ready-filled from the stockroom (deionised water, a standard buffer).
  if (p.fill && typeof p.fill === 'object') {
    const fill = p.fill as Record<string, unknown>
    const prep = refId(fill.preparation)
    if (!prep || !ctx.cat.preparations.has(prep)) ctx.refuse('UNKNOWN-PREPARATION', `There is no "${String(prep)}" in the stockroom`)
    const amountL = ctx.quantity(fill.amount, 'volume', 'amount').si * 1000
    if (amountL > c.capacityL * (1 + 1e-9)) ctx.refuse('OVERFLOW', `${c.label} cannot hold that much`)
    addOnTop(c.contents, layerFrom(ctx.cat, preparationComponents(ctx.cat, prep), amountL))
    c.labelled = { components: labelledFrom(preparationComponents(ctx.cat, prep)), preparation: prep }
  }
  return { outputs: { container: c.id }, facts: { equipment: def.id, container: c.id } }
}

// ---- Liquid handling ----

/** Air-displacement pipettes deliver short of a viscous liquid: per mPa·s above water's, forward and reverse. */
const FORWARD_SHORTFALL_PER_MPAS = 0.006
const REVERSE_SHORTFALL_PER_MPAS = 0.0008
/** A drained vessel keeps a film on its walls: this fraction of its capacity (about 0.2 mL in a 25 mL flask). */
const DRAIN_FILM_FRACTION = 0.006

function transfer(ctx: OpContext, p: Params): OpResult {
  const src = ctx.container(p.source, 'source')
  const dst = ctx.container(p.destination, 'destination')
  if (src.id === dst.id) ctx.refuse('SAME-CONTAINER', 'Source and destination are the same')
  notPlate(ctx, src)
  notPlate(ctx, dst)
  // A syringe's needle goes through a septum; anything else needs the vessel open.
  const toolInstance = p.tool === 'pour' ? undefined : ctx.world.equipment[refId(p.tool) ?? '']
  const syringe = !!toolInstance && ctx.cat.property(toolInstance.equipment, 'syringe') === true
  if (syringe && (toolInstance.state as ToolState).discarded) ctx.refuse('DISCARDED', `${toolInstance.label} has been thrown away: take a fresh one`)
  for (const c of [src, dst]) {
    if (!c.septum) requireOpen(ctx, c)
    else if (!syringe) ctx.refuse('SEPTUM', `${c.label} is sealed with a septum: use a syringe and needle through it, or take the septum off`)
  }
  if (ctx.cat.property(src.equipment, 'agar') === true) ctx.refuse('AGAR', `${src.label} is set agar: nothing can be drawn from it`)
  if (src.contents.gelled) ctx.refuse('SET', `The agar in ${src.label} has cooled and set: it melts again only when heated near boiling`)
  // Pouring it all across: whatever drains, bar the vessel's dead volume and a film on its walls.
  const all = p.all === true
  if (all && p.tool !== undefined && p.tool !== null && p.tool !== 'pour') ctx.refuse('ALL-IS-POURED', 'Only pouring empties a vessel: leave out the tool')
  // Filling to the brim (a BOD bottle, a density bottle): pour until it runs over, so no air is left.
  const brim = p.brim === true
  if (brim && (all || (p.tool !== undefined && p.tool !== null && p.tool !== 'pour'))) ctx.refuse('BRIM-IS-POURED', 'A vessel is filled to the brim by pouring: leave out the tool and the volume')
  if (!all && !brim && p.volume === undefined) ctx.refuse('NO-VOLUME', 'Give a volume, or pour it all')
  const volumeL = all
    ? Math.max(0, liquidVolume(src.contents) - src.deadVolumeL - DRAIN_FILM_FRACTION * src.capacityL)
    : brim
      ? Math.max(0, dst.capacityL - liquidVolume(dst.contents))
      : ctx.quantity(p.volume, 'volume', 'volume').si * 1000
  if (!(volumeL > 0)) ctx.refuse(all ? 'EMPTY' : brim ? 'FULL' : 'BAD-VOLUME', all ? `${src.label} has nothing to pour` : brim ? `${dst.label} is already full` : 'The volume must be positive')

  // "pour" means no measuring tool: straight from the vessel (a measuring cylinder's accuracy at best).
  const toolRef = p.tool === 'pour' ? undefined : p.tool
  let toolId: string | undefined
  let toolEquipment: string | undefined
  let tool: ToolState | undefined
  let inGoodRange = true
  let maxL: number | undefined
  if (toolRef !== undefined && toolRef !== null) {
    const t = toolState(ctx, toolRef, 'pipette')
    toolId = t.id
    toolEquipment = t.equipment
    tool = t.state
    const range = rangeL(ctx, t.equipment)
    const nominal = ctx.cat.property(t.equipment, 'nominal')
    if (range) {
      const [lo, hi] = range
      maxL = hi
      if (volumeL < lo * (1 - 1e-9) || volumeL > hi * (1 + 1e-9)) {
        ctx.refuse('OUT-OF-RANGE', `${fmtL(volumeL)} is outside the ${fmtL(lo)}–${fmtL(hi)} range of this pipette`, { volume: volumeL, lo, hi })
      }
      // Accuracy falls off in the bottom tenth of a pipette's range.
      inGoodRange = volumeL >= 0.1 * hi * (1 - 1e-9)
    } else if (nominal !== undefined) {
      const n = parseValue(String(nominal)).si * 1000
      if (Math.abs(volumeL - n) > n * 0.002) ctx.refuse('FIXED-VOLUME', `A ${fmtL(n)} volumetric pipette delivers ${fmtL(n)} only`)
    }
    if (ctx.cat.property(t.equipment, 'needsTip') === true && !tool.tip) ctx.refuse('NO-TIP', 'Attach a tip first')
  }

  const available = liquidVolume(src.contents) - src.deadVolumeL
  if (volumeL > available + 1e-12) {
    ctx.refuse('NOT-ENOUGH', `${src.label} has only ${fmtL(Math.max(0, available))} that can be drawn`, { available })
  }
  const before = liquidVolume(dst.contents)
  // A counting chamber takes up what fits under its coverslip; the rest stays in the tip.
  const chamber = ctx.cat.property(dst.equipment, 'chamber') === true
  if (!chamber && before + volumeL > dst.capacityL * (1 + 1e-9)) {
    ctx.refuse('OVERFLOW', `${fmtL(volumeL)} would overfill ${dst.label} (capacity ${fmtL(dst.capacityL)})`, { capacity: dst.capacityL })
  }

  // Error channel: the tool's systematic (per instance) and random error, scaled by handling.
  const rng = ctx.rng('volume')
  const dispensing = ctx.cat.property(src.equipment, 'dispensing') === true
  let factor = 1
  if (tool && toolEquipment) {
    const err = errorAt(ctx, toolEquipment, volumeL)
    const systematic = tool.bias ?? tool.biasZ * err.sys * 0.5
    factor = 1 + ctx.options.handlingError * (systematic + rng.normal(0, err.rand))
    // An air-displacement pipette is calibrated for water: a viscous liquid lags in the tip and
    // leaves a thick film, so forward pipetting delivers short. Reverse pipetting (aspirate past
    // the first stop, dispense only to it) leaves the excess behind and mostly removes the error.
    if (ctx.cat.property(toolEquipment, 'needsTip') === true) {
      const eta = viscosityMPaS(ctx.cat, meanLayer(src.contents))
      if (eta > 1.05) factor *= 1 - (p.mode === 'reverse' ? REVERSE_SHORTFALL_PER_MPAS : FORWARD_SHORTFALL_PER_MPAS) * Math.min(eta - 1, 30)
    }
  } else if (dispensing) {
    // A burette delivers what leaves through the tap: only its class tolerance, as a systematic error.
    const z = Math.max(-2, Math.min(2, createRng(`${ctx.world.seed}|bias|${src.id}`).normal()))
    factor = 1 + ctx.options.handlingError * z * ((src.toleranceL ?? 5e-5) / Math.max(src.capacityL, 1e-9)) * 0.5
  } else if (!all && !brim) {
    factor = 1 + ctx.options.handlingError * rng.normal(0, 0.03)
  }
  // Never more than the destination can hold: pouring stops at the brim.
  const aspirate = Math.min(available, Math.max(0, volumeL * factor), Math.max(0, dst.capacityL - before))

  // The tip's film from earlier liquids: half washes into the source, half rides along.
  const tip = tool?.tip ?? null
  const fresh = !tip || tip.touched.length === 0
  const sameSourceAsLast = !!tip && !fresh && tip.touched.every((id) => id === src.id)
  let carried: Layer | null = null
  if (tip?.film && tip.film.volumeL > 0) {
    const half = scaleLayer(tip.film, 0.5)
    if (tip.lastSource !== src.id) {
      mergeIntoTop(src, half)
      ctx.world.provenance.push({ event: ctx.eventIndex, from: tip.lastSource ?? 'tip', to: src.id, volumeL: half.volumeL, kind: 'carryover' })
    }
    carried = tip.lastSource === src.id ? tip.film : half
  }

  const drawn = tool ? drawFromTop(src.contents, aspirate) : drawProportional(src.contents, aspirate)
  const inTip: Layer = emptyLayer()
  addInto(inTip, drawn, 1)
  if (carried) addInto(inTip, carried, 1)

  // A film stays on the tip (pipettes are calibrated to deliver, so the film comes from the
  // aspirated excess and the delivered volume carries the tool's error only).
  const filmFraction = tool && toolEquipment ? Number(ctx.cat.property(toolEquipment, 'filmFraction') ?? 0) : 0
  const filmFixed = tool && toolEquipment ? parseValue(String(ctx.cat.property(toolEquipment, 'filmVolume') ?? '0 uL')).si * 1000 : 0
  const filmVolume = tip ? Math.min(inTip.volumeL * 0.5, filmFraction * aspirate + filmFixed) : 0
  const fractionDelivered = inTip.volumeL > 0 ? (inTip.volumeL - filmVolume) / inTip.volumeL : 0
  const delivered = scaleLayer(inTip, fractionDelivered)
  let film = filmVolume > 0 ? scaleLayer(inTip, 1 - fractionDelivered) : null

  // Dispensing into liquid: the tip touches it and its film picks up the destination's liquid.
  const destinationHadLiquid = before > 0
  if (tip && destinationHadLiquid && film) {
    const destMean = meanLayer(dst.contents)
    const pick = scaleLayer(destMean, (film.volumeL * 0.5) / Math.max(destMean.volumeL, 1e-15))
    film = scaleLayer(film, 0.5)
    addInto(film, pick, 1)
  }

  // Gases: drawing through a septum with no balloon lets air in behind the liquid; an unflushed
  // syringe carries a little air into a sealed flask (and its oxygen into the liquid); liquid
  // poured or drawn through the room's air takes up oxygen from it.
  const gp = gasParams(ctx.cat)
  if (src.septum && !src.balloon) src.headspaceAir = Math.min(1, headspaceAir(src) + (1 - headspaceAir(src)) * Math.min(1, aspirate / headspaceL(src)))
  if (syringe && !(toolInstance.state as ToolState).flushed) {
    if (dst.septum) dst.headspaceAir = Math.min(1, headspaceAir(dst) + (1 - headspaceAir(dst)) * Math.min(1, gp.syringeAirL / headspaceL(dst)))
    // Its oxygen dissolves only as far as the liquid is short of saturation in air.
    if (OXYGEN in delivered.species) {
      const room = Math.max(0, oxygenSaturation(ctx.cat, src.contents.temperatureK, 1) * delivered.volumeL - delivered.species[OXYGEN])
      delivered.species[OXYGEN] += Math.min(room, (gp.syringeAirL * gp.airO2) / 24.45)
    }
  }
  if (OXYGEN in delivered.species && !src.septum) {
    const sat = oxygenSaturation(ctx.cat, src.contents.temperatureK, 1) * delivered.volumeL
    delivered.species[OXYGEN] += (sat - delivered.species[OXYGEN]) * (tool ? 0.1 : 0.5)
  }
  const tSrc = src.contents.temperatureK
  const tDst = dst.contents.temperatureK
  let floated = false
  if (dst.kind === 'well' && ctx.cat.property(dst.equipment, 'gel') === true && !denseEnough(ctx, delivered)) {
    // Without a dense loading dye (glycerol, sucrose) the sample floats up out of the gel well.
    for (const s of Object.keys(delivered.species)) delivered.species[s] *= 0.02
    floated = true
  }
  if (ctx.cat.property(dst.equipment, 'agar') === true) {
    // Onto an agar plate: the liquid soaks into the agar, the cells stay on its surface; a drop
    // spotted at a numbered spot stays there, its colonies counted apart from the other spots'.
    // Molten top agar spreads over the plate and sets there, its cells all through it.
    if (p.spot !== undefined) spotOnSurface(ctx, dst.contents, delivered.populations, Number(p.spot))
    else depositOnSurface(dst.contents, delivered.populations, gellingAgent(ctx.cat, delivered) !== undefined)
    delete delivered.populations
    addOnTop(dst.contents, delivered, 1)
    relaxLayers(dst.contents, 1)
  } else addOnTop(dst.contents, delivered, !samePhase(ctx.cat, delivered, dst.contents.layers[0]) ? 0 : tool ? 0.3 : 0.6)
  const after = liquidVolume(dst.contents)
  dst.contents.temperatureK = after > 0 ? (tDst * before + tSrc * delivered.volumeL) / after : tSrc
  // Whatever reacted where the liquids met (acid with base) gives off or takes up its heat.
  releaseHeat(ctx.cat, dst.contents)
  // Ions that meet come out at once as any solid whose solubility product they exceed, with the
  // heat of precipitation (and of any solid that dissolves).
  const settledBefore = settledEnthalpyJ(ctx.cat, dst.contents)
  if (Object.values(ionicEquilibrate(ctx.cat, dst.contents, 0.5)).some((x) => x !== 0)) releaseHeat(ctx.cat, dst.contents, settledBefore - settledEnthalpyJ(ctx.cat, dst.contents))
  addOrigins(dst, src)

  if (tip) {
    tip.touched = [...new Set([...tip.touched, src.id, ...(destinationHadLiquid ? [dst.id] : [])])]
    tip.lastSource = src.id
    tip.film = film
  }
  ctx.world.provenance.push({ event: ctx.eventIndex, from: src.id, to: dst.id, volumeL: delivered.volumeL, kind: 'transfer' })
  // A drop of immersion oil put on a slide under a high-power lens touches it.
  oilContact(ctx)
  // Liquid poured or pipetted in stirs the grains up again.
  delete dst.contents.grainClock
  // An uncovered bottle or tube is handled at its rim: unflamed, it now and then lets something in.
  rimContact(ctx.cat, ctx.world, src, ctx.eventIndex)
  rimContact(ctx.cat, ctx.world, dst, ctx.eventIndex)

  return {
    outputs: { delivered: `${delivered.volumeL * 1000} mL` },
    facts: {
      source: src.id,
      destination: dst.id,
      volumeL,
      deliveredL: delivered.volumeL,
      tool: toolEquipment ?? 'pour',
      toolId,
      tipFresh: tool?.tip ? fresh : true,
      sameSourceAsLast,
      inGoodRange,
      maxL,
      destinationHadLiquid,
      ...(floated ? { floated } : {}),
    },
  }
}

function spotOnSurface(ctx: OpContext, c: Container['contents'], populations: Layer['populations'], spot: number): void {
  if (!Number.isInteger(spot) || spot < 1 || spot > 48) ctx.refuse('BAD-SPOT', 'Spots are numbered 1 to 48')
  spotCells(c, populations, spot)
}

/**
 * A gel sample sinks into the well only if it is denser than the running buffer by what about 3 %
 * glycerol (v/v) gives: some 8 g/L. Every dense solute counts (glycerol, sucrose, Ficoll): each
 * adds its mass less the water it displaces.
 */
const SINK_EXCESS_G_PER_L = 7.5
function denseEnough(ctx: OpContext, layer: Layer): boolean {
  if (layer.volumeL <= 0) return true
  let excessG = 0
  for (const [s, n] of Object.entries(layer.species)) {
    const def = ctx.cat.substances.get(s)
    if (!def?.physical?.density || !(n > 0)) continue
    const density = parseValue(def.physical.density).si
    if (density <= 1050) continue
    excessG += n * (molarMass(ctx.cat, s) ?? 0) * (1 - 997 / density)
  }
  return excessG / layer.volumeL >= SINK_EXCESS_G_PER_L
}

function setVolume(ctx: OpContext, p: Params): OpResult {
  const t = toolState(ctx, p.pipette, 'pipette')
  const v = ctx.quantity(p.volume, 'volume').si * 1000
  const range = rangeL(ctx, t.equipment)
  if (!range) ctx.refuse('NOT-VARIABLE', 'This pipette has a fixed volume')
  if (v < range[0] * (1 - 1e-9) || v > range[1] * (1 + 1e-9)) ctx.refuse('OUT-OF-RANGE', `This pipette cannot be set to ${fmtL(v)}`)
  t.state.setVolumeL = v
  return { facts: { volumeL: v, inGoodRange: v >= 0.1 * range[1] * (1 - 1e-9) } }
}

function attachTip(ctx: OpContext, p: Params): OpResult {
  const t = toolState(ctx, p.pipette, 'pipette')
  if (ctx.cat.property(t.equipment, 'needsTip') !== true) ctx.refuse('NO-TIPS', 'This pipette does not take tips')
  if (t.state.tip) ctx.refuse('TIP-ATTACHED', 'A tip is already attached: eject it first')
  t.state.tip = { id: ctx.newId('tip'), touched: [], film: null }
  return { facts: { tip: t.state.tip.id } }
}

function ejectTip(ctx: OpContext, p: Params): OpResult {
  const t = toolState(ctx, p.pipette, 'pipette')
  // Pressing the ejector with no tip on does nothing.
  if (!t.state.tip) return { facts: { ejected: false } }
  const used = t.state.tip.touched.length > 0
  t.state.tip = null
  return { facts: { used } }
}

// ---- Solids and weighing ----

function addSolid(ctx: OpContext, p: Params): OpResult {
  const dst = ctx.container(p.destination, 'destination')
  notPlate(ctx, dst)
  requireOpen(ctx, dst)
  // The substance can be a catalogue id (an endless stock) or a container of solid; from a
  // container, `all: true` scrapes out everything (a filter paper keeps a little).
  const srcId = refId(p.substance)
  const srcContainer = srcId ? ctx.world.containers[srcId] : undefined
  const all = p.all === true
  if (all && !srcContainer) ctx.refuse('ALL-NEEDS-CONTAINER', 'Only the contents of a container can be scraped out')
  const massKg = all ? 0 : ctx.quantity(p.mass, 'mass', 'mass').si
  if (!all && !(massKg > 0)) ctx.refuse('BAD-MASS', 'The mass must be positive')
  // A spatula is imprecise: what lands differs from what was intended; the balance tells the truth.
  const actualG = Math.max(0, massKg * 1000 * (1 + ctx.options.handlingError * ctx.rng('spatula').normal(0, 0.04)))
  let addedG = 0
  if (srcContainer) {
    requireOpen(ctx, srcContainer)
    // A scoop of a mixed solid takes every component in proportion to its mass.
    const parts = Object.entries(srcContainer.contents.solid)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => ({ s, n, g: n * (molarMass(ctx.cat, s) ?? 0) }))
    const totalG = parts.reduce((a, x) => a + x.g, 0)
    if (totalG <= 0) ctx.refuse('NOT-ENOUGH', `${srcContainer.label} holds no solid`)
    const f = all ? 1 - Number(ctx.cat.property(srcContainer.equipment, 'solidLeftWhenScraped') ?? 0) : Math.min(1, actualG / totalG)
    for (const part of parts) {
      const mol = part.n * f
      srcContainer.contents.solid[part.s] = part.n - mol
      dst.contents.solid[part.s] = (dst.contents.solid[part.s] ?? 0) + mol
      addedG += part.g * f
      // Tissue goes with what its cells hold.
      moveTissue(srcContainer.contents, dst.contents, part.s, f)
    }
    // A wet solid carries its liquid (and what is dissolved in it) in the same proportion.
    const wet = liquidVolume(srcContainer.contents)
    if (wet > 0) addOnTop(dst.contents, drawProportional(srcContainer.contents, wet * f), 1)
    addOrigins(dst, srcContainer)
  } else {
    const substance = srcId ?? ''
    if (!ctx.cat.substances.has(substance)) ctx.refuse('UNKNOWN-SUBSTANCE', `There is no "${substance}" here`)
    const mm = molarMass(ctx.cat, substance)
    if (!mm) ctx.refuse('NO-MOLAR-MASS', `${substance} cannot be weighed out (no molar mass)`)
    // A solid from the stock brings its heat: at room temperature, or, if it would melt there (ice from
    // the ice bucket), at its melting point.
    const stockMelt = ctx.cat.substances.get(substance)?.physical?.meltingPoint
    const roomK = ctx.world.places.bench?.temperatureK ?? 294.15
    const stockK = stockMelt ? Math.min(roomK, parseValue(stockMelt).si) : roomK
    const held = liquidVolume(dst.contents) > 0 || Object.values(dst.contents.solid).some((x) => x > 0) ? heatCapacityJK(ctx.cat, dst.contents) : 0
    dst.contents.solid[substance] = (dst.contents.solid[substance] ?? 0) + actualG / mm
    const added = heatCapacityJK(ctx.cat, { layers: [], solid: { [substance]: actualG / mm }, temperatureK: stockK } as Contents)
    if (ctx.cat.substances.get(substance)?.physical?.specificHeat) dst.contents.temperatureK = (held * dst.contents.temperatureK + added * stockK) / (held + added)
    addedG = actualG
    // Freshly cut tissue: its cells' water, sap and pigment.
    const fresh = freshTissue(ctx.cat, substance, actualG)
    if (fresh) addTissue(dst.contents, substance, fresh)
  }
  ctx.world.provenance.push({ event: ctx.eventIndex, from: srcContainer?.id ?? String(srcId), to: dst.id, volumeL: 0, kind: 'add-solid' })
  return { facts: { intendedG: all ? addedG : massKg * 1000, addedG, all } }
}

/** Thickness of the liquid a piece carries on its surface when lifted out, cm: blotted, or dripping. */
const FILM_CM = { blotted: 0.0005, wet: 0.01 }

/**
 * Lift solid pieces out of a liquid with forceps (tissue, a metal strip, marble chips), into another
 * vessel: they bring only a film of the liquid, less once blotted on paper towel, and their heat.
 */
function liftOut(ctx: OpContext, p: Params): OpResult {
  const src = ctx.container(p.source, 'source')
  const dst = ctx.container(p.destination, 'destination')
  requireOpen(ctx, src)
  requireOpen(ctx, dst)
  const only = refId(p.substance)
  const pieces = Object.entries(src.contents.solid).filter(([s, n]) => n > 0 && (!only || s === only))
  if (!pieces.length) ctx.refuse('NOTHING-TO-LIFT', `${src.label} has no pieces to lift out`)
  // Heat goes with the pieces: what they and their film hold per kelvin, at the source's temperature.
  const dstHeld = liquidVolume(dst.contents) > 0 || Object.values(dst.contents.solid).some((n) => n > 0) ? heatCapacityJK(ctx.cat, dst.contents) : 0
  const moving = { layers: [], solid: Object.fromEntries(pieces), temperatureK: src.contents.temperatureK } as Contents
  const movingHeld = heatCapacityJK(ctx.cat, moving)
  let grams = 0
  for (const [s, n] of pieces) {
    grams += n * (molarMass(ctx.cat, s) ?? 0)
    dst.contents.solid[s] = (dst.contents.solid[s] ?? 0) + n
    src.contents.solid[s] = 0
    moveTissue(src.contents, dst.contents, s, 1)
  }
  // The film is the liquid on the pieces' surface (taken as a cube's, 6 V^(2/3), from mass and density).
  let areaCm2 = 0
  for (const [s, n] of pieces) {
    const density = ctx.cat.substances.get(s)?.physical?.density
    const gPerCm3 = density ? parseValue(density).si / 1000 : 1
    areaCm2 += 6 * Math.pow((n * (molarMass(ctx.cat, s) ?? 0)) / gPerCm3, 2 / 3)
  }
  const filmL = Math.min(liquidVolume(src.contents), (areaCm2 * (p.blot === false ? FILM_CM.wet : FILM_CM.blotted)) / 1000)
  if (filmL > 0) addOnTop(dst.contents, drawProportional(src.contents, filmL), 1)
  const filmHeld = filmL * 4184
  dst.contents.temperatureK = (dstHeld * dst.contents.temperatureK + (movingHeld + filmHeld) * src.contents.temperatureK) / (dstHeld + movingHeld + filmHeld)
  ctx.world.provenance.push({ event: ctx.eventIndex, from: src.id, to: dst.id, volumeL: filmL, kind: 'add-solid' })
  return { facts: { grams, filmML: filmL * 1000 } }
}

function onPan(ctx: OpContext, balanceId: string): Container[] {
  return Object.values(ctx.world.containers).filter((c) => c.place === balanceId && c.kind !== 'well' && !c.discarded)
}

function weigh(ctx: OpContext, p: Params): OpResult {
  const b = ctx.equipment(p.balance, 'balance')
  if (!ctx.cat.isA(b.equipment, 'core:balance') || b.state.kind !== 'instrument') ctx.refuse('NOT-A-BALANCE', `${b.label} is not a balance`)
  const spec = balanceSpec(ctx.cat, b.equipment)
  const net = loadKg(ctx.cat, onPan(ctx, b.id)) - (b.state.tareKg ?? 0)
  const r = observeMass(net, spec, ctx.rng('balance'), ctx.options.noise)
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: b.id,
    settings: { tared: b.state.tareKg ? 1 : 0 },
    subject: b.id,
    kind: 'scalar',
    quantity: 'mass',
    unit: 'g',
    value: r.value,
    display: { [b.id]: r.display },
    flags: r.flags.length ? { [b.id]: r.flags } : {},
    uncertainty: { random: spec.repeatability * 1000, resolution: spec.readability * 1000 },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, value: `${r.value} g`, display: r.display }, facts: { record: record.id, valueG: r.value } }
}

function tare(ctx: OpContext, p: Params): OpResult {
  const b = ctx.equipment(p.balance, 'balance')
  if (!ctx.cat.isA(b.equipment, 'core:balance') || b.state.kind !== 'instrument') ctx.refuse('NOT-A-BALANCE', `${b.label} is not a balance`)
  b.state.tareKg = loadKg(ctx.cat, onPan(ctx, b.id))
  return { facts: { tareG: b.state.tareKg * 1000 } }
}

// ---- Mixing and volumetric work ----

const MIX_FRACTION: Record<string, number> = { vortex: 1, invert: 0.9, 'pipette-mix': 0.6, swirl: 0.7, stir: 1, shake: 0.95, flick: 0.5 }
/** Share of a cell pellet each cycle of a mixing method puts back into the liquid. */
const RESUSPEND: Record<string, number> = { vortex: 0.9, 'pipette-mix': 0.7, shake: 0.6, stir: 0.5, flick: 0.4, invert: 0.3, swirl: 0.15 }

function mixOne(ctx: OpContext, c: Container, method: string, cycles: number): void {
  const params = ctx.cat.models.get('core:mixing/strata')?.params ?? {}
  const per = Number(params[method] ?? MIX_FRACTION[method] ?? 0.8)
  relaxLayers(c.contents, 1 - Math.pow(1 - per, Math.max(1, cycles)))
  // Mixing brings the liquid towards the gas above it (more so if it is shaken or stirred hard).
  relaxOxygen(ctx.cat, c.contents, headspaceAir(c), 1 - Math.pow(1 - per * 0.5, Math.max(1, cycles)))
  releaseHeat(ctx.cat, c.contents)
  // Solids dissolving give their heat of solution (Hess's law, from the solid's enthalpy of
  // formation; a solid without thermal data dissolves without heat).
  const settledBefore = settledEnthalpyJ(ctx.cat, c.contents)
  dissolve(ctx, c)
  releaseHeat(ctx.cat, c.contents, settledBefore - settledEnthalpyJ(ctx.cat, c.contents))
}

/**
 * Dissolve solids into the liquid (T2: instantaneous on mixing). Substances without a solubility
 * limit dissolve completely; limited ones reach their limit at the current temperature and pH,
 * and any excess comes out (solubility model).
 */
function dissolve(ctx: OpContext, c: Container): void {
  const v = liquidVolume(c.contents)
  if (v <= 0) return
  resuspend(ctx.cat, c.contents)
  // Stirred up: any grains start settling again from the top.
  delete c.contents.grainClock
  const limits = solubilityLimits(ctx.cat)
  for (const [s, n] of Object.entries(c.contents.solid)) {
    // Ionic solids dissolve only as far as their solubility products allow (equilibrate, below);
    // metals, marble and catalysts only react at their surface (models/surface.ts).
    const def = ctx.cat.substances.get(s)
    if (n <= 0 || limits.has(s) || def?.solid || def?.metal || def?.dissolution || def?.catalyst) continue
    // Pieces that do not dissolve: ice (it melts instead), a metal block, tissue, specimens and shoots.
    if (def?.physical?.meltsTo || def?.identity.class === 'metal' || def?.tissue || def?.specimen || def?.transpiration || def?.respiration || def?.absorbs || def?.heart) continue
    // Salts dissolve only in water, not in a solvent layer; a drying agent dries a solvent instead.
    const shares = dissolveShares(ctx.cat, c.contents, s)
    if (!shares) continue
    c.contents.solid[s] = 0
    c.contents.layers.forEach((l, i) => (l.species[s] = (l.species[s] ?? 0) + n * shares[i]))
  }
  equilibrate(ctx.cat, c.contents, 1)
}

function mix(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.container)
  const method = typeof p.method === 'string' ? p.method : 'vortex'
  const cycles = typeof p.cycles === 'number' ? p.cycles : 1
  if (c.kind === 'plate') {
    if (method !== 'shake') ctx.refuse('PLATE-SHAKE', 'Plates are mixed by shaking')
    for (const w of c.wells ?? []) mixOne(ctx, ctx.world.containers[w], method, cycles)
    return { facts: { method } }
  }
  // Consequences, not refusals: an open vessel turned upside down pours out, and vortexing a
  // well-filled open tube splashes.
  let spilledL = 0
  if (c.open && liquidVolume(c.contents) > 0) {
    // A separating funnel is shaken upside down: unstoppered, it pours out like an inverted tube.
    if (method === 'invert' || (method === 'shake' && ctx.cat.property(c.equipment, 'tap') === true)) spilledL = drawProportional(c.contents, liquidVolume(c.contents) * 0.5).volumeL
    else if ((method === 'vortex' || method === 'shake') && liquidVolume(c.contents) > c.capacityL * 0.6) {
      spilledL = drawProportional(c.contents, liquidVolume(c.contents) * 0.02).volumeL
    }
  }
  mixOne(ctx, c, method, cycles)
  // A cell pellet comes back up: a vortex lifts most of it each time, swirling hardly any.
  if (c.contents.cellPellet) resuspendCells(c.contents, 1 - (1 - (RESUSPEND[method] ?? 0.3)) ** cycles)
  return { facts: { method, homogeneity: homogeneity(c.contents), spilledL } }
}

function makeUpToMark(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.container, 'flask')
  const solvent = ctx.container(p.solvent, 'solvent')
  if (c.nominalL === undefined) ctx.refuse('NOT-VOLUMETRIC', `${c.label} has no calibration mark`)
  requireOpen(ctx, c)
  requireOpen(ctx, solvent)
  const current = liquidVolume(c.contents)
  if (current > c.nominalL) ctx.refuse('PAST-MARK', `${c.label} is already past the mark`)
  const tol = c.toleranceL ?? c.nominalL * 0.001
  const err = Math.max(-tol, Math.min(tol, ctx.options.handlingError * ctx.rng('meniscus').normal(0, tol / 3)))
  const add = c.nominalL + err - current
  if (liquidVolume(solvent.contents) - solvent.deadVolumeL < add) ctx.refuse('NOT-ENOUGH', `Not enough ${solvent.label}`)
  const poured = drawProportional(solvent.contents, add)
  const tFlask = c.contents.temperatureK
  addOnTop(c.contents, poured, 0.2)
  // The solvent brings its own temperature: a little iced stock made up with room-temperature
  // buffer is near room temperature.
  const after = liquidVolume(c.contents)
  c.contents.temperatureK = after > 0 ? (tFlask * current + solvent.contents.temperatureK * poured.volumeL) / after : solvent.contents.temperatureK
  releaseHeat(ctx.cat, c.contents)
  addOrigins(c, solvent)
  ctx.world.provenance.push({ event: ctx.eventIndex, from: solvent.id, to: c.id, volumeL: poured.volumeL, kind: 'make-up' })
  return { facts: { finalL: liquidVolume(c.contents), nominalL: c.nominalL } }
}

// ---- Places, environment and time ----

function placeIn(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.container)
  if (c.kind === 'well') ctx.refuse('WELL', 'Move the plate, not a single well')
  const place = ctx.place(p.place)
  const slots = Number(ctx.cat.property(place.equipment, 'slots') ?? 0)
  let slot: number | undefined
  if (slots > 0) {
    // Positions are numbered 1..slots, as on a rotor.
    slot = typeof p.position === 'number' ? p.position : undefined
    if (slot === undefined) {
      const taken = new Set(Object.values(ctx.world.containers).filter((x) => x.place === place.id && x.slot !== undefined).map((x) => x.slot))
      slot = Array.from({ length: slots }, (_, i) => i + 1).find((i) => !taken.has(i))
      if (slot === undefined) ctx.refuse('FULL', `${place.label} is full`)
    }
    if (!Number.isInteger(slot) || slot < 1 || slot > slots) ctx.refuse('NO-SLOT', `${place.label} has positions 1–${slots}`)
    if (Object.values(ctx.world.containers).some((x) => x.place === place.id && x.slot === slot && x.id !== c.id)) ctx.refuse('SLOT-TAKEN', `Position ${slot} is already used`)
    const accepts = ctx.cat.property(place.equipment, 'accepts')
    // `accepts` lists the tube formats the rotor takes ("conical-15 conical-50").
    if (accepts && !String(accepts).split(/\s+/).includes(String(ctx.cat.property(c.equipment, 'format')))) ctx.refuse('DOES-NOT-FIT', `${c.label} does not fit ${place.label}`)
  }
  c.place = place.id
  c.slot = slot
  for (const w of c.wells ?? []) ctx.world.containers[w].place = place.id
  return { facts: { place: place.id, temperatureK: place.temperatureK, ...(slot !== undefined ? { position: slot } : {}) } }
}

function removeFrom(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.container)
  if (c.kind === 'well') ctx.refuse('WELL', 'Move the plate, not a single well')
  c.place = 'bench'
  c.slot = undefined
  for (const w of c.wells ?? []) ctx.world.containers[w].place = 'bench'
  return {}
}

/** Wind speeds a fan gives, m/s. */
const WIND_MS: Record<string, number> = { still: 0, low: 1.5, high: 3 }

function setEnvironment(ctx: OpContext, p: Params): OpResult {
  const place = ctx.place(p.device, 'device')
  // A lamp: its light falls off as the square of the distance; a colour filter passes one band.
  const d = ctx.optionalQuantity(p.distance, 'length', 'distance')
  if (d || p.filter !== undefined) {
    const at10 = Number(ctx.cat.property(place.equipment, 'lightAt10cm') ?? 0)
    if (!(at10 > 0)) ctx.refuse('NOT-A-LAMP', `${place.label} gives no light to adjust`)
    if (d) {
      if (!(d.si > 0)) ctx.refuse('BAD-DISTANCE', 'The distance must be positive')
      place.light = at10 * (0.1 / d.si) ** 2
    }
    if (p.filter !== undefined) place.filter = String(p.filter) === 'none' ? undefined : String(p.filter)
  }
  // The air: a plastic bag over a plant makes it humid; a fan moves it.
  if (p.humidity !== undefined) {
    const h = Number(p.humidity)
    if (!(h >= 0 && h <= 1)) ctx.refuse('BAD-HUMIDITY', 'Humidity is a fraction from 0 to 1')
    place.humidity = h
  }
  if (p.wind !== undefined) place.windMs = WIND_MS[String(p.wind)] ?? 0
  const t = ctx.optionalQuantity(p.temperature, 'temperature', 'temperature')
  if (!t) return { facts: { light: place.light ?? 0 } }
  if (!place.adjustable) ctx.refuse('NOT-ADJUSTABLE', `${place.label} cannot be set`)
  for (const cap of ctx.cat.capabilitiesOf(place.equipment)) {
    const range = cap.params?.temperature
    if (!range) continue
    const r = parseQuantity(range)
    if (r.kind === 'range' && (t.si < r.lo.si - 1e-9 || t.si > r.hi.si + 1e-9)) ctx.refuse('OUT-OF-RANGE', `${place.label} cannot reach ${range.includes('Cel') ? `${(t.si - 273.15).toFixed(1)} °C` : t.si}`)
  }
  place.temperatureK = t.si
  return { facts: { temperatureK: t.si } }
}

function advanceTime(ctx: OpContext, p: Params): OpResult {
  const d = ctx.quantity(p.duration, 'time', 'duration').si
  if (!(d >= 0)) ctx.refuse('BAD-DURATION', 'The duration must not be negative')
  if (d > 30 * 86400) ctx.refuse('TOO-LONG', 'At most 30 days at once')
  const r = advance(ctx.world, ctx.cat, d)
  return { facts: { durationS: d, steps: r.steps } }
}

// ---- Centrifugation ----

/** Out-of-balance load of a rotor (g): the vector sum of masses at their positions. */
export function rotorImbalanceG(ctx: { world: OpContext['world']; cat: OpContext['cat'] }, rotor: string): number {
  const slots = Number(ctx.cat.property(ctx.world.places[rotor]?.equipment ?? '', 'slots') ?? 0)
  if (!slots) return 0
  let x = 0
  let y = 0
  for (const c of Object.values(ctx.world.containers)) {
    if (c.place !== rotor || c.slot === undefined || c.discarded) continue
    const g = (c.tareMassKg + contentsMassKg(ctx.cat, c.contents)) * 1000
    const a = (2 * Math.PI * (c.slot - 1)) / slots
    x += g * Math.cos(a)
    y += g * Math.sin(a)
  }
  return Math.hypot(x, y)
}

/**
 * Spin a centrifuge. An unbalanced rotor is not refused (it is physically possible): it vibrates,
 * the imbalance sensor stops the run and nothing is separated, and an incident is recorded.
 */
function centrifuge(ctx: OpContext, p: Params): OpResult {
  const candidates = Object.values(ctx.world.places).filter((pl) => ctx.cat.isA(pl.equipment, 'core:centrifuge'))
  const id = refId(p.centrifuge) ?? (candidates.length === 1 ? candidates[0].id : undefined)
  if (!id) ctx.refuse('WHICH-CENTRIFUGE', 'Name the centrifuge')
  const place = ctx.place(id, 'centrifuge')
  if (!ctx.cat.isA(place.equipment, 'core:centrifuge')) ctx.refuse('NOT-A-CENTRIFUGE', `${place.label} is not a centrifuge`)
  // Speed as relative centrifugal force, or as rpm through the rotor's radius: RCF = 1.118e-5 × r(cm) × rpm².
  let rcf: number
  if (p.rpm !== undefined) {
    const radius = ctx.cat.property(place.equipment, 'rotorRadius')
    if (radius === undefined) ctx.refuse('NO-RADIUS', `${place.label}'s rotor radius is not known: give the speed as RCF`)
    const rpm = Number(p.rpm)
    if (!(rpm > 0)) ctx.refuse('BAD-SPEED', 'The speed must be positive')
    rcf = 1.118e-5 * parseValue(String(radius)).si * 100 * rpm * rpm
  } else {
    if (p.rcf === undefined) ctx.refuse('NO-SPEED', 'Give the speed as RCF or rpm')
    rcf = ctx.quantity(p.rcf, 'dimensionless', 'speed').si
  }
  const duration = ctx.quantity(p.duration, 'time', 'duration').si
  const maxRCF = parseValue(String(ctx.cat.property(place.equipment, 'maxRCF') ?? '21000 [RCF]')).si
  if (rcf <= 0 || rcf > maxRCF) ctx.refuse('OUT-OF-RANGE', `${place.label} runs up to ${maxRCF} × g`)
  const loaded = Object.values(ctx.world.containers).filter((c) => c.place === place.id && !c.discarded)
  if (loaded.length === 0) ctx.refuse('EMPTY', 'The rotor is empty')
  const imbalance = rotorImbalanceG(ctx, place.id)
  const tolerance = parseValue(String(ctx.cat.property(place.equipment, 'imbalanceTolerance') ?? '0.1 g')).si * 1000
  if (imbalance > tolerance) {
    const severe = imbalance > 10 * tolerance
    ctx.world.incidents.push({
      event: ctx.eventIndex,
      kind: 'mechanical',
      severity: severe ? 'instrument' : 'practice',
      equipment: place.id,
      message: severe
        ? `The rotor was badly out of balance (${imbalance.toFixed(2)} g). It vibrated violently and the run stopped. In a real lab this can damage the centrifuge and create a serious hazard.`
        : `The rotor was out of balance (${imbalance.toFixed(2)} g). The imbalance sensor stopped the run.`,
      data: { imbalanceG: imbalance, rcf },
    })
    return { facts: { ran: false, imbalanceG: imbalance, incident: true } }
  }
  // Open tubes spill in a rotor.
  for (const c of loaded) {
    if (!c.open || liquidVolume(c.contents) <= 0) continue
    const lost = drawProportional(c.contents, liquidVolume(c.contents) * 0.3)
    ctx.world.incidents.push({ event: ctx.eventIndex, kind: 'spill', severity: 'sample', equipment: place.id, message: `${c.label} was open and spilled in the rotor`, data: { lostL: lost.volumeL } })
  }
  // Sedimentation (T1): suspended particles go to the pellet by the centrifugal dose; the supernatant clears.
  for (const c of loaded) {
    relaxLayers(c.contents, 1)
    pellet(c.contents, rcf, duration / 60)
    pelletCells(ctx.cat, c.contents, rcf, duration / 60)
  }
  advance(ctx.world, ctx.cat, duration)
  return { facts: { ran: true, imbalanceG: imbalance, rcf: Math.round(rcf), durationS: duration } }
}

// ---- Measurement ----

function wavelengthNm(ctx: OpContext, value: unknown): number {
  return ctx.quantity(value, 'length', 'wavelength').si * 1e9
}

function measure(ctx: OpContext, p: Params): OpResult {
  const inst = ctx.equipment(p.instrument, 'instrument')
  if (inst.state.kind !== 'instrument') ctx.refuse('NOT-AN-INSTRUMENT', `${inst.label} does not measure`)
  const subject = ctx.container(p.subject, 'sample')
  if (ctx.cat.isA(inst.equipment, 'core:ph-meter')) return measurePH(ctx, inst.id, inst.state, subject)
  if (ctx.cat.isA(inst.equipment, 'core:redox-electrode')) return measurePotential(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:melting-point-apparatus')) return measureMeltingPoint(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:thermometer')) return measureTemperature(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:colony-counter')) return countColonies(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:zone-ruler')) return readZones(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:uv-lamp') && ctx.cat.property(subject.equipment, 'tlc') === true) return viewTlc(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:uv-lamp')) return lookUnderUV(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:gel-imager')) return imageGel(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:microscope') && ctx.cat.property(subject.equipment, 'chamber') === true) return countChamber(ctx, inst.id, subject, p)
  if (ctx.cat.isA(inst.equipment, 'core:microscope')) return observeSlide(ctx, inst.id, subject, p)
  if (ctx.cat.isA(inst.equipment, 'core:visual-inspection') && subject.contents.chamber) return countChamberAnimals(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:visual-inspection')) return inspect(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:sequencer')) return readSequence(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:do-meter')) return measureDissolvedOxygen(ctx, inst.id, subject.id)
  if (ctx.cat.isA(inst.equipment, 'core:gas-syringe')) return readGasSyringe(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:voltmeter')) return measureVoltage(ctx, inst.id, subject, p)
  if (ctx.cat.isA(inst.equipment, 'core:conductivity-meter')) return measureConductivity(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:pressure-sensor')) return measurePressure(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:ruler')) return measureFilm(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:hand-lens')) return scoreFlies(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:ir-spectrometer')) return measureInfrared(ctx, inst.id, subject)
  if (ctx.cat.isA(inst.equipment, 'core:esi-ms')) return measureMassSpectrum(ctx, inst.id, subject, p)
  if (ctx.cat.isA(inst.equipment, 'core:fluorimeter')) return measureFluorescence(ctx, inst.id, subject, p)
  const isReader = ctx.cat.isA(inst.equipment, 'bio:plate-reader')
  const isSpectro = ctx.cat.isA(inst.equipment, 'core:spectrophotometer')
  if (!isReader && !isSpectro) ctx.refuse('UNSUPPORTED-INSTRUMENT', `${inst.label} cannot be run here yet`)
  if (isSpectro && p.mode === 'scan') return scanAbsorbance(ctx, inst.id, inst.equipment, subject, p)
  const nm = wavelengthNm(ctx, p.wavelength)
  const spec = photometerSpec(ctx.cat, inst.equipment)
  if (nm < spec.wavelengthMin - 1e-6 || nm > spec.wavelengthMax + 1e-6) {
    ctx.refuse('WAVELENGTH', `${inst.label} reads ${spec.wavelengthMin}–${spec.wavelengthMax} nm, not ${nm} nm`)
  }
  const rng = ctx.rng('photometer')
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: inst.id,
    settings: { wavelength: nm, mode: String(p.mode ?? 'endpoint') },
    subject: subject.id,
    kind: 'array',
    quantity: 'absorbance',
    unit: 'AU',
    display: {},
    flags: {},
    uncertainty: { random: spec.noise, resolution: spec.readability },
  }
  if (isReader) {
    if (subject.kind !== 'plate') ctx.refuse('NOT-A-PLATE', `${inst.label} reads plates`)
    const wells = (subject.wells ?? []).map((id) => ctx.world.containers[id])
    const readAll = () => {
      const out: Record<string, { value: number; display: string; flags: string[] }> = {}
      for (const w of wells) {
        const trueA = wellAbsorbance(ctx.cat, w, nm) + vesselAbsorbance(w.material, nm)
        out[w.id] = observeAbsorbance(trueA, spec, rng, ctx.options.noise)
      }
      return out
    }
    if (p.mode === 'kinetic') {
      const interval = ctx.quantity(p.interval, 'time', 'interval').si
      const duration = ctx.quantity(p.duration, 'time', 'duration').si
      if (!(interval > 0) || duration < 0) ctx.refuse('BAD-KINETICS', 'A kinetic read needs a positive interval')
      const n = Math.floor(duration / interval + 1e-9) + 1
      if (n > 1000) ctx.refuse('TOO-MANY-READS', 'At most 1000 reads in one kinetic run')
      record.kind = 'series'
      record.times = []
      record.series = {}
      for (let i = 0; i < n; i++) {
        if (i > 0) advance(ctx.world, ctx.cat, interval)
        record.times.push(i * interval)
        for (const [id, r] of Object.entries(readAll())) {
          ;(record.series[id] ??= []).push(r.value)
          record.display[id] = r.display
          if (r.flags.length) record.flags[id] = r.flags as MeasurementRecord['flags'][string]
        }
      }
      record.settings.interval = interval
      record.settings.reads = n
    } else {
      record.values = {}
      for (const [id, r] of Object.entries(readAll())) {
        record.values[id] = r.value
        record.display[id] = r.display
        if (r.flags.length) record.flags[id] = r.flags as MeasurementRecord['flags'][string]
      }
    }
  } else {
    if (!ctx.cat.isA(subject.equipment, 'core:cuvette')) ctx.refuse('NOT-A-CUVETTE', `${inst.label} reads cuvettes`)
    const pathCm = (subject.pathLengthM ?? 0.01) * 100
    let trueA = sampleAbsorbance(ctx.cat, subject, nm, pathCm) + vesselAbsorbance(subject.material, nm)
    const v = liquidVolume(subject.contents)
    const flags: Array<'saturated' | 'insufficient-volume'> = []
    if (subject.minVolumeL !== undefined && v < subject.minVolumeL) {
      // The beam passes partly through air and the meniscus: an erratic, meaningless reading.
      trueA += rng.uniform(0.3, 1.5)
      flags.push('insufficient-volume')
    }
    const blank = inst.state.blanks?.[String(Math.round(nm))]
    if (p.mode === 'kinetic') {
      // A time course in the cell (a chart recorder or kinetics software): the reaction runs on
      // between reads, each read blank-corrected.
      const interval = ctx.quantity(p.interval, 'time', 'interval').si
      const duration = ctx.quantity(p.duration, 'time', 'duration').si
      if (!(interval > 0) || duration < 0) ctx.refuse('BAD-KINETICS', 'A kinetic read needs a positive interval')
      const n = Math.floor(duration / interval + 1e-9) + 1
      if (n > 1000) ctx.refuse('TOO-MANY-READS', 'At most 1000 reads in one kinetic run')
      record.kind = 'series'
      record.times = []
      record.series = { [subject.id]: [] }
      for (let i = 0; i < n; i++) {
        if (i > 0) advance(ctx.world, ctx.cat, interval)
        const a = sampleAbsorbance(ctx.cat, subject, nm, pathCm) + vesselAbsorbance(subject.material, nm) + (flags.includes('insufficient-volume') ? rng.uniform(0.3, 1.5) : 0)
        const read = observeAbsorbance(a, spec, rng, ctx.options.noise)
        record.times.push(i * interval)
        record.series[subject.id].push(blank === undefined ? read.value : Number((read.value - blank).toFixed(3)))
        record.display[subject.id] = read.display
      }
      if (flags.length) record.flags[subject.id] = flags
      record.settings.interval = interval
      record.settings.reads = n
      record.settings.blanked = blank === undefined ? 0 : 1
      ctx.world.measurements.push(record)
      return { outputs: { record: record.id }, facts: { record: record.id, wavelength: nm, reads: n } }
    }
    const r = observeAbsorbance(trueA, spec, rng, ctx.options.noise)
    const value = blank === undefined ? r.value : Number((r.value - blank).toFixed(3))
    record.kind = 'scalar'
    record.value = value
    record.display[subject.id] = r.display === 'OVER' ? 'OVER' : value.toFixed(3)
    if ([...r.flags, ...flags].length) record.flags[subject.id] = [...r.flags, ...flags]
    record.settings.blanked = blank === undefined ? 0 : 1
  }
  ctx.world.measurements.push(record)
  // A single cuvette reading also comes back as its value, as the display shows it.
  return { outputs: { record: record.id, ...(record.kind === 'scalar' && record.value !== undefined ? { value: record.value } : {}) }, facts: { record: record.id, wavelength: nm } }
}

/** pH-meter reading: electrode response through the calibration mapping, with noise and 0.01 readability. */
function measurePH(ctx: OpContext, id: string, state: InstrumentState, c: Container): OpResult {
  const v = liquidVolume(c.contents)
  const flags: MeasurementRecord['flags'][string] = []
  const cal = state.calibration ?? { offset: 0, slope: 1, a: 0, b: 1, calibrated: true }
  const truePH = layerPH(ctx.cat, meanLayer(c.contents), c.contents.temperatureK)
  let electrode: number
  if (truePH === undefined || v < 0.5e-3) {
    // The bulb is not immersed: the reading wanders.
    electrode = 7 + ctx.rng('ph').normal(0, 2)
    flags.push('unstable')
  } else electrode = 7 + (truePH - 7) * cal.slope + cal.offset
  const shown = Math.round((cal.a + cal.b * electrode + ctx.rng('ph').normal(0, 0.005 * ctx.options.noise)) * 100) / 100
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: { calibrated: cal.calibrated ? 1 : 0 },
    subject: c.id,
    kind: 'scalar',
    quantity: 'pH',
    unit: '[pH]',
    value: shown,
    display: { [c.id]: shown.toFixed(2) },
    flags: flags.length ? { [c.id]: flags } : {},
    uncertainty: { random: 0.005, resolution: 0.01 },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, value: shown }, facts: { record: record.id, pH: shown, calibrated: cal.calibrated } }
}

/** The silver–silver chloride reference (3 M KCl) against the standard hydrogen electrode, V. */
const AG_AGCL_V = 0.21

/**
 * A platinum electrode against Ag/AgCl: the solution's redox potential in mV. Without a redox
 * couple in the solution there is nothing to set the platinum's potential, and the reading drifts.
 */
function measurePotential(ctx: OpContext, id: string, c: Container): OpResult {
  const v = liquidVolume(c.contents)
  const flags: MeasurementRecord['flags'][string] = []
  const E = v >= 0.5e-3 ? layerSpeciation(ctx.cat, meanLayer(c.contents), c.contents.temperatureK).potentialV : undefined
  let mV: number
  if (E === undefined) {
    mV = 200 + ctx.rng('orp').normal(0, 80)
    flags.push('unstable')
  } else mV = (E - AG_AGCL_V) * 1000 + ctx.rng('orp').normal(0, 0.8 * ctx.options.noise)
  const shown = Math.round(mV)
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: { reference: 'Ag/AgCl' },
    subject: c.id,
    kind: 'scalar',
    quantity: 'potential',
    unit: 'mV',
    value: shown,
    display: { [c.id]: `${shown} mV` },
    flags: flags.length ? { [c.id]: flags } : {},
    uncertainty: { random: 0.8, resolution: 1 },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, value: shown }, facts: { record: record.id, mV: shown } }
}

/** Cells in a square beyond which nobody can count them. */
const SQUARE_COUNTABLE = 300

/** Count cells in the squares of a counting chamber under the microscope. */
function countChamber(ctx: OpContext, id: string, c: Container, p: Params): OpResult {
  if (liquidVolume(c.contents) <= 0) ctx.refuse('EMPTY', `Load ${c.label} first`)
  const squares = Number(p.squares ?? 4)
  if (!Number.isInteger(squares) || squares < 1 || squares > 25) ctx.refuse('BAD-SQUARES', 'Count between 1 and 25 squares')
  const squareL = parseValue(String(ctx.cat.property(c.equipment, 'squareVolume') ?? '0.1 uL')).si * 1000
  const counts = countSquares(ctx.cat, c.contents, squares, squareL, ctx.rng('chamber'))
  const tooMany = counts.some((x) => x.clear + x.blue > SQUARE_COUNTABLE)
  const display = tooMany
    ? 'too many cells to count: dilute further'
    : counts.map((x, i) => `square ${i + 1}: ${x.clear} clear${x.blue ? `, ${x.blue} blue` : ''}`).join('; ')
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: { squares, squareVolumeUl: squareL * 1e6 },
    subject: c.id,
    kind: 'array',
    quantity: 'count',
    unit: '{cells}',
    ...(tooMany ? {} : { values: Object.fromEntries(counts.map((x, i) => [`square-${i + 1}`, x.clear])) }),
    display: { [c.id]: display },
    flags: tooMany ? { [c.id]: ['too-many'] } : {},
    uncertainty: { resolution: 1 },
  }
  ctx.world.measurements.push(record)
  return {
    outputs: { record: record.id, ...(tooMany ? {} : { counts: counts.map((x) => x.clear), blue: counts.map((x) => x.blue) }) },
    facts: { record: record.id, squares, tooMany },
  }
}

/** Colonies the counter can resolve; beyond this a plate is "too many to count", and a lawn beyond LAWN. */
const COUNTABLE = 1000
const LAWN = 5000

/** Count colonies on a plate. Colonies on an unspread plate run together where the drop sat. */
/**
 * Read the inhibition zones round each disc on a plate with a ruler, to the nearest millimetre
 * (diameters, the disc included). The lawn must have grown for there to be edges to read.
 */
function readZones(ctx: OpContext, id: string, c: Container): OpResult {
  if (!c.contents.discs?.length) ctx.refuse('NO-DISCS', `${c.label} has no antibiotic discs`)
  const zones = zonesOn(ctx.cat, c)
  const rng = ctx.rng('ruler')
  const values: Record<string, number> = {}
  const display: Record<string, string> = {}
  const flags: MeasurementRecord['flags'] = {}
  if (!zones) {
    display[c.id] = 'no confluent lawn: the zones have no edges to read'
    flags[c.id] = ['no-lawn']
  } else {
    for (const z of zones) {
      // Where the edge falls between millimetre marks is a matter of judgement.
      const mm = Math.max(DISC_MM, Math.round(z.diameterMm + rng.normal(0, 0.4)))
      values[z.disc] = mm
      display[z.disc] = `${mm} mm${mm <= DISC_MM ? ' (no zone)' : ''}${z.coloniesInside ? ', colonies inside the zone' : ''}`
    }
  }
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: { discs: c.contents.discs!.length },
    subject: c.id,
    kind: 'array',
    quantity: 'length',
    unit: 'mm',
    values,
    display,
    flags,
    uncertainty: { resolution: 1 },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id }, facts: { record: record.id, zones: values } }
}

function countColonies(ctx: OpContext, id: string, c: Container): OpResult {
  if (ctx.cat.property(c.equipment, 'agar') !== true) ctx.refuse('NOT-A-PLATE', `${c.label} is not an agar plate`)
  const views = coloniesOn(ctx.cat, c.contents)
  const total = views.reduce((a, v) => a + v.colonies, 0)
  const unspread = Object.values(c.contents.surface ?? {}).some((s) => (s.founders ?? 0) > 0 && !s.spread)
  const seen = unspread ? Math.round(total * 0.3) : total
  const kinds = [...new Set(views.map((v) => v.appearance))]
  const flags: MeasurementRecord['flags'][string] = []
  let value: number | undefined = seen
  let display = seen === 0 ? 'no colonies' : `${seen} colonies (${kinds.join('; ')})`
  // A spot plate has its spots even where nothing grew.
  const laid = laidSpots(c.contents)
  const sectors = Math.max(laid, ...views.map((v) => v.bySector?.length ?? 0))
  let bySector: Array<number | null> | undefined
  if (sectors > 0) {
    // A streak plate: describe each sector; the count is of the most dilute separate colonies.
    const parts = describeSectors(views, laid)
    bySector = sectorCounts(views, laid)
    const iso = isolatedSector(views)
    value = iso >= 0 ? views.reduce((a, v) => a + (v.bySector?.[iso] ?? 0), 0) : undefined
    display = parts.join('; ')
    const record: MeasurementRecord = {
      id: ctx.newId('m'),
      event: ctx.eventIndex,
      timeS: ctx.world.timeS,
      instrument: id,
      settings: { streak: sectors },
      subject: c.id,
      kind: 'scalar',
      quantity: 'count',
      unit: '{colonies}',
      ...(value !== undefined ? { value } : {}),
      display: { [c.id]: display },
      flags: value === undefined ? { [c.id]: ['too-many'] } : {},
      uncertainty: { resolution: 1 },
      features: views.map((v) => ({ shape: 'colonies', arrangement: v.appearance, colour: '', abundance: v.colonies > 0 ? 'many' : 'none' })),
    }
    ctx.world.measurements.push(record)
    return { outputs: { record: record.id, count: value ?? null, display, ...(bySector ? { bySector } : {}) }, facts: { record: record.id, count: value ?? null, total } }
  }
  if (total > LAWN) {
    value = undefined
    flags.push('lawn')
    display = `a lawn of growth (${kinds.join('; ')})`
  } else if (total > COUNTABLE) {
    value = undefined
    flags.push('too-many')
    display = `too many colonies to count (${kinds.join('; ')})`
  }
  if (unspread && total > 0) {
    flags.push('unspread')
    display += '; growth is confined to where the drop sat'
  }
  // A faint lawn of microcolonies behind the colonies (an auxotroph's few divisions on a trace of
  // its growth factor), cleared where a disc's mutagen killed everything.
  if (backgroundLawn(c.contents)) {
    display += ', on a faint background lawn'
    for (const d of c.contents.discs ?? []) {
      const across = Number(parseValue(String(ctx.cat.property(ctx.world.containers[d.container]?.equipment ?? '', 'diameter') ?? `${DISC_MM} mm`)).si * 1000)
      const cleared = 20 * (d.clearedCm ?? 0)
      if (cleared > across + 1) display += `; no background growth within a ${Math.round(cleared)} mm circle round ${ctx.world.containers[d.container]?.label ?? 'the disc'}`
    }
  }
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: {},
    subject: c.id,
    kind: 'scalar',
    quantity: 'count',
    unit: '{colonies}',
    ...(value !== undefined ? { value } : {}),
    display: { [c.id]: display },
    flags: flags.length ? { [c.id]: flags } : {},
    uncertainty: { resolution: 1 },
    features: views.map((v) => ({ shape: 'colonies', arrangement: v.appearance, colour: '', abundance: v.colonies > 0 ? 'many' : 'none' })),
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, count: value ?? null, display }, facts: { record: record.id, count: value ?? null, total } }
}

/** Image a stained gel: band positions (mm from the wells) and how strong they look, lane by lane. */
function imageGel(ctx: OpContext, id: string, gel: Container): OpResult {
  if (gel.kind !== 'plate' || ctx.cat.property(gel.equipment, 'gel') !== true) ctx.refuse('NOT-A-GEL', `${gel.label} is not a gel`)
  const lengthMm = Number(ctx.cat.property(gel.equipment, 'lengthMm') ?? 80)
  // A label imager (fluorescence) sees only labelled DNA, whatever the gel is stained with.
  const labelOnly = ctx.cat.property(ctx.world.equipment[id].equipment, 'detects') === 'label'
  const stained = labelOnly || ctx.cat.property(gel.equipment, 'stained') !== false
  const labelled = (key: string) => ctx.cat.substances.get(key.split(/[#+]/)[0])?.dna?.label !== undefined
  const matrix = gelMatrix(ctx.cat, gel.equipment)
  const rng = ctx.rng('gel')
  const bands: NonNullable<MeasurementRecord['bands']> = []
  const parts: string[] = []
  for (const w of gel.wells ?? []) {
    const lane = ctx.world.containers[w]
    const seen = stained ? laneBands(ctx.cat, lane.contents, lengthMm, labelOnly ? { ...matrix, detectNg: matrix.detectNg / 100, saturateNg: matrix.saturateNg / 10 } : matrix, labelOnly ? labelled : undefined).bands : []
    for (const b of seen) {
      bands.push({
        lane: w,
        positionMm: Math.round((b.positionMm + rng.normal(0, 0.15 * ctx.options.noise)) * 10) / 10,
        intensity: b.intensity,
        // Integrated signal, with the imager's few-percent scatter.
        volume: Math.max(0, Number((b.ng * (1 + rng.normal(0, 0.03 * ctx.options.noise))).toPrecision(4))),
      })
    }
    const mine = bands.filter((b) => b.lane === w)
    if (liquidVolume(lane.contents) > 0 || mine.length) parts.push(`lane ${lane.position?.replace(/^A/, '') ?? w}: ${mine.length ? mine.map((b) => `${b.intensity} band at ${b.positionMm.toFixed(1)} mm`).join(', ') : 'no bands'}`)
  }
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: { stained: stained ? 1 : 0 },
    subject: gel.id,
    kind: 'observation',
    quantity: 'appearance',
    unit: 'mm',
    display: { [gel.id]: parts.length ? parts.join('; ') : 'nothing to see' },
    flags: {},
    uncertainty: { random: 0.15, resolution: 0.1 },
    bands,
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id }, facts: { record: record.id, bands: bands.length } }
}

/**
 * Look at a developed TLC plate under UV: at 254 nm the plate's indicator glows and compounds that
 * absorb there show as dark spots (positions in mm from the origin, and the solvent front); under
 * long-wave light the indicator does not glow and nothing shows.
 */
/** A TLC plate under a UV lamp, or (`daylight`) looked at by eye: coloured spots show in their colours. */
export function viewTlc(ctx: OpContext, id: string, plate: Container, daylight = false): OpResult {
  const nm = daylight ? 550 : parseValue(String(ctx.cat.property(ctx.world.equipment[id].equipment, 'wavelength') ?? '365 nm')).si * 1e9
  const tlc = plate.contents.tlc
  const shortWave = nm < 300 || daylight
  const rng = ctx.rng('tlc-view')
  const bands: NonNullable<MeasurementRecord['bands']> = []
  const parts: string[] = []
  if (tlc?.developed && shortWave) {
    for (const [lane, load] of Object.entries(tlc.lanes).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const spots = laneSpots(ctx.cat, Number(lane), load, tlc.developed.positions[lane] ?? {}, daylight ? 'daylight' : 'uv')
      for (const sp of spots) bands.push({ lane: `${plate.id}#${lane}`, positionMm: Math.round((sp.positionMm + rng.normal(0, 0.3 * ctx.options.noise)) * 10) / 10, intensity: sp.intensity })
      const mine = bands.filter((b) => b.lane === `${plate.id}#${lane}`)
      parts.push(`lane ${lane}: ${mine.length ? mine.map((b, k) => `${b.intensity} ${spots[k].colour ? `${spots[k].colour} ` : ''}spot at ${b.positionMm.toFixed(1)} mm (${spots[k].diameterMm.toFixed(0)} mm across)`).join(', ') : 'no spots'}`)
    }
  }
  const frontMm = tlc?.developed ? Math.round((tlc.developed.frontMm + rng.normal(0, 0.3 * ctx.options.noise)) * 10) / 10 : undefined
  const display = !tlc?.developed
    ? 'the plate has not been developed'
    : !shortWave
      ? 'nothing shows: the indicator only glows under short-wave (254 nm) light'
      : `${parts.length ? parts.join('; ') : 'no spots'}; solvent front at ${frontMm!.toFixed(1)} mm`
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: { wavelength: nm, ...(frontMm !== undefined && shortWave ? { frontMm } : {}) },
    subject: plate.id,
    kind: 'observation',
    quantity: 'appearance',
    unit: 'mm',
    display: { [plate.id]: display },
    flags: {},
    uncertainty: { random: 0.3, resolution: 0.1 },
    bands,
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, appearance: display, ...(frontMm !== undefined && shortWave ? { front: `${frontMm} mm` } : {}) }, facts: { record: record.id, spots: bands.length } }
}

/** Read a liquid's temperature: the instrument's own small offset (fixed per instance) plus scatter. */
function measureTemperature(ctx: OpContext, id: string, c: Container): OpResult {
  // A thermometer frozen into a solid that was melted around it (a cooling curve) still reads it.
  if (liquidVolume(c.contents) <= 0 && !Object.values(c.contents.solid).some((n) => n > 0)) ctx.refuse('NOTHING-TO-READ', `${c.label} has no liquid to dip into`)
  const offset = Math.max(-1, Math.min(1, createRng(`${ctx.world.seed}|thermometer|${id}`).normal())) * 0.3
  const shown = Math.round((c.contents.temperatureK - 273.15 + offset * ctx.options.noise + ctx.rng('thermometer').normal(0, 0.03 * ctx.options.noise)) * 10) / 10
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: {},
    subject: c.id,
    kind: 'scalar',
    quantity: 'temperature',
    unit: 'Cel',
    value: shown,
    display: { [c.id]: `${shown.toFixed(1)} °C` },
    flags: {},
    uncertainty: { random: 0.03, resolution: 0.1 },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, value: shown }, facts: { record: record.id, celsius: shown } }
}

/** Look at a plate under long-wave UV: which colonies glow. */
function lookUnderUV(ctx: OpContext, id: string, c: Container): OpResult {
  const views = coloniesOn(ctx.cat, c.contents)
  const glowing = views.filter((v) => v.fluorescent).reduce((a, v) => a + v.colonies, 0)
  const dark = views.filter((v) => !v.fluorescent).reduce((a, v) => a + v.colonies, 0)
  const parts = [glowing > 0 ? 'green fluorescent colonies' : '', dark > 0 ? 'colonies that do not fluoresce' : ''].filter(Boolean)
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: { light: 'UV, long-wave' },
    subject: c.id,
    kind: 'observation',
    quantity: 'appearance',
    unit: '',
    display: { [c.id]: parts.length ? parts.join('; ') : 'nothing glows' },
    flags: {},
    uncertainty: {},
    features: [
      ...(glowing > 0 ? [{ shape: 'colonies', arrangement: '', colour: 'green fluorescent', abundance: 'many' }] : []),
      ...(dark > 0 ? [{ shape: 'colonies', arrangement: '', colour: 'not fluorescent', abundance: 'many' }] : []),
    ],
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, fluorescent: glowing > 0 }, facts: { record: record.id, fluorescent: glowing > 0 } }
}

/**
 * Maxima of a trace (x ascending): on the trace smoothed over five points, each local maximum whose
 * prominence (its height above the higher of the lowest points between it and anything taller on
 * either side) is a share of the trace's range, so noise ripples are not peaks; refined by a parabola.
 */
function traceMaxima(xs: number[], ys: number[], share = 0.03): number[] {
  const sm = ys.map((_, i) => {
    const w = ys.slice(Math.max(0, i - 2), Math.min(ys.length, i + 3))
    return w.reduce((a, b) => a + b, 0) / w.length
  })
  const range = Math.max(...sm) - Math.min(...sm)
  const out: number[] = []
  for (let i = 1; i < sm.length - 1; i++) {
    if (!(sm[i] > sm[i - 1] && sm[i] >= sm[i + 1])) continue
    let left = sm[i]
    for (let j = i - 1; j >= 0 && sm[j] <= sm[i]; j--) left = Math.min(left, sm[j])
    let right = sm[i]
    for (let j = i + 1; j < sm.length && sm[j] <= sm[i]; j++) right = Math.min(right, sm[j])
    if (sm[i] - Math.max(left, right) < share * range) continue
    const d = sm[i - 1] - 2 * sm[i] + sm[i + 1]
    out.push(Math.round((xs[i] + (d !== 0 ? (0.5 * (sm[i - 1] - sm[i + 1])) / d : 0) * (xs[i + 1] - xs[i])) * 10) / 10)
  }
  return out
}

/** The range of a scan (nm): `from` and `to`, within what the instrument covers. */
function scanRange(ctx: OpContext, p: Params, lo: number, hi: number): [number, number] {
  const from = ctx.quantity(p.from, 'length', 'from').si * 1e9
  const to = ctx.quantity(p.to, 'length', 'to').si * 1e9
  if (!(to > from)) ctx.refuse('BAD-RANGE', 'Scan from a shorter to a longer wavelength')
  if (from < lo - 1e-6 || to > hi + 1e-6) ctx.refuse('WAVELENGTH', `This instrument covers ${lo}–${hi} nm`)
  return [Math.round(from), Math.round(to)]
}

/** An absorbance spectrum: the cuvette read every 2 nm across a range (its vessel's absorbance included). */
function scanAbsorbance(ctx: OpContext, id: string, equipment: string, c: Container, p: Params): OpResult {
  if (!ctx.cat.isA(c.equipment, 'core:cuvette')) ctx.refuse('NOT-A-CUVETTE', 'Scans are read in a cuvette')
  const spec = photometerSpec(ctx.cat, equipment)
  const [from, to] = scanRange(ctx, p, spec.wavelengthMin, spec.wavelengthMax)
  const pathCm = (c.pathLengthM ?? 0.01) * 100
  const rng = ctx.rng('scan')
  const xs: number[] = []
  const ys: number[] = []
  for (let nm = from; nm <= to; nm += 2) {
    xs.push(nm)
    ys.push(observeAbsorbance(sampleAbsorbance(ctx.cat, c, nm, pathCm) + vesselAbsorbance(c.material, nm), spec, rng, ctx.options.noise).value)
  }
  const maxima = traceMaxima(xs, ys)
  const record: MeasurementRecord = {
    id: ctx.newId('m'), event: ctx.eventIndex, timeS: ctx.world.timeS, instrument: id, settings: { mode: 'scan', from, to }, subject: c.id,
    kind: 'series', quantity: 'absorbance', unit: 'AU', axis: { label: 'wavelength', unit: 'nm', values: xs }, series: { [c.id]: ys }, peaks: { [c.id]: maxima },
    display: { [c.id]: `maxima at ${maxima.map((x) => x.toFixed(0)).join(', ') || 'none'} nm` }, flags: {}, uncertainty: { random: spec.noise, resolution: spec.readability },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, wavelengths: xs, absorbance: ys, maxima }, facts: { record: record.id, points: xs.length } }
}

/** An emission spectrum: the cuvette excited at one wavelength, the emitted light scanned across a range. */
function measureFluorescence(ctx: OpContext, id: string, c: Container, p: Params): OpResult {
  if (!ctx.cat.isA(c.equipment, 'core:cuvette')) ctx.refuse('NOT-A-CUVETTE', 'Fluorescence is read in a cuvette')
  if (c.material !== 'quartz') ctx.refuse('NOT-QUARTZ', 'Use a quartz cuvette: plastic ones fluoresce and absorb in the UV')
  const exNm = wavelengthNm(ctx, p.wavelength)
  const [from, to] = scanRange(ctx, p, 250, 800)
  if (from <= exNm + 10) ctx.refuse('OVERLAP', 'Start the emission scan at least 10 nm above the excitation wavelength (scattered light)')
  const s = emissionSpectrum(ctx.cat, c, exNm, from, to)
  const rng = ctx.rng('fluorescence')
  // A little scattered light and dark noise under every spectrum.
  const ys = s.intensity.map((i) => Math.max(0, Math.round(i * (1 + rng.normal(0, 0.01 * ctx.options.noise)) + 20 + rng.normal(0, 5 * ctx.options.noise))))
  const top = Math.max(...ys)
  const at = s.wavelengths[ys.indexOf(top)]
  const record: MeasurementRecord = {
    id: ctx.newId('m'), event: ctx.eventIndex, timeS: ctx.world.timeS, instrument: id, settings: { excitation: exNm, from, to }, subject: c.id,
    kind: 'series', quantity: 'fluorescence', unit: 'counts', axis: { label: 'emission wavelength', unit: 'nm', values: s.wavelengths }, series: { [c.id]: ys }, peaks: { [c.id]: traceMaxima(s.wavelengths, ys) },
    display: { [c.id]: `emission maximum ${at} nm, ${top} counts (excitation ${exNm} nm)` }, flags: {}, uncertainty: { resolution: 2 },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, wavelengths: s.wavelengths, intensity: ys, emissionMax: at, intensityMax: top }, facts: { record: record.id, excitation: exNm } }
}

/** Electrospray mass spectrum: a few microlitres infused in positive or negative mode; the peaks (m/z, relative intensity). */
function measureMassSpectrum(ctx: OpContext, id: string, c: Container, p: Params): OpResult {
  if (liquidVolume(c.contents) < 5e-6) ctx.refuse('TOO-LITTLE', `${c.label} has too little solution to infuse (5 µL at least)`)
  const polarity: Polarity = p.polarity === 'negative' ? 'negative' : 'positive'
  const native = p.conditions === 'native'
  const { peaks, tic: trueTic } = esiSpectrum(ctx.cat, c.contents, polarity, native)
  if (peaks.length === 0) ctx.refuse('NO-IONS', `Nothing in ${c.label} gives ions in ${polarity} mode`)
  const tic = Number((trueTic * (1 + ctx.rng('esi-tic').normal(0, 0.1 * ctx.options.noise))).toPrecision(2))
  const rng = ctx.rng('esi')
  const seen = peaks.map((x) => ({ mz: Math.round((x.mz + rng.normal(0, 0.05 * ctx.options.noise)) * 10) / 10, intensity: Math.round(Math.max(0, x.intensity * (1 + rng.normal(0, 0.03 * ctx.options.noise))) * 10) / 10 }))
  const top = Math.max(...seen.map((x) => x.intensity))
  const shown = seen.map((x) => ({ mz: x.mz, intensity: Math.round((1000 * x.intensity) / top) / 10 }))
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: { polarity, conditions: native ? 'native' : 'denaturing', tic },
    subject: c.id,
    kind: 'series',
    quantity: 'count',
    unit: '%',
    axis: { label: 'm/z', unit: 'Th', values: shown.map((x) => x.mz) },
    series: { [c.id]: shown.map((x) => x.intensity) },
    peaks: { [c.id]: shown.map((x) => x.mz) },
    display: { [c.id]: `TIC ${tic.toExponential(1)}; ` + [...shown].sort((a, b) => b.intensity - a.intensity).slice(0, 8).map((x) => `${x.mz.toFixed(1)} (${x.intensity.toFixed(0)})`).join(', ') },
    flags: {},
    uncertainty: { resolution: 0.1 },
  }
  ctx.world.measurements.push(record)
  const base = shown.reduce((a, b) => (b.intensity > a.intensity ? b : a))
  return { outputs: { record: record.id, mz: shown.map((x) => x.mz), intensity: shown.map((x) => x.intensity), base: base.mz, tic }, facts: { record: record.id, peaks: shown.length, polarity, tic } }
}

/** Infrared (ATR): a little of the sample on the crystal; the spectrum and the bands an analyst picks out. */
function measureInfrared(ctx: OpContext, id: string, c: Container): OpResult {
  const spectrum = irSpectrum(ctx.cat, c.contents)
  if (!spectrum) ctx.refuse('NOTHING-TO-SEE', `Nothing in ${c.label} shows in the infrared`)
  const rng = ctx.rng('infrared')
  const t = spectrum.transmittance.map((x) => Math.max(0, Math.min(100, Math.round((x + rng.normal(0, 0.4 * ctx.options.noise)) * 10) / 10)))
  const bands = spectrum.bands
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: { from: spectrum.wavenumbers[0], to: spectrum.wavenumbers[spectrum.wavenumbers.length - 1] },
    subject: c.id,
    kind: 'series',
    quantity: 'absorbance',
    unit: '%T',
    axis: { label: 'wavenumber', unit: 'cm-1', values: spectrum.wavenumbers },
    series: { [c.id]: t },
    peaks: { [c.id]: bands.map((b) => b.wavenumber) },
    display: { [c.id]: bands.map(bandText).join(', ') },
    flags: {},
    uncertainty: { resolution: 2 },
  }
  ctx.world.measurements.push(record)
  return {
    outputs: { record: record.id, peaks: bands.map((b) => b.wavenumber), broad: bands.filter((b) => b.broad).map((b) => b.wavenumber), bands: bands.map(bandText) },
    facts: { record: record.id, bands: bands.length },
  }
}

/** Melting point: a capillary of the sample heated slowly; the onset and the clear point are read. */
function measureMeltingPoint(ctx: OpContext, id: string, c: Container): OpResult {
  const range = meltingRange(ctx.cat, c.contents)
  if (!range) ctx.refuse('NOTHING-MELTS', `Nothing in ${c.label} melts in this apparatus`)
  const rng = ctx.rng('melting')
  const read = (k: number) => Math.round((k - 273.15 + rng.normal(0, 0.2 * ctx.options.noise)) * 10) / 10
  const clear = read(range.clearK)
  const onset = Math.min(clear - 0.1, read(range.onsetK))
  const flags: MeasurementRecord['flags'][string] = []
  if (range.residue) flags.push('residue')
  if (range.wet) flags.push('wet')
  const notes = [range.residue ? 'a solid residue does not melt' : '', range.wet ? 'the sample sweats and bubbles' : ''].filter(Boolean)
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: {},
    subject: c.id,
    kind: 'scalar',
    quantity: 'temperature',
    unit: 'Cel',
    value: clear,
    range: [onset, clear],
    display: { [c.id]: `${onset.toFixed(1)}–${clear.toFixed(1)} °C${notes.length ? ` (${notes.join('; ')})` : ''}` },
    flags: flags.length ? { [c.id]: flags } : {},
    uncertainty: { random: 0.2, resolution: 0.1 },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, onset: `${onset} Cel`, clear: `${clear} Cel` }, facts: { record: record.id, onset, clear } }
}

/** Two-point pH calibration: map the electrode response onto the labelled pH of two buffers. */
function calibratePH(ctx: OpContext, state: InstrumentState, buffers: unknown): OpResult {
  if (!Array.isArray(buffers) || buffers.length !== 2) ctx.refuse('TWO-BUFFERS', 'A two-point calibration needs two buffers')
  const cal = state.calibration ?? { offset: 0, slope: 1, a: 0, b: 1, calibrated: false }
  const points = (buffers as unknown[]).map((ref) => {
    const c = ctx.container(ref, 'buffer')
    const prep = c.labelled?.preparation ? ctx.cat.preparations.get(c.labelled.preparation) : undefined
    if (prep?.pH === undefined) ctx.refuse('NOT-A-BUFFER', `${c.label} has no labelled pH`)
    const truePH = layerPH(ctx.cat, meanLayer(c.contents), c.contents.temperatureK)
    if (truePH === undefined) ctx.refuse('EMPTY', `${c.label} is empty`)
    return { label: prep.pH, electrode: 7 + (truePH - 7) * cal.slope + cal.offset }
  })
  const [p1, p2] = points
  if (Math.abs(p2.electrode - p1.electrode) < 0.5) ctx.refuse('BUFFERS-TOO-CLOSE', 'The two buffers must differ by at least half a pH unit')
  const b = (p2.label - p1.label) / (p2.electrode - p1.electrode)
  state.calibration = { ...cal, a: p1.label - b * p1.electrode, b, calibrated: true }
  return { facts: { slope: b, buffers: points.map((x) => x.label) } }
}

function calibrate(ctx: OpContext, p: Params): OpResult {
  const inst = ctx.equipment(p.instrument, 'instrument')
  if (inst.state.kind === 'instrument' && ctx.cat.isA(inst.equipment, 'core:ph-meter')) return calibratePH(ctx, inst.state, p.buffers)
  if (inst.state.kind !== 'instrument' || !ctx.cat.isA(inst.equipment, 'core:spectrophotometer')) {
    ctx.refuse('UNSUPPORTED-INSTRUMENT', `${inst.label} cannot be blanked this way`)
  }
  const ref = ctx.container(p.reference, 'reference')
  if (!ctx.cat.isA(ref.equipment, 'core:cuvette')) ctx.refuse('NOT-A-CUVETTE', 'Blank with a cuvette')
  const nm = wavelengthNm(ctx, p.wavelength)
  const spec = photometerSpec(ctx.cat, inst.equipment)
  const trueA = sampleAbsorbance(ctx.cat, ref, nm, (ref.pathLengthM ?? 0.01) * 100) + vesselAbsorbance(ref.material, nm)
  const r = observeAbsorbance(trueA, spec, ctx.rng('blank'), ctx.options.noise)
  inst.state.blanks = { ...(inst.state.blanks ?? {}), [String(Math.round(nm))]: r.value }
  return { facts: { wavelength: nm, blank: r.value } }
}

/** Read a graduated vessel. Burettes are read from the top (the scale gives the volume delivered). */
function readVolume(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.container)
  // A sealed syringe of gas: the gas's volume on its scale.
  if (c.gasSample) return readGasSample(ctx, c)
  const dispensing = ctx.cat.property(c.equipment, 'dispensing') === true
  // A burette, or a potometer's capillary, is read from the top: how much has left it.
  const fromTop = dispensing || ctx.cat.property(c.equipment, 'scale') === 'from-top'
  const graduated = ctx.cat.property(c.equipment, 'graduated')
  if (!fromTop && (graduated === undefined || graduated === 'approximate') && c.nominalL === undefined) {
    ctx.refuse('NOT-GRADUATED', `${c.label} has no scale to read`)
  }
  const v = liquidVolume(c.contents)
  const scaleL = fromTop ? c.capacityL - v : v
  const resText = ctx.cat.property(c.equipment, 'resolution')
  const resolutionL = resText !== undefined ? parseValue(String(resText)).si * 1000 : (c.toleranceL ?? 1e-4)
  // Reading a meniscus: a small parallax error, then rounding to the half-graduation read.
  const readL = scaleL + ctx.options.handlingError * ctx.rng('meniscus').normal(0, resolutionL / 4)
  const step = resolutionL * 1000
  const mL = Math.round((readL * 1000) / step) * step
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))
  const value = Number(mL.toFixed(decimals))
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: c.id,
    settings: { scale: fromTop ? 'from-top' : 'from-bottom' },
    subject: c.id,
    kind: 'scalar',
    quantity: 'volume',
    unit: 'mL',
    value,
    display: { [c.id]: `${value.toFixed(decimals)} mL` },
    flags: {},
    uncertainty: { resolution: step },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, value: `${value} mL` }, facts: { record: record.id, mL: value } }
}

// ---- Containers, waste, protection ----

function label(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.container)
  if (typeof p.text !== 'string') ctx.refuse('BAD-LABEL', 'A label needs text')
  // Written in the middle of a slide, where the light passes, it is something to look at.
  if (p.position === 'centre') (c.marks ??= []).push(p.text)
  else c.userLabel = p.text
  return { facts: { text: p.text, position: p.position === 'centre' ? 'centre' : 'label' } }
}

function dispose(ctx: OpContext, p: Params): OpResult {
  const stream = refId(p.stream)
  if (!stream || !ctx.cat.isWasteStream(stream)) ctx.refuse('UNKNOWN-STREAM', `There is no waste stream "${String(stream)}"`)
  if (p.item !== undefined && p.item !== null) {
    // A used tool: a syringe and needle go in the sharps bin, and nowhere else.
    const inst = ctx.equipment(p.item, 'item')
    if (inst.state.kind !== 'tool') ctx.refuse('NOT-DISPOSABLE', `${inst.label} is not thrown away after use`)
    const state = inst.state as ToolState
    if (state.discarded) ctx.refuse('DISCARDED', `${inst.label} has already been thrown away`)
    state.discarded = true
    const sharp = ctx.cat.property(inst.equipment, 'sharp') === true
    const intoSharps = ctx.cat.property(stream, 'sharps') === true
    if (sharp && !intoSharps) {
      ctx.world.incidents.push({ event: ctx.eventIndex, kind: 'exposure', severity: 'practice', equipment: inst.equipment, message: `${inst.label} went into ${stream}, not a sharps bin: a needlestick waiting for whoever empties it` })
    }
    ctx.world.disposals.push({ event: ctx.eventIndex, container: inst.id, stream, materials: [], volumeL: 0 })
    return { facts: { stream, item: inst.id, sharp, intoSharps } }
  }
  const c = ctx.container(p.container)
  const targets = c.kind === 'plate' ? [c, ...(c.wells ?? []).map((w) => ctx.world.containers[w])] : [c]
  let volume = 0
  const materials = new Set<string>()
  for (const t of targets) {
    volume += liquidVolume(t.contents)
    for (const o of t.origins ?? []) materials.add(o)
    t.contents.layers = []
    t.contents.solid = {}
  }
  if (c.kind !== 'well') for (const t of targets) t.discarded = true
  ctx.world.disposals.push({ event: ctx.eventIndex, container: c.id, stream, materials: [...materials], volumeL: volume })
  return { facts: { stream, materials: [...materials], volumeL: volume } }
}

function open(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.container)
  c.open = true
  // A septum comes off with its balloon: the room's air comes in (models/gases.ts).
  if (c.septum) {
    c.septum = false
    delete c.balloon
    c.headspaceAir ??= 1
  }
  // Taking off a lid or cap leaves the vessel exposed to the air (and its rim handled) until it goes back on.
  const closure = ctx.cat.property(c.equipment, 'closure')
  if (closure !== undefined && closure !== 'none') {
    c.uncovered = true
    c.neck = 'handled'
  }
  return {}
}

function close(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.container)
  // A vessel without a cap or stopper of its own can still be sealed with a square of Parafilm.
  if (p.cover === 'septum') {
    // A rubber septum folded over the neck: sealed, but a needle can pass.
    c.septum = true
    c.uncovered = false
    c.open = false
    return { facts: { cover: 'septum' } }
  }
  if (p.cover !== 'parafilm' && ctx.cat.property(c.equipment, 'closure') === 'none') ctx.refuse('NO-CLOSURE', `${c.label} has no closure of its own: cover it with Parafilm`)
  // The cap going back on passes the rim once more.
  if (c.uncovered) rimContact(ctx.cat, ctx.world, c, ctx.eventIndex)
  c.uncovered = false
  c.open = false
  return {}
}

const PPE = ['lab-coat', 'gloves', 'goggles', 'face-shield']

function don(ctx: OpContext, p: Params): OpResult {
  if (typeof p.item !== 'string' || !PPE.includes(p.item)) ctx.refuse('BAD-ITEM', 'Unknown protective equipment')
  if (!ctx.world.operator.ppe.includes(p.item)) ctx.world.operator.ppe.push(p.item)
  return {}
}

function doff(ctx: OpContext, p: Params): OpResult {
  ctx.world.operator.ppe = ctx.world.operator.ppe.filter((x) => x !== p.item)
  return {}
}

export const BENCH_OPERATIONS: Record<string, OpImpl> = {
  'core:fetch': fetchItem,
  'core:transfer': transfer,
  'core:set-volume': setVolume,
  'core:attach-tip': attachTip,
  'core:eject-tip': ejectTip,
  'core:add-solid': addSolid,
  'core:lift-out': liftOut,
  'core:weigh': weigh,
  'core:tare': tare,
  'core:mix': mix,
  'core:make-up-to-mark': makeUpToMark,
  'core:place-in': placeIn,
  'core:remove-from': removeFrom,
  'core:set-environment': setEnvironment,
  'core:advance-time': advanceTime,
  'core:centrifuge': centrifuge,
  'core:measure': measure,
  'core:calibrate': calibrate,
  'core:read-volume': readVolume,
  'core:label': label,
  'core:dispose': dispose,
  'core:open': open,
  'core:close': close,
  'core:don': don,
  'core:doff': doff,
}

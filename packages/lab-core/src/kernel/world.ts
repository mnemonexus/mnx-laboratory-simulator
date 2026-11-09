// Building worlds from catalogue entries: containers, plates, equipment instances and places.
// Used by the stager (compiler) and by tests. Instances are created before the run starts;
// during a run, only operations change the world.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { createRng } from '../rng/rng.ts'
import { parseQuantity, parseValue } from '../units/quantity.ts'
import { layerFrom, labelledFrom, preparationComponents } from './materials.ts'
import type { Container, EquipmentInstance, LabelledComponent, Layer, Place, SurfaceCells, World } from './state.ts'
import { resyncEnthalpy } from '../models/thermochem.ts'
import { inducedAtStart, mutantsAtStart } from '../models/growth.ts'
import { updateGel } from '../models/gelling.ts'

export class WorldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorldError'
  }
}

const ROWS = 'ABCDEFGHIJKLMNOP'

function prop(cat: Catalogue, id: string, name: string): string | number | boolean | undefined {
  return cat.property(id, name)
}

function litres(text: string | number | boolean | undefined, fallback = 0): number {
  if (text === undefined || typeof text === 'boolean') return fallback
  return parseValue(String(text)).si * 1000
}

function massKg(text: string | number | boolean | undefined): number {
  if (text === undefined || typeof text === 'boolean') return 0
  return parseValue(String(text)).si
}

function requireEquipment(cat: Catalogue, id: string) {
  const e = cat.equipment.get(id)
  if (!e) throw new WorldError(`Unknown equipment "${id}"`)
  return e
}

export interface ContainerOptions {
  id: string
  equipment: string
  label?: string
  place?: string
  supply?: string
  role?: string
  open?: boolean
  contents?: Layer
  labelled?: Container['labelled']
}

/** Add a container (tube, bottle, flask, cuvette …) or a plate with its wells. */
export function addContainer(world: World, cat: Catalogue, opts: ContainerOptions): Container {
  const def = requireEquipment(cat, opts.equipment)
  if (world.containers[opts.id]) throw new WorldError(`Container "${opts.id}" already exists`)
  const place = opts.place ?? 'bench'
  const temperatureK = world.places[place]?.temperatureK ?? 294.15
  if (def.kind === 'plate') return addPlate(world, cat, opts, temperatureK)
  const capacityL = litres(prop(cat, def.id, 'capacity'), 1e-3)
  const c: Container = {
    id: opts.id,
    equipment: def.id,
    kind: 'container',
    capacityL,
    deadVolumeL: litres(prop(cat, def.id, 'deadVolume'), 0),
    label: opts.label ?? def.label,
    contents: { layers: opts.contents && opts.contents.volumeL > 0 ? [opts.contents] : [], solid: {}, temperatureK },
    place,
    open: opts.open ?? true,
    tareMassKg: massKg(prop(cat, def.id, 'tareMass')),
    ...(opts.supply ? { supply: opts.supply, origins: [opts.supply] } : {}),
    ...(opts.role ? { role: opts.role } : {}),
    ...(opts.labelled ? { labelled: opts.labelled } : {}),
  }
  const material = prop(cat, def.id, 'material')
  if (typeof material === 'string') c.material = material
  const path = prop(cat, def.id, 'pathLength')
  if (path !== undefined) c.pathLengthM = parseValue(String(path)).si
  const minV = prop(cat, def.id, 'minVolume')
  if (minV !== undefined) c.minVolumeL = litres(minV)
  const nominal = prop(cat, def.id, 'nominal')
  if (nominal !== undefined) c.nominalL = litres(nominal)
  const tol = prop(cat, def.id, 'tolerance')
  if (tol !== undefined) c.toleranceL = litres(tol)
  world.containers[c.id] = c
  return c
}

function addPlate(world: World, cat: Catalogue, opts: ContainerOptions, temperatureK: number): Container {
  const def = requireEquipment(cat, opts.equipment)
  const format = cat.lineage(def.id).find((e) => e.format)?.format
  if (!format) throw new WorldError(`Plate "${def.id}" has no format`)
  const well = format.well
  const plate: Container = {
    id: opts.id,
    equipment: def.id,
    kind: 'plate',
    capacityL: 0,
    deadVolumeL: 0,
    label: opts.label ?? def.label,
    contents: { layers: [], solid: {}, temperatureK },
    place: opts.place ?? 'bench',
    open: true,
    tareMassKg: massKg(prop(cat, def.id, 'tareMass')),
    wells: [],
  }
  const areaText = well.area
  const area = areaText === undefined ? 3.2e-5 : parseValue(String(areaText)).si
  for (let r = 0; r < format.rows; r++) {
    for (let col = 0; col < format.cols; col++) {
      const position = `${ROWS[r]}${col + 1}`
      const id = `${opts.id}/${position}`
      world.containers[id] = {
        id,
        equipment: def.id,
        kind: 'well',
        capacityL: litres(well.capacity as string, 3.5e-4),
        deadVolumeL: litres(well.deadVolume as string, 0),
        label: `${plate.label} ${position}`,
        contents: { layers: [], solid: {}, temperatureK },
        place: plate.place,
        open: true,
        plate: opts.id,
        position,
        tareMassKg: 0,
        areaM2: area,
        material: typeof well.material === 'string' ? well.material : 'polystyrene',
      }
      plate.wells!.push(id)
    }
  }
  world.containers[plate.id] = plate
  return plate
}

/** Add an equipment instance (pipette, balance, reader …). Instruments that hold containers also get a place. */
export function addEquipment(world: World, cat: Catalogue, id: string, equipment: string, label?: string): EquipmentInstance {
  const def = requireEquipment(cat, equipment)
  if (world.equipment[id]) throw new WorldError(`Equipment "${id}" already exists`)
  let inst: EquipmentInstance
  if (def.kind === 'tool') {
    // The instance's systematic error is drawn once per run (a property of this pipette).
    const biasZ = Math.max(-2, Math.min(2, createRng(`${world.seed}|bias|${id}`).normal()))
    // A loop is its own tip: it carries a film from whatever it last touched until it is flamed.
    const tip = cat.property(equipment, 'loop') === true ? { id: `${id}-wire`, touched: [], film: null } : null
    inst = { id, equipment, label: label ?? def.label, state: { kind: 'tool', tip, biasZ } }
  } else if (def.kind === 'instrument') {
    inst = { id, equipment, label: label ?? def.label, state: { kind: 'instrument', blanks: {}, tareKg: 0 } }
    if (cat.isA(equipment, 'core:ph-meter')) {
      // An uncalibrated electrode: offset and slope drift until the meter is calibrated.
      const r = createRng(`${world.seed}|electrode|${id}`)
      ;(inst.state as { calibration?: unknown }).calibration = { offset: r.normal(0, 0.15), slope: 0.97 + r.uniform(-0.02, 0.01), a: 0, b: 1, calibrated: false }
    }
  } else {
    inst = { id, equipment, label: label ?? def.label, state: { kind: 'device' } }
  }
  world.equipment[id] = inst
  if (cat.property(equipment, 'holdsContainers') === true) {
    world.places[id] = { id, equipment, label: inst.label, temperatureK: world.places.bench.temperatureK, adjustable: false, tauS: 900, instrument: id }
  }
  return inst
}

/** Add a place (incubator, water bath, ice bucket, fridge …). */
export function addPlace(world: World, cat: Catalogue, id: string, equipment: string, label?: string, temperature?: string): Place {
  const def = requireEquipment(cat, equipment)
  if (world.places[id]) throw new WorldError(`Place "${id}" already exists`)
  const t = temperature ?? String(cat.property(equipment, 'temperature') ?? '21 Cel')
  const tau = cat.property(equipment, 'thermalTimeConstant')
  const place: Place = {
    id,
    equipment,
    label: label ?? def.label,
    temperatureK: parseValue(t).si,
    adjustable: cat.property(equipment, 'adjustable') === true,
    tauS: tau === undefined ? 600 : parseValue(String(tau)).si,
  }
  const light = cat.property(equipment, 'light')
  if (light !== undefined) place.light = Number(light)
  const humidity = cat.property(equipment, 'humidity')
  if (humidity !== undefined) place.humidity = Number(humidity)
  world.places[id] = place
  return place
}

export interface SupplySpec {
  id: string
  label: string
  container: string
  amount: string
  /** Label composition: either a preparation or components. */
  preparation?: string
  components?: Array<{ substance: string; conc: string }>
  /** Hidden truth composition, if it differs from the label. */
  truth?: Array<{ substance: string; conc: string }>
  /** Scales the amount of every component (old or weak reagent) or the activity of proteins. */
  activityFactor?: number
  role?: string
  place?: string
  /** Solid supplies: the amount is a mass of the substance itself. */
  solid?: string
  /** Solid mixtures: the mass of each component (g). */
  solids?: Array<{ substance: string; massG: number }>
  /** Organisms or cells: count per litre, and the fraction alive (default all). */
  populations?: Array<{ substance: string; perL?: number; total?: number; viable?: number }>
  /** Starting temperature (a supply just taken from storage); default: its place's. */
  temperature?: string
  /** A wet solid's liquid (soil water): its volume, composition and organisms. */
  wet?: { amount: string; preparation?: string; components?: Array<{ substance: string; conc: string }>; populations?: Array<{ substance: string; perL?: number; total?: number }> }
}

/** Add a supply (stock bottle, sample, reagent) with its label and its true contents. */
export function addSupply(world: World, cat: Catalogue, s: SupplySpec): Container {
  const c = stageSupply(world, cat, s)
  const initial: Record<string, number> = {}
  for (const [k, n] of Object.entries(c.contents.solid)) if (n > 0) initial[k] = (initial[k] ?? 0) + n
  for (const l of c.contents.layers) for (const [k, n] of Object.entries(l.species)) if (n > 0) initial[k] = (initial[k] ?? 0) + n
  c.initial = initial
  if (s.temperature) c.contents.temperatureK = parseValue(s.temperature).si
  // Agar below its setting point has set; molten agar is supplied hot.
  updateGel(cat, c)
  // A supply starts at equilibrium: its chemical enthalpy is what it holds now.
  for (const l of c.contents.layers) resyncEnthalpy(cat, l, c.contents.temperatureK)
  return c
}

function stageSupply(world: World, cat: Catalogue, s: SupplySpec): Container {
  if (s.solids) {
    const c = addContainer(world, cat, { id: s.id, equipment: s.container, label: s.label, place: s.place, supply: s.id, role: s.role })
    for (const part of s.solids) {
      const mm = cat.substances.get(part.substance)?.physical?.molarMass
      if (!mm) throw new WorldError(`Solid "${part.substance}" has no molar mass`)
      c.contents.solid[part.substance] = (c.contents.solid[part.substance] ?? 0) + part.massG / (parseValue(mm).si * 1000)
    }
    if (s.wet) {
      // The water the solid holds, with what is dissolved and living in it.
      const volumeL = parseValue(s.wet.amount).si * 1000
      // What dissolves from the solid (a soil's mineral nitrogen) is in its water.
      const released = s.solids.flatMap((part) => (cat.substances.get(part.substance)?.wettable?.releases ?? []).map((r) => ({ substance: r.substance, conc: parseValue(`${(parseValue(r.content).si * part.massG) / volumeL} g/L`) })))
      const layer = layerFrom(cat, [...(s.wet.preparation ? preparationComponents(cat, s.wet.preparation) : []), ...released, ...(s.wet.components ?? []).map((x) => ({ substance: x.substance, conc: parseValue(x.conc) }))], volumeL)
      for (const p of s.wet.populations ?? []) {
        const n = p.total ?? (p.perL ?? 0) * volumeL
        layer.populations ??= {}
        layer.populations[p.substance] = { count: n, viable: n }
      }
      c.contents.layers = [layer]
      resyncEnthalpy(cat, layer, c.contents.temperatureK)
    }
    c.labelled = { components: [] }
    return c
  }
  if (s.solid) {
    const c = addContainer(world, cat, { id: s.id, equipment: s.container, label: s.label, place: s.place, supply: s.id, role: s.role })
    const mm = cat.substances.get(s.solid)?.physical?.molarMass
    if (!mm) throw new WorldError(`Solid "${s.solid}" has no molar mass`)
    c.contents.solid[s.solid] = parseValue(s.amount).si / parseValue(mm).si
    c.labelled = { components: [], preparation: s.solid }
    return c
  }
  const amount = parseQuantity(s.amount)
  if (amount.kind !== 'value') throw new WorldError(`Supply "${s.id}": amount must be a single volume`)
  const volumeL = amount.q.si * 1000
  // A preparation, plus anything added to it (ampicillin in LB broth).
  const labelComponents = [
    ...(s.preparation ? preparationComponents(cat, s.preparation) : []),
    ...(s.components ?? []).map((c) => ({ substance: c.substance, conc: parseValue(c.conc), text: c.conc })),
  ]
  const truthComponents = s.truth ? s.truth.map((c) => ({ substance: c.substance, conc: parseValue(c.conc) })) : labelComponents
  const layer = layerFrom(cat, truthComponents, volumeL)
  // A culture supplied on agar (a slope or plate) has already grown over its surface.
  const onAgar = cat.property(s.container, 'agar') === true
  const grown: Record<string, SurfaceCells> = {}
  for (const p of s.populations ?? []) {
    if (onAgar) {
      // A number is that many separate colonies; a concentration, growth all over.
      const founders = p.total !== undefined ? Math.round(p.total) : GROWN_FOUNDERS
      const cells = p.total !== undefined ? p.total * CELLS_PER_COLONY : (p.perL ?? 0) * volumeL
      grown[p.substance] = { count: cells, viable: cells * (p.viable ?? 1), doublings: GROWN_DOUBLINGS, spread: true, founders }
      continue
    }
    layer.populations ??= {}
    const competent = cat.substances.get(p.substance)?.organism?.competent === true
    const n = p.total ?? (p.perL ?? 0) * volumeL
    layer.populations[p.substance] = { count: n, viable: n * (p.viable ?? 1), ...(competent ? { competence: 1, bound: 0, dose: 0 } : {}) }
  }
  if (layer.populations) {
    inducedAtStart(cat, layer)
    mutantsAtStart(cat, layer)
  }
  if (s.activityFactor !== undefined && s.activityFactor !== 1) {
    for (const [sub, n] of Object.entries(layer.species)) {
      const cls = cat.substances.get(sub)?.identity.class
      if (cls === 'protein' || cls === 'enzyme') {
        layer.active ??= {}
        layer.active[sub] = n * s.activityFactor
      } else {
        layer.species[sub] = n * s.activityFactor
      }
    }
  }
  const labelled: Container['labelled'] = {
    components: labelledFrom(labelComponents) as LabelledComponent[],
    ...(s.preparation ? { preparation: s.preparation } : {}),
  }
  const c = addContainer(world, cat, {
    id: s.id,
    equipment: s.container,
    label: s.label,
    place: s.place,
    supply: s.id,
    role: s.role,
    contents: layer,
    labelled,
  })
  if (Object.keys(grown).length) c.contents.surface = grown
  return c
}

/** A culture supplied on agar is confluent growth: well past visible, more colonies than can be told apart. */
const GROWN_DOUBLINGS = 30
const GROWN_FOUNDERS = 1000
/** Cells in a grown colony. */
const CELLS_PER_COLONY = 1e8

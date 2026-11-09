// Microbiology operations (composition model §5.2: biological handling): drying and heat
// fixing, flooding a slide with a reagent, rinsing, and sterilising a loop. Loop transfers use
// core:transfer with a loop as the tool; its film carries organisms until it is flamed.
import { advance, evaporate } from '../models/processes.ts'
import { equilibrateWithHeat, settleAll } from '../models/solubility.ts'
import { applyStain } from '../models/staining.ts'
import { type OpContext, type OpImpl, type OpResult } from './kernel.ts'
import { baseOrganism, coloniesOn, depositOnSurface, describeSectors, isolatedSector, markersOf, SECTOR_CONFLUENT } from '../models/growth.ts'
import { type Container, drawProportional, liquidVolume, meanLayer, type MeasurementRecord, mergePopulation, type Population, type SurfaceCells, type ToolState } from './state.ts'
import { fingerprint, rimContact } from '../models/contamination.ts'
import { appearance, isPrecipitate, perceivedColour } from '../models/measurement.ts'
import { colourName } from '../models/colour.ts'
import { viewTlc } from './ops-bench.ts'
import { twoPhase } from '../models/phases.ts'
import { parseValue } from '../units/index.ts'

type Params = Record<string, unknown>

/** Drying rates (L/s): a smear or a filter cake in air, or in a warm oven or over a flame. */
const DRY_RATE_L_PER_S: Record<string, number> = { air: 20e-6 / 60, heat: 200e-6 / 60 }

/**
 * Dry a container's liquid: air drying leaves cells loosely attached (they wash off); heat
 * fixes them to the surface and kills them. Dissolved solutes are left behind as solid. With a
 * duration, drying goes at the method's rate and may leave the material still wet.
 */
function dry(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.container)
  const method = p.method === 'heat' ? 'heat' : 'air'
  const d = p.duration === undefined ? undefined : ctx.quantity(p.duration, 'time', 'duration').si
  const volume = liquidVolume(c.contents)
  if (d !== undefined && volume > DRY_RATE_L_PER_S[method] * d) {
    // Still wet: solvent leaves, solutes concentrate and the excess comes out.
    evaporate(c.contents, DRY_RATE_L_PER_S[method] * d)
    equilibrateWithHeat(ctx.cat, c.contents, 1)
    advance(ctx.world, ctx.cat, d)
    return { facts: { method, hadLiquid: true, dry: false, remainingL: liquidVolume(c.contents), fixed: false } }
  }
  settleAll(c.contents)
  const mean = meanLayer(c.contents)
  for (const [s, n] of Object.entries(mean.species)) if (n > 0) c.contents.solid[s] = (c.contents.solid[s] ?? 0) + n
  c.contents.film ??= {}
  for (const [organism, pop] of Object.entries(mean.populations ?? {})) {
    const cells = (c.contents.film[organism] ??= { count: 0, primary: 0, complexed: 0, counter: 0, fixed: false })
    cells.count += pop.count
  }
  if (method === 'heat') for (const cells of Object.values(c.contents.film)) cells.fixed = true
  const hadLiquid = volume > 0
  c.contents.layers = []
  if (d) advance(ctx.world, ctx.cat, d)
  return { facts: { method, hadLiquid, dry: true, fixed: method === 'heat', organisms: Object.keys(c.contents.film) } }
}

/** Cover a slide with a reagent for a time: stains act on the cells on it. */
function flood(ctx: OpContext, p: Params): OpResult {
  const slide = ctx.container(p.container, 'slide')
  const reagent = ctx.container(p.reagent, 'reagent')
  const duration = ctx.quantity(p.duration, 'time', 'duration').si
  if (!(duration > 0)) ctx.refuse('BAD-DURATION', 'The reagent must stay on for some time')
  const use = Math.min(liquidVolume(reagent.contents) - reagent.deadVolumeL, 0.5e-3)
  if (use <= 0) ctx.refuse('NOT-ENOUGH', `${reagent.label} is empty`)
  const drop = drawProportional(reagent.contents, use)
  const film = slide.contents.film ?? {}
  // Liquid over cells that were only air-dried lifts some of them off.
  for (const cells of Object.values(film)) if (!cells.fixed) cells.count *= 0.7
  const roles = applyStain(ctx.cat, film, drop, duration)
  advance(ctx.world, ctx.cat, duration)
  return { facts: { reagent: reagent.id, roles, durationS: duration } }
}

/** Rinse a slide or vessel with water: unfixed cells and loose liquid go. */
function rinse(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.container)
  c.contents.layers = []
  let lost = 0
  for (const cells of Object.values(c.contents.film ?? {})) {
    if (cells.fixed) continue
    lost += cells.count * 0.95
    cells.count *= 0.05
  }
  return { facts: { washedOff: lost } }
}

/**
 * Spread the cells on an agar plate with a spreader. The spreader leaves on this plate what it
 * carried from the last one, and picks up a little of this one, until it is sterilised.
 */
function spread(ctx: OpContext, p: Params): OpResult {
  const plate = ctx.container(p.plate, 'plate')
  if (ctx.cat.property(plate.equipment, 'agar') !== true) ctx.refuse('NOT-A-PLATE', `${plate.label} is not an agar plate`)
  const e = ctx.equipment(p.tool, 'spreader')
  if (e.state.kind !== 'tool' || ctx.cat.property(e.equipment, 'loop') !== true) ctx.refuse('NOT-A-SPREADER', `${e.label} cannot spread cells`)
  const state = e.state as ToolState
  const carried = state.tip?.film?.populations
  const brought = carried ? Object.values(carried).reduce((a, x) => a + x.count, 0) : 0
  if (carried) depositOnSurface(plate.contents, carried)
  const pick: Record<string, Population> = {}
  for (const [k, s] of Object.entries(plate.contents.surface ?? {})) {
    s.spread = true
    pick[k] = { count: s.count * PICK_UP, viable: s.viable * PICK_UP, ...(s.expressed !== undefined ? { expressed: s.expressed } : {}) }
    s.count *= 1 - PICK_UP
    s.viable *= 1 - PICK_UP
  }
  state.tip = { id: state.tip?.id ?? ctx.newId('spreader'), touched: [plate.id], lastSource: plate.id, film: { volumeL: 1e-6, species: {}, populations: pick } }
  return { facts: { plate: plate.id, brought } }
}

/** Fraction of a plate's cells a spreader carries away. */
const PICK_UP = 0.02

/** Streaking: the fraction of the previous sector's cells a fresh loop drags into the next, and what a loop is loaded with after a stroke. */
const STREAK_DRAG = 0.02
const STREAK_LOAD = 0.1

/**
 * Streak one sector of a plate with a loop. Sector 1 spreads the inoculum; each later sector
 * drags a little from the one before, plus whatever the loop still carries (so not flaming
 * between sectors leaves no single colonies).
 */
function streak(ctx: OpContext, p: Params): OpResult {
  const plate = ctx.container(p.plate, 'plate')
  if (ctx.cat.property(plate.equipment, 'agar') !== true) ctx.refuse('NOT-A-PLATE', `${plate.label} is not an agar plate`)
  const e = ctx.equipment(p.tool, 'loop')
  if (e.state.kind !== 'tool' || ctx.cat.property(e.equipment, 'loop') !== true) ctx.refuse('NOT-A-LOOP', `${e.label} cannot streak a plate`)
  const k = Number(p.sector)
  if (!Number.isInteger(k) || k < 1 || k > 6) ctx.refuse('BAD-SECTOR', 'Sectors are numbered 1 to 6')
  const state = e.state as ToolState
  const carried = state.tip?.film?.populations ?? {}
  const surface = (plate.contents.surface ??= {})
  for (const [key, pop] of Object.entries(carried)) {
    if (pop.count > 0) surface[key] ??= { count: 0, viable: 0, doublings: 0, spread: true } as SurfaceCells
  }
  const pick: Record<string, Population> = {}
  let laid = 0
  for (const [key, s] of Object.entries(surface)) {
    s.spread = true
    // Cells already on the plate (the inoculum) lie in sector 1.
    const sectors = (s.sectors ??= [s.viable])
    while (sectors.length < k) sectors.push(0)
    // Each sector crosses the last and drags a little from it, unless it is a separate patch.
    if (k > 1 && p.cross !== false) {
      const dragged = STREAK_DRAG * sectors[k - 2]
      sectors[k - 2] -= dragged
      sectors[k - 1] += dragged
    }
    const from = carried[key]
    if (from && from.count > 0) {
      sectors[k - 1] += from.viable
      s.viable += from.viable
      s.count += from.count
    }
    const load = STREAK_LOAD * sectors[k - 1]
    sectors[k - 1] -= load
    s.viable -= load
    s.count -= load
    laid += sectors[k - 1]
    if (load > 0) pick[key] = { count: load, viable: load, ...(s.expressed !== undefined ? { expressed: s.expressed } : {}) }
  }
  state.tip = { id: state.tip?.id ?? ctx.newId('loop'), touched: [plate.id], lastSource: plate.id, film: { volumeL: 1e-6, species: {}, populations: pick } }
  return { facts: { plate: plate.id, sector: k, laid } }
}

/** Cells a loop takes from a colony, and the share a pipette tip touched to it takes. */
const COLONY_PICK = 1e7
const TIP_PICK = 0.1

/**
 * Pick a colony with a loop into a liquid (broth, or a drop of water on a slide). A colony from
 * a sector where colonies are separate is one strain; from crowded growth, a mixture.
 */
function pickColony(ctx: OpContext, p: Params): OpResult {
  const plate = ctx.container(p.plate, 'plate')
  if (ctx.cat.property(plate.equipment, 'agar') !== true) ctx.refuse('NOT-A-PLATE', `${plate.label} is not an agar plate`)
  const e = ctx.equipment(p.tool, 'loop')
  // A loop, or a pipette with a sterile tip (touched to the colony, it carries less).
  const tipPick = e.state.kind === 'tool' && ctx.cat.property(e.equipment, 'needsTip') === true && !!(e.state as ToolState).tip
  if (e.state.kind !== 'tool' || (ctx.cat.property(e.equipment, 'loop') !== true && !tipPick)) ctx.refuse('NOT-A-LOOP', `${e.label} cannot pick a colony (a loop, or a pipette with a tip)`)
  if (tipPick && p.destination === undefined) ctx.refuse('NO-DESTINATION', 'Touch the tip to the colony, then into a liquid')
  // Without a destination the cells stay on the loop (to streak or stab with).
  const dst = p.destination === undefined ? undefined : ctx.container(p.destination, 'destination')
  if (dst && liquidVolume(dst.contents) <= 0) ctx.refuse('NO-LIQUID', `Put some broth or a drop of water in ${dst.label} first`)
  rimContact(ctx.cat, ctx.world, plate, ctx.eventIndex)
  const views = coloniesOn(ctx.cat, plate.contents)
  if (views.length === 0) ctx.refuse('NO-COLONIES', `There are no colonies on ${plate.label}`)
  const sector = isolatedSector(views)
  const inSector = (v: (typeof views)[number]) => (sector >= 0 ? (v.bySector?.[sector] ?? 0) : v.colonies)
  const want = typeof p.appearance === 'string' ? p.appearance.toLowerCase() : undefined
  const candidates = views.filter((v) => inSector(v) > 0 && (!want || v.appearance.toLowerCase().includes(want)))
  if (candidates.length === 0) ctx.refuse('NO-SUCH-COLONY', want ? `No separate colony looks "${p.appearance}"` : 'No colony to pick')
  const crowded = sector < 0 && views.reduce((a, v) => a + v.colonies, 0) > SECTOR_CONFLUENT
  const picked: Record<string, Population> = {}
  if (crowded) {
    // Crowded growth: whatever touches the loop.
    const total = views.reduce((a, v) => a + v.colonies, 0)
    for (const v of views) picked[v.strain] = { count: (COLONY_PICK * v.colonies) / total, viable: (COLONY_PICK * v.colonies) / total }
  } else {
    const weights = candidates.map((v) => inSector(v))
    const sum = weights.reduce((a, b) => a + b, 0)
    let u = ctx.rng('colony').next() * sum
    let chosen = candidates[candidates.length - 1]
    for (let i = 0; i < candidates.length; i++) {
      u -= weights[i]
      if (u <= 0) {
        chosen = candidates[i]
        break
      }
    }
    picked[chosen.strain] = { count: COLONY_PICK, viable: COLONY_PICK }
  }
  if (tipPick) for (const pop of Object.values(picked)) {
    pop.count *= TIP_PICK
    pop.viable *= TIP_PICK
  }
  const state = e.state as ToolState
  const load: Record<string, Population> = {}
  if (tipPick) {
    // The tip goes into the liquid with its cells and is then discarded with them on it.
    rimContact(ctx.cat, ctx.world, dst!, ctx.eventIndex)
    const top = dst!.contents.layers[0]
    top.populations ??= {}
    for (const [k, pop] of Object.entries(picked)) mergePopulation((top.populations[k] ??= { count: 0, viable: 0 }), pop, 1)
    state.tip!.touched.push(plate.id, dst!.id)
    return { facts: { plate: plate.id, destination: dst!.id, sector: sector + 1, mixed: Object.keys(picked).length > 1, tool: 'tip' } }
  }
  if (dst) {
    rimContact(ctx.cat, ctx.world, dst, ctx.eventIndex)
    const top = dst.contents.layers[0]
    top.populations ??= {}
    for (const [k, pop] of Object.entries(picked)) mergePopulation((top.populations[k] ??= { count: 0, viable: 0 }), pop, 1)
    for (const [k, pop] of Object.entries(picked)) load[k] = { count: pop.count * STREAK_LOAD, viable: pop.viable * STREAK_LOAD }
  } else {
    // A loopful taken to streak or stab with: the loop carries a tenth of a colony's worth.
    for (const [k, pop] of Object.entries(picked)) load[k] = { count: pop.count * STREAK_LOAD, viable: pop.viable * STREAK_LOAD }
  }
  state.tip = { id: state.tip?.id ?? ctx.newId('loop'), touched: dst ? [plate.id, dst.id] : [plate.id], lastSource: plate.id, film: { volumeL: 1e-6, species: {}, populations: load } }
  return { facts: { plate: plate.id, ...(dst ? { destination: dst.id } : {}), sector: sector + 1, mixed: Object.keys(picked).length > 1 } }
}



/** Flame a loop (or needle): its film and the organisms on it are destroyed. */
function sterilise(ctx: OpContext, p: Params): OpResult {
  const e = ctx.equipment(p.tool, 'loop')
  if (e.state.kind !== 'tool' || ctx.cat.property(e.equipment, 'loop') !== true) ctx.refuse('NOT-A-LOOP', `${e.label} cannot be flamed this way`)
  const state = e.state as ToolState
  const hadFilm = !!state.tip?.film
  state.tip = { id: state.tip?.id ?? ctx.newId('loop'), touched: [], film: null }
  return { facts: { hadFilm } }
}

/** Cells a spot test needs to give a readable reaction. */
const SPOT_TEST_CELLS = 1e5

/**
 * A spot test (catalase, oxidase …): a drop of reagent on cells from a culture, a slide or a
 * plate's colonies (those that look like `appearance`, when given). The reagent's `spotTest`
 * names the marker it reveals; the result is positive when the cells have it, negative when they
 * do not, and patchy when only some do. Too few cells give nothing readable.
 */
function spotTest(ctx: OpContext, p: Params): OpResult {
  const reagent = ctx.container(p.reagent, 'reagent')
  const target = ctx.container(p.target, 'target')
  const test = Object.keys(meanLayer(reagent.contents).species).map((s) => ctx.cat.substances.get(s)?.spotTest).find((t) => t !== undefined)
  if (!test) ctx.refuse('NOT-A-TEST-REAGENT', `${reagent.label} is not a spot-test reagent`)
  const dropL = 10e-6
  if (liquidVolume(reagent.contents) < dropL) ctx.refuse('NOT-ENOUGH', `${reagent.label} is empty`)
  drawProportional(reagent.contents, dropL)
  // The cells being tested, by organism.
  const cells: Record<string, number> = {}
  const add = (key: string, n: number) => {
    if (n > 0) cells[key] = (cells[key] ?? 0) + n
  }
  if (target.contents.surface) {
    const look = p.appearance === undefined ? undefined : String(p.appearance)
    for (const v of coloniesOn(ctx.cat, target.contents)) if (!look || v.appearance.includes(look)) add(v.strain, v.colonies * 1e7)
  }
  for (const [key, f] of Object.entries(target.contents.film ?? {})) add(key, f.count)
  for (const [key, pop] of Object.entries(meanLayer(target.contents).populations ?? {})) add(key, pop.count)
  const total = Object.values(cells).reduce((a, b) => a + b, 0)
  const positive = Object.entries(cells).filter(([key]) => markersOf(ctx.cat, key).has(test!.marker)).reduce((a, [, n]) => a + n, 0)
  let result: 'positive' | 'negative' | 'patchy' | 'unreadable'
  if (total < SPOT_TEST_CELLS) result = 'unreadable'
  else if (positive >= 0.9 * total) result = 'positive'
  else if (positive <= 0.1 * total) result = 'negative'
  else result = 'patchy'
  const display = result === 'positive' ? test!.positive : result === 'negative' ? test!.negative : result === 'patchy' ? `a weak, patchy reaction` : 'too few cells to read'
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: reagent.id,
    settings: { test: test!.marker },
    subject: target.id,
    kind: 'observation',
    quantity: 'appearance',
    unit: '',
    display: { [target.id]: display },
    flags: {},
    uncertainty: {},
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, result, display }, facts: { record: record.id, result, marker: test!.marker } }
}

/** Discs a 90 mm plate takes with zones still clear of each other (EUCAST: six). */
const MAX_DISCS = 6

/**
 * Press a disc onto an agar plate: what it carries (an antibiotic, a mutagen) starts diffusing into
 * the agar from now. The disc stays a container (so its zone can be read by its name); it goes where
 * the plate goes.
 */
function applyDisc(ctx: OpContext, p: Params): OpResult {
  const disc = ctx.container(p.disc, 'disc')
  const plate = ctx.container(p.plate, 'plate')
  if (ctx.cat.property(disc.equipment, 'disc') !== true) ctx.refuse('NOT-A-DISC', `${disc.label} is not a paper disc`)
  if (ctx.cat.property(plate.equipment, 'agar') !== true) ctx.refuse('NOT-A-PLATE', `${plate.label} is not an agar plate`)
  if (disc.plate) ctx.refuse('ALREADY-PLACED', `${disc.label} is already on a plate`)
  // What the disc carries: antibiotics or mutagens dried on it, or in the solution put on it. A disc
  // wetted with water or solvent alone carries none (a negative control).
  const acts = (s: string) => !!(ctx.cat.substances.get(s)?.antibiotic || ctx.cat.substances.get(s)?.mutagen)
  const found = new Map<string, number>()
  for (const [s, n] of Object.entries(disc.contents.solid)) if (n > 0 && acts(s)) found.set(s, (found.get(s) ?? 0) + n)
  for (const l of disc.contents.layers) for (const [s, n] of Object.entries(l.species)) if (n > 0 && acts(s)) found.set(s, (found.get(s) ?? 0) + n)
  const drugs = [...found].sort((a, b) => b[1] - a[1])
  const discs = (plate.contents.discs ??= [])
  if (discs.length >= MAX_DISCS) ctx.refuse('TOO-MANY-DISCS', `${plate.label} already has ${MAX_DISCS} discs: their zones would run into each other`)
  const taken = new Set(discs.map((d) => d.position))
  const position = p.position === undefined ? Array.from({ length: MAX_DISCS }, (_, i) => i + 1).find((i) => !taken.has(i))! : Number(p.position)
  if (!Number.isInteger(position) || position < 1 || position > MAX_DISCS) ctx.refuse('BAD-POSITION', `Positions run from 1 to ${MAX_DISCS}`)
  if (taken.has(position)) ctx.refuse('POSITION-TAKEN', `There is already a disc at position ${position}`)
  const [substance, mol] = drugs[0] ?? ['', 0]
  discs.push({ container: disc.id, substance, mol, placedS: ctx.world.timeS, position, ...(drugs.length > 1 ? { drugs: drugs.map(([s, n]) => ({ substance: s, mol: n })) } : {}) })
  disc.contents.solid = {}
  disc.contents.layers = []
  disc.plate = plate.id
  disc.place = plate.place
  return { facts: { disc: disc.id, plate: plate.id, substance, position } }
}

/** Pass the neck of an opened bottle or tube through the flame: what is on its rim is killed. */
function flameNeck(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.container)
  if (ctx.cat.property(c.equipment, 'flameNeck') !== true) ctx.refuse('NO-NECK', `${c.label} has no neck to flame`)
  c.neck = 'flamed'
  return { facts: { uncovered: c.uncovered === true } }
}

function washHands(ctx: OpContext, p: Params): OpResult {
  ctx.world.operator.hands = p.method === 'antiseptic' ? 'antiseptic' : 'washed'
  return { facts: { method: ctx.world.operator.hands } }
}

/** Fingertips pressed gently on the agar of a plate whose lid is off. */
function pressFingers(ctx: OpContext, p: Params): OpResult {
  const plate = ctx.container(p.plate, 'plate')
  if (ctx.cat.property(plate.equipment, 'agar') !== true) ctx.refuse('NOT-A-PLATE', `${plate.label} is not an agar plate`)
  if (!plate.uncovered) ctx.refuse('LID-ON', `Take the lid off ${plate.label} first`)
  fingerprint(ctx.cat, ctx.world, plate, ctx.eventIndex)
  return { facts: { plate: plate.id, hands: ctx.world.operator.hands ?? 'unwashed' } }
}

/** Plunge a loaded loop straight down into an agar deep: the cells lie along the stab. */
function stab(ctx: OpContext, p: Params): OpResult {
  const tube = ctx.container(p.tube, 'tube')
  if (ctx.cat.property(tube.equipment, 'agar') !== true || ctx.cat.property(tube.equipment, 'deep') !== true) ctx.refuse('NOT-A-DEEP', `${tube.label} is not an agar deep`)
  const e = ctx.equipment(p.tool, 'loop')
  if (e.state.kind !== 'tool' || ctx.cat.property(e.equipment, 'loop') !== true) ctx.refuse('NOT-A-LOOP', `${e.label} cannot stab a deep`)
  const state = e.state as ToolState
  let carried = state.tip?.film?.populations ?? {}
  if (p.source !== undefined) {
    // Dip the loop into a broth culture first: it carries a loopful.
    const src = ctx.container(p.source, 'source')
    if (liquidVolume(src.contents) <= 0) ctx.refuse('NO-LIQUID', `${src.label} has no liquid to dip into`)
    rimContact(ctx.cat, ctx.world, src, ctx.eventIndex)
    const loopful = drawProportional(src.contents, Math.min(LOOPFUL_L, liquidVolume(src.contents)))
    carried = loopful.populations ?? {}
  }
  rimContact(ctx.cat, ctx.world, tube, ctx.eventIndex)
  const surface = (tube.contents.surface ??= {})
  let laid = 0
  for (const [key, pop] of Object.entries(carried)) {
    if (!(pop.count > 0)) continue
    const s = (surface[key] ??= { count: 0, viable: 0, doublings: 0, spread: true, stab: true } as SurfaceCells)
    s.count += pop.count
    s.viable += pop.viable
    s.stab = true
    laid += pop.viable
  }
  state.tip = { id: state.tip?.id ?? ctx.newId('loop'), touched: [tube.id], lastSource: tube.id, film: { volumeL: 1e-6, species: {}, populations: {} } }
  return { facts: { tube: tube.id, laid } }
}

/** What a 10 µL loop holds when dipped into a broth. */
const LOOPFUL_L = 10e-6

/** Where growth shows in an agar deep, by how the organism copes with oxygen. */
const STAB_GROWTH: Record<string, string> = {
  aerobe: 'growth only at the top of the stab, at the surface',
  facultative: 'growth all along the stab, heaviest near the top',
  microaerophile: 'growth in a band just below the surface',
  anaerobe: 'growth along the stab below the surface, none at the top',
  aerotolerant: 'even growth all along the stab',
}

/** Cells in a pellet before it can be seen at the bottom of a tube. */
const VISIBLE_PELLET_CELLS = 1e5

/** A broth looks cloudy from about this optical density (1 cm), hazy from the second. */
const CLOUDY_OD = 0.1
const HAZY_OD = 0.02

/**
 * Looking at something: a broth against the light (clear or cloudy), an agar deep (where growth
 * is along the stab), a plate or slope (its colonies, by appearance). What is seen, never what it is.
 */
export function inspect(ctx: OpContext, instrument: string, c: Container): OpResult {
  // A developed TLC plate looked at by eye: coloured spots (leaf pigments) show in daylight.
  if (c.contents.tlc?.developed) return viewTlc(ctx, instrument, c, true)
  const agar = ctx.cat.property(c.equipment, 'agar') === true
  const features: NonNullable<MeasurementRecord['features']> = []
  let display: string
  if (agar && ctx.cat.property(c.equipment, 'deep') === true) {
    for (const [key, s] of Object.entries(c.contents.surface ?? {})) {
      if (!s.stab || !((s.founders ?? 0) > 0)) continue
      const o = ctx.cat.substances.get(baseOrganism(key))?.organism
      features.push({ shape: 'growth', arrangement: STAB_GROWTH[o?.oxygen ?? 'facultative'], colour: (o?.colony ?? '').split(',')[0], abundance: 'many' })
    }
    display = features.length ? [...new Set(features.map((f) => f.arrangement))].join('; ') : 'no growth along the stab'
  } else if (agar) {
    const views = coloniesOn(ctx.cat, c.contents)
    const byLook = new Map<string, number>()
    for (const v of views) byLook.set(v.appearance, (byLook.get(v.appearance) ?? 0) + v.colonies)
    const total = [...byLook.values()].reduce((a, b) => a + b, 0)
    for (const [look, n] of byLook) features.push({ shape: 'colonies', arrangement: look, colour: '', abundance: n > SECTOR_CONFLUENT ? 'many' : n > 0 ? 'few' : 'none', note: String(n) })
    const streaked = views.some((v) => v.bySector)
    display = total === 0 ? 'no colonies' : streaked ? describeSectors(views).join('; ') : `${total > SECTOR_CONFLUENT ? 'too many to count' : `${total} colonies`}: ${[...byLook].map(([look, n]) => `${n > SECTOR_CONFLUENT ? 'confluent' : n} ${look}`).join('; ')}`
  } else {
    const v = liquidVolume(c.contents)
    const look = v > 0 ? appearance(ctx.cat, c, Number(ctx.cat.property(c.equipment, 'pathCm') ?? 1.5)) : undefined
    // The eye misses a precipitate below about 0.01 mg/mL in suspension or 0.1 mg on the bottom.
    const visible = !!look?.precipitate && (look.precipitate.suspendedMg / (v * 1000) >= 0.01 || look.precipitate.settledMg >= 0.1)
    if (v <= 0) {
      // No liquid: what lies there, dry.
      const pieces = solidsSeen(ctx, c)
      display = pieces.length ? `dry: ${pieces.join(' and ')}` : 'empty'
    } else if (look?.precipitate && visible) {
      // A precipitate: its colour and texture, suspended or settled, and the liquid's own colour.
      const p = look.precipitate
      const texture = ['gelatinous', 'curdy', 'fine', 'crystalline'].find((t) => p.look?.includes(t))
      const what = `${texture ? texture + ' ' : ''}${p.name} precipitate`
      const a = /^[aeiou]/.test(what) ? 'an' : 'a'
      const where = p.suspendedMg >= p.settledMg ? (look.opacity > 0.5 ? `${a} ${what}, the liquid cloudy` : `a little ${what}`) : `${a} ${what} settled at the bottom`
      display = look.liquidName === 'colourless' ? `${where}, in a colourless solution` : `${where}, in ${/^[aeiou]/.test(look.liquidName) ? 'an' : 'a'} ${look.liquidName} solution`
      // A coloured solid clouding a coloured liquid: the eye sees the mixture (red in blue looks green, then yellow and orange).
      const overall = colourName(look.rgb, 'liquid')
      const hue = (name: string) => name.replace(/^(pale|deep|dark|very pale) /, '')
      if (look.opacity > 0.2 && look.liquidName !== 'colourless' && ![hue(p.name), hue(look.liquidName)].includes(hue(overall))) display += `: ${overall} overall`
      features.push({ shape: 'precipitate', arrangement: texture ?? '', colour: p.name, abundance: look.opacity > 0.5 ? 'many' : 'few' })
    } else {
      let od = 0
      for (const layer of c.contents.layers) {
        for (const [key, pop] of Object.entries(layer.populations ?? {})) {
          od += (pop.count / (v * 1000)) * (ctx.cat.substances.get(baseOrganism(key))?.organism?.od600PerCell ?? 1.25e-9)
        }
      }
      // A colloid (milk's casein, colloidal sulfur) clouds the liquid as it is; cells as they grow.
      const cloud = look?.colloidOpacity ?? 0
      const tint = look?.colloidName && look.colloidName !== 'white' ? ` (${look.colloidName})` : ''
      display = cloud >= 0.6 ? `too cloudy to see through${tint}` : cloud >= 0.3 ? `cloudy${tint}` : cloud >= 0.12 ? `slightly cloudy${tint}` : cloud >= 0.04 ? 'faintly cloudy' : od >= CLOUDY_OD ? 'cloudy: growth' : od >= HAZY_OD ? 'slightly cloudy' : 'clear'
      // A coloured solution (a dye, a haem protein, an indicator) shows its colour; a colourless one says nothing more.
      // Two liquids that do not mix are described layer by layer below, not as one colour.
      const colour = twoPhase(ctx.cat, c.contents) ? '' : (perceivedColour(ctx.cat, c) ?? '')
      if (colour) display += `, ${colour}`
      const pelleted = Object.values(c.contents.cellPellet ?? {}).reduce((a, x) => a + x.count, 0)
      if (pelleted >= VISIBLE_PELLET_CELLS) display += ', with a small pellet at the bottom'
      features.push({ shape: od >= CLOUDY_OD ? 'cloudy' : od >= HAZY_OD ? 'slightly cloudy' : 'clear', arrangement: '', colour, abundance: od >= HAZY_OD ? 'many' : 'none' })
    }
    // Two liquids that do not mix: each layer's own colour, top first (a red oily layer from Sudan III).
    if (v > 0 && twoPhase(ctx.cat, c.contents)) {
      const pathCm = Number(ctx.cat.property(c.equipment, 'pathCm') ?? 1.5)
      const named = c.contents.layers.filter((l) => l.volumeL > 0).map((l) => `${perceivedColour(ctx.cat, { ...c, contents: { ...c.contents, layers: [l] } }, pathCm) ?? 'colourless'} layer`)
      if (named.length > 1) display += `; in two layers: a ${named[0]} on top of a ${named[named.length - 1]}`
    }
    // What lies in it (a metal, a deposit it has thrown down, marble chips) and any fizzing.
    if (v > 0) {
      const pieces = solidsSeen(ctx, c)
      if (pieces.length) display += `; ${pieces.join(' and ')}`
      const fizz = fizzing(c.gas?.rateMolPerS ?? 0)
      if (fizz) {
        display += `; ${fizz}`
        features.push({ shape: 'bubbles', arrangement: '', colour: '', abundance: fizz })
      }
    }
  }
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument,
    settings: {},
    subject: c.id,
    kind: 'observation',
    quantity: 'appearance',
    unit: '',
    display: { [c.id]: display },
    flags: {},
    uncertainty: {},
    features,
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, appearance: display }, facts: { record: record.id } }
}

export const MICRO_OPERATIONS: Record<string, OpImpl> = {
  'core:flame-neck': flameNeck,
  'core:wash-hands': washHands,
  'core:press-fingers': pressFingers,
  'core:stab': stab,
  'core:apply-disc': applyDisc,
  'core:spot-test': spotTest,
  'core:spread': spread,
  'core:streak': streak,
  'core:pick-colony': pickColony,
  'core:dry': dry,
  'core:flood': flood,
  'core:rinse': rinse,
  'core:sterilise': sterilise,
}

/** The solids lying in a vessel that show (by their look): the most first, a deposit named as one. */
function solidsSeen(ctx: OpContext, c: Container): string[] {
  const seen: Array<[string, number]> = []
  for (const [s, n] of Object.entries(c.contents.solid)) {
    const def = ctx.cat.substances.get(s)
    const look = def?.look?.description
    // A precipitate is described with the liquid it clouds, not as a piece lying in it.
    if (!look || !(n > 0) || isPrecipitate(def!)) continue
    const mm = def?.physical?.molarMass ? parseValue(def.physical.molarMass).si * 1000 : 100
    // Less than about a milligram is not seen.
    if (n * mm < 1e-3) continue
    seen.push([look, n * mm])
  }
  // Corrosion on the metal: a light film, then a coating (from about 5 mg).
  for (const [s, n] of Object.entries(c.contents.coating ?? {})) {
    const def = ctx.cat.substances.get(s)
    const g = n * (def?.physical?.molarMass ? parseValue(def.physical.molarMass).si * 1000 : 100)
    if (!(g >= 1e-3)) continue
    const colour = (def?.solid?.look ?? 'pale').replace(/^gelatinous /, '')
    seen.push([`${g < 5e-3 ? 'a light' : 'a'} ${colour} coating on the metal`, g])
  }
  return seen.sort((a, b) => b[1] - a[1]).map(([look]) => look)
}

/** Gas coming off, as it looks: 2 × 10⁻⁵ mol/s (about 0.5 mL/s) is vigorous fizzing. */
function fizzing(molPerS: number): string | undefined {
  if (molPerS > 2e-5) return 'fizzing vigorously'
  if (molPerS > 2e-6) return 'bubbling steadily'
  if (molPerS > 1e-7) return 'a few bubbles'
  return undefined
}

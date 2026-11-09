// Kernel state (material and state model §2–§10; master-plan/04 §2). Plain, serialisable data:
// the kernel is event-sourced, so state = reduce(initial world, events).
//
// F1 subset of the state model's Portion: an aqueous liquid held as layers (top first, so an
// unmixed tube really is stratified) plus undissolved solids. The solvent is implicit: species
// maps hold solutes only, and the liquid's volume is tracked explicitly.

export const WORLD_SCHEMA = 'lab-world/0.1'

/** Amounts of solutes, in mol, by substance id. */
export type Species = Record<string, number>

/** A population of organisms or cells (state model §6): counts, not individuals. */
export interface Population {
  count: number
  viable: number
  /** Competent cells: how competent they still are (0..1), the fraction with plasmid DNA bound, and the heat-shock dose so far (K·s). */
  competence?: number
  bound?: number
  dose?: number
  /** Transformants: how far the resistance their plasmid carries is expressed (0..1). */
  expressed?: number
  /** Expression strains: how far their inducible protein has accumulated in each cell (0..1). */
  induced?: number
  /** The highest lethal exposure to mutagens the cells have met (Σ c / c_toxic): survivors e^(−exposure). */
  exposure?: number
}

/** Cells on the surface of an agar plate: they become colonies if the medium lets them grow. */
export interface SurfaceCells extends Population {
  /** Doublings since plating (temperature-weighted); colonies are visible from about 17. */
  doublings: number
  spread: boolean
  /** Selection by the plate's antibiotics has been applied. */
  selected?: boolean
  /** When the lawn reached the density at which it outgrows a diffusing drug (world time, s). */
  criticalS?: number
  /** The number of colonies, fixed when they become visible. */
  founders?: number
  /** Streak plates: viable cells laid in each sector (sector 1 first), and the colonies in each. */
  sectors?: number[]
  foundersBySector?: number[]
  /** Stabbed into an agar deep: growth follows the stab line as far as the organism's oxygen needs allow. */
  stab?: boolean
  /** Whole cells that arrived one at a time (settled from the air, left by fingers), not a plated suspension. */
  discrete?: boolean
  /** Laid as spots (sectors are numbered spots, counted apart). */
  spots?: boolean
}

const POPULATION_STATE = ['competence', 'bound', 'dose', 'expressed', 'induced', 'exposure'] as const

/** Mix population b (weight: its viable count) into a: counts add, per-cell state averages. */
export function mergePopulation(a: Population, b: Population, fraction: number): void {
  const wa = a.viable
  const wb = b.viable * fraction
  for (const k of POPULATION_STATE) {
    if (a[k] === undefined && b[k] === undefined) continue
    a[k] = wa + wb > 0 ? ((a[k] ?? 0) * wa + (b[k] ?? 0) * wb) / (wa + wb) : (b[k] ?? a[k])
  }
  a.count += b.count * fraction
  a.viable += wb
}

export interface Layer {
  volumeL: number
  species: Species
  /** Active amount for proteins and enzymes (mol); absent = fully active. */
  active?: Species
  /** Organisms and cells in suspension, by substance id. */
  populations?: Record<string, Population>
  /** Fine undissolved particles suspended in this liquid (a protein precipitate), mol. */
  particles?: Species
  /** DNA cut at a restriction site: mol of molecules cut there, keyed "substance|enzyme|position". */
  cut?: Species
  /** Chemical (proton-transfer) enthalpy carried with the liquid, J; absent = unknown (taken as equilibrium). */
  enthalpyJ?: number
}

/** Cells fixed to a slide, with their stain state (contract staining, T1). */
export interface FixedCells {
  count: number
  /** Primary stain retained (0..1), whether it is complexed by the mordant (0..1), counterstain taken up (0..1). */
  primary: number
  complexed: number
  counter: number
}

export interface Contents {
  /** Liquid layers, top first. Empty = no liquid. */
  layers: Layer[]
  /** Gas given off (mol by gas substance) and not yet taken away to the headspace, a syringe or another liquid. */
  evolved?: Species
  /** Undissolved solids, mol. */
  solid: Species
  /** What corrosion has left on the metal pieces (rust), mol: it stays where it formed. */
  coating?: Species
  /** Flies in a vial (models/genetics.ts). */
  flies?: Flies
  /** A two-sided choice chamber: each side's conditions, and how many of each animal are on each side. */
  chamber?: Chamber
  /** The temperature (K) the ionic model last settled the liquid at: a solid may come out as it cools. */
  equilibratedK?: number
  /** The most of each surface-reacting solid there has been (mol): its area shrinks from what that amount had. */
  surfaceRef?: Species
  /**
   * Solids reacting too slowly to see (a nail in neutral water): the liquid's make-up then, the
   * time they have been reacted to, and until when they wait unless the liquid changes.
   */
  surfaceQuiet?: { key: string; fromS: number; untilS: number }
  temperatureK: number
  /** Cells dried onto a surface (a slide), by organism: air-dried ones wash off, heat-fixed ones stay. */
  film?: Record<string, FixedCells & { fixed: boolean }>
  /** Cells on an agar surface, by strain (organism, plus "+plasmid" for transformants). */
  surface?: Record<string, SurfaceCells>
  /** A spot plate: how many numbered spots were laid on it (the highest number), whatever they held. */
  spots?: number
  /** Cells spun down to the bottom of the tube, by strain, until mixing puts them back into the liquid. */
  cellPellet?: Record<string, Population>
  /** Seconds since the grains in the liquid (a metal powder) were last stirred up: their settling front has moved down since. */
  grainClock?: Record<string, number>
  /**
   * Discs pressed onto an agar surface: the disc (a container), what it carries (mol; `drugs` when it
   * holds several, or none), when and where it went on; for a mutagen, the share of the plate's cells
   * it has left alive and how far round it nothing survived (cm).
   */
  discs?: Array<{ container: string; substance: string; mol: number; placedS: number; position: number; drugs?: Array<{ substance: string; mol: number }>; alive?: number; clearedCm?: number }>
  /** Molten agar that has cooled and set (it melts again only when heated near boiling). */
  gelled?: boolean
  /** Gel lanes: how far each piece of DNA (ladder fragments as "ladder#bp") has run, mm. */
  migration?: Record<string, number>
  /** Matter on the vessel's wall (mol): adsorbed proteins, and antibodies bound there ("id@bound"). */
  adsorbed?: Species
  /** Blots: protein bands transferred from a gel (lane, position, what is in the band, antibodies bound to it, developed signal). */
  blot?: { bands: Array<{ lane: number; positionMm: number; species: Species; bound: Species; prestained?: boolean; signal?: number }>; background?: number }
  /** Affinity columns: protein held on the resin (mol). */
  affinity?: { bound: Species }
  /** TLC plates: what was spotted on each lane (mol), and where it ran to once developed (mm from the origin). */
  tlc?: { lanes: Record<string, Species>; developed?: { frontMm: number; positions: Record<string, Record<string, number>> } }
  /**
   * Size-exclusion columns: the sample taken into the bed (mol), what is still in it, its volume, and
   * the buffer passed since (L). Ion-exchange columns also follow each band's position down the bed
   * (0 top, 1 bottom) and the buffers that have entered it.
   */
  column?: { loaded: Species; left: Species; sampleL: number; passedL: number; positions?: Species; segments?: Array<{ fromL: number; ionicM: number; pH: number }> }
  /** Pieces of plant tissue (their fresh mass is the solid's, g), by tissue: what the cells hold and how damaged their membranes are. */
  tissue?: Record<string, TissueState>
}

export interface TissueState {
  /** Dry matter, g; the rest of the solid's mass is water. */
  dryG: number
  /** Solutes in the cell sap, osmol. */
  osmol: number
  /** Share of the cells whose membranes have been destroyed (0–1). */
  damage: number
  /** Pigment still in the cells, mol. */
  pigmentMol: number
  /** Mass of one piece as cut, g (sets how fast it exchanges water). */
  pieceG: number
}

export interface LabelledComponent {
  substance: string
  /** Stated concentration in SI (mol/m³ for molar, kg/m³ for mass concentrations). */
  si: number
  /** "molar" or "mass" concentration, as written on the label. */
  basis: 'molar' | 'mass'
  /** As written, for display ("2.0 mg/mL"). */
  text: string
}

export interface Container {
  id: string
  /** Catalogue equipment id (model or class). */
  equipment: string
  kind: 'container' | 'plate' | 'well'
  capacityL: number
  deadVolumeL: number
  /** What the printed label says. */
  label: string
  /** What the label claims the contents are (truth may differ: faults, mislabelling). */
  labelled?: { components: LabelledComponent[]; solvent?: string; preparation?: string }
  /** What the learner wrote on it. */
  userLabel?: string
  /** Slides: what the learner wrote in the middle, where the light passes (an inked letter). */
  marks?: string[]
  /** Its lid or cap explicitly taken off (core:open) and not yet put back: exposed to the air (contract contamination). */
  uncovered?: boolean
  /** A neck to flame: flamed since it was last handled, or handled since. */
  neck?: 'flamed' | 'handled'
  /** Sealed with a rubber septum: closed to the air, but a needle can pass through it. */
  septum?: boolean
  /** A balloon of inert gas on a needle through the septum: it keeps the flask under that gas as liquid is drawn out. */
  balloon?: string
  /** The share of the headspace that is air (the rest an inert gas); absent = air. */
  headspaceAir?: number
  /**
   * Gas the contents give off: where it goes (a gas syringe on a bung, or a delivery tube into
   * another container's liquid; absent = the room), how much has gathered in the syringe (mol by
   * gas), what is in the headspace now (mol by gas, over the air), and how fast it came off in the
   * last step (mol/s, for the bubbles one sees).
   */
  gas?: {
    to?: { kind: 'syringe'; instrument: string } | { kind: 'liquid'; container: string }
    collectedMol?: Record<string, number>
    headspaceMol?: Record<string, number>
    rateMolPerS?: number
  }
  /**
   * A still head and condenser on it (core:connect-condenser): what boils off is condensed into the
   * receiver (models/stillhead.ts). The still head's temperatures while it came over (K), and how much did (L).
   */
  still?: { receiver: string; headStartK?: number; headEndK?: number; headMinK?: number; headMaxK?: number; collectedL?: number }
  contents: Contents
  /** The place instance it sits in (wells: their plate's place). */
  place: string
  open: boolean
  /** A half-cell: the other half-cell a salt bridge joins it to. */
  bridge?: string
  /**
   * A sealed syringe of trapped air (mol), its plunger free (one atmosphere) or held at a volume (L);
   * what living things have added to or taken from it since, by gas (mol).
   */
  gasSample?: { airMol: number; fixedL?: number; delta?: Record<string, number> }
  /** A supply from the definition (stock bottles, samples). */
  supply?: string
  /** Sample role from the definition (unknown, standard, blank …). */
  role?: string
  /** Plates: their wells, row-major. Wells: their plate. */
  wells?: string[]
  plate?: string
  /** Well position ("A1"). */
  position?: string
  tareMassKg: number
  material?: string
  pathLengthM?: number
  /** Plate wells: bottom area for path length (V / area). */
  areaM2?: number
  /** Cuvettes: minimum volume for the beam to pass through liquid. */
  minVolumeL?: number
  /** Volumetric ware: nominal volume and class tolerance. */
  nominalL?: number
  toleranceL?: number
  discarded?: boolean
  /** Supplies whose material has entered it (directly or through other containers). */
  origins?: string[]
  /** Supplies: what they held when staged (mol, solid and dissolved), for truth(mass, …). */
  initial?: Species
  /** Position in an instrument with slots (a rotor position). */
  slot?: number
}

/** Something that went wrong physically (scientific simulation §7): serious, never gamified. */
export interface Incident {
  event: number
  kind: 'mechanical' | 'spill' | 'exposure' | 'fire' | 'pressure' | 'electrical' | 'biological' | 'thermal' | 'instrument-damage' | 'sample-loss'
  /** practice < sample < instrument < personal (adaptive support §7). */
  severity: 'practice' | 'sample' | 'instrument' | 'personal'
  equipment?: string
  message: string
  data?: Record<string, unknown>
}

export interface Tip {
  id: string
  /** Containers whose liquid it has touched. Empty = fresh. */
  touched: string[]
  lastSource?: string
  film: Layer | null
}

export interface ToolState {
  kind: 'tool'
  /** Variable pipettes: the dialled volume. */
  setVolumeL?: number
  tip: Tip | null
  /** Standard-normal draw for this instance's systematic error (per run). */
  biasZ: number
  /** A known systematic error (fraction) that replaces the drawn one: a tool out of calibration. */
  bias?: number
  /** Syringes: flushed with an inert gas (drawn from a purged flask and expelled), so no air rides in with the liquid. */
  flushed?: string
  /** Thrown away (a used syringe into the sharps bin). */
  discarded?: boolean
  /** Flame-test wires: what is left on the wire (mol per emitter) until it is cleaned in acid and heated. */
  residue?: Record<string, number>
}

export interface InstrumentState {
  kind: 'instrument'
  /** Spectrophotometers: the reference absorbance per wavelength (nm → AU) set by blanking. */
  blanks?: Record<string, number>
  /** Balances: the tare in kg. */
  tareKg?: number
  /**
   * pH meters: the electrode responds E = 7 + (pH − 7) × slope + offset (its own, fixed per
   * instance); the meter displays a + b × E. Uncalibrated: a = 0, b = 1, so the display is off.
   */
  calibration?: { offset: number; slope: number; a: number; b: number; calibrated: boolean }
  /** Compound microscopes, once their controls are used (contract microscopy). */
  microscope?: MicroscopeState
}

/** A compound microscope's controls and what has happened to it. */
export interface MicroscopeState {
  /** The objective in the light path ("none": the nosepiece turned between objectives). */
  objective: string
  /** Condenser turret: bright field or a phase annulus (ph1, ph2 …). */
  illumination: string
  /** Lamp output as a fraction of full. */
  lamp: number
  condenser: 'adjusted' | 'not-adjusted'
  /** The slide on the stage, and how well it is focused for the objective in place. */
  stage: string | null
  focus: 'none' | 'near' | 'sharp'
  /** Objectives with immersion oil on their front lens, until cleaned. */
  oiled: string[]
  /** Slides cracked by racking the stage up into a high-power objective. */
  cracked: string[]
}

export interface DeviceState {
  kind: 'device'
}

export interface EquipmentInstance {
  id: string
  equipment: string
  label: string
  state: ToolState | InstrumentState | DeviceState
}

export interface Place {
  id: string
  /** Catalogue equipment id of the place (core:bench, core:incubator …) or of an instrument that holds containers. */
  equipment: string
  label: string
  temperatureK: number
  adjustable: boolean
  /** Thermal time constant for a 1 mL container. */
  tauS: number
  /** Instruments that are places (a balance pan): the instrument instance. */
  instrument?: string
  /**
   * Light falling on what is placed here, µmol photons m⁻² s⁻¹ (photosynthetically active), and the
   * colour filter it passes through: room lighting on the bench, a lamp by its distance.
   */
  light?: number
  filter?: string
  /** The air around what is placed here: relative humidity (0–1, 0.5 if unset) and wind speed (m/s, still if unset). */
  humidity?: number
  windMs?: number
}

export interface Operator {
  ppe: string[]
  /** How the hands were last cleaned (contract contamination); unwashed until washed. */
  hands?: 'unwashed' | 'washed' | 'antiseptic'
}

export interface ProvenanceEdge {
  event: number
  from: string
  to: string
  volumeL: number
  kind: 'transfer' | 'carryover' | 'add-solid' | 'make-up' | 'dispose'
}

export interface Disposal {
  event: number
  container: string
  stream: string
  /** Supplies whose material it held. */
  materials: string[]
  volumeL: number
}

/** What can spoil a look down a microscope (models/microscopy.ts). */
export type ViewFlag = 'out-of-focus' | 'too-dark' | 'dim' | 'glare' | 'no-oil' | 'oil-on-lens' | 'annulus-mismatch' | 'uneven-illumination' | 'cracked-slide'

export interface MeasurementRecord {
  id: string
  event: number
  timeS: number
  instrument: string
  settings: Record<string, string | number>
  subject: string
  kind: 'scalar' | 'array' | 'series' | 'observation' | 'sequence'
  quantity: 'absorbance' | 'mass' | 'pH' | 'volume' | 'appearance' | 'temperature' | 'count' | 'fluorescence' | 'length' | 'potential' | 'sequence' | 'concentration' | 'conductivity' | 'pressure'
  unit: string
  /** Scalar value, or per-container values (wells). Raw: never modified afterwards. */
  value?: number
  values?: Record<string, number>
  /** Kinetic reads: read times (s from the start of the read) and per-container series. */
  times?: number[]
  series?: Record<string, number[]>
  /** Series against something other than time (a real-time PCR's cycles, a melt's temperatures). */
  axis?: { label: string; unit: string; values: number[] }
  /** Peaks the instrument found in each container's series (a melt curve's), in the axis unit. */
  peaks?: Record<string, number[]>
  /** Gel images: the bands seen in each lane (lane = well id), positions from the well in mm. */
  /** Bands an imager saw; `volume` is the integrated signal (ng of what it detects), for quantifying. */
  bands?: Array<{ lane: string; positionMm: number; intensity: string; volume?: number }>
  /** A sequencing read: the bases called (N where the trace is ambiguous). */
  sequence?: string
  /** Ranges (a melting point): from and to, in the record's unit. */
  range?: [number, number]
  /** Observations (a microscope field): what is seen, never what it is. */
  features?: Array<{ shape: string; arrangement: string; colour: string; abundance: string; seen?: string; note?: string }>
  /** What the instrument displayed ("0.452", "OVER"). */
  display: Record<string, string>
  flags: Record<string, Array<'saturated' | 'below-detection' | 'unstable' | 'insufficient-volume' | 'not-blanked' | 'residue' | 'wet' | 'lawn' | 'too-many' | 'unspread' | 'no-lawn' | 'no-signal' | 'mixed' | ViewFlag>>
  uncertainty: { random?: number; resolution?: number }
}

export interface NotebookEntry {
  event: number
  field: string
  value: unknown
  source?: string
}

export interface World {
  schema: typeof WORLD_SCHEMA
  seed: number
  timeS: number
  containers: Record<string, Container>
  equipment: Record<string, EquipmentInstance>
  places: Record<string, Place>
  operator: Operator
  measurements: MeasurementRecord[]
  notebook: NotebookEntry[]
  disposals: Disposal[]
  provenance: ProvenanceEdge[]
  incidents: Incident[]
  /** Counter for ids the kernel creates (tips, records). */
  nextId: number
}

export function emptyWorld(seed: number, ambientK = 294.15): World {
  return {
    schema: WORLD_SCHEMA,
    seed,
    timeS: 0,
    containers: {},
    equipment: {},
    places: {
      // A 1 mL tube on the bench cools with a time constant of about 4 min (core:bench says the same).
      bench: { id: 'bench', equipment: 'core:bench', label: 'Bench', temperatureK: ambientK, adjustable: false, tauS: 240 },
    },
    operator: { ppe: [] },
    measurements: [],
    notebook: [],
    disposals: [],
    provenance: [],
    incidents: [],
    nextId: 1,
  }
}

/** Deep copy of plain JSON-like data (no Date, Map or class instances in the world). */
export function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(clone) as T
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = v === undefined ? undefined : clone(v)
  return out as T
}

// ---- Layer arithmetic ----

export function emptyLayer(): Layer {
  return { volumeL: 0, species: {}, enthalpyJ: 0 }
}

export function liquidVolume(c: Contents): number {
  let v = 0
  for (const l of c.layers) v += l.volumeL
  return v
}

/** Merge all layers into one (the mean composition). */
export function meanLayer(c: Contents): Layer {
  const out = emptyLayer()
  for (const l of c.layers) addInto(out, l, 1)
  return out
}

function activeOf(layer: Layer, s: string): number {
  return layer.active?.[s] ?? layer.species[s] ?? 0
}

function addPopulations(out: Layer, layer: Layer, fraction: number): void {
  if (!layer.populations) return
  out.populations ??= {}
  for (const [s, p] of Object.entries(layer.populations)) mergePopulation((out.populations[s] ??= { count: 0, viable: 0 }), p, fraction)
}

/** out += layer × fraction. Active amounts are tracked only where either side records them. */
export function addInto(out: Layer, layer: Layer, fraction: number): void {
  addPopulations(out, layer, fraction)
  if (layer.particles) {
    out.particles ??= {}
    for (const [s, n] of Object.entries(layer.particles)) out.particles[s] = (out.particles[s] ?? 0) + n * fraction
  }
  if (layer.cut) {
    out.cut ??= {}
    for (const [k, n] of Object.entries(layer.cut)) out.cut[k] = (out.cut[k] ?? 0) + n * fraction
  }
  // Enthalpy adds while both sides know theirs; one unknown makes the sum unknown.
  out.enthalpyJ = out.enthalpyJ === undefined || layer.enthalpyJ === undefined ? undefined : out.enthalpyJ + layer.enthalpyJ * fraction
  if (layer.active || out.active) {
    for (const s of Object.keys(layer.species)) {
      if (layer.active?.[s] === undefined && out.active?.[s] === undefined) continue
      const a = activeOf(out, s)
      const b = activeOf(layer, s)
      out.active ??= {}
      out.active[s] = a + b * fraction
    }
  }
  out.volumeL += layer.volumeL * fraction
  for (const [s, n] of Object.entries(layer.species)) out.species[s] = (out.species[s] ?? 0) + n * fraction
}

export function scaleLayer(layer: Layer, fraction: number): Layer {
  const out: Layer = { volumeL: layer.volumeL * fraction, species: {} }
  for (const [s, n] of Object.entries(layer.species)) out.species[s] = n * fraction
  addPopulations(out, layer, fraction)
  if (layer.particles) {
    out.particles = {}
    for (const [s, n] of Object.entries(layer.particles)) out.particles[s] = n * fraction
  }
  if (layer.cut) {
    out.cut = {}
    for (const [k, n] of Object.entries(layer.cut)) out.cut[k] = n * fraction
  }
  if (layer.enthalpyJ !== undefined) out.enthalpyJ = layer.enthalpyJ * fraction
  if (layer.active) {
    out.active = {}
    for (const [s, n] of Object.entries(layer.active)) out.active[s] = n * fraction
  }
  return out
}

export function activeAmount(layer: Layer, substance: string): number {
  const total = layer.species[substance] ?? 0
  const active = layer.active?.[substance]
  return active === undefined ? total : Math.min(active, total)
}

/** Remove a volume from the top layers; returns what was removed. */
export function drawFromTop(c: Contents, volumeL: number): Layer {
  const out = emptyLayer()
  let remaining = volumeL
  while (remaining > 1e-15 && c.layers.length > 0) {
    const top = c.layers[0]
    if (top.volumeL <= remaining + 1e-15) {
      addInto(out, top, 1)
      remaining -= top.volumeL
      c.layers.shift()
    } else {
      const f = remaining / top.volumeL
      addInto(out, top, f)
      const rest = scaleLayer(top, 1 - f)
      c.layers[0] = rest
      remaining = 0
    }
  }
  return out
}

/** Remove a proportional slice of every layer (well-mixed draw, e.g. pouring). */
export function drawProportional(c: Contents, volumeL: number): Layer {
  const total = liquidVolume(c)
  if (total <= 0) return emptyLayer()
  const f = Math.min(1, volumeL / total)
  const out = emptyLayer()
  c.layers = c.layers.map((l) => {
    addInto(out, l, f)
    return scaleLayer(l, 1 - f)
  })
  return out
}

/** Add a layer on top; `jetMix` merges that fraction of it into the layer below. */
export function addOnTop(c: Contents, layer: Layer, jetMix = 0): void {
  if (layer.volumeL <= 0 && Object.keys(layer.species).length === 0 && !layer.populations) return
  if (c.layers.length === 0 || jetMix >= 1) {
    if (c.layers.length === 0) c.layers.push(layer)
    else {
      const merged = meanLayer({ ...c, layers: [layer, ...c.layers] })
      c.layers = [merged]
    }
    return
  }
  if (jetMix > 0) {
    const below = c.layers[0]
    const mixedPart = scaleLayer(layer, jetMix)
    const keep = scaleLayer(layer, 1 - jetMix)
    addInto(below, mixedPart, 1)
    if (keep.volumeL > 0) c.layers.unshift(keep)
  } else {
    c.layers.unshift(layer)
  }
}

/**
 * Homogeneity in [0, 1]: 1 − the largest volume-weighted mean relative deviation of any
 * solute's layer concentration from the container mean (1 for a single layer).
 */
export function homogeneity(c: Contents): number {
  if (c.layers.length <= 1) return 1
  const mean = meanLayer(c)
  if (mean.volumeL <= 0) return 1
  let worst = 0
  for (const [s, n] of Object.entries(mean.species)) {
    if (n <= 0) continue
    const cm = n / mean.volumeL
    let dev = 0
    for (const l of c.layers) {
      if (l.volumeL <= 0) continue
      const cl = (l.species[s] ?? 0) / l.volumeL
      dev += (l.volumeL / mean.volumeL) * Math.abs(cl - cm)
    }
    worst = Math.max(worst, dev / cm)
  }
  return Math.max(0, 1 - worst)
}

/** Relax every layer towards the mean by `fraction` (0 = nothing, 1 = fully mixed). */
export function relaxLayers(c: Contents, fraction: number): void {
  if (c.layers.length <= 1 || fraction <= 0) return
  if (fraction >= 0.999) {
    c.layers = [meanLayer(c)]
    return
  }
  const mean = meanLayer(c)
  const total = mean.volumeL
  if (total <= 0) return
  c.layers = c.layers.map((l) => {
    const share = l.volumeL / total
    const target = scaleLayer(mean, share)
    const out: Layer = { volumeL: l.volumeL, species: {} }
    const keys = new Set([...Object.keys(l.species), ...Object.keys(target.species)])
    for (const s of keys) out.species[s] = (l.species[s] ?? 0) * (1 - fraction) + (target.species[s] ?? 0) * fraction
    if (l.populations || target.populations) {
      out.populations = {}
      const orgs = new Set([...Object.keys(l.populations ?? {}), ...Object.keys(target.populations ?? {})])
      for (const s of orgs) {
        const p: Population = { count: 0, viable: 0 }
        if (l.populations?.[s]) mergePopulation(p, l.populations[s], 1 - fraction)
        if (target.populations?.[s]) mergePopulation(p, target.populations[s], fraction)
        out.populations[s] = p
      }
    }
    if (l.particles || target.particles) {
      out.particles = {}
      for (const s of new Set([...Object.keys(l.particles ?? {}), ...Object.keys(target.particles ?? {})])) {
        out.particles[s] = (l.particles?.[s] ?? 0) * (1 - fraction) + (target.particles?.[s] ?? 0) * fraction
      }
    }
    if (l.enthalpyJ !== undefined && target.enthalpyJ !== undefined) out.enthalpyJ = l.enthalpyJ * (1 - fraction) + target.enthalpyJ * fraction
    if (l.cut || target.cut) {
      out.cut = {}
      for (const k of new Set([...Object.keys(l.cut ?? {}), ...Object.keys(target.cut ?? {})])) {
        out.cut[k] = (l.cut?.[k] ?? 0) * (1 - fraction) + (target.cut?.[k] ?? 0) * fraction
      }
    }
    if (l.active || target.active) {
      out.active = {}
      for (const s of keys) {
        if (l.active?.[s] === undefined && target.active?.[s] === undefined) continue
        const a = l.active?.[s] ?? l.species[s] ?? 0
        const b = target.active?.[s] ?? target.species[s] ?? 0
        out.active[s] = a * (1 - fraction) + b * fraction
      }
    }
    return out
  })
  if (homogeneity(c) > 0.9999) c.layers = [meanLayer(c)]
}

/**
 * Flies of one species in a vial: the adults put in, by genotype key (sex|chromosomes), and the
 * progeny they leave a generation later (kept apart, the parents cleared before they emerge).
 */
export interface Flies {
  species: string
  adults: Record<string, number>
  progeny?: Record<string, number>
  /** Development time accrued at 25 °C (s), and when the brood emerged. */
  developedS?: number
  bredAtS?: number
}

/** A choice chamber's two sides (humidity and light under the gauze) and the animals on each. */
export interface Chamber {
  sides: Array<{ humidity?: 'humid' | 'dry'; light?: 'light' | 'dark' }>
  animals: Record<string, [number, number]>
}

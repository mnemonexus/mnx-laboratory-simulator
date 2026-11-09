// Presentation of the core's state: colour names to neutral display colours, and the bench as
// the 3D scene's existing props expect it. The core decides what a liquid looks like (a colour
// name); this file only decides how that name is painted.
import type { ContainerView, SessionView } from '../../packages/lab-core/src/index.ts'
import type { LabState, Sample } from '../sim/model'

/** Display colours for the colour names the core produces. Unknown names get a light neutral tint. */
const PALETTE: Record<string, string> = {
  colourless: '#dfe7ec',
  empty: '#dfe7ec',
  coloured: '#c9c3b8',
  blue: '#3f6fb5',
  'pale blue': '#9fbfdc',
  purple: '#6b4a9e',
  violet: '#7d5ab5',
  pink: '#d77fa8',
  red: '#b5413f',
  orange: '#d9853b',
  yellow: '#d8c24a',
  green: '#4f9a5a',
  brown: '#8a6a4a',
}

const unknown = new Set<string>()

export function colourHex(name: string): string {
  const hit = PALETTE[name]
  if (hit) return hit
  if (!unknown.has(name)) {
    unknown.add(name)
    console.warn(`No display colour for "${name}"`)
  }
  return '#cfd6db'
}

/** What a container is called on the bench: the learner's label first. */
export function nameOf(c: Pick<ContainerView, 'label' | 'userLabel'>): string {
  return c.userLabel ? `${c.userLabel} (${c.label})` : c.label
}

const ROWS = 'ABCDEFGH'

/** The glassware the bench draws a container as, by its equipment (micro tubes keep their own model). */
const SHAPES: Array<[RegExp, string]> = [
  [/microtube|pcr-tube/, 'microtube'], [/conical-flask/, 'conical-flask'], [/round-bottom-flask/, 'round-bottom-flask'],
  [/volumetric-flask/, 'volumetric-flask'], [/beaker/, 'beaker'], [/conical-tube|bijou|culture-tube/, 'conical-tube'],
  [/boiling-tube/, 'boiling-tube'], [/test-tube/, 'test-tube'], [/calorimeter-cup/, 'cup'], [/cuvette/, 'cuvette'],
]
export function vesselShape(equipment: string): string {
  return SHAPES.find(([re]) => re.test(equipment))?.[1] ?? 'bottle'
}

/**
 * The bench in the shape the 3D scene already draws: up to seven stock vessels on the rack and
 * one 8 × 12 plate. A first bridge; the scene gets its own view model later.
 */
export function toLabState(view: SessionView): LabState {
  const samples: Record<string, Sample> = {}
  const vessel = (c: ContainerView): Sample => ({
    id: c.id,
    name: nameOf(c),
    volume: c.volumeMl * 1000,
    capacity: Math.max(c.capacityMl * 1000, 1),
    concentration: 0,
    // The simulated colour, except that a clear colourless liquid keeps the bench's neutral tint.
    color: c.look && !(c.colour === 'colourless' && c.look.clarity > 0.9) ? c.look.liquid : colourHex(c.colour || 'colourless'),
    history: [],
    ...(c.look ? { look: { clarity: c.look.clarity, bubbling: c.look.bubbling, ...(c.look.sediment ? { sediment: c.look.sediment } : {}) } } : {}),
  })
  // Stocks on the rack; the learner's own vessels with something in them in their glassware (the latest six).
  const loose = view.containers.filter((c) => c.kind === 'container' && c.capacityMl <= 1000)
  const rack = loose.filter((c) => c.supply).slice(0, 7)
  for (const c of rack) samples[c.id] = vessel(c)
  const own = loose.filter((c) => !c.supply && (c.volumeMl > 0 || c.solid)).slice(-6)
  for (const c of own) samples[c.id] = { ...vessel(c), vessel: { shape: vesselShape(c.equipment), capacityMl: c.capacityMl, volumeMl: c.volumeMl } }
  const plate = view.containers.find((c) => c.kind === 'plate' && (c.wells?.length ?? 0) === 96)
  const wells: (Sample | null)[][] = Array.from({ length: 8 }, () => Array.from({ length: 12 }, () => null))
  if (plate) {
    for (const w of view.containers.filter((c) => c.kind === 'well' && c.plate === plate.id && c.volumeMl > 0)) {
      const pos = w.position ?? ''
      const r = ROWS.indexOf(pos[0] ?? '')
      const col = Number(pos.slice(1)) - 1
      if (r >= 0 && col >= 0 && col < 12) wells[r][col] = vessel(w)
    }
  }
  return {
    samples,
    rack: rack.map((c) => c.id),
    vessels: own.map((c) => c.id),
    plate: { label: plate?.label ?? 'Plate', wells },
    waste: 0,
    clock: view.timeS,
    notes: [],
    pipette: 'P200',
    tipNew: true,
    tipContaminated: null,
    measurements: [],
    timeCourses: {},
    blankUsed: null,
    done: view.finished,
    log: [],
    flags: {},
  }
}

/** Which positions of a centrifuge's rotor hold a tube, for the 3D rotor (24 positions). */
export function rotorPositions(view: SessionView, isCentrifuge: (equipment: string) => boolean): boolean[] {
  const rotors = new Set(view.places.filter((p) => isCentrifuge(p.equipment)).map((p) => p.id))
  const out = Array.from({ length: 24 }, () => false)
  for (const c of view.containers) if (rotors.has(c.place) && c.slot !== undefined && c.slot >= 1 && c.slot <= 24) out[c.slot - 1] = true
  return out
}

/** A duration in simulated time as the clock shows it. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}

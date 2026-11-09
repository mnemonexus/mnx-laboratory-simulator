// Structured sample-state model. Pure types only — shared by sim core,
// renderer (via visual mapping) and host integration. Worker-safe.
export interface Sample {
  id: string
  name: string
  /** µL */
  volume: number
  capacity: number
  /** µM */
  concentration: number
  color: string
  /** fraction of molecules actually active (1 = normal) */
  activity?: number
  enzyme?: boolean
  substrate?: boolean
  stock?: boolean
  degraded?: boolean
  description?: string
  history: string[]
  /** What the simulation says the vessel looks like (Practicals): clarity, sediment and bubbling. */
  look?: SampleLook
  /** A learner's own vessel (Practicals): the glassware to draw it as, its capacity and contents in mL. */
  vessel?: { shape: string; capacityMl: number; volumeMl: number }
}

export interface SampleLook {
  /** 1 clear, 0 opaque. */
  clarity: number
  /** What lies on the bottom: its colour and its depth as a share of the liquid's. */
  sediment?: { colour: string; fraction: number }
  /** 0 still, 1 fizzing hard. */
  bubbling: number
}

export interface PlateState {
  wells: (Sample | null)[][]
  label: string
}

export type NoteKind = 'action' | 'measurement' | 'note' | 'warning' | 'system'
export interface Note {
  time: number
  kind: NoteKind
  text: string
}

export interface MeasurementEvent {
  time: number
  plate: string
  settings: string
  blank: string
  values: Record<string, number>
  raw: boolean
}

export interface TimePoint {
  t: number
  blank: number
  values: Record<string, number>
}

export interface LabState {
  /** The learner's own vessels with something in them (Practicals), drawn as glassware. */
  vessels?: string[]
  samples: Record<string, Sample>
  rack: string[]
  plate: PlateState
  waste: number
  clock: number
  notes: Note[]
  pipette: string
  tipNew: boolean
  tipContaminated: string | null
  measurements: MeasurementEvent[]
  timeCourses: Record<string, TimePoint[]>
  blankUsed: string | null
  done: boolean
  log: string[]
  flags: Record<string, string | boolean>
}

export interface ReaderSettings {
  wavelength: number
  blank: string
}

export type OverlayMode = 'physical' | 'signal'

export interface RateRecord {
  S: number
  v: number
  r2: number
}

export interface Answers {
  [key: string]: string
}

export interface GradeResult {
  domains: { name: string; weight: number; score: number; feedback: string }[]
  validity: 'Valid' | 'Valid with limitations' | 'Partially interpretable' | 'Invalid' | 'Inconclusive'
  summary: string
  misconceptions: string[]
}

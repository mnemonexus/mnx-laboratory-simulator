// Microscope operations (composition model §5; contract microscopy): setting the controls,
// focusing, cleaning oil off the lenses, and looking. A microscope nobody has touched is taken to
// be set up competently for each look (practicals that are not about microscopy need not set it
// up); once its controls are used, every look follows from how it is set (models/microscopy.ts).
import { describeFeature, type Graticule, illuminations, type ObjectiveSpec, objectiveIds, objectiveSpec, optics, readGraticule, structuresOn, viewField } from '../models/microscopy.ts'
import { createRng } from '../rng/rng.ts'
import { parseValue } from '../units/index.ts'
import { type OpContext, type OpImpl, type OpResult } from './kernel.ts'
import type { Container, EquipmentInstance, InstrumentState, MeasurementRecord, MicroscopeState } from './state.ts'
import { heartRate } from '../models/physiology.ts'

type Params = Record<string, unknown>

/** Glass is about 1.52: a liquid this close to it fills the gap for an oil objective. */
const IMMERSION_INDEX = 1.47
/** Under this working distance a dry objective dips into a drop of oil on the slide. */
const DIPS_INTO_OIL_MM = 1

function microscope(ctx: OpContext, ref: unknown): EquipmentInstance & { state: InstrumentState } {
  const inst = ctx.equipment(ref, 'instrument')
  if (inst.state.kind !== 'instrument' || !ctx.cat.isA(inst.equipment, 'core:microscope')) ctx.refuse('NOT-A-MICROSCOPE', `${inst.label} is not a microscope`)
  return inst as EquipmentInstance & { state: InstrumentState }
}

/** A microscope as it stands before anyone sets it up: lamp off, lowest objective in place. */
function controls(ctx: OpContext, inst: EquipmentInstance & { state: InstrumentState }): MicroscopeState {
  return (inst.state.microscope ??= {
    objective: objectiveIds(ctx.cat, inst.equipment)[0] ?? 'none',
    illumination: 'brightfield',
    lamp: 0,
    condenser: 'not-adjusted',
    stage: null,
    focus: 'none',
    oiled: [],
    cracked: [],
  })
}

export function hasImmersionOil(ctx: OpContext, c: Container): boolean {
  return c.contents.layers.some((l) =>
    Object.entries(l.species).some(([s, n]) => n > 0 && (ctx.cat.substances.get(s)?.physical?.refractiveIndex ?? 0) >= IMMERSION_INDEX),
  )
}

function specOf(ctx: OpContext, inst: EquipmentInstance, id: string): ObjectiveSpec {
  const spec = objectiveSpec(ctx.cat, inst.equipment, id)
  if (!spec) ctx.refuse('NO-OBJECTIVE', `${inst.label} has no ${id} objective (it has ${objectiveIds(ctx.cat, inst.equipment).join(', ')})`)
  return spec
}

/**
 * Oil meets whatever lens is over it: the oil objective (as it should, to be cleaned after use),
 * or a high-power dry objective, whose short working distance takes it into the drop.
 */
export function oilContact(ctx: OpContext): void {
  for (const inst of Object.values(ctx.world.equipment)) {
    const m = inst.state.kind === 'instrument' ? inst.state.microscope : undefined
    if (!m || !m.stage || m.objective === 'none') continue
    const slide = ctx.world.containers[m.stage]
    const spec = objectiveSpec(ctx.cat, inst.equipment, m.objective)
    if (!slide || !spec || !hasImmersionOil(ctx, slide)) continue
    if ((spec.oil || spec.workingDistanceMm < DIPS_INTO_OIL_MM) && !m.oiled.includes(spec.id)) m.oiled.push(spec.id)
  }
}

/** Turn the nosepiece: parfocal objectives stay nearly in focus. */
function swing(ctx: OpContext, inst: EquipmentInstance, m: MicroscopeState, id: string): void {
  if (id !== 'none') specOf(ctx, inst, id)
  if (m.objective === id) return
  m.objective = id
  if (m.focus !== 'none') m.focus = 'near'
}

function configure(ctx: OpContext, p: Params): OpResult {
  const inst = microscope(ctx, p.instrument)
  const m = controls(ctx, inst)
  if (p.lamp !== undefined) {
    const v = Number(p.lamp)
    if (!(v >= 0 && v <= 1)) ctx.refuse('BAD-LAMP', 'Set the lamp as a fraction of full output, 0 to 1')
    m.lamp = v
  }
  if (p.illumination !== undefined) {
    const v = String(p.illumination)
    if (!illuminations(ctx.cat, inst.equipment).includes(v)) ctx.refuse('BAD-ILLUMINATION', `${inst.label}'s condenser has ${illuminations(ctx.cat, inst.equipment).join(', ')}`)
    m.illumination = v
  }
  if (p.condenser !== undefined) m.condenser = p.condenser === 'adjusted' ? 'adjusted' : 'not-adjusted'
  const oiledBefore = m.oiled.length
  if (p.objective !== undefined) swing(ctx, inst, m, String(p.objective))
  oilContact(ctx)
  const dipped = m.oiled.slice(oiledBefore)
  return { facts: { objective: m.objective, illumination: m.illumination, lamp: m.lamp, condenser: m.condenser, ...(dipped.length ? { oiled: dipped } : {}) } }
}

/**
 * Focus on a slide, putting it on the stage. The coarse knob finds it at low power; at high power
 * the working distance is a fraction of a millimetre and racking the stage up drives the slide
 * into the lens. The fine knob only sharpens an image that is nearly there.
 */
function focus(ctx: OpContext, p: Params): OpResult {
  const inst = microscope(ctx, p.instrument)
  const m = controls(ctx, inst)
  const slide = ctx.container(p.subject, 'slide')
  if (m.stage !== slide.id) {
    m.stage = slide.id
    m.focus = 'none'
  }
  if (m.objective === 'none') ctx.refuse('NO-OBJECTIVE', 'Turn an objective into the light path first')
  const spec = specOf(ctx, inst, m.objective)
  if (p.knob === 'coarse') {
    if (spec.workingDistanceMm < DIPS_INTO_OIL_MM) {
      if (!m.cracked.includes(slide.id)) m.cracked.push(slide.id)
      m.focus = 'none'
      ctx.world.incidents.push({
        event: ctx.eventIndex,
        kind: 'mechanical',
        severity: 'sample',
        equipment: inst.id,
        message: `Racking the stage up at ${spec.id} drove ${slide.label} into the objective and cracked it: find the focus at low power first`,
      })
      oilContact(ctx)
      return { facts: { knob: 'coarse', crashed: true } }
    }
    m.focus = 'near'
    oilContact(ctx)
    return { facts: { knob: 'coarse', crashed: false } }
  }
  if (m.focus === 'none') return { facts: { knob: 'fine', found: false } }
  m.focus = 'sharp'
  oilContact(ctx)
  return { facts: { knob: 'fine', found: true } }
}

/** Wipe immersion oil off objectives (all that have it, or one) and, optionally, off a slide. */
function cleanLens(ctx: OpContext, p: Params): OpResult {
  const inst = microscope(ctx, p.instrument)
  const m = controls(ctx, inst)
  const which = p.objective === undefined ? [...m.oiled] : [String(p.objective)]
  m.oiled = m.oiled.filter((o) => !which.includes(o))
  let wipedL = 0
  if (p.slide !== undefined) {
    const slide = ctx.container(p.slide, 'slide')
    const immersion = (s: string) => (ctx.cat.substances.get(s)?.physical?.refractiveIndex ?? 0) >= IMMERSION_INDEX
    // A drop of oil sits as its own layer on the specimen: the tissue takes it all.
    slide.contents.layers = slide.contents.layers.filter((l) => {
      const present = Object.keys(l.species).filter((s) => l.species[s] > 0)
      if (present.length === 0 || !present.every(immersion)) return true
      wipedL += l.volumeL
      return false
    })
    for (const l of slide.contents.layers) for (const s of Object.keys(l.species)) if (immersion(s)) delete l.species[s]
  }
  // Leaving the oil objective over oiled glass would put the oil straight back.
  oilContact(ctx)
  return { facts: { cleaned: which, ...(p.slide !== undefined ? { slideWipedL: wipedL } : {}) } }
}

/** One look at a slide: the optics, and what of the slide they show. */
export function observeSlide(ctx: OpContext, instRef: unknown, subject: Container, p: Params): OpResult {
  const inst = microscope(ctx, instRef)
  const m = inst.state.microscope
  let setup
  if (!m) {
    // Untouched: set up competently for this look, oil and all.
    const spec = specOf(ctx, inst, String(p.objective ?? '100x-oil'))
    setup = { objective: spec, illumination: 'brightfield', lamp: 0.75, condenserAdjusted: true, focus: 'sharp' as const, oilOnSlide: true, lensOiled: false, cracked: false }
  } else {
    if (p.objective !== undefined) swing(ctx, inst, m, String(p.objective))
    if (m.stage !== subject.id) {
      m.stage = subject.id
      m.focus = 'none'
    }
    oilContact(ctx)
    if (m.objective === 'none') ctx.refuse('NO-OBJECTIVE', 'Turn an objective into the light path first')
    const spec = specOf(ctx, inst, m.objective)
    setup = {
      objective: spec,
      illumination: m.illumination,
      lamp: m.lamp,
      condenserAdjusted: m.condenser === 'adjusted',
      focus: m.focus,
      oilOnSlide: hasImmersionOil(ctx, subject),
      lensOiled: m.oiled.includes(spec.id),
      cracked: m.cracked.includes(subject.id),
    }
  }
  const o = optics(ctx.cat, inst.equipment, setup)
  const structures = structuresOn(ctx.cat, subject)
  const features = viewField(structures, o, ctx.rng('microscope-field'))
  // An eyepiece graticule lined up against what is in view.
  const g = graticuleFor(ctx, inst, setup.objective)
  const scale = g && !o.blank ? readGraticule(structures, features, g, ctx.rng('graticule'), ctx.options.noise) : undefined
  // A water flea's heart, seen through its body and counted for 15 seconds (to a beat or two).
  const heart = !o.blank ? heartRate(ctx.cat, subject.contents) : undefined
  const beats = heart ? Math.max(0, Math.round(heart.bpm / 4 + ctx.rng('heartbeat').normal(0, 1.5 * ctx.options.noise))) : undefined
  const graticuleText = scale
    ? [
        ...(scale.calibration ? [`against the graticule: ${scale.calibration.eyepiece} eyepiece divisions line up with ${scale.calibration.stage} divisions of the stage scale`] : []),
        ...scale.measured.map(([label, n]) => `one of the ${label} measures ${n} eyepiece divisions`),
        ...scale.tooLong.map((label) => `the ${label} are longer than the graticule scale`),
      ]
    : []
  const seen = o.blank ?? [...features.map(describeFeature), ...(beats !== undefined ? [`its heart beats ${beats} times in 15 seconds`] : []), ...graticuleText].join('; ')
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: inst.id,
    settings: {
      objective: setup.objective.id,
      illumination: setup.illumination,
      magnification: o.magnification,
      fieldOfViewMm: Number(o.fieldOfViewMm.toFixed(3)),
      resolutionUm: Number(o.resolutionUm.toFixed(2)),
    },
    subject: subject.id,
    kind: 'observation',
    quantity: 'appearance',
    unit: '',
    display: { [subject.id]: seen || 'nothing visible' },
    flags: o.flags.length ? { [subject.id]: o.flags } : {},
    uncertainty: {},
    features,
  }
  ctx.world.measurements.push(record)
  // What was counted in this field, as [structure, number] pairs.
  const counts = features.filter((f) => f.count !== undefined).map((f) => [f.shape, f.count!])
  // A graticule's readings: [structure, eyepiece divisions] for what was measured, and the stage scale's match.
  const graticuleOut = scale ? { measured: scale.measured, ...(scale.calibration ? { calibration: scale.calibration } : {}) } : {}
  return { outputs: { record: record.id, appearance: record.display[subject.id], counts, fieldAreaMm2: Math.PI * (o.fieldOfViewMm / 2) ** 2, fieldMm: Number(o.fieldOfViewMm.toFixed(3)), ...(beats !== undefined ? { beats15s: beats } : {}), ...graticuleOut }, facts: { record: record.id, features: features.length, magnification: o.magnification } }
}

/**
 * The microscope's eyepiece graticule, if it has one (`graticule`: its divisions; `graticuleSpan`:
 * their length in the eyepiece, 10 mm if unset), with the objective in place. Each objective's true
 * magnification is its nominal one within a few per cent, fixed for the instrument.
 */
function graticuleFor(ctx: OpContext, inst: EquipmentInstance, o: ObjectiveSpec): Graticule | undefined {
  const divisions = Number(ctx.cat.property(inst.equipment, 'graticule') ?? 0)
  if (!(divisions > 0)) return undefined
  const spanUm = parseValue(String(ctx.cat.property(inst.equipment, 'graticuleSpan') ?? '10 mm')).si * 1e6
  const error = Math.max(-0.05, Math.min(0.05, createRng(`${ctx.world.seed}|objective|${inst.id}|${o.id}`).normal(0, 0.02)))
  return { divisions, umPerDivision: spanUm / divisions / (o.magnification * (1 + error)) }
}

export const MICROSCOPE_OPERATIONS: Record<string, OpImpl> = {
  'core:configure': configure,
  'core:focus': focus,
  'core:clean-lens': cleanLens,
}

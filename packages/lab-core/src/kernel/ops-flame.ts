// Flame operations (models/flame.ts): a flame test with a wire loop, seen by eye, through
// cobalt-blue glass, or through a hand spectroscope. The wire carries what it last held until it is
// cleaned in acid and heated, so an unclean wire shows the last sample's colour (often sodium's).
import { type OpContext, type OpImpl, type OpResult } from './kernel.ts'
import { liquidVolume, type MeasurementRecord, type ToolState } from './state.ts'
import { COBALT_GLASS, emittersIn, flameLook, spectroscopeLines } from '../models/flame.ts'
import { hex } from '../models/colour.ts'
import { molarMass } from './materials.ts'

type Params = Record<string, unknown>

/** What a dipped loop holds: about 10 µL of a liquid, or about half a milligram of a dry solid. */
const LOOP_L = 1e-5
const LOOP_SOLID_G = 5e-4
/** Share of what was on the wire that stays fused to it after the test, and after cleaning. */
const LEFT_AFTER_TEST = 0.05
const LEFT_AFTER_CLEANING = 1e-3

function flameTest(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.sample, 'sample')
  const wire = ctx.equipment(p.wire, 'wire')
  if (ctx.cat.property(wire.equipment, 'flameTest') !== true) ctx.refuse('NOT-A-FLAME-WIRE', `${wire.label} is not a flame-test wire`)
  const view = String(p.view ?? 'eye')
  if (!['eye', 'cobalt-glass', 'spectroscope'].includes(view)) ctx.refuse('UNKNOWN-VIEW', `View the flame by eye, through cobalt-glass or through a spectroscope, not "${view}"`)
  const state = wire.state as ToolState
  // Dipped in concentrated hydrochloric acid and held in the flame until it gives no colour.
  const residue: Record<string, number> = {}
  const keep = p.clean === false ? 1 : LEFT_AFTER_CLEANING
  for (const [s, n] of Object.entries(state.residue ?? {})) residue[s] = n * keep
  // The loop picks up a little of the liquid, or of the solid if there is no liquid.
  const v = liquidVolume(c.contents)
  let share = 0
  if (v > 0) share = Math.min(1, LOOP_L / v)
  else {
    const grams = Object.entries(c.contents.solid).reduce((a, [s, n]) => a + n * (molarMass(ctx.cat, s) ?? 0), 0)
    if (grams > 0) share = Math.min(1, LOOP_SOLID_G / grams)
  }
  if (share <= 0) ctx.refuse('NOTHING-TO-PICK-UP', `${c.label} holds nothing for the wire to pick up`)
  const onWire = { ...residue }
  for (const [s, n] of Object.entries(emittersIn(ctx.cat, v > 0 ? { ...c.contents, solid: {} } : c.contents, share))) onWire[s] = (onWire[s] ?? 0) + n
  state.residue = Object.fromEntries(Object.entries(onWire).map(([s, n]) => [s, n * LEFT_AFTER_TEST]))

  const look = flameLook(ctx.cat, onWire, view === 'cobalt-glass' ? COBALT_GLASS : undefined)
  const outputs: Record<string, unknown> = { colour: look.name, hex: hex(look.rgb), brightness: Math.round(look.brightness * 100) / 100 }
  let display = look.name === 'blue' ? 'the flame stays blue' : `${/^[aeiou]/.test(look.name) ? 'an' : 'a'} ${look.name} flame`
  if (view === 'cobalt-glass') display += ' through the blue glass'
  if (view === 'spectroscope') {
    const resolution = 2
    const rng = ctx.rng('spectroscope')
    const lines = spectroscopeLines(ctx.cat, onWire, resolution).map((l) => ({ ...l, nm: Math.round(l.nm + ctx.options.noise * rng.normal(0, resolution / 2)) }))
    outputs.lines = lines.map((l) => l.nm)
    display = lines.length
      ? lines.map((l) => `${l.nm} nm ${l.colour}${l.band ? ' band' : ''}${l.brightness > 0.6 ? ' (bright)' : l.brightness < 0.3 ? ' (faint)' : ''}`).join('; ')
      : 'no bright lines, only the burner\'s faint blue'
  }
  outputs.appearance = display
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: wire.id,
    settings: { view },
    subject: c.id,
    kind: 'observation',
    quantity: 'appearance',
    unit: '',
    display: { [c.id]: display },
    flags: {},
    uncertainty: {},
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, ...outputs }, facts: { record: record.id, colour: look.name } }
}

export const FLAME_OPERATIONS: Record<string, OpImpl> = {
  'core:flame-test': flameTest,
}

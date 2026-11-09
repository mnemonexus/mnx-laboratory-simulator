// Heart rate of a small animal seen under the microscope (contract organism.heart-rate, T1): a
// water flea's heart beats at its rate at 20 °C, scaled by Q10 for the water's temperature and by
// each drug in the water, 1 + change × c / (c + EC50) (caffeine speeds it, ethanol slows it).
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Contents } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'

/** The animal on the slide with a heart, and its rate (beats a minute), if any. */
export function heartRate(cat: Catalogue, contents: Contents): { organism: string; bpm: number } | undefined {
  const organism = Object.keys(contents.solid).find((s) => (contents.solid[s] ?? 0) > 0 && cat.substances.get(s)?.heart)
  if (!organism) return undefined
  const h = cat.substances.get(organism)!.heart!
  let bpm = h.bpm * Math.pow(h.q10 ?? 2, (contents.temperatureK - 293.15) / 10)
  const layer = contents.layers[contents.layers.length - 1]
  for (const [drug, d] of Object.entries(h.drugs ?? {})) {
    const n = layer?.species[drug] ?? 0
    if (!(n > 0) || !(layer.volumeL > 0)) continue
    const c = n / layer.volumeL
    const ec50 = parseValue(d.ec50).si / 1000
    bpm *= Math.max(0, 1 + (d.change * c) / (c + ec50))
  }
  return { organism, bpm }
}

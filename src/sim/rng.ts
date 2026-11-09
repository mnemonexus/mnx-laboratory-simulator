// Pure deterministic RNG + units. No DOM, no React — worker-safe.
export function noise(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 13
  h = Math.imul(h, 0x5bd1e995)
  h ^= h >>> 15
  return (h >>> 0) / 4294967295
}

export function jitter(seed: string, sd = 1): number {
  const a = noise(seed + ':a')
  const b = noise(seed + ':b')
  return Math.sqrt(-2 * Math.log(Math.max(a, 1e-9))) * Math.cos(2 * Math.PI * b) * sd
}

export const trim = (v: number, d = 3) => String(parseFloat(v.toFixed(d)))
export const uL = (v: number) => (v < 1000 ? `${trim(v)} µL` : `${trim(v / 1000)} mL`)
export const uM = (v: number) => {
  if (v === 0) return '0 µM'
  if (v >= 1000) return `${trim(v / 1000)} mM`
  return `${trim(v)} µM`
}

export const ROWS = 'ABCDEFGH'
export const wellId = (r: number, c: number) => `${ROWS[r]}${c + 1}`
export const parseWell = (id: string): [number, number] => [
  ROWS.indexOf(id[0]),
  parseInt(id.slice(1), 10) - 1,
]

export function hexToRgb(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
}

export function mixHex(a: string, b: string, fa: number, fb: number): string {
  if (fa === 0) return b
  if (fb === 0) return a
  const pa = hexToRgb(a)
  const pb = hexToRgb(b)
  const f = fb / (fa + fb)
  const m = (i: number) => Math.round(pa[i] * (1 - f) + pb[i] * f)
  return `#${[m(0), m(1), m(2)].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

export function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60)
  const ss = Math.floor(sec % 60)
  return `${m}m ${String(ss).padStart(2, '0')}s`
}

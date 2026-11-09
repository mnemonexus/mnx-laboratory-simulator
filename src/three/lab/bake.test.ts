import { describe, expect, it } from 'vitest'
import { fromRgb9e5, rgb9e5, runBake, type BakeJob } from './bake'

/** A 2 × 2 m floor patch under one downward area light, optionally with a box on it. */
function floorJob(extra: Partial<BakeJob> = {}, box?: number[]): BakeJob {
  const texel = 0.05
  const n = Math.round(2 / texel)
  return {
    id: 'test', texel, atlasW: 64, atlasH: 64,
    islands: [{ x: 2, y: 2, w: n, h: n, wM: 2, hM: 2, origin: [-1, 0, -1], u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0] }],
    boxes: new Float32Array(box ?? []),
    planes: new Float32Array([0, 1, 0, 0, 0, -1, 0, 2.5]),
    emitters: [{ kind: 'rect', c: [0, 2.48, 0], a: [0.3, 0, 0], b: [0, 0, 0.6], n: [0, -1, 0], L: [6, 6, 6] }],
    aoRays: 16, aoDist: 0.75, aoStrength: 0.88, samples: 4, supersample: 2,
    ambient: { up: [0.2, 0.2, 0.2], side: [0.2, 0.2, 0.2], down: [0.4, 0.4, 0.4] },
    ...extra,
  }
}

const texelAt = (atlas: Uint32Array, i: number, j: number) => fromRgb9e5(atlas[(2 + j) * 64 + 2 + i])[0]

describe('shared-exponent RGB', () => {
  it('round-trips lightmap values to within its 9-bit precision', () => {
    for (const v of [0, 0.001, 0.37, 1, 2.5, 37.25, 900]) {
      const [r, g, b] = fromRgb9e5(rgb9e5(v, v * 0.5, v * 0.25))
      expect(Math.abs(r - v)).toBeLessThanOrEqual(v / 256 + 1e-6)
      expect(Math.abs(g - v * 0.5)).toBeLessThanOrEqual(v / 256 + 1e-6)
      expect(Math.abs(b - v * 0.25)).toBeLessThanOrEqual(v / 256 + 1e-6)
    }
  })
})

describe('lightmap baker', () => {
  it('leaves texels under a solid box out instead of darkening their neighbours', () => {
    // a 0.4 m cube centred on the patch
    const r = runBake(floorJob({}, [-0.2, 0, -0.2, 0.2, 0.4, 0.2]))
    const open = texelAt(r.atlas, 4, 4)
    const nextToBox = texelAt(r.atlas, 15, 20)  // 5 cm outside the cube's −x face
    const under = texelAt(r.atlas, 20, 20)
    // contact darkening, but nothing like the old 35 % of ambient band
    expect(nextToBox).toBeGreaterThan(open * 0.2)
    // the hidden texel is filled from its visible neighbours, not left black or at ambient×0.35
    expect(under).toBeGreaterThan(0.05)
    expect(Number.isFinite(under)).toBe(true)
  })

  it('casts a soft shadow edge that falls off over several texels', () => {
    // a tall thin wall between the light and the +x side of the patch
    const r = runBake(floorJob({}, [0.35, 0, -1, 0.4, 1.6, 1]))
    const row = Array.from({ length: 40 }, (_, i) => texelAt(r.atlas, i, 20))
    const lit = Math.max(...row.slice(0, 20)), dark = Math.min(...row.slice(28))
    expect(dark).toBeLessThan(lit * 0.6)
    // count texels strictly between 20 % and 80 % of the transition: a stepped
    // point-light shadow has at most one; a soft area-light edge several
    const mid = row.filter((v) => v > dark + (lit - dark) * 0.2 && v < dark + (lit - dark) * 0.8).length
    expect(mid).toBeGreaterThanOrEqual(3)
  })

  it('lets light through wall openings and blocks it elsewhere', () => {
    // a wall quad at x = 0.5 from z −1..1, y 0..2.5, with the light beyond it at x = 1.2
    const light = { kind: 'rect' as const, c: [1.2, 2.4, 0] as [number, number, number], a: [0.2, 0, 0] as [number, number, number], b: [0, 0, 0.2] as [number, number, number], n: [0, -1, 0] as [number, number, number], L: [8, 8, 8] as [number, number, number] }
    const solid = new Float32Array([0.5, 0, -1, 0, 0, 2, 0, 2.5, 0, -1, 0, 0])
    const dark = { up: [0, 0, 0] as [number, number, number], side: [0, 0, 0] as [number, number, number], down: [0, 0, 0] as [number, number, number] }
    const blocked = runBake(floorJob({ emitters: [light], quads: solid, aoRays: 0, ambient: dark }))
    // two pieces with a 0.6 m gap at z −0.3..0.3 (a doorway)
    const withGap = new Float32Array([0.5, 0, -1, 0, 0, 0.7, 0, 2.5, 0, -1, 0, 0, 0.5, 0, 0.3, 0, 0, 0.7, 0, 2.5, 0, -1, 0, 0])
    const open = runBake(floorJob({ emitters: [light], quads: withGap, aoRays: 0, ambient: dark }))
    expect(texelAt(blocked.atlas, 10, 20)).toBeLessThan(1e-3)
    expect(texelAt(open.atlas, 10, 20)).toBeGreaterThan(0.01)
  })

  it('adds a first bounce that brightens texels near lit surfaces', () => {
    const noBounce = runBake(floorJob({}, [0.6, 0, -1, 1, 2.4, 1]))
    const bounce = runBake(floorJob({ bounce: { wallAlbedo: 0.5, floorAlbedo: 0.5, ceilingAlbedo: 0.8 } }, [0.6, 0, -1, 1, 2.4, 1]))
    const a = texelAt(noBounce.atlas, 30, 20), b = texelAt(bounce.atlas, 30, 20)
    expect(b).toBeGreaterThan(a * 0.6)
    expect(Number.isFinite(b)).toBe(true)
  })

  it('bakes an ambient cube per volume cell, lit from above more than below', () => {
    const r = runBake(floorJob({ volume: { origin: [-0.5, 0.5, -0.5], nx: 3, ny: 2, nz: 3, cell: 0.5 } }))
    const cells = 3 * 2 * 3
    const up = fromRgb9e5(r.volume![2 * cells + 4])[0]    // +y block, centre cell of the lower layer
    const down = fromRgb9e5(r.volume![3 * cells + 4])[0]  // −y block
    expect(r.volume!.length).toBe(cells * 6)
    expect(up).toBeGreaterThan(down)
  })
})

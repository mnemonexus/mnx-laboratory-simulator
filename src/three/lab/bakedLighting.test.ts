import { describe, expect, it } from 'vitest'
import { decodeBakedLighting, encodeBakedLighting, inputFingerprint } from './bakedLighting'
import type { BakeJob } from './bake'

const job = (over: Partial<BakeJob> = {}): BakeJob => ({
  id: 'main', texel: 0.05, atlasW: 64, atlasH: 32,
  islands: [{ x: 2, y: 2, w: 10, h: 10, wM: 0.5, hM: 0.5, origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0] }],
  boxes: new Float32Array([0, 0, 0, 1, 1, 1]), planes: new Float32Array([0, 1, 0, 0]),
  emitters: [{ kind: 'rect', c: [0, 2.5, 0], a: [0.3, 0, 0], b: [0, 0, 0.6], n: [0, -1, 0], L: [6, 6, 6] }],
  aoRays: 8, aoDist: 0.75, aoStrength: 0.88, samples: 2, supersample: 1,
  ambient: { up: [0.2, 0.2, 0.2], side: [0.2, 0.2, 0.2], down: [0.4, 0.4, 0.4] },
  ...over,
})

describe('shipped lighting bake', () => {
  it('matches a room however finely it was sampled, but not after its layout changes', () => {
    const base = inputFingerprint(job())
    expect(inputFingerprint(job({ aoRays: 64, samples: 4, supersample: 2 }))).toBe(base)
    expect(inputFingerprint(job({ boxes: new Float32Array([0, 0, 0, 1, 1.2, 1]) }))).not.toBe(base)
    expect(inputFingerprint(job({ emitters: [] }))).not.toBe(base)
    expect(inputFingerprint(job({ atlasW: 128 }))).not.toBe(base)
  })

  it('round-trips rooms, lightmaps and volumes through the asset format', () => {
    const atlas = Uint32Array.from({ length: 64 * 32 }, (_, i) => i * 7)
    const volume = { spec: { origin: [0, 0.08, 0] as [number, number, number], nx: 2, ny: 1, nz: 3, cell: 0.16 }, data: Uint32Array.from({ length: 36 }, (_, i) => i + 1) }
    const raw = encodeBakedLighting([
      { zone: 'main', fingerprint: 'aa', atlasW: 64, atlasH: 32, atlas, volume },
      { zone: 'cold', fingerprint: 'bb', atlasW: 64, atlasH: 32, atlas: atlas.slice(0) },
    ])
    const rooms = decodeBakedLighting(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    const main = rooms.get('main|aa')!
    expect(Array.from(main.atlas)).toEqual(Array.from(atlas))
    expect(Array.from(main.volume!.data)).toEqual(Array.from(volume.data))
    expect(main.volume!.spec).toEqual(volume.spec)
    expect(rooms.get('cold|bb')!.volume).toBeUndefined()
  })
})

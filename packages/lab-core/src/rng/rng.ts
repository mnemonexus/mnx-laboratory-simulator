// Seeded randomness (master-plan/03 D5, 04 §6). Every random draw in the kernel comes from a
// stream derived from (run seed, event index, channel): replicates differ, replays are identical.
// No Math.random anywhere in the framework core.

/** 53-bit string hash (cyrb53). Stable across platforms. */
export function hashString(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform in [lo, hi). */
  uniform(lo: number, hi: number): number
  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number
  normal(mean?: number, sd?: number): number
  poisson(lambda: number): number
  binomial(n: number, p: number): number
  pick<T>(items: readonly T[]): T
  /** A child stream, independent of this one's future draws. */
  fork(channel: string): Rng
}

/** sfc32: small, fast, good statistical quality, 32-bit state words. */
class Sfc32 implements Rng {
  private a: number
  private b: number
  private c: number
  private d: number
  private spare: number | undefined
  private readonly key: number

  constructor(key: number) {
    this.key = key
    this.a = key >>> 0
    this.b = Math.floor(key / 4294967296) >>> 0
    this.c = (key ^ 0x9e3779b9) >>> 0
    this.d = 1
    for (let i = 0; i < 12; i++) this.raw()
  }

  private raw(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0
    this.d = (this.d + 1) | 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) | 0
    this.c = (this.c << 21) | (this.c >>> 11)
    this.c = (this.c + t) | 0
    return t >>> 0
  }

  next(): number {
    return this.raw() / 4294967296
  }

  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next()
  }

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }

  normal(mean = 0, sd = 1): number {
    if (this.spare !== undefined) {
      const z = this.spare
      this.spare = undefined
      return mean + sd * z
    }
    let u = 0
    let v = 0
    let s = 0
    do {
      u = this.next() * 2 - 1
      v = this.next() * 2 - 1
      s = u * u + v * v
    } while (s >= 1 || s === 0)
    const f = Math.sqrt((-2 * Math.log(s)) / s)
    this.spare = v * f
    return mean + sd * u * f
  }

  poisson(lambda: number): number {
    if (!(lambda > 0)) return 0
    if (lambda < 30) {
      // Knuth: exact for small means.
      const limit = Math.exp(-lambda)
      let k = 0
      let p = 1
      do {
        k++
        p *= this.next()
      } while (p > limit)
      return k - 1
    }
    // Normal approximation with continuity correction; adequate at teaching-lab counts.
    return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))))
  }

  binomial(n: number, p: number): number {
    if (n <= 0 || p <= 0) return 0
    if (p >= 1) return n
    if (n < 50) {
      let k = 0
      for (let i = 0; i < n; i++) if (this.next() < p) k++
      return k
    }
    const mean = n * p
    const sd = Math.sqrt(n * p * (1 - p))
    return Math.min(n, Math.max(0, Math.round(this.normal(mean, sd))))
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list')
    return items[Math.floor(this.next() * items.length)]
  }

  fork(channel: string): Rng {
    return new Sfc32(hashString(channel, this.key % 4294967296))
  }
}

export function createRng(seed: number | string): Rng {
  return new Sfc32(typeof seed === 'number' ? hashString(`seed:${seed}`) : hashString(seed))
}

/** The stream for one random channel of one event: (run seed, event index, channel). */
export function eventRng(seed: number, eventIndex: number, channel: string): Rng {
  return new Sfc32(hashString(`${seed}|${eventIndex}|${channel}`))
}

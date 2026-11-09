// Procedural surface textures for the lab shell and casework.
// Everything is painted on canvases at load (no external assets, so the
// single-file build stays self-contained). Resolution follows the texture tier.
import * as THREE from 'three'
import { normalPixels } from '../texturePixels'

export interface SurfaceSet {
  map: THREE.Texture
  roughnessMap?: THREE.Texture
  normalMap?: THREE.Texture
}

/** Deterministic PRNG so every load paints the same room. */
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Tileable fractal value noise in [0, 1]. */
function tileNoise(size: number, cells: number, octaves: number, seed: number) {
  const out = new Float32Array(size * size)
  const rand = rng(seed)
  let amp = 1
  let total = 0
  for (let o = 0; o < octaves; o++) {
    const c = cells << o
    const lattice = new Float32Array(c * c)
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand()
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * c
      const y0 = Math.floor(fy)
      const ty = fy - y0
      const sy = ty * ty * (3 - 2 * ty)
      const r0 = (y0 % c) * c
      const r1 = ((y0 + 1) % c) * c
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * c
        const x0 = Math.floor(fx)
        const tx = fx - x0
        const sx = tx * tx * (3 - 2 * tx)
        const c0 = x0 % c
        const c1 = (x0 + 1) % c
        const a = lattice[r0 + c0] + (lattice[r0 + c1] - lattice[r0 + c0]) * sx
        const b = lattice[r1 + c0] + (lattice[r1 + c1] - lattice[r1 + c0]) * sx
        out[y * size + x] += (a + (b - a) * sy) * amp
      }
    }
    total += amp
    amp *= 0.5
  }
  for (let i = 0; i < out.length; i++) out[i] /= total
  return out
}

function canvas(w: number, h = w) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function toTexture(c: HTMLCanvasElement, srgb: boolean, anisotropy: number) {
  const t = new THREE.CanvasTexture(c)
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.anisotropy = anisotropy
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.userData.shared = true
  t.needsUpdate = true
  return t
}

function heightToNormal(h: Float32Array, size: number, strength: number) {
  const c = canvas(size)
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(size, size)
  normalPixels(h, size, size, strength, false, img.data)
  ctx.putImageData(img, 0, 0)
  return c
}

function greyCanvas(values: Float32Array, size: number, lo: number, hi: number) {
  const c = canvas(size)
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < values.length; i++) {
    const v = Math.round((lo + (hi - lo) * values[i]) * 255)
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v
    img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c
}

export interface SurfaceOptions {
  size: number
  normalMaps: boolean
  anisotropy: number
}

/** Light grey speckled terrazzo-look sheet vinyl, as in every reference photo (1 m repeat). */
export function vinylFloor(o: SurfaceOptions): SurfaceSet {
  const size = o.size
  const mottle = tileNoise(size, 6, 4, 11)
  const c = canvas(size)
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < mottle.length; i++) {
    const v = 206 + (mottle[i] - 0.5) * 10
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v + 1
    img.data[i * 4 + 2] = v + 3
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const rand = rng(77)
  const scale = size / 1024
  const chips = Math.round(56000 * scale * scale)
  const palette = ['#8d9094', '#7a7e83', '#f4f4f2', '#e9eaea', '#a9adb1', '#6c7178', '#b7bcc2', '#9aa3ad']
  for (let i = 0; i < chips; i++) {
    ctx.fillStyle = palette[(rand() * palette.length) | 0]
    ctx.globalAlpha = 0.35 + rand() * 0.45
    const s = (0.8 + rand() * 3.2) * Math.max(0.6, scale)
    ctx.fillRect(rand() * size, rand() * size, s, s * (0.6 + rand() * 0.8))
  }
  ctx.globalAlpha = 1
  const rough = tileNoise(size, 4, 3, 19)
  const set: SurfaceSet = {
    map: toTexture(c, true, o.anisotropy),
    roughnessMap: toTexture(greyCanvas(rough, size, 0.62, 0.86), false, o.anisotropy),
  }
  if (o.normalMaps) set.normalMap = toTexture(heightToNormal(tileNoise(size, 48, 2, 23), size, 0.6), false, o.anisotropy)
  return set
}

/** Graphite phenolic / epoxy worktop with a soft satin sheen (1 m repeat). */
export function graphiteTop(o: SurfaceOptions): SurfaceSet {
  const size = Math.min(o.size, 1024)
  const mottle = tileNoise(size, 5, 4, 31)
  const c = canvas(size)
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < mottle.length; i++) {
    const v = 70 + (mottle[i] - 0.5) * 10
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v + 2
    img.data[i * 4 + 2] = v + 5
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const rand = rng(5)
  const n = Math.round(26000 * (size / 1024) ** 2)
  for (let i = 0; i < n; i++) {
    const g = 84 + rand() * 50
    ctx.fillStyle = `rgba(${g},${g + 3},${g + 7},${0.25 + rand() * 0.35})`
    ctx.fillRect(rand() * size, rand() * size, 1.2, 1.2)
  }
  const set: SurfaceSet = {
    map: toTexture(c, true, o.anisotropy),
    roughnessMap: toTexture(greyCanvas(tileNoise(size, 3, 4, 37), size, 0.3, 0.42), false, o.anisotropy),
  }
  if (o.normalMaps) set.normalMap = toTexture(heightToNormal(tileNoise(size, 64, 2, 41), size, 0.35), false, o.anisotropy)
  return set
}

/** Eggshell wall paint: albedo is set by material colour, this is the sheen. */
export function wallPaint(o: SurfaceOptions): SurfaceSet {
  const size = Math.min(o.size, 512)
  const c = greyCanvas(tileNoise(size, 6, 4, 61), size, 0.965, 1.0)
  const set: SurfaceSet = { map: toTexture(c, true, o.anisotropy) }
  if (o.normalMaps) set.normalMap = toTexture(heightToNormal(tileNoise(size, 96, 2, 67), size, 0.5), false, o.anisotropy)
  return set
}

/**
 * Fissured acoustic ceiling tile with the exposed T-bar grid painted in.
 * One repeat covers 2 × 2 tiles (1.2 m).
 */
export function ceilingTile(o: SurfaceOptions): SurfaceSet {
  const size = Math.min(o.size, 1024)
  const n = tileNoise(size, 12, 3, 71)
  const c = canvas(size)
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < n.length; i++) {
    const v = 239 + (n[i] - 0.5) * 12
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v
    img.data[i * 4 + 2] = v - 2
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const rand = rng(73)
  const k = size / 1024
  // dense fine speckle (pinholes) and short fissures: reads as acoustic tile
  for (let i = 0; i < 24000 * k * k; i++) {
    const g = 140 + rand() * 40
    ctx.fillStyle = `rgba(${g},${g - 2},${g - 6},${0.2 + rand() * 0.32})`
    const s = (0.9 + rand() * 1.3) * Math.max(k, 0.6)
    ctx.fillRect(rand() * size, rand() * size, s, s)
  }
  ctx.strokeStyle = 'rgba(160,158,150,0.22)'
  ctx.lineWidth = Math.max(0.6, k)
  for (let i = 0; i < 700 * k; i++) {
    const x = rand() * size
    const y = rand() * size
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.quadraticCurveTo(x + (rand() - 0.5) * 14 * k, y + (rand() - 0.5) * 14 * k, x + (rand() - 0.5) * 22 * k, y + (rand() - 0.5) * 22 * k)
    ctx.stroke()
  }
  // T-bar grid: 24 mm flange with a shadow reveal on each side
  const half = size / 2
  const bar = Math.max(2, Math.round(0.024 * (size / 1.2)))
  for (const p of [0, half]) {
    ctx.fillStyle = 'rgba(120,120,116,0.55)'
    ctx.fillRect(p - bar / 2 - 1, 0, bar + 2, size)
    ctx.fillRect(0, p - bar / 2 - 1, size, bar + 2)
    ctx.fillStyle = '#f6f6f3'
    ctx.fillRect(p - bar / 2, 0, bar, size)
    ctx.fillRect(0, p - bar / 2, size, bar)
  }
  // wrap the seam at 0 onto the opposite edge
  ctx.fillStyle = '#f6f6f3'
  ctx.fillRect(size - bar / 2, 0, bar / 2, size)
  ctx.fillRect(0, size - bar / 2, size, bar / 2)
  return { map: toTexture(c, true, o.anisotropy) }
}

/** Dark walnut door veneer, vertical grain over the whole leaf (UV 0–1). */
export function walnutVeneer(o: SurfaceOptions): SurfaceSet {
  const w = Math.min(o.size, 1024) / 2
  const h = w * 2
  const c = canvas(w, h)
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, w, 0)
  g.addColorStop(0, '#4a3022')
  g.addColorStop(0.5, '#563828')
  g.addColorStop(1, '#4b3023')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  const rand = rng(83)
  const k = w / 256
  for (let i = 0; i < 260; i++) {
    const x = rand() * w
    const dark = rand() > 0.45
    ctx.strokeStyle = dark ? `rgba(32,18,11,${0.12 + rand() * 0.22})` : `rgba(122,84,58,${0.08 + rand() * 0.14})`
    ctx.lineWidth = (0.6 + rand() * 2.2) * k
    ctx.beginPath()
    ctx.moveTo(x, 0)
    let cx = x
    for (let y = 0; y <= h; y += 24 * k) {
      cx += (rand() - 0.5) * 2.2 * k
      ctx.lineTo(cx, y)
    }
    ctx.stroke()
  }
  // a few cathedral arches
  for (let i = 0; i < 5; i++) {
    const cx = w * (0.2 + rand() * 0.6)
    const cy = h * (0.15 + rand() * 0.7)
    for (let r = 6; r < 60; r += 7) {
      ctx.strokeStyle = `rgba(30,17,10,${0.05 + rand() * 0.07})`
      ctx.lineWidth = 1.2 * k
      ctx.beginPath()
      ctx.ellipse(cx, cy, r * k * 0.45, r * k * 3.2, 0, Math.PI * 1.05, Math.PI * 1.95)
      ctx.stroke()
    }
  }
  const tex = toTexture(c, true, o.anisotropy)
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  return { map: tex }
}

function branch(ctx: CanvasRenderingContext2D, rand: () => number, x: number, y: number, len: number, ang: number, width: number, depth: number) {
  const x2 = x + Math.cos(ang) * len
  const y2 = y - Math.sin(ang) * len
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.quadraticCurveTo((x + x2) / 2 + (rand() - 0.5) * len * 0.25, (y + y2) / 2, x2, y2)
  ctx.stroke()
  if (depth <= 0 || len < 3) return
  const n = 2 + (rand() > 0.6 ? 1 : 0)
  for (let i = 0; i < n; i++) {
    const spread = 0.35 + rand() * 0.5
    branch(ctx, rand, x2, y2, len * (0.62 + rand() * 0.18), ang + (i - (n - 1) / 2) * spread + (rand() - 0.5) * 0.3, width * 0.68, depth - 1)
  }
}

/** Blue-hour view of bare trees, as seen through the reference windows. */
export function duskView(width = 1024) {
  const w = width
  const h = Math.round(width * 0.68)
  const c = canvas(w, h)
  const ctx = c.getContext('2d')!
  const sky = ctx.createLinearGradient(0, 0, 0, h)
  sky.addColorStop(0, '#0a1a4a')
  sky.addColorStop(0.45, '#163a86')
  sky.addColorStop(0.8, '#2a57b0')
  sky.addColorStop(1, '#1d3a78')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, w, h)
  const rand = rng(97)
  const k = w / 1024
  // distant tree line
  ctx.fillStyle = '#101b33'
  ctx.beginPath()
  ctx.moveTo(0, h)
  for (let x = 0; x <= w; x += 6 * k) ctx.lineTo(x, h * 0.78 - rand() * 40 * k)
  ctx.lineTo(w, h)
  ctx.fill()
  // bare trees
  ctx.lineCap = 'round'
  const trees = 7
  for (let i = 0; i < trees; i++) {
    const x = (i + 0.2 + rand() * 0.6) * (w / trees)
    const near = rand()
    ctx.strokeStyle = near > 0.5 ? '#0a1124' : '#131f3b'
    branch(ctx, rand, x, h + 5, h * (0.28 + near * 0.12), Math.PI / 2 + (rand() - 0.5) * 0.2, (10 + near * 8) * k, 7)
  }
  // faint hedge / ground
  ctx.fillStyle = '#0b1328'
  ctx.fillRect(0, h * 0.94, w, h * 0.06)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.userData.shared = true
  return t
}

/** Soft rounded-rectangle contact shadow. */
export function blobTexture() {
  const size = 128
  const c = canvas(size)
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // rounded-rectangle falloff: soft inside the footprint, fading past it
      const dx = Math.max(0, Math.abs((x + 0.5) / size - 0.5) * 2 - 0.45) / 0.55
      const dy = Math.max(0, Math.abs((y + 0.5) / size - 0.5) * 2 - 0.45) / 0.55
      const d = Math.min(1, Math.hypot(dx, dy))
      const a = Math.pow(1 - d, 2.2)
      const i = (y * size + x) * 4
      img.data[i] = 255
      img.data[i + 1] = 255
      img.data[i + 2] = 255
      img.data[i + 3] = Math.round(a * 255)
    }
  }
  ctx.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.userData.shared = true
  return t
}

/** Single broad leaf (peace lily / pothos) with alpha. */
export function leafTexture() {
  const w = 128
  const h = 256
  const c = canvas(w, h)
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, w, h)
  const g = ctx.createLinearGradient(0, 0, w, 0)
  g.addColorStop(0, '#1f5a24')
  g.addColorStop(0.5, '#3f8a35')
  g.addColorStop(1, '#215e26')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.moveTo(w / 2, h - 4)
  ctx.bezierCurveTo(-w * 0.15, h * 0.62, w * 0.08, h * 0.12, w / 2, 4)
  ctx.bezierCurveTo(w * 0.92, h * 0.12, w * 1.15, h * 0.62, w / 2, h - 4)
  ctx.fill()
  ctx.strokeStyle = 'rgba(190,230,150,0.55)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(w / 2, h - 6)
  ctx.lineTo(w / 2, 14)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(160,210,120,0.25)'
  ctx.lineWidth = 1
  for (let i = 1; i < 8; i++) {
    const y = h - 20 - i * 26
    ctx.beginPath()
    ctx.moveTo(w / 2, y)
    ctx.quadraticCurveTo(w * 0.3, y - 8, w * 0.16, y - 26)
    ctx.moveTo(w / 2, y)
    ctx.quadraticCurveTo(w * 0.7, y - 8, w * 0.84, y - 26)
    ctx.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.userData.shared = true
  return t
}

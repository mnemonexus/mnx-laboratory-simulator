import * as THREE from 'three'
import type { Tier } from '../quality'
import woodAtlasUrl from '../../assets/lab/walnut-veneer-atlas-v1.jpg'
import { trackDecode } from './decodes'

export interface FurnitureFinishes {
  steel: THREE.Texture
  vinyl: THREE.Texture
  mesh: THREE.Texture
}

const cache = new Map<Tier, FurnitureFinishes & { wood: THREE.Texture }>()
const waiting = new Map<Tier, Set<() => void>>()
const loaded = new Set<Tier>()
function random(seed: number) {
  let s = seed >>> 0
  return () => { s = Math.imul(s, 1664525) + 1013904223 | 0; return (s >>> 0) / 4294967296 }
}
function canvas(w: number, h = w) {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  return c
}
function texture(c: HTMLCanvasElement, color = false) {
  const t = new THREE.CanvasTexture(c)
  if (color) t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 4; t.userData.shared = true
  return t
}

/** Eight continuous veneer cuts share one atlas; each door also crops a different region. */
export function furnitureFinishes(tier: Tier, onReady?: () => void) {
  if(onReady&&!loaded.has(tier)){let listeners=waiting.get(tier);if(!listeners){listeners=new Set();waiting.set(tier,listeners)}listeners.add(onReady)}
  const existing = cache.get(tier)
  if (existing) return existing
  const cell = tier === 'low' ? 128 : tier === 'medium' ? 256 : 512
  const c = canvas(cell * 4, cell * 4), ctx = c.getContext('2d')!
  ctx.fillStyle='#704b31';ctx.fillRect(0,0,c.width,c.height)
  const wood = texture(c, true)
  wood.wrapS = wood.wrapT = THREE.ClampToEdgeWrapping
  const image = new Image()
  image.onload=()=>{
    ctx.drawImage(image,0,0,c.width,c.height)
    wood.needsUpdate=true;loaded.add(tier)
    for(const listener of waiting.get(tier)??[])listener()
    waiting.delete(tier)
  }
  trackDecode(image)
  image.src=woodAtlasUrl
  const steelCanvas = canvas(256), sc = steelCanvas.getContext('2d')!, si = sc.createImageData(256, 256)
  const rand = random(932)
  const lines = Array.from({ length: 256 }, () => rand())
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const value = 94 + lines[x] * 5 + rand() * 3, i = (y * 256 + x) * 4
    si.data[i] = si.data[i + 1] = si.data[i + 2] = value; si.data[i + 3] = 255
  }
  sc.putImageData(si, 0, 0)
  const vinylCanvas = canvas(256), vc = vinylCanvas.getContext('2d')!, vi = vc.createImageData(256, 256)
  for (let i = 0; i < 256 * 256; i++) {
    const v = 124 + (rand() - .5) * 30
    vi.data[i * 4] = vi.data[i * 4 + 1] = v; vi.data[i * 4 + 2] = 252; vi.data[i * 4 + 3] = 255
  }
  vc.putImageData(vi, 0, 0)
  const meshCanvas = canvas(64), mc = meshCanvas.getContext('2d')!
  mc.clearRect(0, 0, 64, 64); mc.strokeStyle = '#ffffff'; mc.lineWidth = 1.1
  for (let i = -64; i <= 128; i += 8) {
    mc.beginPath(); mc.moveTo(i, 0); mc.lineTo(i + 64, 64); mc.stroke()
    mc.beginPath(); mc.moveTo(i, 0); mc.lineTo(i - 64, 64); mc.stroke()
  }
  const mesh = texture(meshCanvas, true); mesh.repeat.set(12, 6)
  const result = { wood, steel: texture(steelCanvas), vinyl: texture(vinylCanvas), mesh }
  cache.set(tier, result)
  return result
}

export function doorVariation(id: string) {
  let seed = 2166136261
  for (const ch of id) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619)
  const n = seed >>> 0
  return { cell: n % 8, x: .025 + (n % 73) / 1460, y: .025 + (n % 59) / 1180, scale: .82 + (n % 11) / 100 }
}

/** Map all pieces of a leaf in the same coordinates, including around its vision panel. */
export function veneerBox(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, width: number, height: number, id: string) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0)
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
  const v = doorVariation(id), p = g.getAttribute('position'), uv = g.getAttribute('uv')
  for (let i = 0; i < p.count; i++) {
    uv.setXY(i, (v.cell % 4 + v.x + p.getX(i) / width * v.scale) / 4,
      (Math.floor(v.cell / 4) + v.y + p.getY(i) / height * v.scale) / 2)
  }
  return g
}

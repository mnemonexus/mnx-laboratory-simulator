// All assets are embedded by both bundlers; no network or host asset request.
import * as THREE from 'three'
import treesUrl from '../../assets/exterior/autumn-trees.webp'
import skyUrl from '../../assets/exterior/blue-hour-sky.webp'
import groundUrl from '../../assets/exterior/damp-ground.webp'
import { TEXTURE_QUALITY, type Tier } from '../quality'
import { blobTexture } from './surfaces'
import { trackDecode } from './decodes'

export interface ExteriorTextures {
  trees: THREE.Texture
  ground: THREE.Texture
  paving: THREE.Texture
  facade: THREE.Texture
  shadow: THREE.Texture
  sky: THREE.Texture
  wall: THREE.Texture
}

function surface(size: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void, repeat = false) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  draw(canvas.getContext('2d')!, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  return texture
}

function embeddedTexture(url: string, maxWidth: number, onReady: () => void) {
  const empty = document.createElement('canvas')
  empty.width = empty.height = 1
  const texture = new THREE.CanvasTexture(empty)
  texture.colorSpace = THREE.SRGBColorSpace
  let disposed = false
  texture.addEventListener('dispose', () => { disposed = true })
  const image = new Image()
  image.onload = () => {
    if (disposed) return
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, maxWidth / image.width)
    canvas.width = Math.round(image.width * scale)
    canvas.height = Math.round(image.height * scale)
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
    texture.image = canvas
    texture.needsUpdate = true
    onReady()
  }
  image.onerror = () => { if (!disposed) console.warn('Exterior image could not decode') }
  trackDecode(image)
  image.src = url
  return texture
}

export function createExteriorTextures(tier: Tier, onReady: () => void): ExteriorTextures {
  const q = TEXTURE_QUALITY[tier]
  // Decode once, then keep bounded texture memory even on Low.
  const trees = embeddedTexture(treesUrl, tier === 'low' ? 768 : 1536, onReady)
  trees.anisotropy = Math.min(q.anisotropy, 4)

  let seed = 481
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296 }
  const ground = embeddedTexture(groundUrl, tier === 'low' ? 512 : 1024, onReady)
  ground.wrapS = ground.wrapT = THREE.RepeatWrapping
  const paving = surface(tier === 'low' ? 256 : 512, (ctx, n) => {
    ctx.fillStyle = '#676d68'
    ctx.fillRect(0, 0, n, n)
    // Low-frequency damp patches and fine aggregate survive an oblique view.
    for (let i = 0; i < 42; i++) {
      const x = random() * n, y = random() * n, r = n * (0.04 + random() * 0.25)
      const stain = ctx.createRadialGradient(x, y, 0, x, y, r)
      stain.addColorStop(0, random() > 0.35 ? '#1b28251f' : '#c5c6b911')
      stain.addColorStop(1, '#00000000')
      ctx.fillStyle = stain
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    }
    for (let i = 0; i < 24000; i++) {
      ctx.fillStyle = random() > 0.5 ? '#d1d2c512' : '#15211e15'
      ctx.fillRect(random() * n, random() * n, 0.5 + random(), 0.5 + random())
    }
    ctx.strokeStyle = '#222e2a55'
    ctx.lineWidth = n / 256
    ctx.strokeRect(0, 0, n, n)
    // Occasional hairline cracks are paint in the shared tile, not geometry.
    ctx.lineWidth = n / 700
    ctx.beginPath()
    ctx.moveTo(n * 0.69, 0)
    ctx.lineTo(n * 0.65, n * 0.14)
    ctx.lineTo(n * 0.7, n * 0.24)
    ctx.lineTo(n * 0.63, n * 0.37)
    ctx.stroke()
  }, true)
  const wall = surface(256, (ctx, n) => {
    ctx.fillStyle = '#e3e5df'
    ctx.fillRect(0, 0, n, n)
    for (let i = 0; i < 28; i++) {
      const x = random() * n, width = 1 + random() * 3
      const streak = ctx.createLinearGradient(0, 0, 0, n)
      streak.addColorStop(0, '#25332c06')
      streak.addColorStop(0.2 + random() * 0.4, '#25332c02')
      streak.addColorStop(1, '#25332c00')
      ctx.fillStyle = streak
      ctx.fillRect(x, 0, width, n)
    }
    for (let i = 0; i < 12; i++) {
      const x = random() * n, y = random() * n, r = 20 + random() * 80
      const wash = ctx.createRadialGradient(x, y, 0, x, y, r)
      wash.addColorStop(0, '#28372e08')
      wash.addColorStop(1, '#28372e00')
      ctx.fillStyle = wash
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    }
  }, true)
  const facade = surface(256, (ctx) => {
    ctx.fillStyle = '#69788b'
    ctx.fillRect(0, 0, 256, 256)
    // Recessed windows and spandrels baked into one repeating facade tile.
    ctx.fillStyle = '#293c53'
    ctx.fillRect(12, 44, 232, 150)
    ctx.fillStyle = '#8b9baa'
    ctx.fillRect(14, 46, 228, 5)
    ctx.fillStyle = '#516b83'
    ctx.fillRect(17, 53, 109, 132)
    ctx.fillStyle = '#7891a4'
    ctx.fillRect(131, 53, 106, 132)
    ctx.fillStyle = '#becbd0'
    ctx.fillRect(0, 223, 256, 3)
    ctx.fillStyle = '#384656'
    ctx.fillRect(0, 253, 256, 3)
  }, true)
  ground.anisotropy = paving.anisotropy = Math.min(q.anisotropy, 8)
  const sky = embeddedTexture(skyUrl, tier === 'low' ? 1024 : 2048, onReady)
  sky.wrapS = THREE.RepeatWrapping
  return { trees, ground, paving, facade, shadow: blobTexture(), sky, wall }
}

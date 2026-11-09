// Procedural PBR texture library.
// Every map is generated on a canvas at load time — no external assets, so the
// single-file build stays self-contained while still giving real albedo /
// roughness / normal variation instead of flat plastic colours.
import * as THREE from 'three'
import { normalPixels } from './texturePixels'

const cache = new Map<string, THREE.Texture>()

function makeCanvas(size = 512) {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  return c
}

function finish(canvas: HTMLCanvasElement, repeat: [number, number] = [1, 1], srgb = false) {
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(repeat[0], repeat[1])
  tex.anisotropy = 8
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

/** value noise helper */
function noiseField(ctx: CanvasRenderingContext2D, size: number, amount: number, mono = true) {
  const img = ctx.getImageData(0, 0, size, size)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amount
    if (mono) {
      d[i] = Math.max(0, Math.min(255, d[i] + n))
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n))
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n))
    } else {
      d[i] = Math.max(0, Math.min(255, d[i] + (Math.random() - 0.5) * amount))
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + (Math.random() - 0.5) * amount))
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + (Math.random() - 0.5) * amount))
    }
  }
  ctx.putImageData(img, 0, 0)
}

/** Height -> normal map conversion (sobel). */
function heightToNormal(height: HTMLCanvasElement, strength = 2.2) {
  const size = height.width
  const src = height.getContext('2d')!.getImageData(0, 0, size, size).data
  const out = makeCanvas(size)
  const octx = out.getContext('2d')!
  const img = octx.createImageData(size, size)
  normalPixels(src, size, size, strength, true, img.data)
  octx.putImageData(img, 0, 0)
  return out
}

/** Epoxy-resin black lab bench top: matte, speckled, subtly uneven. */
export function benchSurface() {
  if (!cache.has('bench-map')) {
    const size = 512
    const c = makeCanvas(size)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#2f3641'
    ctx.fillRect(0, 0, size, size)
    for (let i = 0; i < 9000; i++) {
      const g = 40 + Math.random() * 90
      ctx.fillStyle = `rgba(${g},${g + 4},${g + 10},${0.15 + Math.random() * 0.35})`
      ctx.fillRect(Math.random() * size, Math.random() * size, 1.6, 1.6)
    }
    noiseField(ctx, size, 12)
    cache.set('bench-map', finish(c, [3, 1.6], true))

    const h = makeCanvas(size)
    const hx = h.getContext('2d')!
    hx.fillStyle = '#808080'
    hx.fillRect(0, 0, size, size)
    for (let i = 0; i < 5000; i++) {
      const v = 110 + Math.random() * 70
      hx.fillStyle = `rgb(${v},${v},${v})`
      hx.fillRect(Math.random() * size, Math.random() * size, 2, 2)
    }
    cache.set('bench-normal', finish(heightToNormal(h, 1.1), [3, 1.6]))

    const r = makeCanvas(size)
    const rx = r.getContext('2d')!
    rx.fillStyle = '#b9b9b9'
    rx.fillRect(0, 0, size, size)
    for (let i = 0; i < 2600; i++) {
      const v = 140 + Math.random() * 90
      rx.fillStyle = `rgb(${v},${v},${v})`
      rx.beginPath()
      rx.arc(Math.random() * size, Math.random() * size, Math.random() * 9, 0, Math.PI * 2)
      rx.fill()
    }
    cache.set('bench-rough', finish(r, [3, 1.6]))
  }
  return {
    map: cache.get('bench-map')!,
    normalMap: cache.get('bench-normal')!,
    roughnessMap: cache.get('bench-rough')!,
  }
}

/** Polished vinyl lab floor with tile grout lines. */
export function floorSurface() {
  if (!cache.has('floor-map')) {
    const size = 512
    const c = makeCanvas(size)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#c9d2dc'
    ctx.fillRect(0, 0, size, size)
    for (let i = 0; i < 14000; i++) {
      const g = 175 + Math.random() * 60
      ctx.fillStyle = `rgba(${g},${g + 3},${g + 8},0.5)`
      ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2)
    }
    ctx.strokeStyle = 'rgba(120,132,146,0.55)'
    ctx.lineWidth = 4
    ctx.strokeRect(0, 0, size, size)
    cache.set('floor-map', finish(c, [14, 14], true))

    const r = makeCanvas(size)
    const rx = r.getContext('2d')!
    rx.fillStyle = '#4a4a4a'
    rx.fillRect(0, 0, size, size)
    for (let i = 0; i < 3000; i++) {
      const v = 40 + Math.random() * 120
      rx.fillStyle = `rgb(${v},${v},${v})`
      rx.beginPath()
      rx.arc(Math.random() * size, Math.random() * size, Math.random() * 14, 0, Math.PI * 2)
      rx.fill()
    }
    rx.strokeStyle = '#c8c8c8'
    rx.lineWidth = 5
    rx.strokeRect(0, 0, size, size)
    cache.set('floor-rough', finish(r, [14, 14]))
  }
  return { map: cache.get('floor-map')!, roughnessMap: cache.get('floor-rough')! }
}

/** Instrument housing: injection-moulded ABS with fine grain. */
export function mouldedPlastic(tint = '#e8eaed') {
  const key = `abs-${tint}`
  if (!cache.has(key)) {
    const size = 256
    const c = makeCanvas(size)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = tint
    ctx.fillRect(0, 0, size, size)
    noiseField(ctx, size, 9)
    cache.set(key, finish(c, [2, 2], true))
  }

  // Colour does not change the polymer's surface grain. Share the physical
  // normal map rather than painting and retaining one per casing tint.
  if (!cache.has('abs-grain-normal')) {
    const size = 256
    const h = makeCanvas(size)
    const hx = h.getContext('2d')!
    hx.fillStyle = '#808080'
    hx.fillRect(0, 0, size, size)
    for (let i = 0; i < 12000; i++) {
      const v = 118 + Math.random() * 24
      hx.fillStyle = `rgb(${v},${v},${v})`
      hx.fillRect(Math.random() * size, Math.random() * size, 1, 1)
    }
    cache.set('abs-grain-normal', finish(heightToNormal(h, 0.55), [2, 2]))
  }
  return { map: cache.get(key)!, normalMap: cache.get('abs-grain-normal')! }
}

/** Brushed stainless steel. */
export function brushedMetal() {
  if (!cache.has('metal-rough')) {
    const size = 256
    const r = makeCanvas(size)
    const rx = r.getContext('2d')!
    rx.fillStyle = '#5c5c5c'
    rx.fillRect(0, 0, size, size)
    for (let i = 0; i < 2400; i++) {
      const y = Math.random() * size
      const v = 60 + Math.random() * 110
      rx.strokeStyle = `rgba(${v},${v},${v},0.5)`
      rx.lineWidth = Math.random() * 1.6
      rx.beginPath()
      rx.moveTo(0, y)
      rx.lineTo(size, y + (Math.random() - 0.5) * 3)
      rx.stroke()
    }
    cache.set('metal-rough', finish(r, [2, 2]))

    const h = makeCanvas(size)
    const hx = h.getContext('2d')!
    hx.fillStyle = '#808080'
    hx.fillRect(0, 0, size, size)
    for (let i = 0; i < 1600; i++) {
      const y = Math.random() * size
      const v = 110 + Math.random() * 40
      hx.strokeStyle = `rgb(${v},${v},${v})`
      hx.lineWidth = 1
      hx.beginPath()
      hx.moveTo(0, y)
      hx.lineTo(size, y)
      hx.stroke()
    }
    cache.set('metal-normal', finish(heightToNormal(h, 0.5), [2, 2]))
  }
  return { roughnessMap: cache.get('metal-rough')!, normalMap: cache.get('metal-normal')! }
}

/** Printed reagent label wrapped around a bottle. */
export function reagentLabel(title: string, sub = '', accent = '#1d4ed8') {
  const key = `label-${title}-${sub}-${accent}`
  if (!cache.has(key)) {
    const w = 512
    const h = 256
    const c = makeCanvas(w)
    c.height = h
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#f7f8fa'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = accent
    ctx.fillRect(0, 0, w, 26)
    ctx.fillRect(0, h - 12, w, 12)
    ctx.fillStyle = '#0b1220'
    ctx.font = 'bold 46px system-ui, -apple-system, sans-serif'
    ctx.fillText(title.slice(0, 16), 22, 96)
    ctx.fillStyle = '#475569'
    ctx.font = '30px system-ui, sans-serif'
    if (sub) ctx.fillText(sub.slice(0, 24), 22, 140)
    // barcode strip
    let x = 22
    while (x < w - 40) {
      const bw = 2 + Math.random() * 5
      ctx.fillStyle = Math.random() > 0.35 ? '#0b1220' : '#f7f8fa'
      ctx.fillRect(x, 168, bw, 42)
      x += bw + 2
    }
    ctx.fillStyle = '#94a3b8'
    ctx.font = '18px monospace'
    ctx.fillText('LOT 24-08 · STORE 4 °C', 22, 232)
    noiseField(ctx, Math.min(w, h), 5)
    cache.set(key, finish(c, [1, 1], true))
  }
  return cache.get(key)!
}

/** Instrument LCD / touchscreen face. */
export function screenTexture(
  lines: { text: string; color?: string; size?: number }[],
  title = '',
  bg = '#0b1220',
) {
  const w = 512
  const h = 320
  const c = makeCanvas(w)
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = 'rgba(148,163,184,0.25)'
  ctx.lineWidth = 3
  ctx.strokeRect(8, 8, w - 16, h - 16)
  if (title) {
    ctx.fillStyle = '#38bdf8'
    ctx.font = 'bold 30px system-ui, sans-serif'
    ctx.fillText(title, 26, 54)
  }
  let y = title ? 108 : 64
  for (const l of lines) {
    ctx.fillStyle = l.color ?? '#e2e8f0'
    ctx.font = `${l.size ?? 26}px ui-monospace, monospace`
    ctx.fillText(l.text, 26, y)
    y += (l.size ?? 26) + 16
  }
  // scanline sheen
  for (let i = 0; i < h; i += 4) {
    ctx.fillStyle = 'rgba(255,255,255,0.02)'
    ctx.fillRect(0, i, w, 2)
  }
  const tex = finish(c, [1, 1], true)
  // Screen canvases are state-specific (unlike the cached surface textures).
  tex.userData.ephemeral = true
  return tex
}

/** Small engraved brand plate. */
export function brandTexture(text: string, color = '#1e3a8a', bg = 'transparent') {
  const key = `brand-${text}-${color}-${bg}`
  if (!cache.has(key)) {
    const w = 512
    const h = 128
    const c = makeCanvas(w)
    c.height = h
    const ctx = c.getContext('2d')!
    if (bg !== 'transparent') {
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, w, h)
    } else {
      ctx.clearRect(0, 0, w, h)
    }
    ctx.fillStyle = color
    ctx.font = 'bold 72px system-ui, -apple-system, sans-serif'
    ctx.fillText(text, 10, 92)
    cache.set(key, finish(c, [1, 1], true))
  }
  return cache.get(key)!
}

/** Fired-on graduation and writing patch for a 150 mL low-form beaker. */
export function glasswareMarkings() {
  const key = 'glassware-150ml'
  if (!cache.has(key)) {
    const c = makeCanvas(512); c.height = 512
    const ctx = c.getContext('2d')!
    ctx.clearRect(0,0,512,512); ctx.fillStyle = '#ecefe5'
    ctx.font = 'bold 36px Arial'; ctx.fillText('DURAN',48,62)
    ctx.font = '24px Arial'; ctx.fillText('150 mL',48,98); ctx.fillText('Boro 3.3',48,128)
    for(let i=1;i<=5;i++) { const y=460-i*61;ctx.fillRect(282,y,i%2===0?60:38,4); if(i%2===0){ctx.font='24px Arial';ctx.fillText(String(i*25),350,y+9)} }
    ctx.globalAlpha=.46; ctx.fillRect(50,215,160,140)
    cache.set(key,finish(c,[1,1],true))
  }
  return cache.get(key)!
}

export function disposeTextureCache() {
  cache.forEach((t) => t.dispose())
  cache.clear()
}

/** Seamless laboratory vinyl floor — matte, speckled, no grout. */
export function vinylFloor() {
  if (!cache.has('vinyl-map')) {
    const size = 256
    const c = makeCanvas(size)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#c5c8cc'
    ctx.fillRect(0, 0, size, size)
    for (let i = 0; i < 18000; i++) {
      const g = 150 + Math.random() * 70
      ctx.fillStyle = `rgba(${g},${g + 1},${g + 3},${0.18 + Math.random() * 0.35})`
      ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random(), 1)
    }
    noiseField(ctx, size, 8)
    cache.set('vinyl-map', finish(c, [18, 14], true))
    const r = makeCanvas(size)
    const rx = r.getContext('2d')!
    rx.fillStyle = '#8a8a8a'
    rx.fillRect(0, 0, size, size)
    for (let i = 0; i < 4000; i++) {
      const v = 110 + Math.random() * 50
      rx.fillStyle = `rgb(${v},${v},${v})`
      rx.fillRect(Math.random() * size, Math.random() * size, 2, 2)
    }
    cache.set('vinyl-rough', finish(r, [18, 14]))
  }
  return { map: cache.get('vinyl-map')!, roughnessMap: cache.get('vinyl-rough')! }
}

/** Graphite epoxy worktop. */
export function graphiteWorktop() {
  if (!cache.has('wt-map')) {
    const size = 256
    const c = makeCanvas(size)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#2a2d32'
    ctx.fillRect(0, 0, size, size)
    for (let i = 0; i < 12000; i++) {
      const g = 28 + Math.random() * 40
      ctx.fillStyle = `rgba(${g},${g + 2},${g + 4},${0.3})`
      ctx.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5)
    }
    noiseField(ctx, size, 10)
    cache.set('wt-map', finish(c, [6, 1.4], true))
    const r = makeCanvas(size)
    const rx = r.getContext('2d')!
    rx.fillStyle = '#b4b4b4'
    rx.fillRect(0, 0, size, size)
    noiseField(rx, size, 18)
    cache.set('wt-rough', finish(r, [6, 1.4]))
  }
  return { map: cache.get('wt-map')!, roughnessMap: cache.get('wt-rough')! }
}

/** Modular cabinet face with drawer/door seams. */
export function cabinetFace(kind: 'drawers' | 'doors' = 'drawers') {
  const key = `cab-${kind}`
  if (!cache.has(key)) {
    const w = 256
    const h = 512
    const c = makeCanvas(w)
    c.height = h
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ece8e1'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = 'rgba(160,154,144,0.55)'
    ctx.lineWidth = 2
    if (kind === 'drawers') {
      for (let i = 1; i < 4; i++) {
        ctx.beginPath()
        ctx.moveTo(8, (h * i) / 4)
        ctx.lineTo(w - 8, (h * i) / 4)
        ctx.stroke()
      }
    } else {
      ctx.beginPath()
      ctx.moveTo(w / 2, 8)
      ctx.lineTo(w / 2, h - 8)
      ctx.stroke()
    }
    noiseField(ctx, Math.min(w, h), 6)
    cache.set(key, finish(c, [1, 1], true))
  }
  return cache.get(key)!
}

export function wallPaint() {
  if (!cache.has('wall-map')) {
    const size = 128
    const c = makeCanvas(size)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#e8e2d6'
    ctx.fillRect(0, 0, size, size)
    noiseField(ctx, size, 5)
    cache.set('wall-map', finish(c, [8, 4], true))
  }
  return cache.get('wall-map')!
}

export function woodDoorTex() {
  if (!cache.has('wood-door')) {
    const w = 256
    const h = 512
    const c = makeCanvas(w)
    c.height = h
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#5a3d2b'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 40; i++) {
      const y = Math.random() * h
      ctx.strokeStyle = `rgba(40,24,16,${0.08 + Math.random() * 0.12})`
      ctx.lineWidth = 1 + Math.random() * 2
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y + (Math.random() - 0.5) * 8)
      ctx.stroke()
    }
    cache.set('wood-door', finish(c, [1, 1], true))
  }
  return cache.get('wood-door')!
}

export function duskWindow() {
  if (!cache.has('dusk-win')) {
    const w = 512
    const h = 384
    const c = makeCanvas(w)
    c.height = h
    const ctx = c.getContext('2d')!
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, '#1b2a4a')
    g.addColorStop(1, '#243656')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#0e1624'
    for (let i = 0; i < 18; i++) {
      const x = 20 + i * 28
      ctx.beginPath()
      ctx.moveTo(x, h)
      ctx.lineTo(x + 10, 80 + Math.random() * 80)
      ctx.lineTo(x + 22, h)
      ctx.fill()
    }
    cache.set('dusk-win', finish(c, [1, 1], true))
  }
  return cache.get('dusk-win')!
}

export function posterTex(title: string, lines: string[], bg = '#1d4ed8') {
  const key = `poster-${title}`
  if (!cache.has(key)) {
    const w = 256
    const h = 384
    const c = makeCanvas(w)
    c.height = h
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#f8fafc'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, 54)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 22px system-ui, sans-serif'
    ctx.fillText(title, 14, 34)
    ctx.fillStyle = '#1e293b'
    ctx.font = '16px system-ui, sans-serif'
    lines.forEach((ln, i) => ctx.fillText(ln, 16, 88 + i * 28))
    cache.set(key, finish(c, [1, 1], true))
  }
  return cache.get(key)!
}

export function cellScreen() {
  if (!cache.has('cells')) {
    const w = 256
    const h = 160
    const c = makeCanvas(w)
    c.height = h
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#041018'
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 9; i++) {
      const x = 30 + (i % 3) * 80
      const y = 30 + Math.floor(i / 3) * 50
      ctx.fillStyle = `rgba(56,189,248,${0.35 + Math.random() * 0.4})`
      ctx.beginPath()
      ctx.arc(x, y, 16 + Math.random() * 10, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = 'rgba(125,211,252,0.8)'
      ctx.beginPath()
      ctx.arc(x + 4, y - 2, 5, 0, Math.PI * 2)
      ctx.fill()
    }
    cache.set('cells', finish(c, [1, 1], true))
  }
  return cache.get('cells')!
}

// One canvas atlas for every printed or glowing flat thing in the lab:
// posters, signs, brand plates, labels and static instrument screens.
// Sharing a single texture lets all of them batch into two draw calls
// (lit paper + emissive screens).
import * as THREE from 'three'
import { FACILITY_ZONES } from './facility.gen'
import { rng } from './surfaces'

type Painter = (ctx: CanvasRenderingContext2D, w: number, h: number) => void

/** Fluorescence-microscopy cell image (default content of the lab TV). */
export function paintCells(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.6)
  g.addColorStop(0, '#0f3fb6')
  g.addColorStop(1, '#03113d')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  const r = rng(9)
  for (let i = 0; i < 160; i++) {
    ctx.fillStyle = `rgba(150,200,255,${r() * 0.5})`
    ctx.fillRect(r() * w, r() * h, 2, 2)
  }
  ctx.globalCompositeOperation = 'lighter'
  const cells: [number, number, number][] = [
    [250, 150, 58],
    [330, 128, 52],
    [300, 210, 64],
    [380, 205, 46],
    [210, 220, 40],
    [420, 140, 34],
  ]
  for (const [x, y, rad] of cells) {
    const cg = ctx.createRadialGradient(x, y, rad * 0.2, x, y, rad)
    cg.addColorStop(0, 'rgba(60,110,255,0.15)')
    cg.addColorStop(0.82, 'rgba(110,170,255,0.55)')
    cg.addColorStop(1, 'rgba(190,225,255,0.0)')
    ctx.fillStyle = cg
    ctx.beginPath()
    ctx.arc(x, y, rad, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(200,230,255,0.75)'
    ctx.lineWidth = 2.5
    ctx.stroke()
    ctx.fillStyle = 'rgba(120,180,255,0.6)'
    ctx.beginPath()
    ctx.arc(x + rad * 0.15, y - rad * 0.1, rad * 0.3, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.strokeStyle = 'rgba(120,180,255,0.35)'
  ctx.lineWidth = 1.5
  for (let i = 0; i < 26; i++) {
    ctx.beginPath()
    const a = r() * Math.PI * 2
    ctx.moveTo(320 + Math.cos(a) * 80, 180 + Math.sin(a) * 80)
    ctx.quadraticCurveTo(320 + Math.cos(a) * 180, 180 + Math.sin(a + 0.4) * 160, 320 + Math.cos(a + 0.2) * 300, 180 + Math.sin(a + 0.2) * 200)
    ctx.stroke()
  }
  ctx.globalCompositeOperation = 'source-over'
}


interface Entry {
  name: string
  w: number
  h: number
  paint: Painter
}

export interface DecalAtlas {
  texture: THREE.Texture
  /** UV rectangle [u0, v0, u1, v1] (v measured from the bottom) */
  uv: (name: DecalName) => [number, number, number, number]
}

const BLUE = '#1f5fd1'
/** stripe colour on door plates, by neighbourhood */
const GROUP_STRIPE: Record<string, string> = { life: '#3f8f5f', core: '#c99a3a', chem: '#3d6fb6', support: '#8a9099', hub: '#7a6aa8' }
const NAVY = '#0f2e6b'
const INK = '#1d2633'

function font(px: number, weight = 600) {
  return `${weight} ${px}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function paper(ctx: CanvasRenderingContext2D, w: number, h: number, bg = '#fbfcfd') {
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = 'rgba(30,40,60,0.18)'
  ctx.lineWidth = 3
  ctx.strokeRect(1.5, 1.5, w - 3, h - 3)
}

function iconCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color = BLUE) {
  ctx.strokeStyle = color
  ctx.lineWidth = r * 0.12
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.stroke()
}

function glyph(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number, r: number, color = BLUE) {
  ctx.save()
  ctx.translate(x, y)
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = r * 0.13
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  switch (kind) {
    case 'drop':
      ctx.beginPath()
      ctx.moveTo(0, -r * 0.6)
      ctx.quadraticCurveTo(r * 0.55, 0, 0, r * 0.5)
      ctx.quadraticCurveTo(-r * 0.55, 0, 0, -r * 0.6)
      ctx.stroke()
      break
    case 'hands':
      for (const s of [-1, 1]) {
        ctx.beginPath()
        ctx.ellipse(s * r * 0.22, 0, r * 0.22, r * 0.45, s * 0.35, 0, Math.PI * 2)
        ctx.stroke()
      }
      break
    case 'bubbles':
      for (let i = 0; i < 5; i++) {
        ctx.beginPath()
        ctx.arc(Math.cos(i * 1.3) * r * 0.35, Math.sin(i * 1.7) * r * 0.32, r * (0.1 + (i % 3) * 0.05), 0, Math.PI * 2)
        ctx.stroke()
      }
      break
    case 'towel':
      ctx.strokeRect(-r * 0.4, -r * 0.45, r * 0.8, r * 0.9)
      ctx.beginPath()
      ctx.moveTo(-r * 0.4, r * 0.1)
      ctx.lineTo(r * 0.4, r * 0.1)
      ctx.stroke()
      break
    case 'goggles':
      ctx.beginPath()
      ctx.arc(-r * 0.3, r * 0.05, r * 0.24, 0, Math.PI * 2)
      ctx.arc(r * 0.3, r * 0.05, r * 0.24, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(-r * 0.6, -r * 0.05)
      ctx.lineTo(r * 0.6, -r * 0.05)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(0, -r * 0.18, r * 0.5, Math.PI * 1.1, Math.PI * 1.9)
      ctx.stroke()
      break
    case 'flask':
      ctx.beginPath()
      ctx.moveTo(-r * 0.12, -r * 0.55)
      ctx.lineTo(-r * 0.12, -r * 0.15)
      ctx.lineTo(-r * 0.45, r * 0.45)
      ctx.lineTo(r * 0.45, r * 0.45)
      ctx.lineTo(r * 0.12, -r * 0.15)
      ctx.lineTo(r * 0.12, -r * 0.55)
      ctx.stroke()
      break
    case 'spray':
      ctx.strokeRect(-r * 0.25, -r * 0.2, r * 0.5, r * 0.65)
      ctx.strokeRect(-r * 0.12, -r * 0.45, r * 0.24, r * 0.25)
      break
    case 'warning':
      ctx.beginPath()
      ctx.moveTo(0, -r * 0.55)
      ctx.lineTo(r * 0.55, r * 0.45)
      ctx.lineTo(-r * 0.55, r * 0.45)
      ctx.closePath()
      ctx.stroke()
      ctx.fillRect(-r * 0.04, -r * 0.2, r * 0.08, r * 0.38)
      ctx.fillRect(-r * 0.04, r * 0.26, r * 0.08, r * 0.08)
      break
    case 'flame':
      ctx.beginPath()
      ctx.moveTo(0, -r * 0.6)
      ctx.quadraticCurveTo(r * 0.55, -r * 0.05, r * 0.3, r * 0.45)
      ctx.quadraticCurveTo(0, r * 0.62, -r * 0.3, r * 0.45)
      ctx.quadraticCurveTo(-r * 0.55, -r * 0.05, 0, -r * 0.6)
      ctx.fill()
      break
    case 'biohazard': {
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / 3
        ctx.beginPath()
        ctx.arc(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3, r * 0.34, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.arc(0, 0, r * 0.16, 0, Math.PI * 2)
      ctx.stroke()
      break
    }
  }
  ctx.restore()
}

const entries: Entry[] = [
  {
    name: 'washHands',
    w: 340,
    h: 560,
    paint(ctx, w, h) {
      paper(ctx, w, h)
      ctx.fillStyle = BLUE
      ctx.fillRect(0, 0, w, 74)
      ctx.fillStyle = '#fff'
      ctx.font = font(38, 700)
      ctx.fillText('Wash Your Hands', 18, 50)
      const steps: [string, string][] = [
        ['drop', '1. Wet'],
        ['bubbles', '2. Lather'],
        ['hands', '3. Scrub'],
        ['drop', '4. Rinse'],
        ['towel', '5. Dry'],
      ]
      steps.forEach(([g, t], i) => {
        const y = 128 + i * 88
        iconCircle(ctx, 62, y, 32)
        glyph(ctx, g, 62, y, 32)
        ctx.fillStyle = INK
        ctx.font = font(30, 500)
        ctx.fillText(t, 112, y + 10)
        if (i === 2) {
          ctx.font = font(20, 400)
          ctx.fillText('(20 seconds)', 112, y + 38)
        }
      })
    },
  },
  {
    name: 'wearPPE',
    w: 220,
    h: 330,
    paint(ctx, w, h) {
      paper(ctx, w, h)
      ctx.fillStyle = BLUE
      ctx.beginPath()
      ctx.arc(w / 2, 112, 82, 0, Math.PI * 2)
      ctx.fill()
      glyph(ctx, 'goggles', w / 2, 112, 70, '#fff')
      ctx.fillStyle = INK
      ctx.font = font(36, 700)
      ctx.textAlign = 'center'
      ctx.fillText('Wear Your', w / 2, 248)
      ctx.fillText('PPE', w / 2, 292)
      ctx.textAlign = 'left'
    },
  },
  {
    name: 'labSafety',
    w: 330,
    h: 440,
    paint(ctx, w, h) {
      paper(ctx, w, h)
      ctx.fillStyle = BLUE
      ctx.fillRect(0, 0, w, 70)
      ctx.fillStyle = '#fff'
      ctx.font = font(40, 700)
      ctx.fillText('Lab Safety', 22, 50)
      const rows: [string, string][] = [
        ['goggles', 'Wear PPE'],
        ['flask', 'Know the hazards'],
        ['spray', 'Keep it clean'],
        ['warning', 'Report spills'],
      ]
      rows.forEach(([g, t], i) => {
        const y = 128 + i * 84
        ctx.fillStyle = BLUE
        ctx.beginPath()
        ctx.arc(52, y, 30, 0, Math.PI * 2)
        ctx.fill()
        glyph(ctx, g, 52, y, 28, '#fff')
        ctx.fillStyle = INK
        ctx.font = font(27, 600)
        ctx.fillText(t, 98, y + 10)
      })
    },
  },
  {
    name: 'emergency',
    w: 330,
    h: 440,
    paint(ctx, w, h) {
      paper(ctx, w, h)
      ctx.fillStyle = '#d42a2a'
      ctx.fillRect(0, 0, w, 120)
      ctx.fillStyle = '#fff'
      ctx.font = font(40, 700)
      ctx.textAlign = 'center'
      ctx.fillText('Emergency', w / 2, 52)
      ctx.fillText('Contacts', w / 2, 100)
      ctx.textAlign = 'left'
      const rows = [
        ['Fire', '911'],
        ['Medical', '911'],
        ['Security', '2222'],
        ['Facilities', '3333'],
      ]
      rows.forEach(([a, b], i) => {
        const y = 182 + i * 70
        ctx.fillStyle = INK
        ctx.font = font(30, 600)
        ctx.fillText(a, 26, y)
        ctx.textAlign = 'right'
        ctx.fillText(b, w - 26, y)
        ctx.textAlign = 'left'
        ctx.fillStyle = 'rgba(30,40,60,0.15)'
        ctx.fillRect(22, y + 18, w - 44, 2)
      })
    },
  },
  {
    name: 'postPcr',
    w: 360,
    h: 480,
    paint(ctx, w, h) {
      paper(ctx, w, h)
      ctx.fillStyle = NAVY
      ctx.font = font(38, 700)
      ctx.fillText('Post-PCR / Gel Work', 18, 62)
      ctx.font = font(30, 600)
      ctx.fillText('Amplified DNA only', 18, 108)
      ctx.fillStyle = '#6b2fb3'
      ctx.fillRect(0, 128, w, 12)
      ctx.fillStyle = NAVY
      ctx.font = font(30, 500)
      ;['Agarose', 'Buffers', 'Stains', 'Pipette Tips'].forEach((t, i) => {
        const y = 196 + i * 62
        ctx.beginPath()
        ctx.arc(34, y - 10, 6, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillText(t, 54, y)
      })
      ctx.fillText('(for gels)', 54, 438)
    },
  },
  {
    name: 'flammable',
    w: 340,
    h: 150,
    paint(ctx, w, h) {
      ctx.fillStyle = '#d11f1f'
      ctx.fillRect(0, 0, w, h)
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 5
      ctx.strokeRect(8, 8, w - 16, h - 16)
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.moveTo(62, 26)
      ctx.lineTo(106, 112)
      ctx.lineTo(18, 112)
      ctx.closePath()
      ctx.fill()
      glyph(ctx, 'flame', 62, 84, 30, '#d11f1f')
      let size = 44
      ctx.font = font(size, 800)
      while (ctx.measureText('FLAMMABLE').width > w - 136 && size > 20) ctx.font = font(--size, 800)
      ctx.fillText('FLAMMABLE', 118, 72)
      ctx.font = font(26, 700)
      ctx.fillText('KEEP FIRE AWAY', 120, 112)
    },
  },
  {
    name: 'roomSign',
    w: 360,
    h: 190,
    paint(ctx, w, h) {
      ctx.fillStyle = '#2b3440'
      roundRect(ctx, 0, 0, w, h, 14)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = font(52, 700)
      ctx.fillText('2.14', 24, 66)
      ctx.font = font(30, 600)
      ctx.fillText('Molecular Biology', 24, 112)
      ctx.font = font(22, 400)
      ctx.fillStyle = '#c9d2dd'
      ctx.fillText('Pre-PCR · Post-PCR · Cold Storage', 24, 150)
      ctx.fillStyle = '#f2c230'
      ctx.beginPath()
      ctx.arc(w - 52, 52, 30, 0, Math.PI * 2)
      ctx.fill()
      glyph(ctx, 'biohazard', w - 52, 52, 26, '#1b1b1b')
    },
  },
  ...(['2.13', '2.15'] as const).map((n) => ({
    name: `plate-${n}`,
    w: 200,
    h: 120,
    paint(ctx: CanvasRenderingContext2D, w: number, h: number) {
      ctx.fillStyle = '#2b3440'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#ffffff'
      ctx.font = font(44, 700)
      ctx.fillText(n, 18, 58)
      ctx.font = font(18, 500)
      ctx.fillStyle = '#c9d2dd'
      ctx.fillText(n === '2.13' ? 'Tissue Culture' : 'Instrument Core', 18, 94)
    },
  })),
  // door plates for every generated room (corridor side, latch side of the door)
  ...FACILITY_ZONES.filter((z) => z.kind !== 'circulation' && z.kind !== 'hub').map((z) => ({
    name: `room-${z.roomId}`,
    w: 232,
    h: 84,
    paint(ctx: CanvasRenderingContext2D, w: number, h: number) {
      ctx.fillStyle = '#2b3440'
      roundRect(ctx, 0, 0, w, h, 8)
      ctx.fill()
      ctx.fillStyle = GROUP_STRIPE[z.group] ?? '#9aa5b1'
      ctx.fillRect(0, h - 8, w, 8)
      ctx.fillStyle = '#ffffff'
      ctx.font = font(30, 700)
      ctx.fillText(z.roomId, 14, 36)
      ctx.fillStyle = '#d7dee6'
      let size = 20
      ctx.font = font(size, 500)
      while (ctx.measureText(z.name).width > w - 28 && size > 12) ctx.font = font(--size, 500)
      ctx.fillText(z.name, 14, 64)
      if (z.controlled) {
        ctx.fillStyle = '#f2c230'
        ctx.beginPath()
        ctx.arc(w - 26, 26, 14, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#1b1b1b'
        ctx.font = font(18, 800)
        ctx.textAlign = 'center'
        ctx.fillText('!', w - 26, 33)
        ctx.textAlign = 'left'
      }
    },
  })),
  // overhead wayfinding at the hub's doorways
  ...(
    [
      ['way-life', 'Molecular Biology · Life Sciences', '#3f8f5f'],
      ['way-chem', 'Chemistry · Shared Instruments', '#3d6fb6'],
      ['way-entrance', 'Entrance · Changing · Dry Lab', '#7a6aa8'],
    ] as const
  ).map(([name, text, accent]) => ({
    name,
    w: 520,
    h: 70,
    paint(ctx: CanvasRenderingContext2D, w: number, h: number) {
      ctx.fillStyle = '#2b3440'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = accent
      ctx.fillRect(0, 0, 12, h)
      ctx.fillStyle = '#ffffff'
      ctx.font = font(30, 600)
      ctx.fillText(text, 30, 46)
    },
  })),
  {
    name: 'exit',
    w: 220,
    h: 90,
    paint(ctx, w, h) {
      ctx.fillStyle = '#f4f7f4'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#14a046'
      ctx.font = font(64, 800)
      ctx.textAlign = 'center'
      ctx.fillText('EXIT', w / 2, 70)
      ctx.textAlign = 'left'
    },
  },
  {
    name: 'labelPrep',
    w: 760,
    h: 56,
    paint(ctx, w, h) {
      ctx.fillStyle = '#3c4350'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#eef2f6'
      ctx.font = font(30, 600)
      ctx.fillText('General Molecular Biology / Sample Preparation', 16, 38)
    },
  },
  {
    name: 'labelPcr',
    w: 300,
    h: 56,
    paint(ctx, w, h) {
      ctx.fillStyle = '#3c4350'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#eef2f6'
      ctx.font = font(30, 600)
      ctx.fillText('Clean PCR Setup', 20, 38)
    },
  },
  {
    name: 'notice',
    w: 420,
    h: 300,
    paint(ctx, w, h) {
      ctx.fillStyle = '#b48a5c'
      ctx.fillRect(0, 0, w, h)
      const r = rng(5)
      for (let i = 0; i < 2600; i++) {
        ctx.fillStyle = `rgba(${90 + r() * 60},${60 + r() * 40},${30 + r() * 30},0.35)`
        ctx.fillRect(r() * w, r() * h, 2, 2)
      }
      ctx.strokeStyle = '#8e9399'
      ctx.lineWidth = 14
      ctx.strokeRect(7, 7, w - 14, h - 14)
      const sheets: [number, number, number, number, string][] = [
        [30, 30, 110, 140, '#ffffff'],
        [160, 40, 100, 120, '#fff7c4'],
        [280, 30, 110, 150, '#ffffff'],
        [50, 170, 130, 100, '#dbe9ff'],
        [220, 180, 150, 90, '#ffffff'],
      ]
      for (const [x, y, sw, sh, c] of sheets) {
        ctx.fillStyle = c
        ctx.fillRect(x, y, sw, sh)
        ctx.fillStyle = 'rgba(40,50,70,0.5)'
        for (let l = 0; l < 6; l++) ctx.fillRect(x + 10, y + 16 + l * 16, sw - 20 - (l % 3) * 14, 4)
        ctx.fillStyle = '#d33'
        ctx.beginPath()
        ctx.arc(x + sw / 2, y + 6, 4, 0, Math.PI * 2)
        ctx.fill()
      }
    },
  },
  {
    name: 'clock',
    w: 256,
    h: 256,
    paint(ctx, w) {
      const c = w / 2
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, w)
      ctx.fillStyle = '#1a1a1a'
      ctx.font = font(26, 500)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let i = 1; i <= 12; i++) {
        const a = (i / 12) * Math.PI * 2 - Math.PI / 2
        ctx.fillText(String(i), c + Math.cos(a) * 96, c + Math.sin(a) * 96)
      }
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * Math.PI * 2
        const r0 = i % 5 === 0 ? 112 : 117
        ctx.fillRect(c + Math.cos(a) * r0 - 1, c + Math.sin(a) * r0 - 1, 2, 2)
      }
      ctx.lineCap = 'round'
      ctx.strokeStyle = '#111'
      const hand = (a: number, len: number, width: number) => {
        ctx.lineWidth = width
        ctx.beginPath()
        ctx.moveTo(c, c)
        ctx.lineTo(c + Math.cos(a - Math.PI / 2) * len, c + Math.sin(a - Math.PI / 2) * len)
        ctx.stroke()
      }
      hand((10 / 12 + 9 / 720) * Math.PI * 2, 58, 7)
      hand((9 / 60) * Math.PI * 2, 86, 5)
      ctx.strokeStyle = '#c22'
      hand((32 / 60) * Math.PI * 2, 92, 2)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
    },
  },
  {
    name: 'sharps',
    w: 160,
    h: 160,
    paint(ctx, w, h) {
      ctx.fillStyle = '#f2c51a'
      ctx.fillRect(0, 0, w, h)
      glyph(ctx, 'biohazard', w / 2, h / 2 - 8, 44, '#1b1b1b')
      ctx.fillStyle = '#1b1b1b'
      ctx.font = font(22, 700)
      ctx.textAlign = 'center'
      ctx.fillText('SHARPS', w / 2, h - 14)
      ctx.textAlign = 'left'
    },
  },
  {
    name: 'etbr',
    w: 220,
    h: 230,
    paint(ctx, w, h) {
      ctx.fillStyle = '#c81e1e'
      ctx.fillRect(0, 0, w, h)
      glyph(ctx, 'biohazard', w / 2, 74, 50, '#141414')
      ctx.fillStyle = '#141414'
      ctx.font = font(30, 700)
      ctx.textAlign = 'center'
      ctx.fillText('Gel/EtBr', w / 2, 168)
      ctx.fillText('Waste', w / 2, 206)
      ctx.textAlign = 'left'
    },
  },
  {
    name: 'tv',
    w: 640,
    h: 360,
    paint: (ctx, w, h) => paintCells(ctx, w, h),
  },
  {
    name: 'monitor',
    w: 512,
    h: 320,
    paint(ctx, w, h) {
      ctx.fillStyle = '#15191f'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#20262e'
      ctx.fillRect(0, 0, w, 22)
      ctx.fillRect(0, 22, 96, h - 22)
      ctx.fillStyle = 'rgba(160,175,195,0.5)'
      for (let i = 0; i < 12; i++) ctx.fillRect(10, 36 + i * 20, 60 + (i % 3) * 8, 6)
      ctx.fillStyle = '#02081a'
      ctx.fillRect(108, 34, 290, 274)
      ctx.globalCompositeOperation = 'lighter'
      for (const [x, y, rad] of [
        [220, 140, 52],
        [292, 128, 44],
        [262, 205, 56],
        [190, 210, 34],
      ] as [number, number, number][]) {
        const g = ctx.createRadialGradient(x, y, 4, x, y, rad)
        g.addColorStop(0, 'rgba(80,90,255,0.2)')
        g.addColorStop(0.8, 'rgba(90,120,255,0.65)')
        g.addColorStop(1, 'rgba(90,120,255,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(x, y, rad, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = '#1b2129'
      ctx.fillRect(410, 34, 94, 274)
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = i % 2 ? '#3a6fd8' : '#2c3440'
        ctx.fillRect(418, 44 + i * 42, 78, 30)
      }
    },
  },
  {
    name: 'thermo',
    w: 240,
    h: 150,
    paint(ctx, w, h) {
      ctx.fillStyle = '#0a3c9e'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#e8f1ff'
      ctx.font = font(24, 700)
      ctx.fillText('PCR  98.0 °C', 14, 36)
      ctx.font = font(18, 500)
      ctx.fillText('Cycle 12 / 35', 14, 66)
      ctx.fillStyle = '#4fd1ff'
      ctx.fillRect(14, 84, 150, 10)
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.fillRect(14, 84, 212, 10)
      ctx.fillStyle = '#e8f1ff'
      ctx.fillText('Lid 105 °C', 14, 128)
    },
  },
  ...(['+4', '-20', '-80'] as const).map((t) => ({
    name: `disp${t}`,
    w: 180,
    h: 110,
    paint(ctx: CanvasRenderingContext2D, w: number, h: number) {
      ctx.fillStyle = '#082a6e'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#dbe8ff'
      ctx.font = font(50, 600)
      ctx.textAlign = 'center'
      ctx.fillText(`${t}°C`, w / 2, 70)
      ctx.font = font(15, 500)
      ctx.fillText('SET  ALARM  OK', w / 2, 98)
      ctx.textAlign = 'left'
    },
  })),
  {
    name: 'hoodMonitor',
    w: 140,
    h: 90,
    paint(ctx, w, h) {
      ctx.fillStyle = '#0c1a2c'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#5ef08c'
      ctx.font = font(26, 700)
      ctx.fillText('0.52', 16, 42)
      ctx.font = font(14, 500)
      ctx.fillText('m/s  SAFE', 16, 70)
    },
  },
  {
    name: 'psu',
    w: 200,
    h: 70,
    paint(ctx, w, h) {
      ctx.fillStyle = '#111b12'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#7dff6b'
      ctx.font = font(36, 600)
      ctx.fillText('120V  85mA', 10, 48)
    },
  },
  {
    name: 'vortex',
    w: 360,
    h: 240,
    paint(ctx, w, h) {
      ctx.fillStyle = '#e3e6df'; ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#284d79'; ctx.fillRect(0, 0, w, 67)
      ctx.fillStyle = '#eef2ee'; ctx.font = font(33, 700)
      ctx.fillText('VORTEX MIXER', 12, 42)
      ctx.fillStyle = '#34434b'; ctx.font = font(14, 500)
      ctx.fillText('TOUCH / CONTINUOUS', 13, 91)
      ctx.font = font(13, 600)
      for (let i = 0; i <= 10; i++) {
        const a = Math.PI * 0.75 + i / 10 * Math.PI * 1.5
        ctx.fillText(String(i), 277 + Math.cos(a) * 65 - 4, 164 + Math.sin(a) * 65)
      }
      ctx.fillText('ON', 14, 152); ctx.fillText('OFF', 14, 185); ctx.fillText('TOUCH', 14, 219)
    },
  },
  {
    name: 'microfuge',
    w: 180,
    h: 64,
    paint(ctx, w, h) {
      ctx.fillStyle = '#b7c2a3'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#34483d'
      ctx.font = font(28, 600)
      ctx.fillText('12 000 rpm', 10, 30)
      ctx.font = font(17, 500)
      ctx.fillText('05:00   READY', 10, 54)
    },
  },
  {
    name: 'bath',
    w: 160,
    h: 60,
    paint(ctx, w, h) {
      ctx.fillStyle = '#081c38'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#63c7ff'
      ctx.font = font(34, 600)
      ctx.fillText('37.0°C', 14, 44)
    },
  },
  // ionising-radiation warning sign for the designated isotope bench
  {
    name: 'radiation',
    w: 180,
    h: 220,
    paint(ctx, w, h) {
      ctx.fillStyle = '#f7d117'
      ctx.fillRect(0, 0, w, h)
      ctx.strokeStyle = '#1b1b1b'
      ctx.lineWidth = 6
      ctx.strokeRect(6, 6, w - 12, h - 12)
      const cx = w / 2
      const cy = 82
      ctx.fillStyle = '#1b1b1b'
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.arc(cx, cy, 56, a - Math.PI / 6, a + Math.PI / 6)
        ctx.closePath()
        ctx.fill()
      }
      ctx.fillStyle = '#f7d117'
      ctx.beginPath()
      ctx.arc(cx, cy, 15, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#1b1b1b'
      ctx.beginPath()
      ctx.arc(cx, cy, 10, 0, Math.PI * 2)
      ctx.fill()
      ctx.font = font(22, 800)
      ctx.textAlign = 'center'
      ctx.fillText('RADIOACTIVE', cx, 170)
      ctx.font = font(15, 600)
      ctx.fillText('Designated area', cx, 196)
      ctx.textAlign = 'left'
    },
  },
  // oxygen-depletion alarm head: status only
  {
    name: 'o2',
    w: 120,
    h: 150,
    paint(ctx, w, h) {
      ctx.fillStyle = '#eef0f2'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#0b1f33'
      ctx.fillRect(14, 16, w - 28, 54)
      ctx.fillStyle = '#9fd3ff'
      ctx.font = font(26, 700)
      ctx.textAlign = 'center'
      ctx.fillText('O₂', w / 2, 52)
      ctx.fillStyle = '#3ddc84'
      ctx.beginPath()
      ctx.arc(w / 2 - 22, 100, 9, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#cfd4d9'
      ctx.beginPath()
      ctx.arc(w / 2 + 22, 100, 9, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#334155'
      ctx.font = font(13, 600)
      ctx.fillText('OXYGEN ALARM', w / 2, 136)
      ctx.textAlign = 'left'
    },
  },
  // room-pressure gauge: needle sits in the green band (no number)
  {
    name: 'pressure',
    w: 140,
    h: 140,
    paint(ctx, w, h) {
      const cx = w / 2
      const cy = h / 2
      ctx.fillStyle = '#1f2937'
      ctx.beginPath()
      ctx.arc(cx, cy, 68, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#f8fafc'
      ctx.beginPath()
      ctx.arc(cx, cy, 60, 0, Math.PI * 2)
      ctx.fill()
      ctx.lineWidth = 9
      ctx.strokeStyle = '#22c55e'
      ctx.beginPath()
      ctx.arc(cx, cy, 48, Math.PI * 0.95, Math.PI * 1.35)
      ctx.stroke()
      ctx.strokeStyle = '#ef4444'
      ctx.beginPath()
      ctx.arc(cx, cy, 48, Math.PI * 1.6, Math.PI * 2.05)
      ctx.stroke()
      ctx.strokeStyle = '#111827'
      ctx.lineWidth = 2
      for (let i = 0; i <= 10; i++) {
        const a = Math.PI * (0.75 + i * 0.15)
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(a) * 52, cy + Math.sin(a) * 52)
        ctx.lineTo(cx + Math.cos(a) * 58, cy + Math.sin(a) * 58)
        ctx.stroke()
      }
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.cos(Math.PI * 1.15) * 46, cy + Math.sin(Math.PI * 1.15) * 46)
      ctx.stroke()
      ctx.fillStyle = '#111827'
      ctx.font = font(14, 700)
      ctx.textAlign = 'center'
      ctx.fillText('Pa', cx, cy + 32)
      ctx.textAlign = 'left'
    },
  },
  // idle status screen for generic instruments (no readings: the sim owns those)
  {
    name: 'instrument',
    w: 160,
    h: 90,
    paint(ctx, w, h) {
      ctx.fillStyle = '#0b1f33'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#1d3a57'
      ctx.fillRect(0, 0, w, 20)
      ctx.fillStyle = '#9fd3ff'
      ctx.font = font(13, 600)
      ctx.fillText('READY', 10, 15)
      ctx.fillStyle = '#3ddc84'
      ctx.beginPath()
      ctx.arc(w - 14, 10, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#2b4c6e'
      for (let i = 0; i < 3; i++) ctx.fillRect(10, 32 + i * 18, w - 20 - i * 30, 8)
    },
  },
  {
    name: 'oven',
    w: 110,
    h: 64,
    paint(ctx, w, h) {
      ctx.fillStyle = '#1b0e0a'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#ff6a3d'
      ctx.font = font(34, 700)
      ctx.fillText('65°', 18, 46)
    },
  },
  {
    name: 'gel',
    w: 260,
    h: 180,
    paint(ctx, w, h) {
      ctx.fillStyle = '#3b2fd8'
      ctx.fillRect(0, 0, w, h)
      const g = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.7)
      g.addColorStop(0, 'rgba(120,120,255,0.6)')
      g.addColorStop(1, 'rgba(40,20,160,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = 'rgba(255,170,240,0.85)'
      for (let lane = 0; lane < 8; lane++) {
        const x = 20 + lane * 29
        for (let b = 0; b < 4; b++) {
          const y = 40 + ((lane * 13 + b * 31) % 110)
          ctx.fillRect(x, y, 20, 3)
        }
      }
    },
  },
  ...(
    [
      ['eppendorf', '#1f4fbf', 'eppendorf', 300, 70, 46],
      ['thermo', '#d42b20', 'Thermo', 260, 70, 46],
      ['gilson', '#283b51', 'GILSON', 220, 60, 40],
      ['sartorius', '#643c67', 'sartorius', 220, 60, 40],
      ['bmg', '#3f4548', 'BMG LABTECH', 360, 70, 40],
      ['biorad', '#2a8d3a', 'BIO-RAD', 260, 76, 46],
      ['uvp', '#2c5bd8', 'UVP', 200, 70, 50],
      ['purell', '#1f4fbf', 'Purell', 160, 60, 38],
      ['tork', '#4a4f57', 'TORK', 160, 60, 38],
    ] as const
  ).map(([name, color, text, w, h, size]) => ({
    name: `brand-${name}`,
    w,
    h,
    paint(ctx: CanvasRenderingContext2D, cw: number, ch: number) {
      ctx.fillStyle = name === 'uvp' ? '#121417' : '#f3f5f7'
      ctx.fillRect(0, 0, cw, ch)
      ctx.fillStyle = color
      ctx.font = font(size, 800)
      ctx.textAlign = 'center'
      ctx.fillText(text, cw / 2, ch / 2 + size * 0.36)
      ctx.textAlign = 'left'
    },
  })),
  {
    name:'pipetteCounter',w:80,h:140,
    paint(ctx,w,h) {
      ctx.fillStyle='#111719';ctx.fillRect(0,0,w,h)
      ctx.font=font(38,700);ctx.textAlign='center'
      for(let i=0;i<3;i++){ctx.fillStyle='#e4e9e6';ctx.fillText(['0','5','0'][i],w/2,40+i*44)}
      ctx.textAlign='left'
    },
  },
  ...([
    ['fisher','Fisherbrand','#a5292e','GENERAL LABWARE'],
    ['corning','CORNING','#24698f','CELL CULTURE'],
    ['axygen','AXYGEN','#5c377c','PIPETTE TIPS'],
  ] as const).map(([id,name,color,product])=>({
    name:`carton-${id}`,w:300,h:180,
    paint(ctx:CanvasRenderingContext2D,w:number,h:number) {
      ctx.fillStyle='#efeee6';ctx.fillRect(0,0,w,h)
      ctx.fillStyle=color;ctx.fillRect(0,0,11,h);ctx.font=font(32,800);ctx.fillText(name,22,49)
      ctx.font=font(16,600);ctx.fillText(product,22,81)
      ctx.fillStyle='#555b58';ctx.font=font(12,500);ctx.fillText('LOT 2408 • RESEARCH USE',22,106)
      for(let i=0;i<38;i++) if(i%5!==2)ctx.fillRect(22+i*3.8,123,i%3===0?2.4:1.2,26)
      ctx.fillStyle=color;ctx.fillRect(0,h-14,w,14)
    },
  })),
  {
    name: 'keyboard',
    w: 320,
    h: 100,
    paint(ctx, w, h) {
      ctx.fillStyle = '#16181b'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#2b2f35'
      for (let r = 0; r < 5; r++) for (let c = 0; c < 18; c++) ctx.fillRect(6 + c * 17, 6 + r * 18, 14, 15)
    },
  },
  {
    name: 'bottleLabel',
    w: 160,
    h: 80,
    paint(ctx, w, h) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#1f5fd1'
      ctx.fillRect(0, 0, w, 14)
      ctx.fillStyle = 'rgba(30,40,60,0.75)'
      ctx.fillRect(10, 26, 100, 8)
      ctx.fillRect(10, 42, 130, 5)
      ctx.fillRect(10, 54, 80, 5)
    },
  },
  {
    name: 'carton',
    w: 220,
    h: 140,
    paint(ctx, w, h) {
      ctx.fillStyle = '#f7f8fa'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#1f4fbf'
      ctx.fillRect(0, h - 34, w, 34)
      ctx.font = font(30, 800)
      ctx.fillText('LAB SUPPLIES', 14, 52)
      ctx.fillStyle = 'rgba(30,40,60,0.6)'
      ctx.fillRect(14, 66, 120, 6)
      ctx.fillRect(14, 80, 90, 6)
    },
  },
]

export type DecalName =
  | 'washHands'
  | 'wearPPE'
  | 'labSafety'
  | 'emergency'
  | 'postPcr'
  | 'flammable'
  | 'roomSign'
  | 'exit'
  | 'plate-2.13'
  | 'plate-2.15'
  | `room-${string}`
  | 'way-life'
  | 'way-chem'
  | 'way-entrance'
  | 'labelPrep'
  | 'labelPcr'
  | 'notice'
  | 'clock'
  | 'sharps'
  | 'etbr'
  | 'tv'
  | 'monitor'
  | 'thermo'
  | 'disp+4'
  | 'disp-20'
  | 'disp-80'
  | 'hoodMonitor'
  | 'psu'
  | 'bath'
  | 'microfuge'
  | 'vortex'
  | 'instrument'
  | 'radiation'
  | 'o2'
  | 'pressure'
  | 'oven'
  | 'gel'
  | 'brand-eppendorf'
  | 'brand-thermo'
  | 'brand-gilson'
  | 'brand-sartorius'
  | 'brand-bmg'
  | 'pipetteCounter'
  | 'carton-fisher'
  | 'carton-corning'
  | 'carton-axygen'
  | 'brand-biorad'
  | 'brand-uvp'
  | 'brand-purell'
  | 'brand-tork'
  | 'keyboard'
  | 'bottleLabel'
  | 'carton'

const ATLAS = 2048
const PAD = 6

export function buildDecalAtlas(scale: number, anisotropy: number): DecalAtlas {
  // Shelf-pack in logical 2048 space, paint scaled to the tier's resolution.
  const rects = new Map<string, { x: number; y: number; w: number; h: number }>()
  const sorted = [...entries].sort((a, b) => b.h - a.h)
  let x = PAD
  let y = PAD
  let row = 0
  for (const e of sorted) {
    if (x + e.w + PAD > ATLAS) {
      x = PAD
      y += row + PAD
      row = 0
    }
    rects.set(e.name, { x, y, w: e.w, h: e.h })
    x += e.w + PAD
    row = Math.max(row, e.h)
  }
  const used = y + row + PAD
  const height = Math.pow(2, Math.ceil(Math.log2(used)))
  const c = document.createElement('canvas')
  c.width = Math.round(ATLAS * scale)
  c.height = Math.round(height * scale)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, c.width, c.height)
  for (const e of entries) {
    const r = rects.get(e.name)!
    ctx.save()
    ctx.scale(scale, scale)
    ctx.translate(r.x, r.y)
    ctx.beginPath()
    ctx.rect(0, 0, e.w, e.h)
    ctx.clip()
    e.paint(ctx, e.w, e.h)
    ctx.restore()
  }
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = anisotropy
  texture.userData.shared = true
  return {
    texture,
    uv(name) {
      const r = rects.get(name)
      if (!r) throw new Error(`no decal ${name}`)
      const inset = 1.5
      return [(r.x + inset) / ATLAS, 1 - (r.y + r.h - inset) / height, (r.x + r.w - inset) / ATLAS, 1 - (r.y + inset) / height]
    },
  }
}

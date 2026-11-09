// Decor props for every room, modelled after the reference photos. All of it
// is static and merges into room batches; chairs register movable instances.
// Prop builders work in a local frame: y = 0 on the supporting surface,
// +z towards the person using it, x along the bench.
import * as THREE from 'three'
import type { LabCtx } from './context'
import type { Batch } from './kit'
import { appliance, powerInlet } from './powerRecords'
import { outlet, barPull } from './casework'
import { wallPlate, yawFor } from './architecture'
import { rng } from './surfaces'
import { perforatedDeck, vesselGeometry, profiledSolid, instrumentCasingGeometry, loadingPanelGeometry, rotorCrownGeometry, rotorSocket, mediaBottleGeometry, wasteBodyGeometry, pipetteHousingGeometry, pipetteFingerRestGeometry, pipetteGripGeometry, pipetteButtonGeometry } from '../equipmentGeometry'
import {
  BENCH_TOP,
  CHAIRS,
  FIXTURES,
  UPPER_BOTTOM,
  UPPER_TOP,
  bench,
  benchPoint,
  benchYaw,
  type Vec2,
  type ZoneId,
} from './layout'

const WHITE = '#f2f3f4'
const OFFWHITE = '#e9ebec'

function onBench(ctx: LabCtx, runId: string, s: number, d: number, fn: (b: Batch) => void, yaw = 0) {
  const run = bench(runId)
  const b = ctx.batch[run.zone]
  const [x, z] = benchPoint(run, s, d)
  b.at(x, BENCH_TOP, z, benchYaw(run) + yaw, () => fn(b))
}

/** Frame on a wall face: origin at (x, y, z) on the face, +z into the room. */
function onWall(ctx: LabCtx, zone: ZoneId, x: number, y: number, z: number, n: Vec2, fn: (b: Batch) => void) {
  const b = ctx.batch[zone]
  b.at(x, y, z, yawFor(n), () => fn(b))
}

// â”€â”€ small lab ware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function bottle(b: Batch, x: number, z: number, r: number, h: number, cap = '#1f5fd1', liquid?: string, label = true) {
  const neck = r * 0.64
  b.add('bottle',mediaBottleGeometry(r,h,b.detail==='full'?24:12),new THREE.Matrix4().makeTranslation(x,0,z),'#edf3ef')
  if (liquid) b.cyl('liquid', x, h * 0.25 + 0.002, z, r - 0.0015, r - 0.0015, h * 0.5, { color: liquid, seg: 16 })
  const capH=Math.min(0.024,h*0.18), capR=neck*1.15
  b.cyl('gloss', x, h+capH*0.33, z, capR, capR, capH, { color: cap, seg: b.detail === 'full' ? 24 : 12 })
  b.cyl('plastic',x,h-capH*0.18,z,capR*1.02,capR*1.02,0.002,{color:'#cddcd8',seg:20})
  for(let i=0;i<(b.detail==='full'?24:0);i++) {
    const angle=i/(b.detail==='full'?24:12)*Math.PI*2
    b.box('plastic',x+Math.sin(angle)*capR,h+capH*.33,z+Math.cos(angle)*capR,0.0008,capH*.86,0.0012,{color:cap,ry:angle})
  }
  if (label) b.decal('bottleLabel', x, h * 0.4, z + r + 0.0004, r * 1.35, h * 0.3)
}

export function carton(b: Batch, x: number, z: number, w: number, h: number, d: number, color = '#f6f7f8', decal = true) {
  b.box('plastic', x, h / 2, z, w, h, d, { color })
  const artwork = (['carton-fisher','carton-corning','carton-axygen'] as const)[Math.abs(Math.round(x*97+z*59+w*1000+h*1300))%3]
  if (decal) b.decal(artwork, x, h * 0.55, z + d / 2 + 0.0012, w * 0.86, h * 0.6)
}

export function tipBox(b: Batch, x: number, z: number, color: string, y = 0, closed = false) {
  const w = 0.123, d = 0.083
  b.at(x, y, z, 0, () => {
    b.box('plastic', 0, 0.028, 0, w, 0.056, d, { color, radius: 0.003 })
    const holes = Array.from({ length: 96 }, (_, i) => ({ x: (i % 12 - 5.5) * 0.009, z: (Math.floor(i / 12) - 3.5) * 0.009, radius: 0.0033 }))
    if (!closed) {
      b.add('plastic', perforatedDeck(w - 0.004, d - 0.004, 0.003, holes, 0.001, b.detail === 'full' ? 12 : 8), new THREE.Matrix4().makeTranslation(0, 0.055, 0), '#e3e7e5')
      for (const h of holes) {
        // Only the cuff projects above the tray; the tapered shaft sits inside the box.
        b.lathe('bottle', [[0.0005, 0], [0.0009, 0.004], [0.0031, 0.036], [0.0037, 0.04], [0.0029, 0.04]], h.x, 0.021, h.z, '#edf0e8', b.detail === 'full' ? 10 : 6)
        b.lathe('bottle', [[0.0029, 0.04], [0.0027, 0.036], [0.0003, 0.001]], h.x, 0.021, h.z, '#738b86', b.detail === 'full' ? 10 : 6)
      }
    }
    b.within(new THREE.Matrix4().makeRotationX(closed ? 0 : -1.8).setPosition(0, closed ? 0.06 : 0.058, -d / 2), () => {
      b.box('bottle', 0, 0.002, d / 2, w, 0.004, d, { color: '#c5d8e4', radius: 0.0015 })
      for (const side of [-1, 1]) b.box('plastic', side * (w / 2 - 0.001), 0.001, d / 2, 0.002, 0.002, d, { color })
      b.box('plastic', 0, 0, d, 0.014, 0.004, 0.003, { color })
    })
  })
}

export function tubeRack(b: Batch, x: number, z: number, color: string, cols = 10, rows = 5, tubes?: string[]) {
  const pitch = 0.0215
  const w = cols * pitch + 0.012, d = rows * pitch + 0.012
  const h = 0.055
  const holes = Array.from({ length: cols * rows }, (_, i) => ({ x: (i % cols - (cols - 1) / 2) * pitch, z: (Math.floor(i / cols) - (rows - 1) / 2) * pitch, radius: 0.0063 }))
  b.at(x, 0, z, 0, () => {
    b.box('plastic', 0, 0.003, 0, w, 0.006, d, { color, radius: 0.002 })
    b.add('plastic', perforatedDeck(w, d, 0.004, holes, 0.002, b.detail === 'full' ? 16 : 8), new THREE.Matrix4().makeTranslation(0, h - 0.004, 0), color)
    for (const side of [-1, 1]) {
      b.box('plastic', side * (w / 2 - 0.003), h / 2, 0, 0.006, h, d, { color, radius: 0.0015 })
      // Rails support the deck without turning the rack into an opaque brick.
      b.box('plastic', 0, 0.012, side * (d / 2 - 0.003), w, 0.014, 0.006, { color })
    }
    if (tubes) {
      const rand = rng(Math.round((x + z) * 1000))
      for (let i = 0; i < Math.min(tubes.length, holes.length); i++) {
        if (rand() < 0.15) continue
        const hole = holes[i]
        b.add('bottle', vesselGeometry(0.0054, 0.0015, 0.037, 0.0006, b.detail === 'full' ? 12 : 8), new THREE.Matrix4().makeTranslation(hole.x, h - 0.022, hole.z), '#eef2ec')
        b.cyl('plastic', hole.x, h + 0.017, hole.z, 0.0062, 0.0062, 0.004, { color: tubes[i], seg: 12 })
        b.box('plastic', hole.x + 0.006, h + 0.015, hole.z, 0.003, 0.004, 0.002, { color: tubes[i] })
      }
    }
    b.shadow(0, 0, 0, w, d, 0.4)
  })
}

/** Stored plates keep their hollow skirts; only the uncovered top needs full wells. */
export function plateStack(b: Batch, count = 4) {
  const w = 0.12776, d = 0.08548, h = 0.01435, wall = 0.0014
  for (let i = 0; i < count; i++) b.at(0, 0.001 + i * 0.0145, 0, 0, () => {
    for (const side of [-1, 1]) {
      b.box('bottle', 0, h / 2, side * (d - wall) / 2, w, h, wall, { color: '#e1e7e8' })
      b.box('bottle', side * (w - wall) / 2, h / 2, 0, wall, h, d - 2 * wall, { color: '#e1e7e8' })
    }
    if (i !== count - 1) return
    const holes = Array.from({ length: 96 }, (_, n) => ({ x: (n % 12 - 5.5) * 0.009, z: (Math.floor(n / 12) - 3.5) * 0.009, radius: 0.0036 }))
    b.add('plastic', perforatedDeck(w, d, 0.0011, holes, 0.002, b.detail === 'full' ? 12 : 8), new THREE.Matrix4().makeTranslation(0, h - 0.0011, 0), '#dce2e6')
    for (const hole of holes) {
      b.lathe('bottle', [[0, 0.00035], [0.0025, 0.00035], [0.0031, 0.0098], [0.0036, 0.0109]], hole.x, h - 0.0109, hole.z, '#7e9397', b.detail === 'full' ? 12 : 8)
    }
  })
}

/** Mixed mechanical pipettes on a slotted, stable linear support. No tips stored fitted. */
export function pipetteStand(b: Batch) {
  const w = 0.34
  b.box('plastic',0,0.007,0,w,0.014,0.135,{color:'#e4e5e0',radius:0.002})
  for(const side of [-1,1]) {
    b.box('plastic',side*0.151,0.13,-0.043,0.016,0.24,0.023,{color:'#a6adb0',radius:0.001})
    for(const end of [-1,1]) b.cyl('rubber',side*.14,0.002,end*.048,.008,.008,.004,{color:'#303638',seg:8})
  }
  b.box('plastic',0,.252,-.043,w,.008,.024,{color:'#bbc1c1',radius:.001})
  // Individual prongs leave open front-loading slots for the finger rests.
  for(let i=0;i<=5;i++) b.box('plastic',-.15+i*.06,.252,-.012,.033,.008,.045,{color:'#bbc1c1',radius:.001})
  const codes=['#dfb72f','#dfb72f','#34758d','#9c4168','#785793']
  for(let i=0;i<5;i++) b.at(-.12+i*.06,i<3?.06:.07,.009,0,()=>{
    const classic=i<3, ivory=classic?'#e8ece8':'#ecece7', grip=classic?'#102b46':'#595f61'
    if(classic) {
      b.add('plastic',pipetteGripGeometry(b.detail==='full'?24:16),undefined,grip)
      b.add('plastic',pipetteHousingGeometry(b.detail==='full'?24:16),undefined,ivory)
      b.add('plastic',pipetteFingerRestGeometry(b.detail==='full'?6:3),undefined,ivory)
    } else {
      // Contemporary one-piece white body, broad upper head and narrow waist.
      b.lathe('plastic',[[0,.078],[.005,.078],[.007,.095],[.0085,.125],[.010,.15],[.012,.181],[.009,.195],[0,.195]],0,0,0,ivory,20)
      b.box('rubber',0,.123,-.007,.01,.055,.005,{color:grip,radius:.001})
      b.cyl('plastic',0,.196,0,.008,.008,.006,{color:codes[i],seg:16})
    }
    if(!classic) b.box('plastic',0,.185,-.017,.013,.006,.024,{color:ivory,radius:.0005})
    b.cyl('plastic',0,classic?.2045:.201,0,classic?.0038:.003,classic?.0038:.003,classic?.025:.017,{color:grip,seg:12})
    if(classic) b.add('plastic',pipetteButtonGeometry(b.detail==='full'?24:16),new THREE.Matrix4().makeTranslation(0,.219,0),codes[i])
    else b.cyl('plastic',0,.214,0,.0075,.0065,.008,{color:codes[i],seg:16})
    b.cyl('plastic',0,classic?.047:.053,0,classic?.0035:.0054,.0026,classic?.045:.057,{color:ivory,seg:12})
    if(classic) b.cyl('plastic',0,.0675,0,.0048,.0035,.003,{color:ivory,seg:12})
    b.cyl('plastic',0,.074,0,.0062,.0048,.01,{color:ivory,seg:12})
    b.box('rubber',0,classic?.157:.158,classic?.0079:.0104,classic?.0076:.0085,classic?.021:.025,.0008,{color:'#202629',radius:.0003})
    b.decal('pipetteCounter',0,classic?.157:.158,classic?.00835:.011,.0064,classic?.0188:.022)
    b.decal(classic?'brand-gilson':'brand-sartorius',0,.18,classic?.00955:.011,.015,.004)
    b.cyl('plastic',.006,classic?.199:.196,-.01,classic?.0055:.0045,classic?.005:.0038,classic?.013:.012,{color:classic?grip:ivory,seg:12})
    if(classic) b.box('plastic',.003,.203,-.006,.012,.003,.012,{color:grip,radius:.0007})
  })
  b.shadow(0,0,0,w,.135,.45)
}

export function vortex(b: Batch) { return appliance(b,'vortex mixer',()=>vortexGeometry(b)) }

function vortexGeometry(b: Batch) {
  const blue = '#31598f'
  const profile: [number, number][] = [[-0.08, 0.01], [0.08, 0.01], [0.08, 0.042], [0.045, 0.125], [-0.08, 0.125]]
  b.add('plastic', profiledSolid(0.13, profile, 0.0015), undefined, blue)
  b.box('rubber', 0, 0.007, 0, 0.125, 0.008, 0.155, { color: '#30383b', radius: 0.001 })
  for (const x of [-1, 1]) for (const z of [-1, 1]) b.cyl('rubber', x * 0.046, 0.003, z * 0.058, 0.006, 0.006, 0.006, { color: '#282d30', seg: 10 })
  b.cyl('rubber', 0, 0.132, -0.012, 0.016, 0.018, 0.018, { color: '#272d31', seg: 16 })
  b.add('rubber', vesselGeometry(0.027, 0.017, 0.024, 0.004, 20), new THREE.Matrix4().makeTranslation(0, 0.141, -0.012), '#202629')
  const angle = -Math.atan2(0.035, 0.083)
  b.within(new THREE.Matrix4().makeRotationX(angle).setPosition(0, 0.0835 - Math.sin(angle) * 0.002, 0.0625 + Math.cos(angle) * 0.002), () => {
    b.box('rubber', 0, 0, 0, 0.112, 0.075, 0.001, { color: '#404a51' })
    b.decal('vortex', 0, 0, 0.001, 0.108, 0.071)
    b.cyl('rubber', 0.03, -0.012, 0.008, 0.014, 0.014, 0.012, { color: '#252c32', rx: Math.PI / 2, seg: 20 })
    b.box('plastic', 0.03, -0.006, 0.0142, 0.0015, 0.009, 0.0005, { color: '#cbd1cf' })
    b.cyl('steel', -0.035, -0.022, 0.003, 0.0055, 0.0055, 0.003, { rx: Math.PI / 2, seg: 12 })
    b.rod('steel', { x: -0.035, y: -0.022, z: 0.005 }, { x: -0.035, y: -0.017, z: 0.015 }, 0.0015)
  })
  b.shadow(0, 0, 0, 0.13, 0.16, 0.55)
}

export function microfuge(b: Batch) { return appliance(b,'compact centrifuge',()=>microfugeGeometry(b)) }

function microfugeGeometry(b: Batch) {
  b.add('plastic', instrumentCasingGeometry({ width: 0.27, depth: 0.32, deckHeight: 0.15, frontHeight: 0.085, shoulderDepth: 0.05, baseHeight: 0.01, holes: [{ x: 0, z: -0.01, radius: 0.1 }], segments: b.detail === 'full' ? 28 : 20 }), undefined, WHITE)
  b.box('rubber', 0, 0.007, 0, 0.264, 0.014, 0.314, { color: '#596269', radius: 0.002 })
  b.add('steel', vesselGeometry(0.098, 0.087, 0.065, 0.0018, 28), new THREE.Matrix4().makeTranslation(0, 0.081, -0.01))
  b.add('rubber', new THREE.TorusGeometry(0.1, 0.0025, 6, 32), new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0.151, -0.01), '#242a2e')
  b.at(0, 0.082, -0.01, 0, () => {
    b.cyl('frame', 0, 0.017, 0, 0.036, 0.079, 0.022, { color: '#353b3e', seg: 24 })
    b.add('frame', rotorCrownGeometry(12, b.detail === 'full' ? 12 : 8, 0.09), undefined, '#353b3e')
    for (let i = 0; i < 12; i++) b.add('frame', vesselGeometry(0.0075, 0.005, 0.04, 0.0012, b.detail === 'full' ? 12 : 8), rotorSocket(i, 12), '#353b3e')
    b.cyl('plastic', 0, 0.06, 0, 0.011, 0.012, 0.012, { color: '#86423c', seg: 16 })
  })
  b.within(new THREE.Matrix4().makeRotationX(-1.15).setPosition(0, 0.154, -0.14), () => {
    b.box('plastic', 0, 0.006, 0.13, 0.25, 0.012, 0.26, { color: OFFWHITE, radius: 0.0015 })
    b.add('plastic', new THREE.RingGeometry(0.005, 0.093, 28), new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, -0.001, 0.13), '#bfc6c8')
    for (const side of [-1, 1]) b.box('frame', side * 0.11, -0.001, 0.13, 0.004, 0.002, 0.23, { color: '#8c9599' })
  })
  for (const side of [-1, 1]) b.cyl('frame', side * 0.08, 0.15, -0.14, 0.0045, 0.0045, 0.026, { color: '#767e83', rz: Math.PI / 2, seg: 12 })
  b.within(new THREE.Matrix4().makeRotationX(-Math.atan2(0.05, 0.065)).setPosition(0, 0.1175, 0.135), () => {
    b.box('plastic', 0, 0, 0.001, 0.235, 0.067, 0.002, { color: '#dfe5e7', radius: 0.0005 })
    b.decal('microfuge', -0.025, 0.006, 0.0025, 0.115, 0.027, 0, 'screen', 0.85)
    // Membrane keys distinguish this compact unit from the working knob-controlled centrifuge.
    for(const x of [.052,.079]) for(const y of [-.009,.009]) b.box('plastic',x,y,.0035,.018,.012,.0015,{color:'#737d7e',radius:.0008})
    b.box('plastic',.079,-.027,.0035,.018,.009,.0015,{color:'#43816c',radius:.0008})
    b.box('plastic',.052,-.027,.0035,.018,.009,.0015,{color:'#9b4740',radius:.0008})
  })
  b.decal('brand-thermo', -0.05, 0.045, 0.161, 0.08, 0.015)
  b.shadow(0, 0, 0, 0.27, 0.32, 0.55)
}

export function thermocycler(b: Batch) { return appliance(b,'thermal cycler',()=>thermocyclerGeometry(b)) }

function thermocyclerGeometry(b: Batch) {
  const profile: [number, number][] = [[-0.18, 0.012], [0.18, 0.012], [0.18, 0.065], [0.06, 0.2], [0.04, 0.205], [-0.18, 0.205]]
  b.add('plastic', profiledSolid(0.27, profile, 0.0015), undefined, WHITE)
  b.box('rubber', 0, 0.008, 0, 0.26, 0.008, 0.348, { color: '#535d62', radius: 0.001 })
  b.box('plastic', 0, 0.204, -0.063, 0.256, 0.002, 0.226, { color: '#6b7876' })
  b.box('plastic', 0, 0.211, -0.063, 0.255, 0.012, 0.226, { color: OFFWHITE, radius: 0.0015 })
  // A real recessed latch and a restrained top handle, rather than a rounded cap.
  b.box('rubber', 0, 0.218, 0.027, 0.083, 0.002, 0.022, { color: '#4b555b', radius: 0.001 })
  b.box('plastic', 0, 0.224, 0.027, 0.098, 0.012, 0.014, { color: OFFWHITE, radius: 0.001 })
  b.within(new THREE.Matrix4().makeRotationX(-Math.atan2(0.12, 0.135)).setPosition(0, 0.1325, 0.12), () => {
    b.box('plastic', 0, 0, 0.002, 0.207, 0.137, 0.003, { color: '#e0e5e7', radius: 0.001 })
    b.box('rubber', 0, -0.004, 0.004, 0.176, 0.097, 0.002, { color: '#28343b', radius: 0.0005 })
    b.decal('thermo', 0, -0.004, 0.0052, 0.161, 0.082, 0, 'screen', 0.85)
    b.decal('brand-biorad', 0, 0.055, 0.005, 0.079, 0.014)
  })
  b.box('frame', 0.092, 0.04, 0.181, 0.017, 0.007, 0.001, { color: '#7b878c' })
  b.box('rubber', 0.092, 0.04, 0.182, 0.013, 0.004, 0.001, { color: '#1d272c' })
  for (const side of [-1, 1]) {
    b.box('rubber', side * 0.136, 0.095, -0.09, 0.001, 0.09, 0.114, { color: '#344047' })
    for (let i = 0; i < 11; i++) b.box('plastic', side * 0.1365, 0.053 + i * 0.008, -0.09, 0.0015, 0.004, 0.116, { color: WHITE })
    for (const end of [-1, 1]) b.cyl('rubber', side * 0.105, 0.003, end * 0.145, 0.007, 0.007, 0.006, { color: '#3d484e', seg: 10 })
  }
  b.shadow(0, 0, 0, 0.27, 0.36, 0.55)
}

/** Static counterpart of the working reader, used by generated-room recipes. */
export function plateReader(b: Batch) { return appliance(b,'plate reader',()=>plateReaderGeometry(b)) }

function plateReaderGeometry(b: Batch) {
  const w = 0.45, d = 0.51, h = 0.4
  for (const side of [-1, 1]) b.box('plastic', side * (w / 2 - 0.004), (h + 0.012) / 2, 0, 0.008, h - 0.012, d, { color: WHITE, radius: 0.0015 })
  b.box('plastic', 0, h - 0.002, 0, w - 0.008, 0.004, d, { color: WHITE, radius: 0.001 })
  b.box('plastic', 0, (h + 0.21) / 2, d / 2, w - 0.012, h - 0.21, 0.004, { color: WHITE, radius: 0.001 })
  b.box('plastic', 0, (h + 0.012) / 2, -d / 2, w - 0.008, h - 0.012, 0.004, { color: WHITE })
  b.add('plastic', loadingPanelGeometry(w - 0.012, 0.194, 0.003, { x: -0.105, y: 0.021, width: 0.21, height: 0.05 }), new THREE.Matrix4().makeTranslation(0, 0.111, d / 2 - 0.002), '#dfe4e6')
  b.box('frame', 0, 0.209, d / 2, w - 0.012, 0.0015, 0.001, { color: '#47677f' })
  b.decal('brand-bmg',-.137,.35,d/2+.0022,.095,.017)
  b.box('rubber', 0, 0.009, 0, w - 0.008, 0.006, d - 0.008, { color: '#303940' })
  b.box('rubber', -0.105, 0.106, d / 2 - 0.12, 0.21, 0.002, 0.24, { color: '#242d33' })
  b.box('rubber', -0.105, 0.132, d / 2 - 0.24, 0.21, 0.054, 0.002, { color: '#242d33' })
  b.box('rubber', -0.105, 0.128, d / 2 + 0.06, 0.196, 0.009, 0.15, { color: '#303940' })
  b.box('frame', -0.105, 0.134, d / 2 + 0.06, 0.14, 0.005, 0.096, { color: '#858f95' })
  b.box('rubber', 0.146, 0.132, d / 2 + 0.002, 0.088, 0.062, 0.002, { color: '#26343e' })
  b.decal('instrument', 0.146, 0.132, d / 2 + 0.0032, 0.08, 0.054, 0, 'screen', 0.85)
  for (const side of [-1, 1]) {
    b.box('rubber', side * (w / 2 + 0.0001), 0.118, -0.115, 0.001, 0.135, 0.148, { color: '#303940' })
    for (let i = 0; i < 15; i++) b.box('plastic', side * (w / 2 + 0.0005), 0.053 + i * 0.009, -0.115, 0.0015, 0.004, 0.15, { color: WHITE })
  }
  b.shadow(0, 0, 0, w, d, 0.55)
}

/** Connected binocular tubes, with an open eyecup and a recessed optical surface. */
function binocularHead(b: Batch, y: number, z: number, separation: number) {
  b.box('plastic', 0, y, z - 0.012, 0.1, 0.048, 0.1, { color: WHITE, radius: 0.003 })
  b.within(new THREE.Matrix4().makeRotationX(0.65).setPosition(0, y + 0.012, z + 0.008), () => {
    for (const side of [-1, 1]) {
      const x = side * separation / 2
      b.cyl('plastic', x, 0.025, 0, 0.014, 0.018, 0.05, { color: '#31383b', seg: 16 })
      b.cyl('rubber', x, 0.064, 0, 0.013, 0.013, 0.03, { color: '#202629', seg: 16 })
      b.lathe('rubber', [[0.013, 0], [0.016, 0.003], [0.016, 0.014], [0.0115, 0.014], [0.0115, 0.004]], x, 0.077, 0, '#171e22', 16)
      b.cyl('gloss', x, 0.082, 0, 0.011, 0.011, 0.001, { color: '#28454b', seg: 16 })
      b.cyl('frame', x, 0.047, 0, 0.0145, 0.0145, 0.003, { color: '#6e7477', seg: 16 })
    }
  })
}

export function compoundMicroscope(b: Batch) { return appliance(b,'compound microscope',()=>compoundMicroscopeGeometry(b)) }

function compoundMicroscopeGeometry(b: Batch) {
  b.box('plastic', 0, 0.027, 0.01, 0.19, 0.054, 0.25, { color: WHITE, radius: 0.004 })
  b.box('rubber', 0, 0.006, 0.01, 0.17, 0.008, 0.23, { color: '#323a3c', radius: 0.001 })
  // Curved cast arm, extruded sideways. The optical head physically joins its crown.
  const arm = new THREE.Shape()
  arm.moveTo(0.12, 0.05); arm.lineTo(0.12, 0.29)
  arm.quadraticCurveTo(0.12, 0.36, 0.045, 0.365)
  arm.lineTo(-0.025, 0.365); arm.lineTo(-0.025, 0.305)
  arm.lineTo(0.025, 0.29); arm.quadraticCurveTo(0.06, 0.25, 0.06, 0.15)
  arm.lineTo(0.06, 0.05); arm.closePath()
  const cast = new THREE.ExtrudeGeometry(arm, { depth: 0.06, bevelEnabled: true, bevelSize: 0.0015, bevelThickness: 0.0015, bevelSegments: 1, steps: 1, curveSegments: 6 })
  cast.rotateY(Math.PI / 2); cast.translate(-0.03, 0, 0)
  b.add('plastic', cast, undefined, WHITE)
  binocularHead(b, 0.345, 0.025, 0.06)
  for (const side of [-1, 1]) {
    b.cyl('rubber', side * 0.046, 0.135, -0.078, 0.027, 0.027, 0.024, { color: '#272f33', rz: Math.PI / 2, seg: 20 })
    b.cyl('plastic', side * 0.063, 0.135, -0.078, 0.014, 0.014, 0.012, { color: '#50595d', rz: Math.PI / 2, seg: 16 })
  }
  b.cyl('frame', 0, 0.272, 0.025, 0.034, 0.031, 0.015, { color: '#636e73', seg: 24 })
  const lengths = [0.038, 0.05, 0.078, 0.059]
  const bands = ['#b14743', '#c2a143', '#4e83b0', '#73986d']
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * Math.PI * 2 - Math.PI / 2
    const x = Math.cos(a) * 0.02, z = 0.025 + Math.sin(a) * 0.02, len = lengths[i]
    b.cyl('steel', x, 0.265 - len / 2, z, 0.009, 0.0065, len, { color: '#bbc2c5', seg: 12 })
    b.cyl('plastic', x, 0.265 - len + 0.01, z, 0.0078, 0.0078, 0.004, { color: bands[i], seg: 12 })
    b.cyl('rubber', x, 0.265 - len, z, 0.0065, 0.0065, 0.003, { color: '#26353b', seg: 12 })
  }
  const stageHoles = [{ x: 0, z: 0, radius: 0.014 }]
  b.add('rubber', perforatedDeck(0.15, 0.13, 0.009, stageHoles), new THREE.Matrix4().makeTranslation(0, 0.156, 0.025), '#222b30')
  b.box('frame', 0.025, 0.169, 0.025, 0.1, 0.004, 0.045, { color: '#5c6569' })
  b.box('glass', 0, 0.173, 0.025, 0.076, 0.001, 0.026, { color: '#dae5e3' })
  for (const side of [-1, 1]) b.box('steel', side * 0.042, 0.175, 0.025, 0.008, 0.002, 0.024)
  b.cyl('frame', 0, 0.135, 0.025, 0.023, 0.018, 0.029, { color: '#626e72', seg: 20 })
  b.cyl('rubber', 0, 0.117, 0.025, 0.024, 0.024, 0.006, { color: '#273136', seg: 20 })
  b.rod('steel', { x: 0.02, y: 0.116, z: 0.025 }, { x: 0.04, y: 0.116, z: 0.046 }, 0.002)
  b.cyl('gloss', 0, 0.055, 0.025, 0.025, 0.025, 0.002, { color: '#d5e2dd', seg: 20 })
  b.cyl('plastic', 0.078, 0.132, 0.06, 0.007, 0.007, 0.04, { color: '#303a3f', seg: 12 })
  b.cyl('plastic', 0.078, 0.113, 0.06, 0.01, 0.01, 0.012, { color: '#303a3f', seg: 12 })
  b.decal('brand-thermo', 0, 0.03, 0.136, 0.06, 0.016)
  b.shadow(0, 0, 0, 0.19, 0.25, 0.6)
}

export function stereoMicroscope(b: Batch) { return appliance(b,'stereo microscope',()=>stereoMicroscopeGeometry(b)) }

function stereoMicroscopeGeometry(b: Batch) {
  b.box('plastic', 0, 0.017, 0.02, 0.22, 0.034, 0.26, { color: WHITE, radius: 0.003 })
  b.cyl('rubber', 0, 0.035, 0.04, 0.052, 0.052, 0.004, { color: '#566166', seg: 24 })
  b.cyl('plastic', 0, 0.038, 0.04, 0.048, 0.048, 0.003, { color: '#e2e6e1', seg: 24 })
  for (const side of [-1, 1]) b.rod('steel', { x: side * 0.057, y: 0.042, z: 0.01 }, { x: side * 0.025, y: 0.042, z: 0.022 }, 0.002)
  b.cyl('steel', 0, 0.205, -0.08, 0.014, 0.014, 0.34, { seg: 16 })
  b.cyl('plastic', 0, 0.375, -0.08, 0.017, 0.017, 0.006, { color: '#5f6b70', seg: 16 })
  b.box('plastic', 0, 0.264, -0.065, 0.068, 0.065, 0.065, { color: WHITE, radius: 0.003 })
  b.box('plastic', 0, 0.281, -0.004, 0.084, 0.064, 0.12, { color: WHITE, radius: 0.003 })
  binocularHead(b, 0.302, 0.033, 0.05)
  b.cyl('plastic', 0, 0.232, 0.033, 0.032, 0.034, 0.04, { color: '#3b4448', seg: 20 })
  b.cyl('frame', 0, 0.211, 0.033, 0.033, 0.033, 0.006, { color: '#727e82', seg: 20 })
  b.cyl('gloss', 0, 0.207, 0.033, 0.023, 0.023, 0.001, { color: '#28474c', seg: 20 })
  for (const side of [-1, 1]) {
    b.cyl('rubber', side * 0.047, 0.264, -0.065, 0.024, 0.024, 0.022, { color: '#283136', rz: Math.PI / 2, seg: 18 })
    b.cyl('plastic', side * 0.062, 0.264, -0.065, 0.013, 0.013, 0.009, { color: '#566268', rz: Math.PI / 2, seg: 14 })
  }
  b.shadow(0, 0, 0.02, 0.22, 0.26, 0.55)
}

export function pcTower(b: Batch) { return appliance(b,'computer tower',()=>pcTowerGeometry(b)) }

function pcTowerGeometry(b: Batch) {
  b.box('plastic', 0, 0.19, 0, 0.18, 0.38, 0.4, { color: '#16181b', radius: 0.008 })
  b.box('gloss', 0, 0.19, 0.2, 0.17, 0.37, 0.004, { color: '#23262b' })
  b.box('rubber', 0, 0.3, 0.203, 0.11, 0.004, 0.002, { color: '#33373d' })
  b.cyl('glow', 0, 0.34, 0.204, 0.006, 0.006, 0.002, { color: new THREE.Color(0.2, 1.6, 2.6), rx: Math.PI / 2, seg: 10 })
  b.shadow(0, 0, 0, 0.18, 0.4, 0.6)
}

export function monitor(b: Batch) { return appliance(b,'computer display',()=>monitorGeometry(b)) }

function monitorGeometry(b: Batch) {
  b.box('plastic', 0, 0.006, -0.02, 0.24, 0.012, 0.17, { color: '#1a1c20', radius: 0.006 })
  b.box('plastic', 0, 0.13, -0.06, 0.05, 0.24, 0.025, { color: '#1a1c20' })
  b.box('plastic', 0, 0.3, -0.035, 0.58, 0.36, 0.028, { color: '#131417', radius: 0.006 })
  b.decal('monitor', 0, 0.305, -0.0205, 0.555, 0.335, 0, 'screen', 1.1)
  b.box('plastic', 0, 0.006, 0.18, 0.44, 0.02, 0.14, { color: '#17191c', radius: 0.004 })
  b.decal('keyboard', 0, 0.0165, 0.18, 0.42, 0.125, 0, 'paper', 1, -Math.PI / 2)
  b.sphere('plastic', 0.29, 0.012, 0.19, 0.03, '#17191c', 0.4)
  b.shadow(0, 0, -0.02, 0.24, 0.17, 0.5)
  b.shadow(0, 0, 0.18, 0.44, 0.14, 0.35)
}

export function sharpsBin(b: Batch) {
  b.add('plastic',wasteBodyGeometry(.22,.17,.24),undefined,'#dfb622')
  b.add('plastic',loadingPanelGeometry(.23,.18,.006,{x:-.02,y:0,width:.10,height:.05}),new THREE.Matrix4().makeRotationX(-Math.PI/2).setPosition(0,.24,0),'#d2a518')
  b.box('plastic',.077,.249,0,.065,.003,.056,{color:'#d2a518'})
  for(const side of [-1,1]) b.box('plastic',0,.248,side*.029,.212,.003,.003,{color:'#d2a518'})
  b.box('plastic',.106,.254,0,.003,.009,.03,{color:'#d2a518'})
  b.decal('sharps',0,.12,.079,.11,.11,0,'paper',1,Math.atan(.0136/.24))
  b.shadow(0,0,0,.22,.17,.55)
}

export function pencilCup(b: Batch) {
  b.cyl('wovenMesh',0,.051,0,.034,.031,.096,{seg:b.detail==='full'?40:20,open:true})
  b.cyl('rubber',0,.003,0,.032,.032,.006,{color:'#202427',seg:24})
  for(const y of [.006,.099]) b.add('frame',new THREE.TorusGeometry(y>.01?.034:.0315,.0013,5,b.detail==='full'?40:20),new THREE.Matrix4().makeRotationX(Math.PI/2).setPosition(0,y,0),'#25292c')
  const pens=[['#dbad26',.157,-.015,.001],['#1b1e22',.182,.003,-.008],['#be3437',.148,.012,.007],['#2054a7',.164,-.002,.013],['#24333b',.139,.014,-.01]] as const
  pens.forEach(([color,h,x,z],i)=>b.within(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler((i-2)*.035,0,(i%2?1:-1)*.075)).setPosition(x,.012,z),()=>{
    b.cyl('plastic',0,h/2,0,.0028,.0028,h,{color,seg:i===0?6:12})
    if(i===0) {
      b.cyl('plastic',0,h+.006,0,.0005,.0028,.012,{color:'#c9a477',seg:6})
      b.cyl('rubber',0,h+.0125,0,.0001,.0006,.004,{color:'#282b2c',seg:6})
    } else {
      b.cyl('plastic',0,h+.004,0,.002,.002,.008,{color:i===1?'#9ca3a5':color,seg:10})
      b.box('chrome',.0028,h-.011,0,.0007,.025,.0014,{color:'#bfc5c6'})
      b.cyl('plastic',0,h-.027,0,.0031,.0031,.002,{color,seg:10})
    }
  }))
  b.shadow(0,0,0,.075,.075,.35)
}

function bottleTopDispenser(b: Batch) {
  bottle(b, 0, 0, 0.045, 0.16, '#1f5fd1', '#cfe3ff')
  b.cyl('gloss', 0, 0.19, 0, 0.022, 0.026, 0.04, { color: '#2563eb', seg: 14 })
  b.cyl('gloss', 0, 0.235, 0, 0.012, 0.012, 0.06, { color: '#e5e7eb', seg: 10 })
  b.box('gloss', 0, 0.255, 0.035, 0.012, 0.012, 0.07, { color: '#e5e7eb' })
  b.shadow(0, 0, 0, 0.1, 0.1, 0.45)
}

export function chair(b: Batch, ctx: LabCtx) {
  ctx.seat(b)
}

/** One reusable local-space chair, instanced separately from the room furniture. */
export function buildChairModel(b: Batch) {
  const k='#1f2327'
  for(let i=0;i<5;i++) {
    const angle=i/5*Math.PI*2+.3
    b.within(new THREE.Matrix4().makeRotationY(angle),()=>{
      b.box('rubber',.164,.102,0,.293,.044,.049,{color:k,radius:b.detail==='full'?.006:undefined,rz:-.10})
      b.cyl('rubber',.292,.065,0,.011,.013,.04,{color:k,seg:10})
      b.box('rubber',.292,.060,0,.035,.025,.042,{color:'#22272a',radius:b.detail==='full'?.004:undefined})
      for(const z of [-.014,.014]) {
        b.cyl('rubber',.292,.030,z,.0275,.0275,.012,{color:'#171b1e',rx:Math.PI/2,seg:b.detail==='full'?20:8})
        if(b.detail==='full') b.cyl('rubber',.292,.030,z+Math.sign(z)*.0062,.022,.022,.001,{color:'#2a2e31',rx:Math.PI/2,seg:16})
      }
    })
  }
  b.lathe('rubber',[[.048,.07],[.053,.10],[.047,.13],[.034,.15]],0,0,0,k,20)
  b.cyl('rubber',0,.237,0,.031,.033,.23,{color:k,seg:20})
  b.cyl('chrome',0,.408,0,.019,.019,.134,{seg:24})
  b.cyl('rubber',0,.351,0,.034,.034,.014,{color:'#24292c',seg:20})
  b.box('rubber',0,.476,0,.35,.028,.30,{color:'#25292b',radius:b.detail==='full'?.006:undefined})
  b.box('upholstery',0,.516,.01,.46,.072,.44,{color:'#26292c',radius:.017})
  // The piping is a separate narrow welt, not a large rounded cushion edge.
  const seam=(w:number,d:number,y:number,r:number)=>{
    const pts:THREE.Vector3[]=[]
    for(const [cx,cz,start] of [[w/2-r,d/2-r,0],[-w/2+r,d/2-r,90],[-w/2+r,-d/2+r,180],[w/2-r,-d/2+r,270]]) {
      for(let j=0;j<=4;j++){const a=(start+j*90/4)*Math.PI/180;pts.push(new THREE.Vector3(cx+Math.cos(a)*r,y,cz+Math.sin(a)*r))}
    }
    b.add('upholstery',new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts,true,'centripetal'),b.detail==='full'?48:24,.0011,4,true),undefined,'#34383a')
  }
  b.at(0,0,.01,0,()=>seam(.448,.428,.540,.023))
  b.box('rubber',0,.476,-.20,.065,.025,.13,{color:'#25292b'})
  b.box('rubber',0,.604,-.252,.047,.232,.026,{color:'#202528',rx:-.08,radius:b.detail==='full'?.003:undefined})
  b.within(new THREE.Matrix4().makeRotationX(-.08).setPosition(0,.82,-.225),()=>{
    b.box('rubber',0,0,-.026,.407,.333,.018,{color:'#171c1f',radius:.015})
    b.box('upholstery',0,0,.003,.395,.32,.058,{color:'#26292c',radius:.019})
    b.within(new THREE.Matrix4().makeRotationX(Math.PI/2),()=>seam(.386,.307,.032,.023))
  })
  b.rod('steel',{x:-.05,y:.468,z:.06},{x:-.175,y:.463,z:.08},.005,'#383e42')
  b.box('rubber',-.18,.46,.085,.065,.012,.038,{color:'#1c2023',radius:b.detail==='full'?.004:undefined})
  // its shadow on the floor is cast by the room's own lights (chairShadow.ts)
}

export function plant(b: Batch, scale = 1) {
  b.cyl('gloss', 0, 0.065 * scale, 0, 0.075 * scale, 0.058 * scale, 0.13 * scale, { color: '#f7f7f5', seg: 20 })
  b.cyl('rubber', 0, 0.126 * scale, 0, 0.068 * scale, 0.068 * scale, 0.006, { color: '#3b2a1e', seg: 16 })
  const rand = rng(Math.round(scale * 1000) + 11)
  const leaves = b.detail === 'full' ? 16 : 9
  for (let i = 0; i < leaves; i++) {
    const a = (i / leaves) * Math.PI * 2 + rand() * 0.4
    const tilt = 0.35 + rand() * 0.6
    const len = (0.18 + rand() * 0.1) * scale
    const m = new THREE.Matrix4()
      .makeRotationY(a)
      .multiply(new THREE.Matrix4().makeTranslation(0, 0.12 * scale, 0))
      .multiply(new THREE.Matrix4().makeRotationX(-tilt))
      .multiply(new THREE.Matrix4().makeTranslation(0, len / 2, 0))
    const geo = new THREE.PlaneGeometry(0.075 * scale, len)
    b.add('leaf', geo, m, undefined, true)
  }
}

// â”€â”€ wall-mounted things â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function soapDispenser(b: Batch) {
  b.box('gloss', 0, 0, 0.04, 0.11, 0.2, 0.08, { color: WHITE, radius: 0.02 })
  b.box('gloss', 0, -0.03, 0.081, 0.05, 0.08, 0.004, { color: '#1f56d1', radius: 0.008 })
  b.decal('brand-purell', 0, 0.045, 0.082, 0.07, 0.025)
}

export function towelDispenser(b: Batch) {
  b.box('gloss', 0, 0, 0.06, 0.32, 0.4, 0.12, { color: WHITE, radius: 0.03 })
  b.box('plastic', 0, -0.205, 0.07, 0.24, 0.05, 0.002, { color: '#f8f8f6', rx: 0.2 })
  b.decal('brand-tork', 0, -0.12, 0.1205, 0.08, 0.03)
}

export function gloveDispenser(b: Batch) {
  b.box('gloss', 0, 0, 0.05, 0.28, 0.42, 0.1, { color: WHITE, radius: 0.02 })
  for (let i = 0; i < 2; i++) b.box('gloss', 0, -0.09 + i * 0.16, 0.101, 0.2, 0.12, 0.004, { color: '#2a63d8' })
}

export function poster(b: Batch, name: Parameters<Batch['decal']>[0], w: number, h: number) {
  b.box('plastic', 0, 0, 0.001, w + 0.004, h + 0.004, 0.002, { color: '#ffffff' })
  b.decal(name, 0, 0, 0.0025, w, h)
}

// â”€â”€ room inventories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function mainRoom(ctx: LabCtx) {
  // Pre-PCR / clean sample-prep bench (north). The west half is the
  // interactive work zone; decor fills the rest like the photo.
  onBench(ctx, 'main-north', 0.24, 0.2, (b) => pipetteStand(b))
  onBench(ctx, 'main-north', 2.45, 0.22, (b) => {
    tipBox(b, -0.07, 0, '#7cc6ff')
    tipBox(b, 0.07, 0, '#2f7be8')
    tipBox(b, 0, -0.1, '#9ad4ff', 0, true)
    tipBox(b, 0, -0.1, '#2f7be8', 0.064, true)
    b.shadow(0, 0, -0.04, 0.26, 0.2, 0.5)
  })
  onBench(ctx, 'main-north', 2.98, 0.24, (b) => {
    const pinks = Array.from({ length: 50 }, (_, i) => (i % 3 ? '#f472b6' : '#e2e8f0'))
    tubeRack(b, -0.08, 0, '#ff3f9e', 10, 5, pinks)
    tubeRack(b, 0.2, 0.03, '#2f6ff0', 8, 4, Array.from({ length: 32 }, (_, i) => (i % 2 ? '#93c5fd' : '#ffffff')))
    tubeRack(b, 0.05, -0.15, '#30c7f0', 8, 4)
  })
  onBench(ctx, 'main-north', 3.58, 0.28, (b) => vortex(b))
  onBench(ctx, 'main-north', 4.05, 0.3, (b) => microfuge(b))
  onBench(ctx, 'main-north', 4.6, 0.3, (b) => thermocycler(b))
  // a few reagent cartons tucked against the backsplash
  onBench(ctx, 'main-north', 3.95, 0.08, (b) => {
    carton(b, 0.18, 0, 0.12, 0.08, 0.09)
    carton(b, 0.32, 0.01, 0.1, 0.06, 0.08, '#f1f5f9', false)
  })

  // Microscopy / imaging bench (south)
  onBench(ctx, 'main-south', 0.42, 0.32, (b) => sharpsBin(b))
  onBench(ctx, 'main-south', 0.95, 0.3, (b) => bottleTopDispenser(b))
  onBench(ctx, 'main-south', 1.52, 0.22, (b) => {
    tipBox(b, -0.07, 0, '#f2c46d', 0, true)
    tipBox(b, -0.07, 0, '#3f86f0', 0.064, true)
    tipBox(b, 0.07, 0, '#2f7be8', 0, true)
    tipBox(b, 0.07, 0, '#6fb7ff', 0.064, true)
    b.shadow(0, 0, 0, 0.26, 0.1, 0.5)
  })
  onBench(ctx, 'main-south', 2.15, 0.2, (b) => {
    carton(b, -0.06, 0, 0.13, 0.1, 0.1)
    carton(b, 0.1, 0.02, 0.12, 0.07, 0.11)
    b.shadow(0, 0, 0, 0.28, 0.12, 0.45)
  })
  onBench(ctx, 'main-south', 2.6, 0.24, (b) => {
    plateStack(b)
    b.shadow(0, 0, 0, 0.13, 0.09, 0.4)
  })
  onBench(ctx, 'main-south', 2.95, 0.18, (b) => pencilCup(b))
  onBench(ctx, 'main-south', 4.05, 0.3, (b) => pcTower(b))
  onBench(ctx, 'main-south', 4.72, 0.3, (b) => monitor(b))
  onBench(ctx, 'main-south', 5.82, 0.32, (b) => stereoMicroscope(b), 0.15)
  onBench(ctx, 'main-south', 6.42, 0.34, (b) => compoundMicroscope(b), -0.1)
  onBench(ctx, 'main-south', 6.95, 0.25, (b) => {
    b.box('plastic', 0, 0.006, 0, 0.21, 0.012, 0.28, { color: '#1f3b73', ry: 0.1 })
    b.box('plastic', 0, 0.0125, 0, 0.2, 0.001, 0.27, { color: '#f7f6f0', ry: 0.1 })
  })

  // East end bench under the window
  onBench(ctx, 'main-east', 0.42, 0.3, (b) => {
    tubeRack(b, 0, 0, '#1f4fbf', 6, 4, ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#ffffff', '#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ffffff', '#ec4899', '#3b82f6', '#ef4444'])
  })
  onBench(ctx, 'main-east', 0.98, 0.3, (b) => {
    b.box('gloss', 0, 0.06, 0, 0.2, 0.12, 0.26, { color: WHITE, radius: 0.02 })
    b.box('steel', 0, 0.121, -0.02, 0.15, 0.004, 0.15)
    b.decal('bath', 0, 0.07, 0.1305, 0.09, 0.034, 0, 'screen', 1.2)
    b.shadow(0, 0, 0, 0.2, 0.26, 0.5)
  })
  onBench(ctx, 'main-east', 1.55, 0.22, (b) => {
    tipBox(b, 0, 0, '#ffffff', 0, true)
    tipBox(b, 0, 0, '#d9e2ec', 0.064, true)
    b.shadow(0, 0, 0, 0.12, 0.08, 0.45)
  })
  onBench(ctx, 'main-east', 2.2, 0.22, (b) => {
    carton(b, 0, 0, 0.14, 0.12, 0.12)
    carton(b, 0.0, 0.0, 0.12, 0.06, 0.1, '#f8fafc', false)
    b.shadow(0, 0, 0, 0.16, 0.14, 0.45)
  })
  // plant on the window sill
  ctx.batch.main.at(4.3 - 0.11, 1.0, -0.45, -Math.PI / 2, () => plant(ctx.batch.main, 1.05))
  ctx.batch.main.at(4.3 - 0.12, 1.0, 0.55, -Math.PI / 2, () => {
    for (let i = 0; i < 3; i++) carton(ctx.batch.main, i * 0.075 - 0.075, 0, 0.07, 0.09, 0.05, '#eef4fb', i === 1)
  })

  // Sink end: dispensers, posters, trash and switches (west wall)
  const W = -4.3
  // hand-washing alcove (back wall at x = âˆ’4.65)
  const A = -4.65
  onWall(ctx, 'main', A, 1.84, 1.3, [1, 0], (b) => poster(b, 'washHands', 0.26, 0.43))
  onWall(ctx, 'main', A, 1.32, 1.06, [1, 0], (b) => soapDispenser(b))
  onWall(ctx, 'main', A, 1.5, 0.82, [1, 0], (b) => towelDispenser(b))
  onWall(ctx, 'main', A, 1.42, 0.48, [1, 0], (b) => gloveDispenser(b))
  ctx.batch.main.at(A + 0.17, BENCH_TOP, 1.36, Math.PI / 2, () => plant(ctx.batch.main, 1.15))
  ctx.batch.main.at(A + 0.12, BENCH_TOP, 0.44, 0, () => {
    const b = ctx.batch.main
    b.cyl('steel', 0, 0.075, 0, 0.055, 0.055, 0.15, { seg: 20 })
    b.cyl('steel', 0, 0.152, 0, 0.058, 0.058, 0.006, { seg: 20 })
    b.shadow(0, 0, 0, 0.12, 0.12, 0.5)
  })
  onWall(ctx, 'main', W, 1.2, 0.12, [1, 0], (b) => wallPlate(b, 'double'))
  const trash = FIXTURES.find((f) => f.id === 'trash')!
  ctx.batch.main.at((trash.min[0] + trash.max[0]) / 2, 0, (trash.min[2] + trash.max[2]) / 2, 0, () => trashCan(ctx.batch.main))
  // "Wear your PPE" on the short wall between the entrance and the Post-PCR door
  onWall(ctx, 'main', W, 1.55, -1.5, [1, 0], (b) => poster(b, 'wearPPE', 0.18, 0.27))
  onWall(ctx, 'main', -2.88, 1.2, -1.8, [0, 1], (b) => wallPlate(b, 'switch'))
  // cold-room door switch + thermostat
  onWall(ctx, 'main', 2.2, 1.2, -1.8, [0, 1], (b) => wallPlate(b, 'switch'))
  onWall(ctx, 'main', 2.2, 1.52, -1.8, [0, 1], (b) => wallPlate(b, 'thermostat'))

  // outlets
  benchOutlets(ctx, 'main-north')
  benchOutlets(ctx, 'main-south')
  benchOutlets(ctx, 'main-east')
  plugIn(ctx, 'main-east', 0.98, 0.3, 0.13, 0.05)
}

/** Duplex outlets on the wall above each bench (along-run positions). */
const OUTLETS: Record<string, number[]> = {
  'main-north': [0.35, 1.6, 3.0, 4.4],
  'main-south': [1.7, 3.2, 4.6, 6.6],
  'main-east': [0.25, 2.55],
  'post-north': [0.4, 1.35, 2.2],
  'cold-north': [0.6, 1.35, 2.25],
}
const OUTLET_Y = 1.1

function benchOutlets(ctx: LabCtx, id: string) {
  const run = bench(id)
  const b = ctx.batch[run.zone]
  b.at(run.start[0], 0, run.start[1], benchYaw(run), () => OUTLETS[id].forEach((s) => outlet(b, s, id==='main-east'?.947:OUTLET_Y)))
}

/**
 * Power cord from the back of an instrument (at along-run `s`, `d` from the
 * wall, back face `back` behind its centre) across the worktop and up to the
 * nearest outlet.
 */
function plugIn(ctx: LabCtx, runId: string, s: number, d: number, back: number, height = .04) {
  const labels:Record<string,string>={
    'main-east:0.98':'dry block heater','post-north:0.62':'electrophoresis power supply',
    'post-north:1.08':'UV transilluminator','post-north:1.62':'gel documentation imager',
    'post-north:2.1':'post-PCR instrument','cold-north:0.28':'heating oven','cold-north:0.78':'water bath',
  }
  onBench(ctx,runId,s,d,b=>{
    const device = powerInlet(b,labels[`${runId}:${s}`]??`${runId} appliance ${s}`,0,height,-back-.002)
    device.bounds = new THREE.Box3(new THREE.Vector3(-0.2,0,-back),new THREE.Vector3(0.2,Math.max(0.16,height+0.10),back+0.02)).applyMatrix4(b.matrix)
  })
}

export function trashCan(b: Batch) {
  const seg=b.detail==='full'?48:24
  b.cyl('rubber',0,.014,0,.145,.148,.028,{color:'#24292c',seg})
  b.lathe('satinSteel',[[0,.024],[.135,.024],[.142,.030],[.146,.048],[.148,.565],[.149,.585],[.145,.589],[.141,.580],[.139,.045],[0,.032]],0,0,0,'#e0e3e4',seg)
  b.cyl('rubber',0,.589,0,.148,.148,.004,{color:'#41484b',seg})
  b.lathe('satinSteel',[[0,.594],[.145,.594],[.153,.598],[.153,.608],[.149,.613],[.13,.617],[0,.619]],0,0,0,'#e2e5e5',seg)
  b.box('rubber',0,.572,-.151,.048,.055,.028,{color:'#30373b',radius:.004})
  b.rod('satinSteel',{x:0,y:.566,z:-.158},{x:0,y:.044,z:-.155},.005)
  b.box('rubber',0,.035,.158,.092,.016,.043,{color:'#272d30',radius:.005})
  b.box('satinSteel',0,.028,.10,.018,.009,.135,{color:'#bfc6c9'})
  for(let i=0;i<6;i++) b.box('rubber',-.034+i*.0135,.044,.158,.004,.002,.029,{color:'#444a4c'})
  b.shadow(0,0,0,.31,.32,.6)
}

export function wireShelf(b: Batch, w: number, d: number, h: number, levels: number[], casters: boolean, rand: () => number) {
  const y0 = casters ? 0.09 : 0.02
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.cyl('chrome', sx * (w / 2 - 0.012), y0 + (h - y0) / 2, sz * (d / 2 - 0.012), 0.012, 0.012, h - y0, { seg: 10 })
      if (casters) {
        b.cyl('rubber', sx * (w / 2 - 0.012), 0.035, sz * (d / 2 - 0.012), 0.032, 0.032, 0.025, { color: '#18191b', rx: Math.PI / 2, seg: 12 })
        b.box('chrome', sx * (w / 2 - 0.012), 0.075, sz * (d / 2 - 0.012), 0.03, 0.03, 0.03)
      }
    }
  }
  for (const y of levels) {
    // wire deck: perimeter frame + slats
    b.span('chrome', -w / 2, y - 0.006, -d / 2, w / 2, y + 0.006, -d / 2 + 0.012)
    b.span('chrome', -w / 2, y - 0.006, d / 2 - 0.012, w / 2, y + 0.006, d / 2)
    const slats = b.detail === 'full' ? Math.round(w / 0.035) : Math.round(w / 0.09)
    for (let i = 0; i <= slats; i++) b.span('chrome', -w / 2 + (i * w) / slats - 0.002, y - 0.003, -d / 2, -w / 2 + (i * w) / slats + 0.002, y + 0.002, d / 2)
  }
  // contents
  for (let li = 0; li < levels.length; li++) {
    const y = levels[li]
    const nextGap = (li + 1 < levels.length ? levels[li + 1] : h + 0.3) - y
    if (nextGap < 0.18) continue
    let x = -w / 2 + 0.05
    while (x < w / 2 - 0.06) {
      const kind = rand()
      b.at(x, y + 0.006, (rand() - 0.5) * (d * 0.3), 0, () => {
        if (kind < 0.55) {
          const big = rand() > 0.5
          bottle(b, 0, 0, big ? 0.045 : 0.035, big ? 0.17 : 0.13, rand() > 0.25 ? '#1f5fd1' : '#c2410c', rand() > 0.6 ? '#dbeafe' : undefined)
        } else if (kind < 0.8) carton(b, 0, 0, 0.12 + rand() * 0.06, 0.09 + rand() * 0.08, Math.min(d - 0.06, 0.16), rand() > 0.5 ? '#f6f7f8' : '#dfe7f3', rand() > 0.4)
        else b.box('plastic', 0, 0.06, 0, 0.18, 0.12, Math.min(d - 0.06, 0.2), { color: '#c39a66' })
      })
      x += 0.1 + rand() * 0.08
    }
  }
}

function postRoom(ctx: LabCtx) {
  const pb = ctx.batch.post
  // gel bench (north)
  onBench(ctx, 'post-north', 0.25, 0.3, (b) => {
    b.box('rubber', 0, 0.015, 0, 0.26, 0.03, 0.14, { color: '#3a3f46' })
    b.box('bottle', 0, 0.065, 0, 0.22, 0.07, 0.11, { color: '#eef6ff' })
    b.box('bottle', 0, 0.104, 0, 0.23, 0.01, 0.12, { color: '#bfd7ff' })
    b.cyl('gloss', -0.09, 0.118, 0.04, 0.007, 0.007, 0.02, { color: '#dc2626' })
    b.cyl('gloss', -0.07, 0.118, 0.04, 0.007, 0.007, 0.02, { color: '#111' })
    b.box('plastic', 0.02, 0.022, 0.0705, 0.12, 0.022, 0.002, { color: '#ffffff' })
    b.decal('brand-biorad', 0.02, 0.022, 0.072, 0.1, 0.018)
    b.tube('rubber', [new THREE.Vector3(-0.09, 0.128, 0.04), new THREE.Vector3(-0.05, 0.16, 0.12), new THREE.Vector3(0.12, 0.05, 0.18), new THREE.Vector3(0.29, 0.03, 0.140)], 0.003, '#dc2626')
    b.tube('rubber', [new THREE.Vector3(-0.07, 0.128, 0.04), new THREE.Vector3(-0.03, 0.15, 0.13), new THREE.Vector3(0.14, 0.04, 0.2), new THREE.Vector3(0.34, 0.03, 0.140)], 0.003, '#151515')
    for(const [x,color] of [[.29,'#dc2626'],[.34,'#151515']] as const) b.cyl('rubber',x,.03,.140,.005,.005,.008,{color,rx:Math.PI/2,seg:8})
    b.shadow(0, 0, 0, 0.26, 0.14, 0.5)
  })
  onBench(ctx, 'post-north', 0.62, 0.3, (b) => {
    b.box('gloss', 0, 0.055, 0, 0.24, 0.11, 0.25, { color: '#f4f5f6', radius: 0.01 })
    b.box('gloss', 0, 0.055, 0.1255, 0.22, 0.09, 0.002, { color: '#e3e6e9' })
    b.decal('psu', -0.04, 0.07, 0.127, 0.1, 0.035, 0, 'screen', 1.2)
    for (let i = 0; i < 4; i++) b.cyl('rubber', -0.08 + i * 0.05, 0.03, 0.13, 0.009, 0.009, 0.012, { color: i < 2 ? '#dc2626' : '#111', rx: Math.PI / 2 })
    b.cyl('rubber', 0.08, 0.075, 0.132, 0.016, 0.016, 0.014, { color: '#222', rx: Math.PI / 2 })
    b.decal('brand-biorad', 0.06, 0.098, 0.127, 0.07, 0.014)
    b.shadow(0, 0, 0, 0.24, 0.25, 0.55)
  })
  onBench(ctx, 'post-north', 1.08, 0.32, (b) => {
    // UVP transilluminator: black base, glowing blue stage
    b.box('plastic', 0, 0.05, 0, 0.42, 0.1, 0.32, { color: '#1b1d22', radius: 0.012 })
    b.box('plastic', 0, 0.098, 0.01, 0.34, 0.006, 0.24, { color: '#0b0c10' })
    b.decal('gel', 0, 0.102, 0.01, 0.32, 0.22, 0, 'screen', 2.6, -Math.PI / 2)
    b.decal('brand-uvp', 0, 0.04, 0.1605, 0.09, 0.03, 0, 'screen', 1.4)
    b.shadow(0, 0, 0, 0.42, 0.32, 0.6)
    const p = new THREE.Vector3(0, 0.11, 0.01).applyMatrix4(b.matrix)
    ctx.emit('post', { kind: 'rect', c: [p.x, p.y, p.z], a: [0.15, 0, 0], b: [0, 0, 0.1], n: [0, 1, 0], L: [0.35, 0.3, 1.6] })
  })
  onBench(ctx, 'post-north', 1.62, 0.34, (b) => {
    // gel documentation system
    b.box('steel', 0, 0.2, 0, 0.32, 0.4, 0.38)
    b.box('plastic', 0, 0.19, 0.192, 0.27, 0.32, 0.01, { color: '#141518', radius: 0.006 })
    b.box('plastic', 0, 0.43, -0.03, 0.2, 0.08, 0.2, { color: '#1a1b1f', radius: 0.01 })
    b.box('plastic', 0, 0.355, 0.195, 0.3, 0.03, 0.006, { color: '#202227' })
    b.decal('brand-biorad', -0.07, 0.355, 0.1985, 0.08, 0.018)
    b.box('steel', 0.12, 0.19, 0.205, 0.015, 0.12, 0.02)
    b.shadow(0, 0, 0, 0.32, 0.38, 0.65)
  })
  onBench(ctx, 'post-north', 2.1, 0.32, (b) => {
    b.box('gloss', 0, 0.045, 0, 0.3, 0.09, 0.28, { color: '#f3f4f5', radius: 0.012 })
    b.box('gloss', 0, 0.045, 0.141, 0.26, 0.05, 0.002, { color: '#dcdfe3' })
    b.decal('bath', -0.05, 0.05, 0.1425, 0.08, 0.03, 0, 'screen', 1.2)
    b.cyl('gloss', 0.07, 0.05, 0.142, 0.012, 0.012, 0.004, { color: '#dc2626', rx: Math.PI / 2 })
    b.box('gloss', 0, 0.115, 0, 0.34, 0.016, 0.3, { color: '#2459d6', rz: 0.06, radius: 0.004 })
    b.shadow(0, 0, 0, 0.32, 0.3, 0.55)
  })
  // reagent bottles in the glazed uppers
  {
    const run = bench('post-north')
    const rand = rng(31)
    const levels = [UPPER_BOTTOM + 0.019, UPPER_BOTTOM + (UPPER_TOP - UPPER_BOTTOM) * 0.36 + 0.016]
    pb.at(run.start[0], 0, run.start[1], benchYaw(run), () => {
      for (const y of levels) {
        let s = 0.08
        while (s < 2.27) {
          const kind = rand()
          pb.at(s, y, 0.17, 0, () => {
            if (kind < 0.6) bottle(pb, 0, 0, 0.042, 0.17, rand() > 0.2 ? '#1f5fd1' : '#0f766e')
            else carton(pb, 0, -0.02, 0.15, 0.12 + rand() * 0.06, 0.12, '#f7f8fa', true)
          })
          s += 0.1 + rand() * 0.1
        }
      }
    })
  }
  // EtBr waste bin against the east wall, under the Post-PCR sign
  {
    const f = FIXTURES.find((x) => x.id === 'etbr-bin')!
    pb.at((f.min[0] + f.max[0]) / 2, 0, (f.min[2] + f.max[2]) / 2, -Math.PI / 2, () => {
      pb.box('gloss', 0, 0.28, 0, 0.34, 0.56, 0.34, { color: '#c81e1e', radius: 0.02 })
      pb.box('gloss', 0, 0.58, 0, 0.36, 0.05, 0.36, { color: '#a81616', radius: 0.02 })
      pb.decal('etbr', 0, 0.3, 0.1712, 0.19, 0.2)
      pb.shadow(0, 0, 0, 0.34, 0.34, 0.6)
    })
  }
  // wire shelving cart (west wall)
  {
    const f = FIXTURES.find((x) => x.id === 'shelf-cart')!
    pb.at((f.min[0] + f.max[0]) / 2, 0, (f.min[2] + f.max[2]) / 2, Math.PI / 2, () =>
      wireShelf(pb, f.max[2] - f.min[2], f.max[0] - f.min[0], 1.8, [0.2, 0.62, 1.04, 1.46, 1.78], true, rng(41)),
    )
    pb.shadow((f.min[0] + f.max[0]) / 2, 0, (f.min[2] + f.max[2]) / 2, 0.45, 1.2, 0.5)
  }
  // south bench: agarose, buffers, stains, gel tips
  onBench(ctx, 'post-south', 0.35, 0.2, (b) => {
    bottle(b, -0.06, 0, 0.05, 0.2, '#1f5fd1', '#e0f2fe')
    bottle(b, 0.06, 0.02, 0.045, 0.17, '#1f5fd1')
    b.shadow(0, 0, 0, 0.2, 0.12, 0.45)
  })
  onBench(ctx, 'post-south', 0.85, 0.2, (b) => {
    carton(b, 0, 0, 0.16, 0.1, 0.1, '#e0f2fe')
    carton(b, 0.0, -0.005, 0.12, 0.07, 0.08, '#fce7f3', false)
    tipBox(b, 0.2, 0.02, '#38bdf8')
    b.shadow(0, 0, 0, 0.36, 0.12, 0.45)
  })
  onBench(ctx, 'post-south', 1.5, 0.2, (b) => {
    tubeRack(b, 0, 0, '#ec4899', 8, 4)
    tipBox(b, 0.2, 0, '#f8fafc')
  })
  onBench(ctx, 'post-south', 2.2, 0.22, (b) => {
    for (let i = 0; i < 3; i++) bottle(b, -0.1 + i * 0.1, 0, 0.04, 0.15, i === 1 ? '#7c3aed' : '#1f5fd1', i === 2 ? '#fde68a' : undefined)
    b.shadow(0, 0, 0, 0.32, 0.1, 0.45)
  })
  benchOutlets(ctx, 'post-north')
  plugIn(ctx, 'post-north', 0.62, 0.3, 0.125, 0.05)
  plugIn(ctx, 'post-north', 1.08, 0.32, 0.16, 0.05)
  plugIn(ctx, 'post-north', 1.62, 0.34, 0.19, 0.08)
  plugIn(ctx, 'post-north', 2.1, 0.32, 0.14, 0.05)
  // signage
  onWall(ctx, 'post', 0, 1.62, -3.2, [-1, 0], (b) => poster(b, 'postPcr', 0.36, 0.48))
  onWall(ctx, 'post', -4.3, 1.2, -2.25, [1, 0], (b) => wallPlate(b, 'switch'))
  // de-gowning point by the exit (behind the open Preâ†’Post leaf): Post-PCR coats stay here,
  // gloves go in the bin, hands are washed at the lobby basin
  onWall(ctx, 'post', -4.3, 0, -2.58, [1, 0], (b) => {
    b.span('laminate', -0.21, 1.62, 0, 0.21, 1.7, 0.025, { color: '#dde1e5' })
    // two blue Post-PCR coats on hooks: collar, shoulders, body
    for (const x of [-0.11, 0.11]) {
      const z = 0.07 + (x > 0 ? 0.02 : 0)
      b.cyl('steel', x, 1.66, 0.05, 0.008, 0.008, 0.07, { rx: Math.PI / 2 })
      b.box('plastic', x, 1.58, z, 0.12, 0.06, 0.05, { color: '#bcd3f0', radius: 0.02 })
      b.box('plastic', x, 1.5, z, 0.24, 0.1, 0.06, { color: '#cfe0f5', radius: 0.03 })
      b.box('plastic', x, 1.12, z, 0.2, 0.68, 0.055, { color: '#cfe0f5', radius: 0.03 })
      b.box('plastic', x, 1.3, z + 0.031, 0.012, 0.36, 0.004, { color: '#9fb8d8' })
    }
  })
  onWall(ctx, 'post', -4.3, 0, -2.13, [1, 0], (b) => {
    b.box('gloss', 0, 0.55, 0.06, 0.22, 0.3, 0.12, { color: '#f4f5f6', radius: 0.01 })
    b.box('gloss', 0, 0.715, 0.06, 0.22, 0.03, 0.12, { color: '#e11d48' })
  })
}

function fumeHood(ctx: LabCtx) {
  const f = FIXTURES.find((x) => x.id === 'fume-hood')!
  const b = ctx.batch.cold
  const w = f.max[0] - f.min[0]
  const d = f.max[2] - f.min[2]
  b.at((f.min[0] + f.max[0]) / 2, 0, f.min[2], 0, () => appliance(b,'fume hood',()=>{
    // local: x across, z from the wall (0) to the front (d)
    // flammables base cabinet
    b.span('laminate', -w / 2, 0.1, 0.02, w / 2, 0.86, d - 0.025, { color: '#ebe9e4' })
    b.span('frame', -w / 2 + 0.02, 0, 0.04, w / 2 - 0.02, 0.1, d - 0.08, { color: '#8d9196' })
    for (const sx of [-1, 1]) {
      b.span('laminate', sx > 0 ? 0.002 : -w / 2 + 0.003, 0.105, d - 0.025, sx > 0 ? w / 2 - 0.003 : -0.002, 0.855, d - 0.006, { color: '#f1efea', radius: 0.003 })
      barPull(b, sx * 0.05, 0.62, d - 0.006, true)
    }
    b.decal('flammable', 0.36, 0.5, d - 0.0045, 0.3, 0.13)
    // work surface: the benches' resin, baked like them
    b.span('worktop', -w / 2, 0.86, 0, w / 2, 0.9, d, { radius: 0.004, bake: ['+y', '+z'] })
    // hood superstructure: side posts, top, back baffle
    const post = 0.14
    for (const sx of [-1, 1]) b.span('gloss', sx * (w / 2 - post / 2) - post / 2, 0.9, 0, sx * (w / 2 - post / 2) + post / 2, 2.38, d, { color: WHITE })
    b.span('gloss', -w / 2, 1.98, 0, w / 2, 2.38, d, { color: WHITE })
    b.span('gloss', -w / 2 + post, 0.9, 0, w / 2 - post, 1.98, 0.06, { color: '#e2e5e8' })
    b.span('gloss', -w / 2 + post, 0.9, 0.06, w / 2 - post, 1.98, 0.08, { color: '#d9dde1' })
    for (const y of [1.15, 1.5]) b.span('gloss', -w / 2 + post + 0.05, y, 0.081, w / 2 - post - 0.05, y + 0.03, 0.085, { color: '#cfd4d9' })
    // interior side liners
    for (const sx of [-1, 1]) b.span('gloss', sx * (w / 2 - post) - sx * 0.004, 0.9, 0.06, sx * (w / 2 - post), 1.98, d - 0.08, { color: '#e6e9ec' })
    b.span('gloss', -w / 2 + post, 1.94, 0.06, w / 2 - post, 1.98, d - 0.02, { color: '#e6e9ec' })
    // interior light
    b.span('glow', -w / 2 + post + 0.05, 1.935, d - 0.2, w / 2 - post - 0.05, 1.94, d - 0.12, { color: new THREE.Color(3.2, 3.2, 3.1) })
    // sash, raised to the working height
    const sy0 = 1.28
    const sy1 = 1.92
    b.span('steel', -w / 2 + post, sy0 - 0.03, d - 0.05, w / 2 - post, sy0, d - 0.02)
    b.span('steel', -w / 2 + post, sy1, d - 0.05, w / 2 - post, sy1 + 0.03, d - 0.02)
    b.plane('glass', 0, (sy0 + sy1) / 2, d - 0.035, w - post * 2, sy1 - sy0)
    b.span('steel', -w / 2 + post + 0.02, sy0 + 0.02, d - 0.02, w / 2 - post - 0.02, sy0 + 0.035, d - 0.005)
    // airfoil sill
    b.span('steel', -w / 2 + post, 0.9, d - 0.06, w / 2 - post, 0.925, d + 0.01, { radius: 0.006 })
    // fascia, airflow monitor, service valves
    b.span('gloss', -w / 2, 1.98, d - 0.001, w / 2, 2.12, d + 0.004, { color: '#f4f5f6' })
    b.decal('hoodMonitor', 0.0, 2.05, d + 0.0055, 0.1, 0.064, 0, 'screen', 1.3)
    const knobs = ['#16a34a', '#facc15', '#f97316', '#2563eb']
    for (const sx of [-1, 1]) {
      knobs.forEach((c, i) => {
        const x = sx * (w / 2 - post / 2)
        const y = 1.46 - i * 0.11
        b.cyl('steel', x, y, d + 0.012, 0.012, 0.012, 0.024, { rx: Math.PI / 2, seg: 10 })
        b.sphere('gloss', x, y, d + 0.032, 0.022, c)
      })
    }
    b.box('gloss', w / 2 - post / 2, 1.7, d + 0.003, 0.05, 0.05, 0.004, { color: '#facc15' })
    // exhaust duct to the ceiling
    b.cyl('steel', 0, 2.6, d * 0.45, 0.18, 0.18, 0.5, { seg: 28 })
    b.cyl('steel', 0, 2.39, d * 0.45, 0.2, 0.2, 0.03, { seg: 28 })
    for (let i = 0; i < 3; i++) b.cyl('steel', 0, 2.47 + i * 0.09, d * 0.45, 0.184, 0.184, 0.012, { seg: 28 })
  },'fixed'))
  ctx.occluder('cold', [f.min[0], 0, f.min[2]], [f.max[0], 0.9, f.max[2]])
  ctx.occluder('cold', [f.min[0], 0.9, f.min[2]], [f.min[0] + 0.14, 2.38, f.max[2]])
  ctx.occluder('cold', [f.max[0] - 0.14, 0.9, f.min[2]], [f.max[0], 2.38, f.max[2]])
  ctx.occluder('cold', [f.min[0], 1.98, f.min[2]], [f.max[0], 2.38, f.max[2]])
  ctx.occluder('cold', [f.min[0], 0.9, f.min[2]], [f.max[0], 1.98, f.min[2] + 0.08])
  ctx.collider(f.min[0], f.min[2], f.max[0], f.max[2])
}

function coldUnit(ctx: LabCtx, id: string, label: '+4' | '-20' | '-80') {
  const f = FIXTURES.find((x) => x.id === id)!
  const b = ctx.batch.cold
  const w = f.max[0] - f.min[0]
  const h = f.max[1]
  const d = f.max[2] - f.min[2]
  // fridges stand on the south wall facing north (local +z = âˆ’z world)
  b.at((f.min[0] + f.max[0]) / 2, 0, f.max[2], Math.PI, () => appliance(b,`cold storage ${label}`,()=>{
    b.box('gloss', 0, h / 2 + 0.03, (d+.075) / 2, w - 0.01, h - 0.06, d-.075, { color: '#f1f2f3', radius: 0.012, bake: ['+x', '-x'] })
    b.box('gloss', 0, (h - 0.25) / 2 + 0.25, d + 0.012, w - 0.03, h - 0.3, 0.025, { color: '#f6f7f8', radius: 0.008, bake: ['+z'] })
    b.box('rubber', 0, 0.15, d + 0.006, w - 0.06, 0.2, 0.01, { color: '#2a2d31' })
    for (let i = 0; i < 7; i++) b.box('gloss', 0, 0.075 + i * 0.026, d + 0.012, w - 0.08, 0.008, 0.008, { color: '#e2e5e8' })
    b.box('steel', w / 2 - 0.07, 1.15, d + 0.045, 0.025, 0.42, 0.03, { radius: 0.01 })
    b.box('steel', w / 2 - 0.07, 1.36, d + 0.03, 0.02, 0.02, 0.03)
    b.box('steel', w / 2 - 0.07, 0.94, d + 0.03, 0.02, 0.02, 0.03)
    b.box('plastic', 0, h - 0.33, d + 0.026, 0.2, 0.13, 0.008, { color: '#0e2552', radius: 0.008 })
    b.decal(`disp${label}`, 0, h - 0.33, d + 0.0305, 0.17, 0.104, 0, 'screen', 1.5)
    b.decal('brand-thermo', -w / 2 + 0.1, h - 0.12, d + 0.0255, 0.1, 0.027)
    for (const sx of [-1, 1]) for (const sz of [0.08, d - 0.08]) b.cyl('rubber', sx * (w / 2 - 0.06), 0.02, sz, 0.02, 0.02, 0.04, { color: '#1a1b1d' })
    b.shadow(0, 0, d / 2, w, d, 0.6)
  },'plug'))
  ctx.occluder('cold', f.min, f.max)
  ctx.collider(f.min[0], f.min[2], f.max[0], f.max[2])
}

function coldRoom(ctx: LabCtx) {
  fumeHood(ctx)
  coldUnit(ctx, 'fridge-4', '+4')
  coldUnit(ctx, 'freezer-20', '-20')
  coldUnit(ctx, 'freezer-80', '-80')
  // Thermo heating oven ("hot box")
  onBench(ctx, 'cold-north', 0.28, 0.33, (b) => {
    b.box('gloss', 0, 0.23, 0, 0.47, 0.46, 0.5, { color: '#eef0f2', radius: 0.012 })
    b.box('gloss', -0.05, 0.22, 0.252, 0.33, 0.38, 0.012, { color: '#f4f5f6', radius: 0.006 })
    b.box('gloss', 0.175, 0.22, 0.252, 0.1, 0.38, 0.012, { color: '#2b5bc9', radius: 0.006 })
    b.decal('oven', 0.175, 0.33, 0.2585, 0.06, 0.035, 0, 'screen', 1.3)
    b.cyl('gloss', 0.175, 0.2, 0.262, 0.018, 0.018, 0.016, { color: '#e5e7eb', rx: Math.PI / 2 })
    b.box('steel', 0.1, 0.22, 0.27, 0.014, 0.16, 0.02, { radius: 0.006 })
    b.decal('brand-thermo', -0.12, 0.43, 0.2585, 0.1, 0.027)
    for (let i = 0; i < 8; i++) b.box('rubber', 0.12, 0.47, -0.18 + i * 0.03, 0.18, 0.004, 0.012, { color: '#3b3f45' })
    b.shadow(0, 0, 0, 0.47, 0.5, 0.6)
  })
  // water bath
  onBench(ctx, 'cold-north', 0.78, 0.34, (b) => {
    b.box('gloss', 0, 0.12, 0, 0.42, 0.24, 0.34, { color: '#e8eaec', radius: 0.02 })
    b.box('steel', 0, 0.245, -0.02, 0.36, 0.02, 0.26, { radius: 0.01 })
    b.box('steel', 0, 0.28, -0.02, 0.1, 0.03, 0.04, { radius: 0.01 })
    b.box('gloss', 0, 0.09, 0.171, 0.32, 0.1, 0.004, { color: '#1e4fb8', radius: 0.006 })
    b.decal('bath', -0.07, 0.1, 0.1735, 0.09, 0.034, 0, 'screen', 1.3)
    for (let i = 0; i < 3; i++) b.cyl('gloss', 0.04 + i * 0.035, 0.09, 0.175, 0.01, 0.01, 0.006, { color: i === 2 ? '#facc15' : '#e5e7eb', rx: Math.PI / 2 })
    b.shadow(0, 0, 0, 0.42, 0.34, 0.55)
  })
  benchOutlets(ctx, 'cold-north')
  plugIn(ctx, 'cold-north', 0.28, 0.33, 0.25, 0.08)
  plugIn(ctx, 'cold-north', 0.78, 0.34, 0.17, 0.05)
  // shelving along the east wall
  const rand = rng(57)
  for (const id of ['shelf-low-a', 'shelf-low-b', 'shelf-tall']) {
    const f = FIXTURES.find((x) => x.id === id)!
    const tall = id === 'shelf-tall'
    ctx.batch.cold.at((f.min[0] + f.max[0]) / 2, 0, (f.min[2] + f.max[2]) / 2, Math.PI / 2, () =>
      wireShelf(ctx.batch.cold, f.max[2] - f.min[2], f.max[0] - f.min[0], f.max[1], tall ? [0.12, 0.55, 0.98, 1.4, 1.84] : [0.12, 0.52, 1.0], true, rand),
    )
    ctx.batch.cold.shadow((f.min[0] + f.max[0]) / 2, 0, (f.min[2] + f.max[2]) / 2, f.max[0] - f.min[0], f.max[2] - f.min[2], 0.5)
    ctx.collider(f.min[0], f.min[2], f.max[0], f.max[2])
  }
  // window plant + sill items
  ctx.batch.cold.at(4.3 - 0.1, 1.08, -4.45, -Math.PI / 2, () => plant(ctx.batch.cold, 1.1))
  ctx.batch.cold.at(4.3 - 0.1, 1.08, -3.7, -Math.PI / 2, () => {
    bottle(ctx.batch.cold, 0, 0, 0.03, 0.1, '#1f5fd1')
    carton(ctx.batch.cold, 0.1, 0, 0.08, 0.07, 0.06)
  })
  // west wall: clock + safety boards + switch
  onWall(ctx, 'cold', 0.15, 2.2, -3.9, [1, 0], (b) => {
    b.cyl('rubber', 0, 0, 0.02, 0.17, 0.17, 0.04, { rx: Math.PI / 2, color: '#1b1c1f', seg: 32 })
    b.cyl('plastic', 0, 0, 0.041, 0.155, 0.155, 0.002, { rx: Math.PI / 2, color: '#ffffff', seg: 32 })
    b.roundDecal('clock', 0, 0, 0.0425, 0.3)
  })
  onWall(ctx, 'cold', 0.15, 1.55, -4.65, [1, 0], (b) => poster(b, 'labSafety', 0.36, 0.48))
  onWall(ctx, 'cold', 0.15, 1.55, -3.95 + 0.7, [1, 0], (b) => poster(b, 'emergency', 0.33, 0.44))
  onWall(ctx, 'cold', 0.15, 1.2, -2.45, [1, 0], (b) => wallPlate(b, 'switch'))
  onWall(ctx, 'cold', 3.55, 1.2, -1.95, [0, -1], (b) => wallPlate(b, 'switch'))
}

function hallway(ctx: LabCtx) {
  onWall(ctx, 'hall', -4.5, 1.55, -1.55, [-1, 0], (b) => poster(b, 'roomSign', 0.3, 0.158))
  onWall(ctx, 'hall', -4.5, 1.25, -2.1, [-1, 0], (b) => soapDispenser(b))
  // handwash basin on the way out of Post-PCR
  onWall(ctx, 'hall', -4.5, 0, -2.15, [-1, 0], (b) => {
    b.box('steel', 0, 0.85, 0.2, 0.46, 0.06, 0.36, { radius: 0.01 })
    b.box('steel', 0, 0.65, 0.04, 0.28, 0.38, 0.05)
    b.cyl('chrome', 0, 1.0, 0.09, 0.012, 0.012, 0.2, { rx: Math.PI / 2 })
  })
  ctx.collider(-4.88, -2.38, -4.5, -1.92)
  // west wall north of the opening to the hub
  onWall(ctx, 'hall', -6.5, 1.45, -2.9, [1, 0], (b) => {
    b.box('frame', 0, 0, 0.015, 1.1, 0.8, 0.03, { color: '#9aa0a6' })
    b.decal('notice', 0, 0, 0.0305, 1.04, 0.74)
  })
  onWall(ctx, 'hall', -6.5, 0.0, -4.1, [1, 0], (b) => {
    b.box('gloss', 0, 0.95, 0.09, 0.32, 0.7, 0.18, { color: '#f2f2f0', radius: 0.01 })
    b.cyl('gloss', 0, 0.9, 0.12, 0.07, 0.07, 0.42, { color: '#c81e1e' })
    b.cyl('rubber', 0, 1.15, 0.12, 0.03, 0.04, 0.08, { color: '#111' })
    b.plane('glass', 0, 0.95, 0.182, 0.26, 0.6)
  })
  onWall(ctx, 'hall', -4.5, 1.2, -1.3, [-1, 0], (b) => wallPlate(b, 'switch'))
  onWall(ctx, 'hall', -4.85, 1.5, 0.9, [-1, 0], (b) => poster(b, 'labSafety', 0.36, 0.48))
}

export function buildProps(ctx: LabCtx) {
  mainRoom(ctx)
  postRoom(ctx)
  coldRoom(ctx)
  hallway(ctx)
  for (const c of CHAIRS) ctx.batch[c.zone].at(c.x, 0, c.z, c.yaw, () => chair(ctx.batch[c.zone], ctx))
  const trash = FIXTURES.find((f) => f.id === 'trash')!
  ctx.collider(trash.min[0], trash.min[2], trash.max[0], trash.max[2])
  ctx.occluder('main', trash.min, trash.max)
  const bin = FIXTURES.find((f) => f.id === 'etbr-bin')!
  ctx.occluder('post', bin.min, bin.max)
  const cart = FIXTURES.find((f) => f.id === 'shelf-cart')!
  ctx.collider(cart.min[0], cart.min[2], cart.max[0], cart.max[2])
}

// Development check of the bench's vessel looks (E17). Never imported by the app or the add-on.
// Each vessel is mixed by the real kernel (ionic model in Rust, surface reactions, gases), turned
// into the look the session gives the bench, and drawn by the bench's own vessel builder.
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { addSupply, createKernel, emptyWorld, lookOf } from '../packages/lab-core/src/index.ts'
import { appearance } from '../packages/lab-core/src/models/measurement.ts'
import { catalogue } from '../src/runtime/content'
import { colourHex } from '../src/runtime/present'
import { initialiseRustScience } from '../src/runtime/rustScience'
import { buildGlassVessel, buildMicroTube, type GlassShape, type VesselLook } from '../src/three/labModels'

type Step = [op: string, params: Record<string, unknown>]
const SHAPES: Array<[GlassShape, number]> = [['beaker', 130], ['conical-flask', 125], ['test-tube', 20], ['boiling-tube', 50], ['round-bottom-flask', 110], ['conical-tube', 15], ['beaker', 130], ['volumetric-flask', 100], ['conical-flask', 125], ['cuvette', 4]]
interface Case { label: string; supplies: Array<[id: string, substance: string, conc: string]>; steps: Step[] }
const pour = (source: string, volume: string): Step => ['core:transfer', { source, destination: 'v', volume, tool: 'pour' }]
const CASES: Case[] = [
  { label: 'water', supplies: [['w', 'core:sodium-chloride', '0 mol/L']], steps: [pour('w', '30 mL')] },
  { label: 'copper(II) sulfate 0.5 M', supplies: [['cu', 'aq:copper-ii-sulfate', '0.5 mol/L']], steps: [pour('cu', '30 mL')] },
  { label: 'with a little NaOH', supplies: [['cu', 'aq:copper-ii-sulfate', '0.1 mol/L'], ['oh', 'aq:sodium-hydroxide', '1 mol/L']], steps: [pour('cu', '30 mL'), pour('oh', '3 mL'), ['core:mix', { container: 'v', method: 'swirl', cycles: 3 }]] },
  { label: '… left 20 min', supplies: [['cu', 'aq:copper-ii-sulfate', '0.1 mol/L'], ['oh', 'aq:sodium-hydroxide', '1 mol/L']], steps: [pour('cu', '30 mL'), pour('oh', '3 mL'), ['core:mix', { container: 'v', method: 'swirl', cycles: 3 }], ['core:advance-time', { duration: '20 min' }]] },
  { label: 'excess ammonia', supplies: [['cu', 'aq:copper-ii-sulfate', '0.05 mol/L'], ['nh3', 'aq:ammonia', '2 mol/L']], steps: [pour('cu', '25 mL'), pour('nh3', '10 mL'), ['core:mix', { container: 'v', method: 'swirl', cycles: 3 }]] },
  { label: 'silver chloride', supplies: [['ag', 'aq:silver-nitrate', '0.05 mol/L'], ['cl', 'aq:sodium-chloride', '0.1 mol/L']], steps: [pour('ag', '20 mL'), pour('cl', '10 mL'), ['core:mix', { container: 'v', method: 'swirl', cycles: 3 }]] },
  { label: 'lead iodide', supplies: [['pb', 'aq:lead-ii-nitrate', '0.05 mol/L'], ['i', 'aq:potassium-iodide', '0.1 mol/L']], steps: [pour('pb', '20 mL'), pour('i', '20 mL'), ['core:mix', { container: 'v', method: 'swirl', cycles: 3 }]] },
  { label: 'iron(III) thiocyanate', supplies: [['fe', 'aq:iron-iii-nitrate', '0.002 mol/L'], ['h', 'aq:nitric-acid', '0.2 mol/L'], ['scn', 'aq:potassium-thiocyanate', '0.02 mol/L']], steps: [pour('fe', '15 mL'), pour('h', '5 mL'), pour('scn', '15 mL'), ['core:mix', { container: 'v', method: 'swirl', cycles: 3 }]] },
  { label: 'magnesium in acid', supplies: [['hcl', 'aq:hydrochloric-acid', '1 mol/L']], steps: [pour('hcl', '30 mL'), ['core:add-solid', { substance: 'aq:magnesium-ribbon', destination: 'v', mass: '0.15 g' }], ['core:advance-time', { duration: '5 s' }]] },
  { label: 'zinc in CuSO₄, 10 min', supplies: [['cu', 'aq:copper-ii-sulfate', '0.2 mol/L']], steps: [pour('cu', '30 mL'), ['core:add-solid', { substance: 'aq:zinc-powder', destination: 'v', mass: '1 g' }], ['core:mix', { container: 'v', method: 'swirl', cycles: 3 }], ['core:advance-time', { duration: '10 min' }]] },
]

async function start() {
  const status = document.getElementById('status')!
  await initialiseRustScience()
  const cat = catalogue().catalogue
  const looks: Array<{ label: string; color: string; fill: number; look?: VesselLook; note: string }> = []
  const only = new URL(location.href).searchParams.get('cases')?.split(',').map(Number)
  for (const c of only ? only.map((i) => CASES[i]) : CASES) {
    const w = emptyWorld(1)
    for (const [id, substance, conc] of c.supplies) addSupply(w, cat, { id, label: id, container: 'core:reagent-bottle-250ml', amount: '200 mL', components: [{ substance, conc }] })
    const k = createKernel(cat, w)
    const run = (op: string, params: Record<string, unknown>) => {
      const r = k.execute({ op, params })
      if (!r.ok) throw new Error(`${c.label}: ${op}: ${r.refusal.message}`)
    }
    run('core:fetch', { equipment: 'core:beaker-100ml', id: 'v' })
    for (const [op, params] of c.steps) run(op, params)
    const v = k.world.containers.v
    const look = lookOf(cat, v).look
    const a = appearance(cat, v, 1.5)
    const colourless = a?.liquidName === 'colourless' && (look?.clarity ?? 1) > 0.9
    const color = look && !colourless ? look.liquid : colourHex('colourless')
    looks.push({ label: c.label, color, fill: v.contents.layers.reduce((s, l) => s + l.volumeL, 0) / 0.05, look, note: `${a?.liquidName ?? ''}${a?.precipitate ? `, ${a.precipitate.name} solid` : ''}${look?.bubbling ? `, bubbling ${look.bubbling.toFixed(2)}` : ''}` })
  }
  const canvas = document.getElementById('view') as HTMLCanvasElement
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#e9ebec')
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture
  const key = new THREE.DirectionalLight('#ffffff', 1.6)
  key.position.set(0.3, 1, 0.8)
  scene.add(key, new THREE.AmbientLight('#ffffff', 0.4))
  const bench = new THREE.Mesh(new THREE.BoxGeometry(1, 0.01, 0.2), new THREE.MeshStandardMaterial({ color: '#3a3f44', roughness: 0.8 }))
  bench.position.y = -0.005
  scene.add(bench)
  const pitch = 0.085
  const animated: THREE.Group[] = []
  looks.forEach((l, i) => {
    // Each case in a different piece of the bench's glassware, filled to 70 % of it.
    const [shape, capacity] = SHAPES[i % SHAPES.length]
    const g = buildGlassVessel(shape, capacity)
    ;(g.userData.setContents as (ml: number, c: string, look?: VesselLook) => void)(capacity * 0.7, l.color, l.look)
    g.position.x = (i - (looks.length - 1) / 2) * pitch
    scene.add(g)
    if (g.userData.animate) animated.push(g)
    // The same contents in a micro tube, as the bench's rack shows them (scaled up to be seen).
    const t = buildMicroTube(l.color, 0.85)
    ;(t.userData.setFill as (v: number, c: string, look?: VesselLook) => void)(0.85, l.color, l.look)
    t.scale.setScalar(1.6)
    t.position.set(g.position.x + 0.03, 0, 0.05)
    scene.add(t)
    if (t.userData.animate) animated.push(t)
  })
  for (const g of animated) (g.userData.animate as (t: number) => boolean)(1.37)
  const camera = new THREE.PerspectiveCamera(32, canvas.clientWidth / canvas.clientHeight, 0.01, 10)
  camera.position.set(0, 0.11, 0.08 + looks.length * 0.085)
  camera.lookAt(0, 0.05, 0.02)
  renderer.render(scene, camera)
  const labels = document.getElementById('labels')!
  labels.innerHTML = looks.map((l) => `<div><b>${l.label}</b><br>${l.note}</div>`).join('')
  status.textContent = 'ready'
  document.body.dataset.ready = 'true'
}
start().catch((e) => {
  document.getElementById('status')!.textContent = String(e?.stack ?? e)
  document.body.dataset.ready = 'error'
})

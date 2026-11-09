// Isolated prototype. Never imported by the production app or add-on entry.
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { LabWorld } from '../src/three/lab/world'
import { PRESETS } from '../src/three/quality'
import { distribution } from '../src/three/lab/performance'

async function start() {
  const status = document.getElementById('status')!
  const source = document.getElementById('reference')!, target = document.getElementById('candidate')!
  const world = await LabWorld.create({ ...PRESETS.low, antialias: 'off', refine: false, fpsCap: 0 }, () => {})
  world.attach(source)
  await new Promise<void>(resolve => world.whenReady(resolve))
  world.setMode('walk')
  world.setView({ x: 2.8, y: 1.4, z: 0.7 }, { x: -4.4, y: 1.27, z: 0.7 })
  await new Promise<void>(resolve => {
    const check = () => { if (world.debugInfo().bake.main === 'final') resolve(); else setTimeout(check, 100) }; check()
  })
  await new Promise(resolve => setTimeout(resolve, 1000))
  world.detach()
  source.append(world.renderer.domElement)
  // BatchedMesh has renderer-managed buffers: cloning its Object3D is not a valid
  // asset snapshot. Reuse the same frozen scene with independent renderer caches.
  const scene = world.scene, camera = world.camera.clone()
  const patched = new Set<string>()
  scene.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const inspect = (material: THREE.Material) => {
      if (material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) patched.add(mesh.name || material.type)
    }
    if (Array.isArray(mesh.material)) mesh.material.forEach(inspect)
    else inspect(mesh.material)
  })
  const forceWebGL = new URL(location.href).searchParams.has('forceWebGL')
  const candidate = new WebGPURenderer({ antialias: false, forceWebGL })
  const initStarted = performance.now()
  await candidate.init()
  const initMs = performance.now() - initStarted
  candidate.setPixelRatio(1)
  candidate.setSize(source.clientWidth, source.clientHeight)
  candidate.outputColorSpace = THREE.SRGBColorSpace
  candidate.toneMapping = THREE.NeutralToneMapping
  candidate.toneMappingExposure = world.renderer.toneMappingExposure
  target.append(candidate.domElement)
  // Both paths use the same frozen geometry, textures, camera and lights. Existing GLSL
  // hooks and custom grading remain documented parity blockers, not silently accepted.
  world.renderer.render(scene, camera)
  candidate.render(scene, camera)
  const blockers = [
    `${patched.size} mesh/material uses require TSL equivalents for existing shader hooks.`,
    'Candidate uses Neutral tone mapping; production custom grading is not ported.',
    'Effects are disabled for both; production EffectComposer parity is not demonstrated.',
    'No production backend promotion is permitted by this prototype alone.',
  ]
  const run = async (seconds = 5) => {
    const results = []
    for (const [name, renderer] of [['webgl2', world.renderer], [forceWebGL ? 'webgpu-webgl2-fallback' : 'webgpu-auto', candidate]] as const) {
      for (let i = 0; i < 30; i++) { await new Promise(requestAnimationFrame); renderer.render(scene, camera) }
      const cpu: number[] = [], intervals: number[] = [], rows: number[][] = []
      const end = performance.now() + seconds * 1000
      let last: number | undefined
      while (performance.now() < end) {
        const now = await new Promise<number>(requestAnimationFrame)
        if (last !== undefined) intervals.push(now - last)
        last = now
        const started = performance.now()
        renderer.render(scene, camera)
        const duration = performance.now() - started
        cpu.push(duration); rows.push([now, duration])
      }
      results.push({ name, cpuSubmissionMs: distribution(cpu), frameIntervalMs: distribution(intervals), rows })
    }
    return { schema: 'lab-renderer-spike/1', forceWebGL, initMs, viewport: { width: source.clientWidth, height: source.clientHeight }, blockers, results }
  }
  ;(window as unknown as { __rendererSpike: unknown }).__rendererSpike = { run, blockers, initMs }
  status.textContent = `Candidate initialised in ${initMs.toFixed(1)} ms. Click either view to inspect the shared mesh.\n${blockers.join('\n')}`
  for (const canvas of [world.renderer.domElement, candidate.domElement]) canvas.addEventListener('pointerdown', event => {
    const box = canvas.getBoundingClientRect(), ray = new THREE.Raycaster()
    ray.setFromCamera(new THREE.Vector2((event.clientX - box.left) / box.width * 2 - 1, 1 - (event.clientY - box.top) / box.height * 2), camera)
    status.textContent = `Selected: ${ray.intersectObjects(scene.children, true)[0]?.object.name ?? 'no object'}\n${blockers.join('\n')}`
  })
  window.addEventListener('pagehide', () => { candidate.dispose(); world.dispose() }, { once: true })
}
void start().catch(error => { document.getElementById('status')!.textContent = String(error); console.error(error) })

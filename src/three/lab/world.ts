// Persistent laboratory runtime.
//
// One renderer, scene, baked lab, set of probes and compiled shaders live for
// as long as graphics settings stay compatible; station views only attach the
// canvas, add their own objects and move the camera. Rendering is on demand:
// an idle view costs no GPU time at all.
import * as THREE from 'three/webgpu'
import { Fn, neutralToneMapping, mix } from 'three/tsl'
import { GpuPipeline, needsPipeline, passLayout, supported, type PassLayout } from './gpuPipeline'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { DEV } from '../../env'
import { BAKE_QUALITY, rebuildKey, type GraphicsSettings } from '../quality'
import { buildLab, type LabBuild } from './build'
import { LAMP_VIEW } from './kit'
import { BakeRunner, applyBake, bakeJob } from './bakeRunner'
import { inputFingerprint, loadBakedLighting } from './bakedLighting'
import type { BakeResult } from './bake'
import { captureProbe } from './lighting'
import { Nav } from './nav'
import { ChairMover, type ChairDirection } from './chairs'
import type { Seat } from './context'
import { SEATED_EYE_HEIGHT, WALK_EYE_HEIGHT, ZONES, ZONE_IDS, type ZoneId } from './layout'
import { RoomLighting } from './roomLighting'
import { EnvironmentInteractions, type InteractionPrompt } from './interactions'
import type { EnvironmentNotice } from '../../runtime/environment'
import { EXTERIOR_FAR, EXTERIOR_WINDOWS, addRoomsSeenFromOutside, exteriorVisible } from './exterior'
import { FrameCapture } from './performance'
import { decodesSettled } from './decodes'

export type CameraMode = 'walk' | 'free'
export type LookMode = 'drag' | 'follow'
export type SeatAction = 'sit' | 'stand' | 'pull' | null

/** Loading-screen progress: what the world is preparing, and how far along. */
export interface PrepareProgress {
  stage: 'textures' | 'lighting' | 'reflections' | 'shaders' | 'ready'
  done: number
  total: number
}

export interface WorldStats {
  fps: number
  ms: number
  calls: number
  triangles: number
  scale: number
  zone: string
  /** nothing changed recently, so nothing was rendered */
  idle: boolean
}

// ── stats store (read by the performance overlay) ──────────────────────────
let currentStats: WorldStats = { fps: 0, ms: 0, calls: 0, triangles: 0, scale: 1, zone: '', idle: true }
const statListeners = new Set<() => void>()
export const statsStore = {
  subscribe(cb: () => void) {
    statListeners.add(cb)
    return () => statListeners.delete(cb)
  },
  get: () => currentStats,
}
/** Let the page paint (the loading screen's progress) between preparation steps. */
const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** The next animation frame (three advances its node frame there); a hidden page falls back to a timeout. */
const nextAnimationFrame = () => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, 200)
  requestAnimationFrame(() => { clearTimeout(timer); resolve() })
})

function publishStats(s: WorldStats) {
  currentStats = s
  statListeners.forEach((cb) => cb())
}

const WALK_SPEED = 1.45
const FLY_SPEED = 3.3
const EYE_MIN = 1.15
const EYE_MAX = WALK_EYE_HEIGHT
const WALK_FOV = 52
const FREE_FOV = 58
/** Holding right mouse narrows the view to about 2.3× magnification, for labels and displays. */
const CLOSER_FOV = 24
const CLOSER_SECONDS = 0.16

/**
 * Tone curve for every tier: Khronos PBR Neutral (white casework stays white,
 * accent colours stay true), then a gentle S-curve around display mid-grey
 * that deepens the darks like a photograph. As the custom tone map it runs per
 * material when Medium draws straight to the canvas, and in OutputPass when a
 * composer runs, so all tiers share one grade.
 */
// calibrated against the look target's luma bands (2026-10-27)
const EXPOSURE = 0.58
const CONTRAST = 0.1
/** A panel counts towards glare within this cosine of the view's centre (about 28°). */
const GLARE_CONE = 0.88
/**
 * Glare from the panels' weighted solid angle. Looking up is limited to about
 * 40°, so a centred panel is at least ~1.9 away: that view is about 0.8.
 */
const GLARE_GAIN = 7
/** How far the view stops down when glare is full. */
const GLARE_STOP = 0.4

export interface AttachOptions {
  onPick?: (ndc: THREE.Vector2) => void
  onSeatAction?: (action: SeatAction) => void
  onInteraction?: (prompt: InteractionPrompt | null) => void
  onNotice?: (notice: EnvironmentNotice) => void
  onLookActive?: (active: boolean) => void
  machineGuard?: (kind: string) => string | undefined
  onSettingsOpen?: (open: boolean) => void
}

export class LabWorld {
  readonly key: string
  readonly renderer: THREE.WebGPURenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly lab: LabBuild
  readonly nav: Nav
  readonly chairMover: ChairMover
  readonly interactions: EnvironmentInteractions
  lookMode: LookMode = 'drag'
  lookActive = false
  settingsOpen = false
  private tabHeld = false
  private resumeOnEnter = false
  private pointerOver = false
  private unlocking = false
  private relockAfterUnlock = false
  private onSettingsOpen?: (open: boolean) => void
  private onLookActive?: (active: boolean) => void
  private pointerNdc: THREE.Vector2 | null = null
  private hoverDirty = false
  private lastHover = 0
  settings: GraphicsSettings

  // player
  mode: CameraMode = 'walk'
  readonly player = new THREE.Vector3(0, WALK_EYE_HEIGHT, 0)
  yaw = 0
  pitch = 0
  private pressed = new Set<string>()
  private looking = false
  /** Right mouse held: look closer. `closer` eases 0 → 1 toward the narrow view. */
  private closerHeld = false
  private closer = 0
  private occupiedSeat: Seat | null = null
  private standingPosition = new THREE.Vector3()
  private seatAction: SeatAction = null
  private onSeatAction?: AttachOptions['onSeatAction']

  // runtime
  private container: HTMLElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private raf = 0
  private last = 0
  private lastRender = 0
  private needsRender = true
  private shadowDirty = true
  private frameHooks = new Set<(dt: number, t: number) => boolean>()
  private refineFrames = 0
  private performanceCapture: FrameCapture | null = null
  private performanceDrawMs = 0
  private detachInput: (() => void) | null = null
  private zone: ZoneId | null = 'main'
  private frustum = new THREE.Frustum()
  private projScreen = new THREE.Matrix4()
  private dynScale = 1
  private avgMs = 16.7
  private slowSince = 0
  private slowSinceRes = 0
  private fastSince = 0
  /** set when a frame did one-off heavy work (probe capture) */
  private spike = false
  private statFrames = 0
  private statTime = 0
  private statCalls = 0
  private statTris = 0
  private onSlow: () => void
  refs = 0
  disposeTimer: ReturnType<typeof setTimeout> | null = null
  disposed = false

  // lighting
  private pmrem: THREE.PMREMGenerator
  private fallbackEnv: THREE.RenderTarget
  private roomFallbackEnv: THREE.RenderTarget
  private roomLighting: RoomLighting
  private probes: Partial<Record<ZoneId, THREE.RenderTarget>> = {}
  private bakeState: Partial<Record<ZoneId, 'final'>> = {}
  private baker = new BakeRunner()
  private spot: THREE.SpotLight | null = null

  // post: the scene-pass layout is fixed for the world's lifetime (see GpuPipeline)
  private composer: GpuPipeline | null = null
  private readonly layout: PassLayout
  private readonly pipelined: boolean
  private nextDue = 0

  private born = performance.now()
  private log(msg: string) {
    this.bakeLog.push(`${Math.round(performance.now() - this.born)} ${msg}`)
  }

  static async create(settings: GraphicsSettings, onSlow: () => void) {
    const renderer = new THREE.WebGPURenderer({
      // The node pipeline multisamples its own scene pass; canvas MSAA would be wasted.
      antialias: (settings.antialias === 'msaa4' || settings.antialias === 'msaa8') && !needsPipeline(settings),
      powerPreference: 'high-performance', stencil: false, depth: true,
      forceWebGL: DEV && (globalThis as { __labForceWebGL?: boolean }).__labForceWebGL === true,
    })
    await renderer.init()
    try { return new LabWorld(settings, onSlow, renderer) }
    catch (error) { renderer.dispose(); throw error }
  }

  private constructor(requested: GraphicsSettings, onSlow: () => void, renderer: THREE.WebGPURenderer) {
    // the app compares keys of the settings it asked for; the world runs what the backend can
    this.key = rebuildKey(requested)
    const settings = supported(requested, renderer)
    this.settings = settings
    this.onSlow = onSlow
    this.layout = passLayout(settings)
    this.pipelined = needsPipeline(settings)
    this.renderer = renderer
    const r = this.renderer
    r.outputColorSpace = THREE.SRGBColorSpace
    r.toneMapping = THREE.CustomToneMapping
    r.toneMappingExposure = EXPOSURE
    r.info.autoReset = false
    r.shadowMap.enabled = settings.shadows !== 'off'
    r.shadowMap.type = THREE.PCFShadowMap
    r.domElement.tabIndex = 0
    r.domElement.setAttribute('aria-label', 'Interactive 3D Molecular Biology laboratory')
    r.domElement.classList.add('lab-canvas')
    // Error checks force each program to finish compiling synchronously.
    ;(r.library as unknown as { addToneMapping(fn: unknown, mode: number): void }).addToneMapping(Fn(([rgb, exposure]: [THREE.Node<'vec3'>, THREE.Node<'float'>]) => {
      const c = (neutralToneMapping(rgb, exposure) as THREE.Node<'vec3'>).clamp().pow(1 / 2.2)
      return mix(c, c.mul(c).mul(c.mul(-2).add(3)), CONTRAST).pow(2.2)
    }), THREE.CustomToneMapping)
    r.onDeviceLost = info => { if (!this.disposed && !this.failed) this.stopWithError(new Error(`Graphics device lost: ${info.message}`)) }
    // Three filters the 'destroyed' reason. An unexpected destroy while this
    // world is live must still stop rendering and expose recovery. Our own
    // disposal marks the world disposed before releasing its GPU resources.
    const device = (r.backend as unknown as { device?: { lost: Promise<{ message: string }> } }).device
    void device?.lost.then(info => {
      if (!this.disposed && !this.failed) this.stopWithError(new Error(`Graphics device lost: ${info.message || 'Device destroyed'}`))
    })
    r.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); if (!this.disposed) this.stopWithError(new Error('Graphics context lost')) })

    this.scene.background = new THREE.Color('#2a2f38')
    this.camera = new THREE.PerspectiveCamera(WALK_FOV, 16 / 10, 0.03, EXTERIOR_FAR)

    this.pmrem = new THREE.PMREMGenerator(r)
    this.fallbackEnv = this.pmrem.fromScene(new RoomEnvironment(), 0.04)
    this.scene.environment = this.fallbackEnv.texture
    this.scene.environmentIntensity = 0.9

    // Decodes finish before prepare() captures reflections, so nothing re-captures later.
    this.lab = buildLab({ textures: settings.textures, lighting: settings.lighting, detail: settings.detail, onExteriorReady: () => {
      if (!this.disposed) this.requestRender()
    } })
    this.scene.add(this.lab.root)
    this.nav = new Nav(this.lab.ctx.colliders)
    this.interactions = new EnvironmentInteractions(this.lab)
    this.chairMover = new ChairMover(this.lab.root, this.nav, this.lab.ctx.seats, this.lab.doors)
    // A room's reflections before its probe exists, which is what the other
    // rooms' captures see in it: a dim, neutral room (about a lit wall's
    // radiance). The studio fallback made every metal frame glow in the probes,
    // and so in the floors (a bright line round each doorway).
    const neutral = new THREE.Scene()
    neutral.background = new THREE.Color().setScalar(0.3)
    this.roomFallbackEnv = this.pmrem.fromScene(neutral, 0)
    this.roomLighting = new RoomLighting(this.roomFallbackEnv.texture)
    for (const id of ZONE_IDS) {
      const m = this.lab.shellMats[id]
      this.roomLighting.register(id, [m.wall, m.floor, m.ceiling, m.cove, ...Object.values(m.casework)])
      this.roomLighting.watch(id, this.lab.zones[id])
    }
    // a door leaf takes the light of the room it swings into, its push side that of the room it faces
    for (const rt of this.lab.doors) {
      this.roomLighting.watch(rt.def.swingInto, rt.leaf)
      this.roomLighting.watch(rt.pushInto, rt.pushFaces)
    }

    // Direct light for everything that is not baked (instruments, props). Baked
    // surfaces strip direct light in their shader, so nothing is lit twice.
    // Room probes supply local ceiling illumination at every tier. A fixed
    // fill replaces the camera-following pool, which relit adjacent rooms.
    {
      const key = new THREE.DirectionalLight(0xffffff, 0.55)
      key.position.set(0.4, 3, 0.6)
      key.target.position.set(0, 0, 0)
      this.scene.add(key, key.target)
    }

    if (settings.shadows !== 'off') {
      const spot = new THREE.SpotLight(0xffffff, 1.2, 3.2, 0.55, 1, 2)
      spot.castShadow = true
      const size = settings.shadows === 'high' ? 2048 : 1024
      spot.shadow.mapSize.set(size, size)
      spot.shadow.bias = -0.0002
      spot.shadow.normalBias = 0.02
      spot.shadow.radius = settings.shadows === 'high' ? 6 : 3
      spot.shadow.camera.near = 0.3
      spot.shadow.camera.far = 4.5
      // re-rendered only when something it lights moves (see draw)
      spot.shadow.autoUpdate = false
      this.scene.add(spot, spot.target)
      this.spot = spot
    }

    this.log('constructed')
    this.setLive(settings)
    this.warming = this.prepare().catch(error => { if (!this.disposed) this.stopWithError(error) })
  }

  // ── preparation (behind the loading screen) ─────────────────────────────

  /** resolves once every room is lit, has its reflections and has its shaders compiled */
  ready = false
  private readyCallbacks: (() => void)[] = []
  private warming: Promise<void> = Promise.resolve()
  progress: PrepareProgress = { stage: 'textures', done: 0, total: 1 }
  private progressListeners = new Set<(p: PrepareProgress) => void>()
  prepareMs = 0
  whenReady(cb: () => void) {
    if (this.ready) cb()
    else this.readyCallbacks.push(cb)
  }

  /** Follow the loading stages; called at once with the current stage. */
  onProgress(fn: (p: PrepareProgress) => void) {
    this.progressListeners.add(fn)
    fn(this.progress)
    return () => { this.progressListeners.delete(fn) }
  }

  private setProgress(stage: PrepareProgress['stage'], done: number, total: number) {
    this.progress = { stage, done, total }
    for (const fn of this.progressListeners) fn(this.progress)
  }

  /**
   * Everything the lab needs happens here, once, while the loading screen is
   * up: decoded textures, every room's lightmap and reflections, and every
   * object's first draw (its node build, pipeline and bindings) through the
   * frame's own pipeline. Walking around afterwards bakes, captures, uploads
   * and compiles nothing.
   */
  private async prepare() {
    const started = performance.now()
    this.setProgress('textures', 0, 1)
    await decodesSettled()
    if (this.disposed) return
    this.log('textures decoded')
    await this.bakeAll()
    if (this.disposed) return
    // Reflections before shaders, so materials compile with their final probes.
    for (const [i, zone] of ZONE_IDS.entries()) {
      this.setProgress('reflections', i, ZONE_IDS.length)
      await yieldToPage()
      if (this.disposed) return
      this.captureRoomProbe(zone)
    }
    this.log('probes captured')
    // Frames draw the scene pass nested inside the post-processing pipeline,
    // whose render objects compileAsync (which works at the top call depth)
    // never creates; measured, it only added time. So the frame loop itself
    // draws every room once, from its probe point with culling off.
    if (this.raf) {
      await this.warmRooms(ZONE_IDS, true)
      if (this.disposed) return
      this.log('rooms drawn once')
    }
    this.prepareMs = Math.round(performance.now() - started)
    this.log(`prepared in ${this.prepareMs} ms`)
    this.ready = true
    this.setProgress('ready', 1, 1)
    this.readyCallbacks.splice(0).forEach((cb) => cb())
    this.requestRender()
  }

  /**
   * Light every room: from the shipped offline bake where it still matches the
   * room as built, otherwise (a layout changed since `npm run bake`) by baking
   * it now on the worker pool with fallback sampling.
   */
  private async bakeAll() {
    const t0 = performance.now()
    let done = 0
    this.setProgress('lighting', 0, ZONE_IDS.length)
    const shipped = await loadBakedLighting()
    if (this.disposed) return
    const stale: ZoneId[] = []
    await Promise.all(ZONE_IDS.map(async (zone) => {
      const job = bakeJob(this.lab, zone, 'runtime')
      const room = shipped.get(`${zone}|${inputFingerprint(job)}`)
      let r: BakeResult
      if (room && room.atlasW === job.atlasW && room.atlasH === job.atlasH) {
        r = { id: zone, atlas: room.atlas, volume: room.volume?.data, timing: { texels: 0, texelMs: 0 } }
      } else {
        stale.push(zone)
        r = await this.baker.run(job)
        if (this.disposed) return
      }
      applyBake(this.lab, zone, r)
      const v = job.volume
      if (v && r.volume) this.roomLighting.setVolume(zone, r.volume, { x: v.origin[0], y: v.origin[1], z: v.origin[2] }, v.cell, { x: v.nx, y: v.ny, z: v.nz })
      this.bakeState[zone] = 'final'
      this.bakeTiming[zone] = r.timing
      this.setProgress('lighting', ++done, ZONE_IDS.length)
    }))
    this.bakeMs = Math.round(performance.now() - t0)
    this.log(`lit ${ZONE_IDS.length - stale.length} rooms from the shipped bake, baked ${stale.length} here in ${this.bakeMs} ms${stale.length ? ` (${stale.join(', ')}; run npm run bake)` : ''}`)
  }

  /** Set while the frame loop draws one room for warming (see warmRoom). */
  private warmZone: ZoneId | null = null
  /** set by draw() once the warming room has really been drawn */
  private warmDrawn = false

  /**
   * Draw rooms once each through the frame loop (then return to the player's
   * view). A station opened in an already prepared lab warms its rooms like
   * this before the overlay lifts, so its new objects never stall a frame.
   */
  async warmRooms(zones: readonly ZoneId[], report = false) {
    if (!this.raf || this.disposed) return
    for (const [i, zone] of zones.entries()) {
      if (report) this.setProgress('shaders', i, zones.length)
      await this.warmRoom(zone)
      if (this.disposed) return
    }
    this.applyView()
  }

  /**
   * Have the frame loop draw one room, from its probe point with culling off,
   * so nothing in it is drawn for the first time while someone walks in.
   * Resolves once a frame has drawn it (the frame-rate cap does not apply).
   */
  private async warmRoom(zone: ZoneId) {
    const culled: THREE.Object3D[] = []
    const uncull = (o: THREE.Object3D) => {
      if (o.frustumCulled) {
        o.frustumCulled = false
        culled.push(o)
      }
    }
    this.lab.zones[zone].traverse(uncull)
    // its door leaves too: they live outside the room's group
    for (const rt of this.lab.doors) if (rt.def.a === zone || rt.def.b === zone) rt.pivot.traverse(uncull)
    this.warmZone = zone
    this.warmDrawn = false
    this.requestRender()
    try {
      for (let i = 0; i < 30 && !this.warmDrawn && !this.disposed; i++) {
        this.requestRender()
        await nextAnimationFrame()
      }
    } finally {
      for (const o of culled) o.frustumCulled = true
      this.warmZone = null
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  attach(container: HTMLElement, opts: AttachOptions = {}) {
    this.container = container
    container.appendChild(this.renderer.domElement)
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
    this.interactions.onPrompt = opts.onInteraction
    this.interactions.onNotice = opts.onNotice
    this.interactions.guard = opts.machineGuard
    this.onLookActive = opts.onLookActive
    this.onSettingsOpen = opts.onSettingsOpen
    this.settingsOpen = false
    opts.onSettingsOpen?.(false)
    this.detachInput = this.bindInput(opts)
    this.onSeatAction = opts.onSeatAction
    this.updateSeatAction()
    opts.onSeatAction?.(this.seatAction)
    this.last = performance.now()
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(this.tick)
    this.requestRender()
  }

  detach() {
    this.interactions.clear()
    this.interactions.onPrompt = undefined
    this.interactions.onNotice = undefined
    this.interactions.guard = undefined
    this.onLookActive = undefined
    this.onSettingsOpen = undefined
    this.settingsOpen = false
    this.tabHeld = false
    this.resumeOnEnter = false
    this.pointerOver = false
    this.relockAfterUnlock = false
    this.unlocking = false
    this.lookActive = false
    this.renderer.domElement.style.cursor = ''
    document.documentElement.classList.remove('lab-mouse-look')
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock()
    this.pointerNdc = null
    this.onSeatAction = undefined
    this.standUp()
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.detachInput?.()
    this.detachInput = null
    this.pressed.clear()
    this.looking = false
    this.closerHeld = false
    this.closer = 0
    this.applyFov()
    if (this.container && this.renderer.domElement.parentElement === this.container) this.container.removeChild(this.renderer.domElement)
    this.container = null
  }

  dispose() {
    this.performanceCapture = null
    if (this.disposed) return
    this.disposed = true
    this.detach()
    this.baker.dispose()
    this.readyCallbacks = []
    // An abandoned quality/station build may still be compiling pipelines. Freeing
    // texture caches during compileAsync leaves live backend allocations orphaned.
    void this.warming.then(() => this.disposeGraphics())
  }

  private disposeGraphics() {
    this.interactions.dispose()
    this.chairMover.dispose()
    this.composer?.dispose()
    this.roomLighting.dispose()
    for (const p of Object.values(this.probes)) p?.dispose()
    this.fallbackEnv.dispose()
    this.roomFallbackEnv.dispose()
    this.pmrem.dispose()
    this.lab.dispose()
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      m.geometry.dispose()
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      mats.forEach((x) => x.dispose())
    })
    this.renderer.dispose()
  }

  addFrameHook(fn: (dt: number, t: number) => boolean) {
    this.frameHooks.add(fn)
    return () => this.frameHooks.delete(fn)
  }

  requestRender(shadows = false) {
    this.needsRender = true
    if (shadows) this.shadowDirty = true
  }

  /** Point the dynamic shadow light at the active station. */
  focusShadows(target: THREE.Vector3Like) {
    if (!this.spot) return
    this.spot.position.set(target.x, 2.6, target.z)
    this.spot.target.position.set(target.x, 0.9, target.z)
    this.spot.target.updateMatrixWorld()
    this.shadowDirty = true
  }

  // ── settings ─────────────────────────────────────────────────────────────

  /**
   * Settings that apply without rebuilding. A world made with the node pipeline
   * keeps it (and its scene-pass layout) even when every effect is off, so
   * materials never recompile for a different target mid-session.
   */
  setLive(requested: GraphicsSettings) {
    const s = supported(requested, this.renderer)
    this.settings = s
    if (this.pipelined) {
      this.composer ??= new GpuPipeline(this.renderer, this.scene, this.camera, this.layout)
      this.composer.configure(s)
    }
    this.dynScale = 1
    this.resize()
    this.requestRender()
  }

  private pixelRatio() {
    const s = this.settings
    return Math.max(0.35, Math.min(window.devicePixelRatio || 1, s.maxPixelRatio) * s.renderScale * this.dynScale)
  }

  resize() {
    const c = this.container
    if (!c) return
    const w = c.clientWidth
    const h = c.clientHeight
    if (!w || !h) return
    const pr = this.pixelRatio()
    this.renderer.setPixelRatio(pr)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.requestRender()
    if (this.raf && this.ready) this.draw(0)
  }

  // ── lighting: bakes and probes (prepared once, see prepare) ───────────────

  private bakeMs = 0
  private bakeTiming: Record<string, unknown> = {}
  private bakeLog: string[] = []

  /** Capture a room's reflection probe from its baked lighting. */
  private captureRoomProbe(zone: ZoneId) {
    const size = BAKE_QUALITY[this.settings.lighting].probeSize
    // the room and the rooms it opens onto: a continuous floor reflects their lights too
    const seen = this.nav.seenThroughOpenings(zone)
    const vis = ZONE_IDS.map((id) => this.lab.zones[id].visible)
    ZONE_IDS.forEach((id) => (this.lab.zones[id].visible = seen.has(id)))
    const leaves = this.lab.doors.map((rt) => rt.pivot.visible)
    for (const rt of this.lab.doors) rt.pivot.visible = seen.has(rt.def.a) || seen.has(rt.def.b)
    const exteriorWasVisible = this.lab.exterior.root.visible
    this.lab.exterior.root.visible = EXTERIOR_WINDOWS.some((w) => seen.has(w.zone))
    const extras = this.scene.children.filter((c) => c !== this.lab.root && c.visible && !(c as THREE.Light).isLight)
    extras.forEach((c) => (c.visible = false))
    const p = ZONES[zone].probe
    // light panels at full radiance, so reflections and probe-lit objects see the real source
    const lamp = this.lab.palette.materials.lamp as THREE.MeshBasicMaterial
    lamp.color.setScalar(1)
    // One pass: walls, casework and parts carry baked light (lightmap or
    // volume), so the probe sees them lit without a second capture.
    const env = captureProbe(this.renderer, this.scene, this.pmrem, { x: p[0], y: p[1], z: p[2] }, size, this.lab.exterior.root.visible ? EXTERIOR_FAR : 40)
    this.roomLighting.setEnvironment(zone, env.texture)
    this.probes[zone]?.dispose()
    this.probes[zone] = env
    lamp.color.setScalar(LAMP_VIEW)
    extras.forEach((c) => (c.visible = true))
    ZONE_IDS.forEach((id, i) => (this.lab.zones[id].visible = vis[i]))
    this.lab.doors.forEach((rt, i) => (rt.pivot.visible = leaves[i]))
    this.lab.exterior.root.visible = exteriorWasVisible
  }

  // ── player ───────────────────────────────────────────────────────────────

  setView(eye: THREE.Vector3Like, focus: THREE.Vector3Like) {
    this.occupiedSeat = null
    this.pressed.clear()
    this.player.set(eye.x, eye.y, eye.z)
    if (this.mode === 'walk') {
      this.player.y = THREE.MathUtils.clamp(this.player.y, EYE_MIN, EYE_MAX)
      this.nav.resolveSpawn(this.player, this.lab.doors)
    }
    const dx = focus.x - this.player.x
    const dy = focus.y - this.player.y
    const dz = focus.z - this.player.z
    this.yaw = Math.atan2(dx, dz)
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz))
    this.applyView()
  }

  setMode(m: CameraMode) {
    this.interactions.clear()
    if (m !== this.mode) this.standUp()
    this.mode = m
    if (m === 'walk') {
      this.player.y = THREE.MathUtils.clamp(this.player.y, EYE_MIN, EYE_MAX)
      this.applyView()
    }
    this.applyFov()
    this.updateSeatAction()
  }

  private baseFov() {
    return this.mode === 'free' ? FREE_FOV : WALK_FOV
  }

  private applyFov() {
    const t = this.closer * this.closer * (3 - 2 * this.closer)
    this.camera.fov = THREE.MathUtils.lerp(this.baseFov(), CLOSER_FOV, t)
    this.camera.updateProjectionMatrix()
    this.hoverDirty = true
    this.requestRender()
  }

  /** Turning slows with magnification, so aim stays steady while looking closer. */
  private lookGain() {
    return this.camera.fov / this.baseFov()
  }

  /** Right mouse: hold to look closer. Anything that releases the mouse releases it too. */
  private holdCloser(held: boolean) {
    this.closerHeld = held && !this.settingsOpen && !this.tabHeld
  }

  /** Ease toward the held view; true while the view is changing. */
  private updateCloser(dt: number) {
    const target = this.closerHeld ? 1 : 0
    if (this.closer === target) return false
    const step = dt / CLOSER_SECONDS
    this.closer = target > this.closer ? Math.min(target, this.closer + step) : Math.max(target, this.closer - step)
    this.applyFov()
    return true
  }

  get seated() {
    return this.occupiedSeat !== null
  }

  private nearbySeat() {
    if (this.mode !== 'walk' || this.seated) return null
    const zone = this.nav.zoneAt(this.player.x, this.player.z)
    return this.lab.ctx.seats
      .filter((seat) => seat.zone === zone && Math.min(Math.hypot(seat.position.x - this.player.x, seat.position.z - this.player.z), Math.hypot(seat.home.x - this.player.x, seat.home.z - this.player.z)) <= 1.1)
      .sort((a, b) => a.position.distanceToSquared(this.player) - b.position.distanceToSquared(this.player))
      .find((seat) => this.nav.canApproach(this.player, seat.position, this.lab.doors, seat.collider) || this.nav.canApproach(this.player, seat.home, this.lab.doors, seat.collider)) ?? null
  }

  private updateSeatAction() {
    const seat = this.nearbySeat()
    const action: SeatAction = this.seated ? 'stand' : seat ? this.nav.canApproach(this.player, seat.position, this.lab.doors, seat.collider) ? 'sit' : 'pull' : null
    if (action === this.seatAction) return
    this.seatAction = action
    this.onSeatAction?.(action)
  }

  /** Sit in the closest reachable chair, preserving a safe place to stand. */
  sitDown(seat = this.nearbySeat()) {
    if (!seat || this.mode !== 'walk' || this.seated || !this.lab.ctx.seats.includes(seat)) return false
    if (this.nav.zoneAt(this.player.x, this.player.z) !== seat.zone || Math.hypot(seat.position.x - this.player.x, seat.position.z - this.player.z) > 1.1) return false
    if (!this.nav.canApproach(this.player, seat.position, this.lab.doors, seat.collider)) return false
    this.standingPosition.copy(this.player)
    if (!this.nav.resolveSpawn(this.standingPosition, this.lab.doors)) return false
    this.occupiedSeat = seat
    this.pressed.clear()
    this.player.copy(seat.position)
    this.player.y += SEATED_EYE_HEIGHT
    this.yaw = seat.yaw
    this.pitch = 0
    this.applyView()
    return true
  }

  standUp() {
    if (!this.seated) return false
    this.occupiedSeat = null
    this.pressed.clear()
    this.player.copy(this.standingPosition)
    this.nav.resolveSpawn(this.player, this.lab.doors)
    this.applyView()
    return true
  }

  toggleSeating() {
    return this.seated ? this.standUp() : this.seatAction === 'pull' ? this.moveChair('out') : this.sitDown()
  }

  chairMoves() {
    const seat = this.occupiedSeat ?? this.nearbySeat()
    const player = this.seated ? undefined : this.player
    return { in: !!seat && this.chairMover.canMove(seat, 'in', player), out: !!seat && this.chairMover.canMove(seat, 'out', player) }
  }

  moveChair(direction: ChairDirection) {
    const seat = this.occupiedSeat ?? this.nearbySeat()
    if (!seat || this.mode !== 'walk') return false
    const moved = this.chairMover.move(seat, direction, this.seated ? undefined : this.player)
    if (!moved) return false
    if (this.seated) this.player.copy(seat.position).add(new THREE.Vector3(0, SEATED_EYE_HEIGHT, 0))
    this.applyView()
    this.requestRender(true)
    return true
  }

  /** Picking follows each movable chair's current seat/back bounds. */
  private pickSeat(ndc: THREE.Vector2) {
    if (this.mode !== 'walk' || this.seated) return false
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.camera)
    const bounds = new THREE.Box3(new THREE.Vector3(-0.25, 0.46, -0.28), new THREE.Vector3(0.25, 1.0, 0.26))
    const hits = this.lab.ctx.seats.flatMap((seat) => {
      if (seat.zone !== this.nav.zoneAt(this.player.x, this.player.z) || Math.hypot(seat.position.x - this.player.x, seat.position.z - this.player.z) > 1.1) return []
      const frame = new THREE.Matrix4().makeRotationY(seat.yaw).setPosition(seat.position)
      const ray = raycaster.ray.clone().applyMatrix4(frame.invert())
      const hit = ray.intersectBox(bounds, new THREE.Vector3())
      return hit ? [{ seat, distance: ray.origin.distanceTo(hit) }] : []
    }).sort((a, b) => a.distance - b.distance)
    if (!hits.length) return false
    if (this.interactions.blocked(hits[0].seat.zone, raycaster, hits[0].distance, 0.12)) return false
    return this.sitDown(hits[0].seat)
  }

  private applyView() {
    this.hoverDirty = true
    this.camera.position.copy(this.player)
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch))
    this.camera.lookAt(this.player.clone().add(dir))
    this.camera.updateMatrixWorld()
    this.updateSeatAction()
    this.requestRender()
  }

  setLookMode(mode: LookMode) {
    this.lookMode = mode
    this.resumeOnEnter = false
    this.setLookActive(false)
    this.looking = false
    this.interactions.clear()
  }

  private setLookActive(active: boolean) {
    this.lookActive = active
    this.renderer.domElement.style.cursor = active ? 'none' : ''
    document.documentElement.classList.toggle('lab-mouse-look', active)
    if (!active) {
      this.relockAfterUnlock = false
      if (document.pointerLockElement === this.renderer.domElement) {
        this.unlocking = true
        document.exitPointerLock()
      }
    }
    this.onLookActive?.(active)
    this.hoverDirty = true
  }

  private captureLook() {
    if (this.lookMode !== 'follow' || this.settingsOpen || this.tabHeld) return
    if (this.unlocking) { this.relockAfterUnlock = true; return }
    this.setLookActive(true)
    // Native capture is available to the standalone site. MnemoNexus's sandbox
    // forbids it; its capture overlay and edge turning provide the fallback.
    if (document.documentElement.dataset.labNativeCapture === 'true' && document.pointerLockElement !== this.renderer.domElement) {
      try {
        const pending = this.renderer.domElement.requestPointerLock()
        pending?.catch(() => undefined)
      } catch { /* Keep the sandbox-compatible capture surface. */ }
    }
  }

  openSettings() {
    this.settingsOpen = true
    this.resumeOnEnter = false
    this.tabHeld = false
    this.looking = false
    this.pressed.clear()
    this.holdCloser(false)
    this.setLookActive(false)
    this.interactions.clear()
    this.onSettingsOpen?.(true)
  }

  closeSettings() {
    this.settingsOpen = false
    this.resumeOnEnter = this.lookMode === 'follow'
    this.onSettingsOpen?.(false)
    if (this.pointerOver && this.resumeOnEnter) {
      this.captureLook()
      this.renderer.domElement.focus()
    }
  }

  interact() {
    if (!this.pointerNdc) return false
    this.refreshHover()
    const used = this.interactions.activate(this.player)
    if (used) this.requestRender(true)
    return used
  }

  private refreshHover() {
    this.hoverDirty = false
    if (!this.pointerNdc || this.mode !== 'walk') { this.interactions.clear(); return }
    const ndc = this.lookMode === 'follow' && this.lookActive ? new THREE.Vector2() : this.pointerNdc
    this.interactions.hover(ndc, this.camera, this.nav.zoneAt(this.player.x, this.player.z))
  }

  private bindInput(opts: AttachOptions) {
    const el = this.renderer.domElement
    let drag: { x: number; y: number; lastX: number; lastY: number; distance: number; entering: boolean } | null = null
    const isCapture = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.('[data-lab-mouse-capture]') != null
    const ndcAt = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      return new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1, -((e.clientY-rect.top)/rect.height)*2+1)
    }
    const onDown = (e: PointerEvent) => {
      if (e.button === 2) { this.holdCloser(true); el.focus(); return }
      if (e.button !== 0 || this.settingsOpen || this.tabHeld) return
      const entering = this.lookMode === 'follow' && !this.lookActive
      drag = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, distance: 0, entering }
      if (e.pointerType === 'touch') { e.preventDefault(); el.setPointerCapture(e.pointerId) }
      this.pointerNdc = ndcAt(e)
      this.pointerOver = true
      if (this.lookMode === 'follow') this.captureLook()
      else this.looking = true
      el.focus()
    }
    const onMove = (e: PointerEvent) => {
      // A button pressed or released while another is held arrives as a move; a
      // release outside the frame arrives as a move with the button no longer held.
      const scene = e.target === el || isCapture(e.target)
      const left = (e.buttons & 1) !== 0, right = (e.buttons & 2) !== 0
      if (e.button === 0 && !left && drag) onUp(e)
      else if (e.button === 0 && left && !drag && scene) onDown(e)
      if (this.closerHeld && !right) this.holdCloser(false)
      else if (e.button === 2 && right && !this.closerHeld && scene) this.holdCloser(true)
      if (e.target !== el && !this.lookActive) return
      this.pointerNdc = ndcAt(e)
      this.hoverDirty = true
      const dx = e.pointerType === 'touch' && drag ? e.clientX - drag.lastX : e.movementX
      const dy = e.pointerType === 'touch' && drag ? e.clientY - drag.lastY : e.movementY
      if (drag) { drag.distance += Math.abs(dx) + Math.abs(dy); drag.lastX = e.clientX; drag.lastY = e.clientY }
      if (!this.looking && !(this.lookMode === 'follow' && this.lookActive)) return
      const gain = 0.0022 * this.lookGain()
      this.yaw -= dx * gain
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * gain, -1.2, 0.7)
      this.applyView()
    }
    const onUp = (e: PointerEvent) => {
      if (e.button === 2) { this.holdCloser(false); return }
      this.looking = false
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      if (!drag) return
      const previous = drag
      drag = null
      if (previous.entering || previous.distance > 6 || Math.abs(e.clientX-previous.x)+Math.abs(e.clientY-previous.y)>6 || (e.target !== el && !isCapture(e.target))) return
      this.pointerNdc = ndcAt(e)
      const ndc = this.lookMode === 'follow' && this.lookActive ? new THREE.Vector2() : this.pointerNdc
      if (!this.interact() && !this.pickSeat(ndc)) opts.onPick?.(ndc)
    }
    const onLeave = (e?: PointerEvent) => {
      if ((e?.relatedTarget as HTMLElement | null)?.closest?.('[data-testid=environment-prompt]')) return
      if (this.lookActive && (document.pointerLockElement === el || isCapture(e?.relatedTarget ?? null))) return
      if (this.lookActive) this.resumeOnEnter = true
      this.pointerOver = false
      drag = null; this.looking = false; this.pointerNdc = null
      this.setLookActive(false); this.pressed.clear(); this.holdCloser(false); this.interactions.clear()
    }
    const onEnter = (e: PointerEvent) => {
      this.pointerOver = true
      this.pointerNdc = ndcAt(e)
      if (this.lookMode === 'follow' && this.resumeOnEnter && !this.tabHeld && !this.settingsOpen) {
        this.captureLook()
        el.focus()
      }
    }
    const onOutside = (e: PointerEvent) => {
      if (isCapture(e.target)) { onDown(e); return }
      if (e.target !== el) onLeave()
    }
    const onWheel = (e: WheelEvent) => {
      if (this.mode !== 'walk') return
      e.preventDefault()
      if (this.seated) return
      const f = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw))
      this.player.addScaledVector(f, THREE.MathUtils.clamp(-e.deltaY * 0.0006, -0.18, 0.18))
      this.nav.resolve(this.player, this.lab.doors)
      this.applyView()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (k === 'escape' && this.onSettingsOpen) {
        e.preventDefault()
        drag = null
        if (this.settingsOpen) this.closeSettings()
        else this.openSettings()
        return
      }
      if ((e.target as HTMLElement)?.matches?.('input, textarea, select')) return
      if (k === 'tab' && this.lookMode === 'follow' && !this.settingsOpen && (this.lookActive || this.tabHeld || this.resumeOnEnter)) {
        e.preventDefault()
        this.tabHeld = true; this.resumeOnEnter = true; drag = null; this.looking = false
        this.setLookActive(false); this.pressed.clear(); this.holdCloser(false)
        return
      }
      if (this.settingsOpen) return
      if (document.activeElement !== el) return
      if (document.activeElement === el && this.mode === 'walk' && (k === 'e' || (k === ' ' && this.seated))) {
        e.preventDefault()
        if (!e.repeat && !(k === 'e' && this.interact())) this.toggleSeating()
        return
      }
      if (!['w', 'a', 's', 'd', 'q', 'e', ' ', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) return
      this.pressed.add(k)
      // keep space / arrows from scrolling the page while driving the camera
      if (document.activeElement === el) e.preventDefault()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      this.pressed.delete(k)
      if (k === 'tab') {
        this.tabHeld = false
        if (this.pointerOver && this.resumeOnEnter && !this.settingsOpen && this.lookMode === 'follow') {
          this.captureLook(); el.focus()
        }
      }
    }
    const onBlur = () => { this.tabHeld = false; this.setLookActive(false); this.resumeOnEnter = false; onLeave() }
    const onCancel = (e: PointerEvent) => { drag = null; this.looking = false; this.pressed.clear(); this.holdCloser(false); if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId) }
    // Right mouse is an in-game control, so the scene never opens the browser's
    // menu. A menu opened elsewhere swallows key releases: stop moving first.
    const onContextMenu = (e: MouseEvent) => {
      if (e.target === el || isCapture(e.target)) e.preventDefault()
      else { this.pressed.clear(); this.holdCloser(false) }
    }
    const onVisibility = () => { onBlur(); this.last = performance.now(); this.lastRender = this.last; this.slowSince = 0; this.slowSinceRes = 0; this.fastSince = 0; if (!document.hidden) this.requestRender() }
    const onElementBlur = () => {
      this.pressed.clear()
      if (!this.tabHeld && !this.resumeOnEnter) this.setLookActive(false)
    }
    const onLockChange = () => {
      if (this.unlocking && document.pointerLockElement !== el) {
        this.unlocking = false
        const resume = this.relockAfterUnlock
        this.relockAfterUnlock = false
        if (resume) this.captureLook()
        return
      }
      if (document.pointerLockElement !== el && this.lookActive && document.documentElement.dataset.labNativeCapture === 'true') this.openSettings()
    }
    el.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('pointerenter', onEnter)
    el.addEventListener('blur', onElementBlur)
    window.addEventListener('pointerdown', onOutside)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('visibilitychange', onVisibility)
    el.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    document.addEventListener('pointerlockchange', onLockChange)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('pointerenter', onEnter)
      el.removeEventListener('blur', onElementBlur)
      window.removeEventListener('pointerdown', onOutside)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('visibilitychange', onVisibility)
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('pointerlockchange', onLockChange)
    }
  }

  private movePlayer(dt: number) {
    if (this.seated) return false
    const p = this.pressed
    if (!p.size) return false
    const f = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw))
    const r = new THREE.Vector3(f.z, 0, -f.x)
    const move = new THREE.Vector3()
    if (p.has('w') || p.has('arrowup')) move.add(f)
    if (p.has('s') || p.has('arrowdown')) move.sub(f)
    if (p.has('d') || p.has('arrowright')) move.sub(r)
    if (p.has('a') || p.has('arrowleft')) move.add(r)
    const free = this.mode === 'free'
    if (free && (p.has(' ') || p.has('e'))) move.y += 1
    if (free && p.has('q')) move.y -= 1
    if (free && p.has('shift') && !p.has('w') && !p.has('s') && !p.has('a') && !p.has('d')) move.y -= 1
    if (move.lengthSq() === 0) return false
    move.normalize()
    const sprint = p.has('shift') && !free ? 1.6 : 1
    this.player.addScaledVector(move, (free ? FLY_SPEED : WALK_SPEED) * sprint * dt)
    if (free) this.player.y = THREE.MathUtils.clamp(this.player.y, 0.15, 3.4)
    else {
      this.player.y = THREE.MathUtils.clamp(this.player.y, EYE_MIN, EYE_MAX)
      this.nav.resolve(this.player, this.lab.doors)
    }
    this.applyView()
    return true
  }

  // ── doors + culling ──────────────────────────────────────────────────────

  private updateDoors(dt: number) {
    let moving = false
    const c = this.camera.position
    for (const d of this.lab.doors) {
      if (d.def.propped !== undefined) continue
      // open when standing in front of (either side of) the doorway
      const rx = c.x - d.def.center[0]
      const rz = c.z - d.def.center[1]
      const along = Math.abs(rx * d.def.normal[0] + rz * d.def.normal[1])
      const lateral = Math.abs(-rx * d.def.normal[1] + rz * d.def.normal[0])
      let target = along < 1.45 && lateral < 0.75 ? 1 : 0
      // one-way doors open from zone a; someone already in the doorway gets through
      if (target && d.def.oneWay && rx * d.def.normal[0] + rz * d.def.normal[1] > 0.35) target = 0
      // airlocks: wait until the other door of the group has shut
      const lock = d.def.interlock
      if (target && lock && this.lab.doors.some((o) => o.def.interlock === lock && o.def.id !== d.def.id && o.openness > 0.02)) target = 0
      if (Math.abs(target - d.openness) < 1e-3) continue
      const speed = target > d.openness ? 2.4 : 0.9
      d.openness = THREE.MathUtils.clamp(d.openness + Math.sign(target - d.openness) * speed * dt, 0, 1)
      const eased = d.openness * d.openness * (3 - 2 * d.openness)
      d.pivot.rotation.y = d.yaw0 + d.sign * eased * d.def.maxAngle
      moving = true
    }
    return moving
  }

  /** Which rooms (and whether the outdoors) can be seen; nothing else happens here. */
  private updateZones() {
    if (this.warmZone) {
      this.warmDrawn = true
      const zone = this.warmZone
      const p = ZONES[zone].probe
      this.camera.position.set(p[0], p[1], p[2])
      this.camera.updateMatrixWorld()
      for (const id of ZONE_IDS) this.lab.zones[id].visible = id === zone
      for (const rt of this.lab.doors) rt.pivot.visible = rt.def.a === zone || rt.def.b === zone
      this.lab.exterior.root.visible = EXTERIOR_WINDOWS.some((w) => w.zone === zone)
      return
    }
    const c = this.camera.position
    this.zone = this.nav.zoneAt(c.x, c.z) ?? (this.mode === 'free' && (c.y > 2.9 || c.y < 0) ? null : this.zone)
    this.projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.projScreen, this.renderer.coordinateSystem)
    const vis = this.nav.visibleZones(this.camera, this.frustum, this.zone, this.lab.doors) as Set<ZoneId>
    const outdoors = exteriorVisible(vis, c, this.frustum)
    // other wings seen through their own windows from across the campus
    if (outdoors) addRoomsSeenFromOutside(vis, c, this.frustum)
    for (const id of ZONE_IDS) this.lab.zones[id].visible = vis.has(id)
    for (const rt of this.lab.doors) rt.pivot.visible = vis.has(rt.def.a) || vis.has(rt.def.b)
    this.lab.exterior.root.visible = outdoors
  }

  get currentZone() {
    return this.zone
  }

  /** Direction the camera faces, in radians: forward is (sin h, cos h) in x/z. */
  get heading() {
    return this.yaw
  }

  /** Paint new content on the lab TV (640 × 360 logical canvas). */
  showOnTv(paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
    this.lab.tv.show(paint)
    this.requestRender()
  }

  // ── frame loop ───────────────────────────────────────────────────────────

  /** Render one frame with the current state. */
  private glare = 0
  private glareView = new THREE.Vector3()

  /**
   * Eyes, like cameras, stop down when they look into a light: staring at a
   * panel dims the rest of the view a little and its glow spreads. The glare is
   * the room's panels' solid angle near the view's centre, worked out from the
   * panels themselves (no GPU readback), and eases in and out over about a
   * third of a second. A level view barely moves it. True while it changed.
   */
  private updateGlare(dt: number) {
    let target = 0
    const zone = this.zone ? ZONES[this.zone] : null
    if (zone) {
      const p = this.camera.position
      const view = this.camera.getWorldDirection(this.glareView)
      for (const t of zone.troffers) {
        const dx = t.x - p.x, dy = zone.ceiling - p.y, dz = t.z - p.z
        if (dy <= 0) continue
        const dist = Math.hypot(dx, dy, dz)
        const c = (dx * view.x + dy * view.y + dz * view.z) / dist
        if (c <= GLARE_CONE) continue
        const centre = (c - GLARE_CONE) / (1 - GLARE_CONE)
        // a downward-facing panel's solid angle, weighted towards the view's centre
        target += ((t.w * t.d * dy) / (dist * dist * dist)) * centre * centre
      }
    }
    target = Math.min(1, target * GLARE_GAIN)
    if (this.glare === target) return false
    // ease towards the target, then land on it exactly: a view at rest always
    // has the same exposure, however the eye arrived there
    const eased = this.glare + (target - this.glare) * (1 - Math.exp(-dt / 0.35))
    this.glare = Math.abs(target - eased) < 0.003 ? target : eased
    this.renderer.toneMappingExposure = EXPOSURE * (1 - GLARE_STOP * this.glare)
    this.composer?.setGlare(this.glare)
    return true
  }

  private draw(_dt: number) {
    const captureStart = this.performanceCapture ? performance.now() : 0
    this.updateZones()
    if (this.spot && this.shadowDirty) {
      this.spot.shadow.needsUpdate = true
      this.shadowDirty = false
    }
    this.renderer.info.reset()
    if (this.composer) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
    this.needsRender = false
    if (this.performanceCapture) this.performanceDrawMs = performance.now() - captureStart
  }

  /** Set once a frame has thrown; the loop is stopped and the next acquire rebuilds. */
  failed = false
  private failHandlers = new Set<(err: unknown) => void>()

  /** Called if a frame throws. Returns an unsubscribe function. */
  onFail(fn: (err: unknown) => void) {
    this.failHandlers.add(fn)
    return () => {
      this.failHandlers.delete(fn)
    }
  }

  private stopWithError(err: unknown) {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.failed = true
    console.error('3D view stopped:', err)
    this.failHandlers.forEach(fn => fn(err))
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick)
    try {
      const capture = this.performanceCapture
      const captureStart = capture ? performance.now() : 0
      this.frame(now)
      if (capture) capture.record(now, performance.now() - captureStart, this.lastRender === now, this.performanceDrawMs, this.renderer.info.render.drawCalls, this.renderer.info.render.triangles)
    } catch (err) {
      // Inside MnemoNexus an uncaught error ends the run, so a broken frame
      // stops the 3D view instead; the lab's controls keep working.
      this.stopWithError(err)
    }
  }

  private frame(now: number) {
    const rawDt = (now - this.last) / 1000
    const dt = Math.min(rawDt, 0.05)
    this.last = now
    const t = now / 1000

    // A sandbox cannot lock/recentre the OS pointer. Keep turning at the
    // viewport edge so an embedded mouse-look session never runs out of travel.
    let edgeTurning = false
    if (this.lookActive && this.lookMode === 'follow' && document.pointerLockElement !== this.renderer.domElement && this.pointerNdc) {
      const edge = (v: number) => Math.abs(v) > 0.90 ? Math.sign(v)*(Math.min(1,Math.abs(v))-0.90)/0.10 : 0
      const x = edge(this.pointerNdc.x), y = edge(this.pointerNdc.y)
      if (x || y) {
        const gain = this.lookGain()
        this.yaw -= x*1.6*dt*gain
        this.pitch = THREE.MathUtils.clamp(this.pitch+y*1.0*dt*gain,-1.2,0.7)
        this.applyView(); edgeTurning = true
      }
    }
    const lens = this.updateCloser(dt)
    const adapting = this.ready && this.updateGlare(dt)
    const moved = this.movePlayer(dt)
    const doors = this.updateDoors(dt)
    let animating = this.interactions.update(dt, rawDt)
    if (animating && this.mode === 'walk') {
      this.nav.resolve(this.player, this.lab.doors)
      this.applyView()
    }
    if ((this.hoverDirty || animating) && now-this.lastHover > 90) { this.refreshHover(); this.lastHover = now }
    for (const h of this.frameHooks) if (h(dt, t)) animating = true
    const active = moved || doors || animating || this.looking || edgeTurning || lens || adapting

    const refining = this.settings.refine && this.refineFrames > 0
    if ((!this.ready && !this.warmZone) || (!active && !this.needsRender && !refining)) return
    // Pace a capped rate by deadlines, so 60 on a 144 Hz display averages 60
    // rather than snapping to every third refresh.
    const cap = this.settings.fpsCap
    if (cap && !this.warmZone) {
      const interval = 1000 / cap
      if (now < this.nextDue - 1.5) return
      this.nextDue = now - this.nextDue > interval ? now + interval : this.nextDue + interval
    }
    const frameMs = now - this.lastRender
    this.lastRender = now

    if (doors || animating) this.shadowDirty = true
    const explicit = active || this.needsRender
    this.draw(dt)
    if (explicit) this.refineFrames = this.settings.refine ? 32 : 0
    else if (refining) this.refineFrames--

    this.statFrames++
    this.statCalls = this.renderer.info.render.drawCalls
    this.statTris = this.renderer.info.render.triangles
    if (active && frameMs < 250 && !this.spike) this.adaptResolution(now, frameMs)
    this.spike = false
    if (now - this.statTime > 500) {
      const secs = (now - this.statTime) / 1000
      publishStats({
        idle: this.statFrames < 4,
        fps: Math.round(this.statFrames / secs),
        ms: Math.round(this.avgMs * 10) / 10,
        calls: this.statCalls,
        triangles: this.statTris,
        scale: Math.round(this.pixelRatio() * 100) / 100,
        zone: this.zone ?? 'outside',
      })
      this.statFrames = 0
      this.statTime = now
    }
  }

  /**
   * Dynamic resolution with hysteresis: drop only after 1.5 s of genuinely
   * slow frames, recover only after 4 s of comfortable ones. One-off spikes
   * (probe captures, GC) are ignored so the canvas is not resized needlessly.
   */
  private adaptResolution(now: number, frameMs: number) {
    const target = this.settings.fpsCap === 30 ? 33.3 : 16.7
    const min = this.settings.minDynamicScale
    this.avgMs = this.avgMs * 0.9 + Math.min(frameMs, target * 3) * 0.1
    const slow = this.avgMs > target * 1.3
    const fast = this.avgMs < target * 1.08
    if (slow) {
      this.fastSince = 0
      if (!this.slowSinceRes) this.slowSinceRes = now
    } else this.slowSinceRes = 0
    if (fast) {
      if (!this.fastSince) this.fastSince = now
    } else this.fastSince = 0

    let next = this.dynScale
    if (this.slowSinceRes && now - this.slowSinceRes > 1500 && this.dynScale > min) next = Math.max(min, this.dynScale - 0.1)
    else if (this.fastSince && now - this.fastSince > 4000 && this.dynScale < 1) next = Math.min(1, this.dynScale + 0.1)
    if (Math.abs(next - this.dynScale) > 0.001) {
      this.dynScale = next
      this.slowSinceRes = 0
      this.fastSince = 0
      this.resize()
    }
    // watchdog: still slow at the lowest resolution for 3 s → tell the app
    if (this.avgMs > target * 1.3 && this.dynScale <= min + 1e-3) {
      if (!this.slowSince) this.slowSince = now
      else if (now - this.slowSince > 3000) {
        this.slowSince = 0
        this.stepDown()
      }
    } else this.slowSince = 0
  }


  /**
   * Still slow at the lowest resolution: drop the costliest effect that can go
   * without rebuilding the world. Only when none is left does the app hear of
   * it, and that lowers the tier for the next launch, never mid-session.
   */
  private stepDown() {
    const s = this.settings
    const next: GraphicsSettings | null = s.ao !== 'off' ? { ...s, ao: 'off' }
      : s.ssr !== 'off' ? { ...s, ssr: 'off' }
      : s.bloom ? { ...s, bloom: false }
      : s.refine ? { ...s, refine: false }
      : null
    if (!next) { this.onSlow(); return }
    this.log(`slow: ${s.ao !== 'off' ? 'ambient occlusion' : s.ssr !== 'off' ? 'reflections' : s.bloom ? 'bloom' : 'refinement'} off`)
    this.setLive({ ...next, minDynamicScale: s.minDynamicScale })
  }

  /** Dev-only, opt-in capture; does not force rendering or change graphics/scientific state. */
  startPerformanceCapture(capacity = 12000) {
    if (!DEV) throw new Error('Performance capture requires a development build')
    if (this.performanceCapture) throw new Error('A performance capture is already active')
    this.performanceCapture = new FrameCapture(capacity)
  }

  endPerformanceCapture() {
    const capture = this.performanceCapture
    this.performanceCapture = null
    return capture?.finish() ?? null
  }

  /** Dev helper for screenshots / debugging. */
  debugInfo() {
    return { backend: this.renderer.backend.constructor.name, probes: Object.keys(this.probes).length, prepareMs: this.prepareMs, lookMode: this.lookMode, lookActive: this.lookActive, settingsOpen: this.settingsOpen, storage: this.lab.storage.length, machines: this.interactions.targets.length, zone: this.zone, player: this.player.toArray(), yaw: this.yaw, pitch: this.pitch, seated: this.seated, seatAction: this.seatAction, seats: this.lab.ctx.seats.length, bake: { ...this.bakeState }, bakeMs: this.bakeMs, bakeLog: this.bakeLog }
  }
}

// ── singleton management ───────────────────────────────────────────────────

let world: LabWorld | null = null

let pendingWorld: Promise<LabWorld> | null = null

export async function acquireWorld(settings: GraphicsSettings, onSlow: () => void): Promise<LabWorld> {
  if (pendingWorld) await pendingWorld
  const key = rebuildKey(settings)
  if (world && (world.key !== key || world.disposed || world.failed)) {
    world.dispose()
    world = null
  }
  if (!world) {
    pendingWorld = LabWorld.create(settings, onSlow)
    try { world = await pendingWorld } finally { pendingWorld = null }
    if (DEV) (window as unknown as { __lab?: LabWorld }).__lab = world
  }
  if (world.disposeTimer) {
    clearTimeout(world.disposeTimer)
    world.disposeTimer = null
  }
  world.refs++
  return world
}

export function releaseWorld(w: LabWorld) {
  w.refs = Math.max(0, w.refs - 1)
  if (w.refs > 0 || w.disposed) return
  w.disposeTimer = setTimeout(() => {
    if (w.refs === 0) {
      w.dispose()
      if (world === w) world = null
    }
  }, 60000)
}

// Real-time WebGPU laboratory viewport (WebGL2 compatibility backend).
// - The lab itself (src/three/lab/*) is a persistent world: baked lighting,
//   per-room reflection probes, merged static geometry, render-on-demand.
// - This component attaches that world to its container, adds the station's
//   own interactive objects and drives their animations.
// - Two camera rigs: scientist POV (eye height, collision) and free fly.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import * as THREE from 'three'

import type { LabState } from '../sim/model'
import {
  BENCH_H,
  MM,
  buildBeaker,
  buildCentrifuge,
  buildChromatographySkid,
  buildFractionRack,
  buildGlassVessel,
  buildMicroTube,
  buildMicroplate,
  buildPipette,
  buildPlateReader,
  buildReagentBottle,
  buildSharpsBin,
  buildTipBox,
  buildTubeRack,
  type CentrifugeHandle,
  type GlassShape,
  type PipetteHandle,
  type PlateHandle,
  type ReaderHandle,
  type VesselLook,
} from '../three/labModels'
import { ANCHORS, VIEWS, type SceneVariant } from '../three/lab/layout'
import { acquireWorld, releaseWorld, statsStore, type CameraMode, type LabWorld, type PrepareProgress, type SeatAction } from '../three/lab/world'
import { rebuildKey } from '../three/quality'
import { mergeStaticMeshes } from '../three/lab/optimize'
import { useGraphics } from '../graphics'
import { useLabHost } from '../host/context'
import { BAKED_LIGHTING_PATH, provideBakedLighting } from '../three/lab/bakedLighting'
import { LabMap, MapIcon, mapStore, useMapState, type MapAnchor } from './LabMap'
import { ChairControls } from './ChairControls'
import { EnvironmentHud } from './EnvironmentHud'
import type { InteractionPrompt } from '../three/lab/interactions'
import type { EnvironmentNotice } from '../runtime/environment'

export type { SceneVariant, CameraMode }

export interface SeatControl {
  action: Exclude<SeatAction, null>
  activate: () => void
  moves: () => { in: boolean; out: boolean }
  move: (direction: 'in' | 'out') => void
}

const PREP = ANCHORS.prep
const stockPos = (i: number) => new THREE.Vector3(PREP.stockStart[0] + i * PREP.stockPitch, BENCH_H, PREP.stockStart[1])

// ── persistent instruments (part of the room in every view) ────────────────

interface Instruments {
  reader: ReaderHandle
  readerPickables: THREE.Object3D[]
  centrifuge: CentrifugeHandle
  fractionHost: THREE.Group
  rotorLoaded: boolean[]
}

const instrumentCache = new WeakMap<LabWorld, Instruments>()

/** Rooms that hold station objects (instruments and each station's variant group). */
const STATION_ROOMS = ['main', 'cold'] as const

function instrumentsFor(w: LabWorld): Instruments {
  let ins = instrumentCache.get(w)
  if (ins) return ins
  const readerPickables: THREE.Object3D[] = []
  const reader = buildPlateReader(undefined, readerPickables, w.settings.detail)
  reader.group.position.set(...ANCHORS.reader.pos)
  reader.group.rotation.y = ANCHORS.reader.yaw
  const spare = buildTubeRack(6, undefined, w.settings.detail)
  spare.position.set(ANCHORS.readerSide.rack[0], BENCH_H, ANCHORS.readerSide.rack[1])
  spare.rotation.y = Math.PI
  const bca = buildReagentBottle('BCA Reagent', 'working solution', '#6f5ad6', 0.66, w.settings.detail)
  bca.position.set(ANCHORS.readerSide.bottle[0], BENCH_H, ANCHORS.readerSide.bottle[1])
  bca.rotation.y = Math.PI

  const centrifuge = buildCentrifuge([], w.settings.detail)
  centrifuge.group.position.set(...ANCHORS.centrifuge.pos)
  centrifuge.group.rotation.y = ANCHORS.centrifuge.yaw

  const skid = buildChromatographySkid()
  skid.position.set(...ANCHORS.chromatography.skid)
  const fractionHost = new THREE.Group()
  fractionHost.position.set(...ANCHORS.chromatography.rack)
  fractionHost.add(buildFractionRack(defaultFractions()))

  // Instruments live in their room's group so room culling hides them too;
  // static parts are merged into a few draw calls.
  const mainSet = new THREE.Group()
  mainSet.name = 'instruments:main'
  mainSet.add(reader.group, spare, bca)
  mergeStaticMeshes(mainSet, [reader.tray, reader.scanBar])
  const coldSet = new THREE.Group()
  coldSet.name = 'instruments:cold'
  coldSet.add(centrifuge.group, skid)
  mergeStaticMeshes(coldSet, [centrifuge.rotor, centrifuge.lid])
  for (const g of [mainSet, coldSet]) g.traverse((o) => (o.userData.shared = true))
  coldSet.add(fractionHost)
  w.lab.zones.main.add(mainSet)
  w.lab.zones.cold.add(coldSet)
  ins = { reader, readerPickables, centrifuge, fractionHost, rotorLoaded: [] }
  instrumentCache.set(w, ins)
  return ins
}

function defaultFractions() {
  return Array.from({ length: 10 }, (_, i) => ({
    num: 12 + i,
    fill01: [0.2, 0.34, 0.5, 0.88, 1, 0.92, 0.74, 0.42, 0.28, 0.18][i],
    color: i >= 3 && i <= 6 ? (i === 4 ? '#0f4da8' : '#2f86d8') : '#d3e2f2',
    selected: false,
  }))
}

/** Dispose everything under `root` that is not marked as shared. */
function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    if (o === root || o.userData.shared) return
    const mesh = o as THREE.Mesh
    mesh.geometry?.dispose()
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    mats.forEach((m) => {
      if (m.userData?.shared) return
      const mapped = m as THREE.Material & { map?: THREE.Texture | null }
      if (mapped.map?.userData.ephemeral) mapped.map.dispose()
      m.dispose()
    })
  })
}

interface ThreeLabSceneProps {
  variant: SceneVariant
  lab?: LabState
  selectedSource?: string
  selectedWell?: string
  pipetteLoaded?: boolean
  reading?: boolean
  spinning?: boolean
  wavelength?: number
  rpm?: number
  rotorLoaded?: boolean[]
  fractions?: { num: number; fill01: number; color: string; selected: boolean }[]
  onTubeSelect?: (id: string) => void
  onWellSelect?: (id: string) => void
  showCameraUI?: boolean
  /** optional controlled camera rig */
  cameraMode?: CameraMode
  onCameraMode?: (m: CameraMode) => void
  /** the facility map (M); off on decorative backgrounds */
  showMap?: boolean
  /** where the minimap docks inside the scene, from its bottom-right corner */
  mapAnchor?: MapAnchor
  /** a floating "Map" button when the camera bar is hidden and the host has none */
  mapButton?: boolean
  /** Let a host with its own camera toolbar place the contextual seat action. */
  onSeatControl?: (control: SeatControl | null) => void
}

interface StationRefs {
  world: LabWorld
  ins: Instruments
  plate?: PlateHandle
  pipette?: PipetteHandle
  rackHost: THREE.Group
  markers: THREE.Group
  variantGroup: THREE.Group
  pickables: THREE.Object3D[]
  fallingTips: { mesh: THREE.Mesh; age: number }[]
}

export function ThreeLabScene({
  variant,
  lab,
  selectedSource,
  selectedWell,
  pipetteLoaded = false,
  pipetteVolume = 50,
  tipPresent = true,
  animTrigger,
  reading = false,
  spinning = false,
  wavelength = 562,
  rpm = 14000,
  rotorLoaded,
  fractions,
  onTubeSelect,
  onWellSelect,
  showCameraUI = true,
  cameraMode,
  onCameraMode,
  showMap = variant !== 'home',
  mapAnchor,
  mapButton = true,
  onSeatControl,
}: ThreeLabSceneProps & {
  pipetteVolume?: number
  tipPresent?: boolean
  animTrigger?: { type: 'aspirate' | 'dispense' | 'eject'; time: number } | null
}) {
  const graphics = useGraphics()
  const rootRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const refs = useRef<StationRefs | null>(null)
  const getWorld = useCallback(() => refs.current?.world ?? null, [])
  const map = useMapState()
  const [innerMode, setInnerMode] = useState<CameraMode>(variant === 'overview' || variant === 'home' ? 'free' : 'walk')
  /** 'start': WebGL never came up; 'stopped': the 3D view failed while running. */
  const [glError, setGlError] = useState<'start' | 'stopped' | null>(null)
  const [retry, setRetry] = useState(0)
  const [building, setBuilding] = useState(true)
  const [progress, setProgress] = useState<PrepareProgress | null>(null)
  const host = useLabHost()
  // the shipped offline bake: worlds built from here on light rooms from it
  provideBakedLighting(() => host.asset(BAKED_LIGHTING_PATH))
  const [seatAction, setSeatAction] = useState<SeatAction>(null)
  const [interaction, setInteraction] = useState<InteractionPrompt | null>(null)
  const [notice, setNotice] = useState<EnvironmentNotice | null>(null)
  const [lookActive, setLookActive] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const clearNotice = useCallback(() => setNotice(null), [])
  const toggleSeating = useCallback(() => {
    const w = refs.current?.world
    w?.toggleSeating()
    w?.renderer.domElement.focus()
  }, [])
  const chairMoves = useCallback(() => refs.current?.world.chairMoves() ?? { in: false, out: false }, [])
  const moveChair = useCallback((direction: 'in' | 'out') => {
    const w = refs.current?.world
    w?.moveChair(direction)
    w?.renderer.domElement.focus()
  }, [])
  useEffect(() => {
    onSeatControl?.(seatAction && !building && !glError ? { action: seatAction, activate: toggleSeating, moves: chairMoves, move: moveChair } : null)
  }, [onSeatControl, seatAction, building, glError, toggleSeating, chairMoves, moveChair])
  const mode = cameraMode ?? innerMode
  const setMode = (m: CameraMode) => {
    setInnerMode(m)
    onCameraMode?.(m)
  }
  const modeRef = useRef<CameraMode>(mode)
  modeRef.current = mode
  const cb = useRef({ onTubeSelect, onWellSelect })
  cb.current = { onTubeSelect, onWellSelect }
  const dyn = useRef({ reading, spinning, pipetteLoaded, pipetteVolume, tipPresent, selectedWell, selectedSource, wavelength, rpm })
  dyn.current = { reading, spinning, pipetteLoaded, pipetteVolume, tipPresent, selectedWell, selectedSource, wavelength, rpm }
  const settingsRef = useRef(graphics.settings)
  settingsRef.current = graphics.settings
  const slowRef = useRef(graphics.reportSlow)
  slowRef.current = graphics.reportSlow
  const labRef = useRef(lab)
  labRef.current = lab
  const rotorRef = useRef(rotorLoaded)
  rotorRef.current = rotorLoaded
  const rk = rebuildKey(graphics.settings)

  const activeAnim = useRef<{
    active: boolean
    type: 'aspirate' | 'dispense' | 'eject'
    startTime: number
    duration: number
    sourcePos: THREE.Vector3
    destPos: THREE.Vector3
    color: string
  } | null>(null)

  // Trigger animations when prop arrives
  useEffect(() => {
    const r = refs.current
    if (!animTrigger || !r?.pipette) return
    const sample = lab && selectedSource ? lab.samples[selectedSource] : null
    const color = sample?.color ?? '#38bdf8'
    const srcPos = stockPos(0).setY(BENCH_H + 0.1)
    if (lab && selectedSource) {
      const idx = lab.rack.indexOf(selectedSource)
      if (idx >= 0) srcPos.x = stockPos(idx).x
    }
    const dstPos = new THREE.Vector3(...PREP.plate).setY(BENCH_H + 0.08)
    if (r.plate && selectedWell) {
      const idx = r.plate.wellIds.indexOf(selectedWell)
      if (idx >= 0) {
        dstPos.copy(r.plate.wellLocalPos[idx])
        r.plate.group.localToWorld(dstPos)
      }
    }
    if (animTrigger.type === 'eject') {
      const tip = new THREE.Mesh(
        new THREE.CylinderGeometry(4.4 * MM, 0.75 * MM, 54 * MM, 20, 1, true),
        new THREE.MeshStandardMaterial({ color: '#f8fafc', transparent: true, opacity: 0.8, roughness: 0.1 }),
      )
      tip.position.set(PREP.sharps[0], PREP.sharps[1] + 0.24, PREP.sharps[2])
      r.variantGroup.add(tip)
      r.fallingTips.push({ mesh: tip, age: 0 })
    }
    activeAnim.current = {
      active: true,
      type: animTrigger.type,
      startTime: performance.now(),
      duration: animTrigger.type === 'aspirate' ? 1400 : animTrigger.type === 'dispense' ? 1200 : 800,
      sourcePos: srcPos,
      destPos: dstPos,
      color,
    }
    r.world.requestRender(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animTrigger])

  // ── attach the world and build this station's objects ──────────────────
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let cancelled = false
    let cleanup: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    setBuilding(true)
    setGlError(null)
    // Let the loading overlay paint before the (synchronous) world build.
    const start = requestAnimationFrame(() => {
      timer = setTimeout(async () => {
        if (cancelled) return
        let w: LabWorld
        try {
          w = await acquireWorld(settingsRef.current, () => slowRef.current())
          if (cancelled) { releaseWorld(w); return }
        } catch (err) {
          console.error('Graphics renderer unavailable — 3D viewport disabled:', err)
          setGlError('start')
          setBuilding(false)
          return
        }
        // Errors here would be uncaught (inside a timer), which ends a
        // MnemoNexus run; the station's controls work without the 3D view.
        const stopped = () => {
          setGlError('stopped')
          setBuilding(false)
        }
        try {
          const teardown = setupStation(w, mount)
          const unsubscribe = w.onFail(stopped)
          const unfollow = w.onProgress(setProgress)
          cleanup = () => {
            unsubscribe()
            unfollow()
            teardown()
          }
        } catch (err) {
          console.error('3D station could not be built:', err)
          w.detach()
          releaseWorld(w)
          stopped()
          return
        }
        w.whenReady(() => {
          // A station opened in an already prepared lab draws its rooms once
          // before the overlay lifts, so its objects' first frame never stalls.
          void w.warmRooms(STATION_ROOMS).catch(() => undefined).finally(() => { if (!cancelled) setBuilding(false) })
        })
      }, 0)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(start)
      clearTimeout(timer)
      cleanup?.()
    }

    function setupStation(w: LabWorld, container: HTMLDivElement) {
      const ins = instrumentsFor(w)
      const variantGroup = new THREE.Group()
      variantGroup.name = `station:${variant}`
      const stationZone = variant === 'centrifuge' || variant === 'chromatography' ? 'cold' : 'main'
      w.lab.zones[stationZone].add(variantGroup)
      const rackHost = new THREE.Group()
      const markers = new THREE.Group()
      variantGroup.add(rackHost, markers)
      const pickables: THREE.Object3D[] = []
      const store: StationRefs = { world: w, ins, rackHost, markers, variantGroup, pickables, fallingTips: [] }

      if (variant === 'home' || variant === 'prep' || variant === 'overview') {
        const plate = buildMicroplate(labRef.current, pickables, w.settings.detail)
        plate.group.position.set(...PREP.plate)
        variantGroup.add(plate.group)
        store.plate = plate
        const pipette = buildPipette(dyn.current.pipetteLoaded, dyn.current.tipPresent, dyn.current.pipetteVolume, w.settings.detail)
        pipette.group.position.set(...PREP.pipette)
        pipette.group.rotation.set(0.28, 0.2, 0.16)
        variantGroup.add(pipette.group)
        store.pipette = pipette
        const tips = buildTipBox(undefined, false, w.settings.detail)
        tips.position.set(PREP.tips[0], BENCH_H, PREP.tips[1])
        tips.rotation.y = 0.12
        const bin = buildSharpsBin()
        bin.position.set(...PREP.sharps)
        const beaker = buildBeaker(0.5, '#d6e8ff', w.settings.detail)
        beaker.position.set(PREP.beaker[0], BENCH_H, PREP.beaker[1])
        const benchware = new THREE.Group()
        benchware.add(tips, bin, beaker)
        variantGroup.add(mergeStaticMeshes(benchware))
      }
      if (variant === 'reader') {
        store.plate = ins.reader.plate
        pickables.push(...ins.readerPickables)
        ins.reader.plate.refresh(labRef.current)
      }
      if (variant === 'centrifuge' && rotorRef.current) { ins.centrifuge.setLoadedPositions(rotorRef.current); ins.rotorLoaded = rotorRef.current }

      const focus =
        variant === 'reader'
          ? ANCHORS.reader.pos
          : variant === 'centrifuge'
            ? ANCHORS.centrifuge.pos
            : variant === 'chromatography'
              ? ANCHORS.chromatography.rack
              : PREP.plate
      w.focusShadows({ x: focus[0], y: focus[1], z: focus[2] })

      const view = VIEWS[variant]
      const eye = modeRef.current === 'free' ? view.free : view.eye
      w.setMode(modeRef.current)
      w.setView({ x: eye[0], y: eye[1], z: eye[2] }, { x: view.focus[0], y: view.focus[1], z: view.focus[2] })

      const raycaster = new THREE.Raycaster()
      w.attach(container, {
        onSeatAction: setSeatAction,
        onInteraction: setInteraction,
        onNotice: setNotice,
        onLookActive: setLookActive,
        onSettingsOpen: variant === 'home' ? undefined : setSettingsOpen,
        machineGuard(kind) {
          if (kind === 'working centrifuge' && (dyn.current.spinning || ins.rotorLoaded.some(Boolean))) return 'Rotor contains tubes or a practical run is active. Use the Centrifuge workspace to check balance and run these samples.'
          if (kind === 'working plate reader' && dyn.current.reading) return 'An assay read is active. Use the Reader workspace to control this run.'
          return undefined
        },
        onPick(ndc) {
          raycaster.setFromCamera(ndc, w.camera)
          const hits = raycaster.intersectObjects(store.pickables, false)
          if (!hits.length) return
          const hit = hits[0]
          const data = hit.object.userData.pick as { kind: string; id: string } | undefined
          if (data?.kind === 'well' && hit.instanceId !== undefined) {
            const ids = hit.object.userData.wellIds as string[]
            const id = ids?.[hit.instanceId]
            if (id) cb.current.onWellSelect?.(id)
          } else if (data?.kind === 'tube') {
            cb.current.onTubeSelect?.(data.id)
          }
        },
      })

      // station animations; return true while something is moving
      const pipTarget = new THREE.Vector3()
      const pipRotation = new THREE.Euler()
      const pipQuaternion = new THREE.Quaternion()
      const removeHook = w.addFrameHook((dt) => {
        const d = dyn.current
        let moving = false
        const c = ins.centrifuge
        const emptySpin = w.interactions.targets.some(target => target.kind === 'working centrifuge' && w.interactions.machines.isRunning(target.id))
        if ((variant === 'centrifuge' && d.spinning) || (emptySpin && Math.abs(c.lid.rotation.x) < 0.08)) {
          c.rotor.rotation.y += 52 * dt
          moving = true
        }
        const lidTarget = (variant === 'centrifuge' && d.spinning) || emptySpin ? 0 : -1.15
        if (Math.abs(c.lid.rotation.x - lidTarget) > 0.002) {
          c.lid.rotation.x = THREE.MathUtils.lerp(c.lid.rotation.x, lidTarget, 0.08)
          moving = true
        }
        const rd = ins.reader
        const trayTarget = variant === 'reader' && d.reading ? rd.trayClosedZ : rd.trayOpenZ
        if (Math.abs(rd.tray.position.z - trayTarget) > 0.0005) {
          rd.tray.position.z = THREE.MathUtils.lerp(rd.tray.position.z, trayTarget, 0.09)
          moving = true
        }
        rd.scanBar.visible = variant === 'reader' && d.reading
        if (rd.scanBar.visible) {
          const t = performance.now() / 1000
          rd.scanBar.position.set(-0.105 + Math.sin(t * 6) * 0.05, 0.142, rd.tray.position.z)
          ;(rd.scanBar.material as THREE.MeshBasicMaterial).opacity = 0.22 + Math.abs(Math.sin(t * 9)) * 0.3
          moving = true
        }
        for (let i = store.fallingTips.length - 1; i >= 0; i--) {
          const f = store.fallingTips[i]
          f.age += dt
          f.mesh.position.y -= 0.5 * dt
          f.mesh.rotation.x += 6 * dt
          f.mesh.rotation.z += 4.5 * dt
          moving = true
          if (f.age > 0.6) {
            store.variantGroup.remove(f.mesh)
            f.mesh.geometry.dispose()
            ;(f.mesh.material as THREE.Material).dispose()
            store.fallingTips.splice(i, 1)
          }
        }
        const pip = store.pipette
        if (pip) {
          pipTarget.set(...PREP.pipette)
          pipRotation.set(0.28, 0.2, 0.16)
          const anim = activeAnim.current
          if (anim?.active) {
            moving = true
            const progress = Math.min(1, (performance.now() - anim.startTime) / anim.duration)
            if (anim.type === 'aspirate') {
              const dipY = anim.sourcePos.y - 0.02
              const hoverY = anim.sourcePos.y + 0.08
              pipTarget.copy(anim.sourcePos)
              if (progress < 0.3) {
                pipTarget.y = hoverY - (progress / 0.3) * (hoverY - dipY)
                pip.plunger.position.y = -0.008 * (1 - progress / 0.3)
              } else if (progress < 0.7) {
                pipTarget.y = dipY
                const aspFrac = (progress - 0.3) / 0.4
                pip.plunger.position.y = 0.008 * (aspFrac - 1)
                pip.setLoaded(true, aspFrac, anim.color)
              } else {
                pipTarget.y = dipY + ((progress - 0.7) / 0.3) * (hoverY - dipY)
                pip.setLoaded(true, 1, anim.color)
              }
              pipRotation.set(0.08, 0, 0)
            } else if (anim.type === 'dispense') {
              const wellTopY = anim.destPos.y + 0.012
              const wellHoverY = anim.destPos.y + 0.06
              pipTarget.copy(anim.destPos)
              if (progress < 0.35) {
                pipTarget.y = wellHoverY - (progress / 0.35) * (wellHoverY - wellTopY)
              } else if (progress < 0.75) {
                pipTarget.y = wellTopY
                const drainFrac = 1 - (progress - 0.35) / 0.4
                pip.plunger.position.y = -0.012 * (1 - drainFrac)
                pip.setLoaded(drainFrac > 0.05, drainFrac, anim.color)
              } else {
                pipTarget.y = wellTopY + ((progress - 0.75) / 0.25) * (wellHoverY - wellTopY)
                pip.plunger.position.y = 0
                pip.setLoaded(false)
              }
              pipRotation.set(0.06, 0, 0)
            } else {
              pipTarget.set(PREP.sharps[0], PREP.sharps[1] + 0.24, PREP.sharps[2])
              pipRotation.set(0.12, 0, 0.2)
              pip.setTipPresent(false)
            }
            if (progress >= 1) {
              anim.active = false
              pip.plunger.position.y = 0
            }
          } else if (store.plate && d.selectedWell) {
            const idx = store.plate.wellIds.indexOf(d.selectedWell)
            if (idx >= 0) {
              pipTarget.copy(store.plate.wellLocalPos[idx])
              store.plate.group.localToWorld(pipTarget)
              pipTarget.y += d.pipetteLoaded ? 0.045 : 0.085
            }
          }
          if (pip.group.position.distanceToSquared(pipTarget) > 1e-8) {
            pip.group.position.lerp(pipTarget, 0.12)
            moving = true
          }
          pipQuaternion.setFromEuler(pipRotation)
          if (pip.group.quaternion.angleTo(pipQuaternion) > 1e-4) {
            pip.group.quaternion.slerp(pipQuaternion, 0.12)
            moving = true
          }
        }
        return moving
      })

      refs.current = store
      w.requestRender(true)

      return () => {
        removeHook()
        w.detach()
        variantGroup.removeFromParent()
        disposeTree(variantGroup)
        if (refs.current === store) refs.current = null
        releaseWorld(w)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, rk, retry])

  // Live settings (no rebuild needed)
  useEffect(() => {
    const w = refs.current?.world
    if (w && w.key === rk) w.setLive(graphics.settings)
  }, [graphics.settings, rk, building])

  useEffect(() => {
    const w = refs.current?.world
    if (!w) return
    const view = VIEWS[variant]
    const start = mode === 'free' ? view.free : view.eye
    w.setMode(mode)
    w.setView({ x: start[0], y: start[1], z: start[2] }, { x: view.focus[0], y: view.focus[1], z: view.focus[2] })
  }, [mode, variant, building])

  useEffect(() => {
    const r = refs.current
    r?.plate?.refresh(lab)
    r?.world.requestRender()
  }, [lab, building])

  useEffect(() => {
    const r = refs.current
    if (!r) return
    const host = r.rackHost
    const registerPick = (obj: THREE.Object3D, id: string) => {
      obj.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        m.userData.pick = { kind: 'tube', id }
        m.userData.dynamicPick = true
        r.pickables.push(m)
      })
    }
    if (!lab || (variant !== 'prep' && variant !== 'home' && variant !== 'overview')) return
    const ids = lab.rack.slice(0, 7)
    const own = (lab.vessels ?? []).filter((id) => lab.samples[id]?.vessel)
    const signature = ids.join('|') + '#' + own.map((id) => `${id}:${lab.samples[id].vessel!.shape}`).join('|')
    type StockVisual = { bottle: THREE.Group; tube?: THREE.Group }
    let stockVisuals = host.userData.stockVisuals as Record<string, StockVisual> | undefined
    let vesselVisuals = host.userData.vesselVisuals as Record<string, THREE.Group> | undefined
    if (host.userData.signature !== signature || !stockVisuals || !vesselVisuals) {
      for (let i = r.pickables.length - 1; i >= 0; i--) {
        if (r.pickables[i].userData.dynamicPick) r.pickables.splice(i, 1)
      }
      disposeTree(host)
      host.clear()
      stockVisuals = {}
      vesselVisuals = {}
      host.userData.signature = signature
      host.userData.stockVisuals = stockVisuals
      host.userData.vesselVisuals = vesselVisuals
      ids.forEach((id, i) => {
        const s = lab.samples[id]
        if (!s) return
        const fill = Math.max(0.08, Math.min(1, s.volume / Math.max(1, s.capacity)))
        const bottle = buildReagentBottle(s.name.replace(/\s*\(.*\)/, '').slice(0, 15), `${Math.round(s.volume)} µL`, s.color, fill * 0.8, r.world.settings.detail)
        bottle.position.copy(stockPos(i))
        registerPick(bottle, id)
        host.add(bottle)
        stockVisuals![id] = { bottle }
      })
      const tubeRack = buildTubeRack(6, undefined, r.world.settings.detail)
      tubeRack.position.set(PREP.rack[0], BENCH_H, PREP.rack[1])
      host.add(tubeRack)
      ids.slice(0, 6).forEach((id, i) => {
        const s = lab.samples[id]
        if (!s) return
        const tube = buildMicroTube(s.color, Math.max(0.15, Math.min(1, s.volume / Math.max(1, s.capacity))))
        tube.position.set(PREP.rack[0] + (i - 2.5) * 0.02, BENCH_H + 0.016, PREP.rack[1] + 0.011)
        registerPick(tube, id)
        host.add(tube)
        if (stockVisuals![id]) stockVisuals![id].tube = tube
      })
      // The learner's vessels in their own glassware, in a row in front of the rack.
      own.forEach((id, i) => {
        const v = lab.samples[id].vessel!
        const g = v.shape === 'microtube'
          ? buildMicroTube(lab.samples[id].color, 0.5)
          : v.shape === 'bottle'
            ? buildReagentBottle(lab.samples[id].name.slice(0, 15), '', lab.samples[id].color, 0.5, r.world.settings.detail)
            : buildGlassVessel(v.shape as GlassShape, v.capacityMl, r.world.settings.detail)
        g.position.set(PREP.rack[0] + (i - (own.length - 1) / 2) * 0.075, BENCH_H, PREP.rack[1] + 0.3)
        registerPick(g, id)
        host.add(g)
        vesselVisuals![id] = g
      })
    }
    ids.forEach((id) => {
      const s = lab.samples[id]
      const visual = stockVisuals?.[id]
      if (!s || !visual) return
      const fill = Math.max(0.01, Math.min(1, s.volume / Math.max(1, s.capacity)))
      const updateBottle = visual.bottle.userData.setFill as ((v: number, color: string, look?: VesselLook) => void) | undefined
      const updateTube = visual.tube?.userData.setFill as ((v: number, color: string, look?: VesselLook) => void) | undefined
      updateBottle?.(fill * 0.8, s.color, s.look)
      updateTube?.(fill, s.color, s.look)
    })
    own.forEach((id) => {
      const s = lab.samples[id]
      const g = vesselVisuals?.[id]
      if (!s?.vessel || !g) return
      const setContents = g.userData.setContents as ((ml: number, color: string, look?: VesselLook) => void) | undefined
      const setFill = g.userData.setFill as ((v: number, color: string, look?: VesselLook) => void) | undefined
      if (setContents) setContents(s.vessel.volumeMl, s.color, s.look)
      else setFill?.(Math.max(0.01, Math.min(1, s.vessel.volumeMl / Math.max(1e-6, s.vessel.capacityMl))), s.color, s.look)
    })
    // Bubbles rise while the simulation says gas is coming off; the hook stops asking for frames when none are.
    const animated = [...Object.values(stockVisuals ?? {}).flatMap((v) => [v.bottle, v.tube]), ...Object.values(vesselVisuals ?? {})].filter((o): o is THREE.Group => !!o?.userData.animate)
    const removeBubbles = r.world.addFrameHook((_dt, t) => {
      let moving = false
      for (const o of animated) if ((o.userData.animate as (t: number) => boolean)(t)) moving = true
      return moving
    })
    r.world.requestRender(true)
    return () => {
      removeBubbles()
    }
  }, [lab, variant, building])

  useEffect(() => {
    const r = refs.current
    if (!r) return
    disposeTree(r.markers)
    r.markers.clear()
    if (r.plate && selectedWell) {
      const idx = r.plate.wellIds.indexOf(selectedWell)
      if (idx >= 0) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(5.2 * MM, 0.55 * MM, 10, 36),
          new THREE.MeshBasicMaterial({ color: '#22d3ee', toneMapped: false }),
        )
        const pos = r.plate.wellLocalPos[idx].clone()
        r.plate.group.localToWorld(pos)
        ring.position.copy(pos).add(new THREE.Vector3(0, 0.0012, 0))
        ring.rotation.x = Math.PI / 2
        r.markers.add(ring)
      }
    }
    if (selectedSource && lab) {
      const i = lab.rack.indexOf(selectedSource)
      if (i >= 0) {
        const halo = new THREE.Mesh(
          new THREE.RingGeometry(15 * MM, 18 * MM, 40),
          new THREE.MeshBasicMaterial({ color: '#fbbf24', toneMapped: false, side: THREE.DoubleSide }),
        )
        halo.rotation.x = -Math.PI / 2
        halo.position.copy(stockPos(i)).setY(BENCH_H + 0.001)
        r.markers.add(halo)
      }
    }
    r.world.requestRender()
  }, [selectedWell, selectedSource, lab, building])

  useEffect(() => {
    const r = refs.current
    const pip = r?.pipette
    if (!r || !pip) return
    pip.setVolumeDisplay(pipetteVolume)
    r.world.requestRender()
    if (activeAnim.current?.active) return
    pip.setTipPresent(tipPresent)
    const sample = lab && selectedSource ? lab.samples[selectedSource] : null
    pip.setLoaded(pipetteLoaded, Math.min(1, pipetteVolume / 200), sample?.color ?? '#38bdf8')
  }, [pipetteVolume, tipPresent, pipetteLoaded, lab, selectedSource, building])

  useEffect(() => {
    const r = refs.current
    if (!r || variant !== 'reader') return
    r.ins.reader.setScreen(reading, wavelength, '25 °C')
    r.world.requestRender()
  }, [reading, wavelength, variant, building])

  useEffect(() => {
    const r = refs.current
    if (!r) return
    r.ins.centrifuge.setScreen(rpm, '4 °C', variant === 'centrifuge' && spinning)
    r.world.requestRender()
  }, [rpm, spinning, variant, building])

  useEffect(() => {
    const r = refs.current
    if (!r || !rotorLoaded || variant !== 'centrifuge') return
    r.ins.centrifuge.setLoadedPositions(rotorLoaded)
    r.ins.rotorLoaded = rotorLoaded
    r.world.requestRender(true)
  }, [rotorLoaded, variant, building])

  useEffect(() => {
    const r = refs.current
    if (!r || variant !== 'chromatography' || !fractions) return
    const host = r.ins.fractionHost
    disposeTree(host)
    host.clear()
    host.add(buildFractionRack(fractions))
    r.world.requestRender(true)
  }, [fractions, variant, building])

  return (
    <div ref={rootRef} className="absolute inset-0">
      <div ref={mountRef} className="absolute inset-0 three-lab-scene" />
      {building && !glError && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-2)]/70 pointer-events-none">
          <div className="ui-panel px-3 py-2 text-[11.5px] text-[var(--muted)] w-[240px]" data-testid="lab-loading">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
              Preparing the laboratory…
            </div>
            {progress && progress.stage !== 'ready' && <>
              <div className="mt-1.5 text-[10.5px] text-[var(--faint)]">{progressLabel(progress)}</div>
              <div className="mt-1 h-1 rounded-full bg-[var(--bg-2)] overflow-hidden">
                <div className="h-full bg-[var(--accent)] transition-[width] duration-300" style={{ width: `${Math.round(progressFraction(progress) * 100)}%` }} />
              </div>
            </>}
          </div>
        </div>
      )}
      {graphics.showStats && !glError && <PerfOverlay />}
      {variant !== 'home' && !building && !glError && refs.current && <EnvironmentHud
        world={refs.current.world} prompt={interaction} notice={notice} active={lookActive} clearNotice={clearNotice}
        containerRef={rootRef} settingsOpen={settingsOpen}
      />}
      {seatAction && !onSeatControl && !building && !glError && (
        <div className="absolute left-3 bottom-3 z-10 ui-panel p-1 text-[11px]">
          <ChairControls control={{ action: seatAction, activate: toggleSeating, moves: chairMoves, move: moveChair }} />
        </div>
      )}
      {glError && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-2)]/90 p-6 text-center">
          <div className="max-w-sm text-xs text-[var(--muted)]">
            <div className="mb-1 font-semibold text-[var(--ink)]">3D viewport unavailable</div>
            {glError === 'start'
              ? 'The graphics renderer could not start in this browser/GPU context.'
              : 'The 3D view stopped after an error.'}{' '}
            All laboratory controls, the simulation and analysis still work normally.
            <button className="ui-btn mt-3" onClick={() => setRetry(value => value + 1)} data-testid="retry-graphics">Retry 3D view</button>
          </div>
        </div>
      )}
      {showCameraUI && (
        <div className="absolute right-3 bottom-3 z-10 flex items-center gap-1.5 rounded-xl border border-[var(--line)]/70 bg-[var(--bg-2)]/80 p-1 backdrop-blur-md">
          <button
            onClick={() => setMode('walk')}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
              mode === 'walk' ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
            title="Walk through the room at eye height"
          >
            Walk
          </button>
          <button
            onClick={() => setMode('free')}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
              mode === 'free' ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
            title="Fly freely through the laboratory"
          >
            Fly
          </button>
          {showMap && (
            <button
              data-testid="map-toggle"
              onClick={() => mapStore.toggle()}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all flex items-center gap-1.5 ${
                map.open || map.expanded ? 'bg-[var(--ink)] text-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
              title="Show or hide the facility map (M)"
            >
              <MapIcon />
              Map
            </button>
          )}
          <span className="px-2 text-[10px] text-[var(--faint)] hidden sm:inline">
            {mode === 'walk' ? 'WASD walk · shift sprint · E interact · M map' : 'WASD fly · space rise · Q descend · E interact · M map'}
          </span>
        </div>
      )}
      {showMap && !glError && (
        <LabMap getWorld={getWorld} containerRef={rootRef} anchor={mapAnchor ?? (showCameraUI ? { right: 12, bottom: 52 } : { right: 12, bottom: 12 })} floatingButton={!showCameraUI && mapButton} />
      )}
    </div>
  )
}

// Loading stages and their rough share of the preparation time.
const STAGES: Record<PrepareProgress['stage'], { label: string; from: number; span: number }> = {
  textures: { label: 'Loading textures', from: 0, span: 0.05 },
  lighting: { label: 'Lighting the rooms', from: 0.05, span: 0.6 },
  reflections: { label: 'Capturing reflections', from: 0.65, span: 0.2 },
  shaders: { label: 'Compiling shaders', from: 0.85, span: 0.15 },
  ready: { label: 'Ready', from: 1, span: 0 },
}

function progressLabel(p: PrepareProgress) {
  const stage = STAGES[p.stage]
  return p.total > 1 ? `${stage.label} · ${p.done} of ${p.total}` : `${stage.label}…`
}

function progressFraction(p: PrepareProgress) {
  const stage = STAGES[p.stage]
  return stage.from + stage.span * (p.total ? Math.min(1, p.done / p.total) : 0)
}

function PerfOverlay() {
  const s = useSyncExternalStore(statsStore.subscribe, statsStore.get)
  return (
    <div className="absolute left-3 top-3 z-10 rounded-md bg-black/60 px-2 py-1 font-mono-ui text-[10.5px] leading-4 text-white/90 pointer-events-none">
      <div>{s.idle ? `idle (last ${s.ms} ms)` : `${s.fps} fps · ${s.ms} ms`}</div>
      <div>
        {s.calls} draws · {(s.triangles / 1000).toFixed(0)}k tris
      </div>
      <div>
        res ×{s.scale} · {s.zone}
      </div>
    </div>
  )
}

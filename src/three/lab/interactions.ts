import * as THREE from 'three'
import { EnvironmentMachines, machinePolicy, type EnvironmentNotice } from '../../runtime/environment'
import type { LabBuild } from './build'
import { powerRecords } from './powerRecords'
import { storageBlocked, storageMatrix, updateStorage, type StoragePart } from './storage'
import { ZONE_IDS, type ZoneId } from './layout'
import { rayBoxesDistance } from './occlusion'
import { RigidMeshBatch } from './rigidMeshBatch'

export interface InteractionPrompt { id: string; label: string; action: string; detail?: string }
interface MachineTarget { id: string; kind: string; zone: ZoneId; bounds: THREE.Box3 }
type Target = { storage: StoragePart; distance: number } | { machine: MachineTarget; distance: number }

export class EnvironmentInteractions {
  readonly machines = new EnvironmentMachines()
  readonly targets: MachineTarget[] = []
  private selected: Target | null = null
  private raycaster = new THREE.Raycaster()
  private lastPrompt = ''
  private lights: { mesh: RigidMeshBatch; targets: MachineTarget[] }[] = []
  onPrompt?: (prompt: InteractionPrompt | null) => void
  onNotice?: (notice: EnvironmentNotice) => void
  guard?: (kind: string) => string | undefined

  constructor(private lab: LabBuild) {
    for (const zone of ZONE_IDS) for (const device of powerRecords(lab.ctx.batch[zone]).devices) {
      if (device.bounds && !/indicator|light|socket/.test(device.kind)) this.targets.push({ id: device.id, kind: device.kind, zone, bounds: device.bounds })
    }
    // Fixed-anchor hero instruments are registered here; their station animations
    // and scientific controls remain with the existing station runtime.
    for (const zone of ZONE_IDS) for (const device of powerRecords(lab.ctx.batch[zone]).devices) {
      if (!/working plate reader|working centrifuge|chromatography pump/.test(device.kind)) continue
      const bounds = new THREE.Box3(new THREE.Vector3(-0.29, 0, -0.26), new THREE.Vector3(0.29, 0.30, 0.30)).applyMatrix4(device.frame)
      this.targets.push({ id: device.id, kind: device.kind, zone, bounds })
    }
    for (const zone of ZONE_IDS) {
      const targets = this.targets.filter(t => t.zone === zone)
      if (!targets.length) continue
      // one rigid batch per room (a shared pipeline); hidden lamps collapse to a point
      const off = new THREE.Matrix4().makeScale(0, 0, 0)
      const sphere = new THREE.SphereGeometry(0.007, 6, 4)
      const mesh = new RigidMeshBatch(targets.map(() => ({ geometry: sphere, matrix: off })), new THREE.MeshBasicMaterial({ color: '#67e8ac', toneMapped: false }))
      mesh.name = 'environment:power-indicators'
      mesh.frustumCulled = false
      lab.zones[zone].add(mesh); this.lights.push({ mesh, targets })
    }
  }

  clear() { this.selected = null; this.lastPrompt = ''; this.onPrompt?.(null) }

  hover(ndc: THREE.Vector2, camera: THREE.Camera, zone: ZoneId | null) {
    this.raycaster.setFromCamera(ndc, camera)
    const ray = this.raycaster.ray
    const candidates: Target[] = []
    for (const storage of this.lab.storage) {
      if (storage.zone !== zone) continue
      const localRay = ray.clone().applyMatrix4(storageMatrix(storage).invert())
      const point = localRay.intersectBox(storage.bounds, new THREE.Vector3())
      if (point) {
        const distance = ray.origin.distanceTo(point.applyMatrix4(storageMatrix(storage)))
        if (distance <= 1.8) candidates.push({ storage, distance })
      }
    }
    for (const machine of this.targets) {
      if (machine.zone !== zone) continue
      const point = ray.intersectBox(machine.bounds, new THREE.Vector3())
      if (point) {
        const distance = ray.origin.distanceTo(point)
        if (distance <= 1.8) candidates.push({ machine, distance })
      }
    }
    candidates.sort((a, b) => a.distance - b.distance)
    let selected: Target | null = candidates[0] ?? null
    // AABB targeting is only a broad phase: walls, worktops and other opaque
    // objects still occlude targets.
    if (selected && zone && this.blocked(zone, this.raycaster, selected.distance)) selected = null
    this.selected = selected
    this.publish()
  }

  /**
   * Whether something opaque stands in front of `distance` along the ray: the
   * room's walls and solid occluders (the boxes the light bake uses) and the
   * door leaves. A target's own body starts where its bounds do, hence the margin.
   */
  blocked(zone: ZoneId, raycaster: THREE.Raycaster, distance: number, margin = 0.07) {
    const limit = distance - margin
    if (limit <= 0) return false
    const ray = raycaster.ray
    if (rayBoxesDistance(ray, this.lab.ctx.occluders[zone], limit) < limit) return true
    if (rayBoxesDistance(ray, this.lab.shells[zone].wallBoxes, limit) < limit) return true
    raycaster.far = limit
    const leaf = raycaster.intersectObject(this.lab.doorsGroup, true).find(h => !((h.object as THREE.Mesh).material as THREE.Material).transparent)
    raycaster.far = Infinity
    return leaf !== undefined
  }

  private publish() {
    const target = this.selected
    let prompt: InteractionPrompt | null = null
    if (target && 'storage' in target) {
      const s = target.storage
      prompt = { id: s.id, label: s.label, action: s.open ? 'Close' : 'Open' }
    } else if (target && 'machine' in target) {
      const m = target.machine, running = this.machines.isRunning(m.id)
      prompt = { id: m.id, label: m.kind.replace(/([a-z])([A-Z])/g, '$1 $2'), action: running ? 'Stop' : machinePolicy(m.kind).action,
        detail: this.guard?.(m.kind) ?? (running ? this.machines.states.get(m.id)?.policy.running : 'No experimental sample loaded') }
    }
    const key = JSON.stringify(prompt)
    if (key !== this.lastPrompt) { this.lastPrompt = key; this.onPrompt?.(prompt) }
  }

  activate(player: THREE.Vector3) {
    const target = this.selected
    if (!target) return false
    if ('storage' in target) {
      const s = target.storage
      if (storageBlocked(s, player)) this.onNotice?.({ tone: 'warning', title: s.label, message: 'Step back to give the panel room to move.' })
      else {
        s.open = !s.open
        this.publish()
      }
    } else {
      const reason = this.guard?.(target.machine.kind)
      this.onNotice?.(reason ? { tone: 'warning', title: target.machine.kind, message: reason } : this.machines.activate(target.machine.id, target.machine.kind))
    }
    this.publish()
    return true
  }

  update(dt: number, elapsed = dt) {
    const moving = updateStorage(this.lab.storage, dt)
    // A panel's collider follows it during the animation; the world's navigation
    // resolver keeps a walking player clear while a panel is moving.
    for (const notice of this.machines.update(elapsed)) this.onNotice?.(notice)
    let running = false
    let lightChanged = false
    for (const { mesh, targets } of this.lights) {
      let changed = false
      targets.forEach((target, i) => {
        const active = this.machines.isRunning(target.id)
        if (mesh.userData[target.id] === active) return
        mesh.userData[target.id] = active; changed = true
        const p = target.bounds.getCenter(new THREE.Vector3())
        p.y = target.bounds.max.y + 0.012
        mesh.setMatrixAt(i, active ? new THREE.Matrix4().setPosition(p) : new THREE.Matrix4().makeScale(0, 0, 0))
      })
      if (changed) { mesh.computeBoundingSphere(); lightChanged = true }
      running ||= targets.some(t => this.machines.isRunning(t.id) && Number.isFinite(this.machines.states.get(t.id)?.remaining))
    }
    this.publish()
    return moving || running || lightChanged
  }

  dispose() { for (const { mesh } of this.lights) { mesh.removeFromParent(); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose() } }
}

// Ceiling-hung lab display. The screen is its own canvas texture so the app can
// put live information on it (protocol steps, timers, results) at any time.
import * as THREE from 'three'
import { paintCells } from './decals'
import type { Palette } from './kit'
import { Batch } from './kit'
import type { DecalAtlas } from './decals'

export interface TvHandle {
  group: THREE.Group
  canvas: HTMLCanvasElement
  /** Repaint the screen; `paint` draws in a 640 × 360 logical space. */
  show: (paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) => void
  dispose: () => void
}

const SCREEN_W = 1.0
const SCREEN_H = 0.565

/**
 * @param pos   centre of the screen
 * @param yaw   rotation so the screen's +z faces the room
 * @param ceiling height of the ceiling for the drop pole
 */
export function buildTv(palette: Palette, atlas: DecalAtlas, pos: THREE.Vector3, yaw: number, ceiling: number): TvHandle {
  const group = new THREE.Group()
  group.name = 'tv'

  // housing + ceiling bracket (static, merged)
  const b = new Batch('main', 'full', atlas)
  b.at(pos.x, pos.y, pos.z, yaw, () => {
    b.box('plastic', 0, 0, -0.02, SCREEN_W + 0.04, SCREEN_H + 0.04, 0.045, { color: '#131417', radius: 0.008 })
    b.box('plastic', 0, -SCREEN_H / 2 - 0.012, 0.004, 0.08, 0.008, 0.004, { color: '#2a2c30' })
    b.box('frame', 0, 0.05, -0.07, 0.3, 0.2, 0.03, { color: '#2a2c30' })
  })
  // drop pole behind the screen up to the ceiling
  const top = pos.y + 0.12
  const px = pos.x - Math.sin(yaw) * 0.07
  const pz = pos.z - Math.cos(yaw) * 0.07
  b.cyl('frame', px, (top + ceiling) / 2, pz, 0.025, 0.025, ceiling - top, { color: '#2a2c30', seg: 12 })
  b.box('frame', px, ceiling - 0.01, pz, 0.16, 0.02, 0.16, { color: '#2a2c30' })
  group.add(b.build(palette, 'tv').group)

  // live screen
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 576
  const ctx = canvas.getContext('2d')!
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(SCREEN_W, SCREEN_H),
    new THREE.MeshBasicMaterial({ map: texture, color: new THREE.Color(1.25, 1.25, 1.25) }),
  )
  screen.name = 'tv:screen'
  screen.position.copy(pos)
  screen.rotation.y = yaw
  screen.translateZ(0.0035)
  group.add(screen)

  const show = (paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) => {
    ctx.save()
    ctx.setTransform(canvas.width / 640, 0, 0, canvas.height / 360, 0, 0)
    paint(ctx, 640, 360)
    ctx.restore()
    texture.needsUpdate = true
  }
  show(paintCells)

  return {
    group,
    canvas,
    show,
    dispose() {
      texture.dispose()
      screen.geometry.dispose()
      ;(screen.material as THREE.Material).dispose()
    },
  }
}

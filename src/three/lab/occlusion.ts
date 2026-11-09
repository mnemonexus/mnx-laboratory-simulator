// Cheap line-of-sight tests against the room's occluder boxes (the same boxes
// the light bake uses) instead of ray-casting whole merged room meshes.
import type * as THREE from 'three'

/** Distance to the nearest box a ray enters within `far` (boxes: min xyz, max xyz). */
export function rayBoxesDistance(ray: THREE.Ray, boxes: ArrayLike<number>, far: number) {
  const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z
  const ix = 1 / ray.direction.x, iy = 1 / ray.direction.y, iz = 1 / ray.direction.z
  let best = far
  for (let i = 0; i + 5 < boxes.length; i += 6) {
    let t0 = (boxes[i] - ox) * ix, t1 = (boxes[i + 3] - ox) * ix
    let near = Math.min(t0, t1), exit = Math.max(t0, t1)
    t0 = (boxes[i + 1] - oy) * iy; t1 = (boxes[i + 4] - oy) * iy
    near = Math.max(near, Math.min(t0, t1)); exit = Math.min(exit, Math.max(t0, t1))
    t0 = (boxes[i + 2] - oz) * iz; t1 = (boxes[i + 5] - oz) * iz
    near = Math.max(near, Math.min(t0, t1)); exit = Math.min(exit, Math.max(t0, t1))
    // a ray starting inside a box (the camera in a doorway reveal) is not blocked by it
    if (exit >= Math.max(near, 0) && near > 0 && near < best) best = near
  }
  return best
}

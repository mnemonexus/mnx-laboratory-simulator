// Assembles the whole Molecular Biology suite from the layout.
import * as THREE from 'three'
import { LIGHTMAP_TEXEL, TEXTURE_QUALITY, type Tier } from '../quality'
import { buildCeiling, buildDoors, buildFakeDoors, buildLeaf, buildShell, buildWindows, type DoorRuntime, type ShellResult } from './architecture'
import { buildBench } from './casework'
import { buildStorage, type StoragePart } from './storage'
import { LabCtx } from './context'
import { buildDecalAtlas, type DecalAtlas } from './decals'
import { createPalette, type Palette } from './kit'
import { createEnvBoxUniforms, createShellMaterials, type ShellMaterials } from './lighting'
import { BENCHES, LEAF_W, PERSISTENT_BODIES, TV, ZONES, ZONE_IDS, roomPaint, type ZoneId } from './layout'
import { furnishFacility } from './furnish'
import { buildProps } from './props'
import { connectPower, permanentInstrumentPower, type PowerConnectionReport } from './power'
import { furnitureFinishes } from './furnitureFinishes'
import { buildChairInstances } from './chairs'
import { buildExterior } from './exterior'
import { createExteriorTextures } from './exteriorTextures'
import { buildTv, type TvHandle } from './tv'
import { blobTexture, ceilingTile, graphiteTop, leafTexture, vinylFloor, wallPaint } from './surfaces'

export interface LabBuild {
  root: THREE.Group
  zones: Record<ZoneId, THREE.Group>
  doorsGroup: THREE.Group
  doors: DoorRuntime[]
  shells: Record<ZoneId, ShellResult>
  shellMats: Record<ZoneId, ShellMaterials>
  ctx: LabCtx
  palette: Palette
  texel: number
  power: PowerConnectionReport[]
  storage: StoragePart[]
  /** live lab display (draw on it with `tv.show`) */
  tv: TvHandle
  exterior: ReturnType<typeof buildExterior>
  dispose: () => void
}

interface TextureSet {
  atlas: DecalAtlas
  floor: ReturnType<typeof vinylFloor>
  worktop: ReturnType<typeof graphiteTop>
  wall: ReturnType<typeof wallPaint>
  ceiling: ReturnType<typeof ceilingTile>
  walnut: { map: THREE.Texture }
  furniture: ReturnType<typeof furnitureFinishes>
  leaf: THREE.Texture
  blob: THREE.Texture
}

const textureCache = new Map<Tier, TextureSet>()

function textures(tier: Tier, onReady?: () => void): TextureSet {
  furnitureFinishes(tier,onReady)
  const cached = textureCache.get(tier)
  if (cached) return cached
  const q = TEXTURE_QUALITY[tier]
  const o = { size: q.size, normalMaps: q.normalMaps, anisotropy: q.anisotropy }
  const set: TextureSet = {
    atlas: buildDecalAtlas(q.size >= 2048 ? 1 : q.size >= 1024 ? 0.75 : 0.5, q.anisotropy),
    floor: vinylFloor(o),
    worktop: graphiteTop(o),
    wall: wallPaint(o),
    ceiling: ceilingTile(o),
    walnut: { map:furnitureFinishes(tier).wood },
    furniture:furnitureFinishes(tier),
    leaf: leafTexture(),
    blob: blobTexture(),
  }
  textureCache.set(tier, set)
  return set
}

export function buildLab(opts: { textures: Tier; lighting: Tier; detail: 'reduced' | 'full'; onExteriorReady?: () => void }): LabBuild {
  const tex = textures(opts.textures,opts.onExteriorReady)
  const normalMaps = TEXTURE_QUALITY[opts.textures].normalMaps
  const palette = createPalette(
    {
      worktop: tex.worktop,
      walnut: tex.walnut.map,
      furniture:tex.furniture,
      atlas: tex.atlas,
      leaf: tex.leaf,
      blob: tex.blob,
    },
    normalMaps,
  )
  const ctx = new LabCtx(opts.detail, tex.atlas)
  const texel = LIGHTMAP_TEXEL

  // architecture details, casework, props (baked boxes register lightmap faces)
  for (const id of ZONE_IDS) buildCeiling(ctx, ZONES[id])
  buildWindows(ctx)
  const fakeLeaves = buildFakeDoors(ctx)
  for (const run of BENCHES) buildBench(ctx, run)
  buildProps(ctx)
  furnishFacility(ctx)
  // solid equipment bodies shadow the bake like the casework does
  for (const id of ZONE_IDS) ctx.occluders[id].push(...ctx.batch[id].occluders)
  for (const { zone, pos, yaw, size: [w, h, d] } of PERSISTENT_BODIES) {
    ctx.batch[zone].at(pos[0], pos[1], pos[2], yaw, () => ctx.occluderLocal(zone, -w / 2, 0.004, -d / 2, w / 2, h, d / 2))
  }
  permanentInstrumentPower(ctx)
  const power = connectPower(ctx)
  const doors = buildDoors(ctx, palette, tex.atlas)

  // shells: one lightmap atlas per room holds walls, floor, ceiling and casework
  const shells = {} as Record<ZoneId, ShellResult>
  const shellMats = {} as Record<ZoneId, ShellMaterials>
  const m = palette.materials
  const caseworkMats = {
    laminateBaked: { material: m.laminate, reflective: false },
    worktopBaked: { material: m.worktop, reflective: true },
    frameBaked: { material: m.frame, reflective: false },
    glossBaked: { material: m.gloss, reflective: true },
  }
  for (const id of ZONE_IDS) {
    shellMats[id] = createShellMaterials({ wall: tex.wall, floor: tex.floor, ceiling: tex.ceiling }, normalMaps, createEnvBoxUniforms(), caseworkMats, roomPaint(ZONES[id]))
    const batch = ctx.batch[id]
    shells[id] = buildShell(ZONES[id], texel, shellMats[id], batch.bakeFaces)
    batch.assignLightmapUVs(shells[id].place, texel, shells[id].atlasW, shells[id].atlasH)
  }

  const root = new THREE.Group()
  root.name = 'BIO_SITE'
  const zones = {} as Record<ZoneId, THREE.Group>
  for (const id of ZONE_IDS) {
    const g = new THREE.Group()
    g.name = `zone:${id}`
    g.add(shells[id].group)
    const contents = ctx.batch[id].build(palette, id, shellMats[id].casework).group
    g.add(contents)
    root.add(g)
    zones[id] = g
  }
  // doors on solid walls hang a real (closed) leaf, lit by their room like any other
  for (const f of fakeLeaves) {
    const leaf = buildLeaf(palette, tex.atlas, opts.detail, 1, LEAF_W, f.veneer, 'obscure')
    f.matrix.decompose(leaf.position, leaf.quaternion, leaf.scale)
    zones[f.zone].add(leaf)
  }
  const storage = buildStorage(ctx, palette, zones)
  root.add(doors.group)
  const exterior = buildExterior(createExteriorTextures(opts.textures, opts.onExteriorReady ?? (() => {})), opts.detail === 'reduced')
  root.add(exterior.root)
  buildChairInstances(ctx, palette, tex.atlas, zones)
  const tvYaw = Math.atan2(TV.faces[0] - TV.pos[0], TV.faces[1] - TV.pos[2])
  const tv = buildTv(palette, tex.atlas, new THREE.Vector3(...TV.pos), tvYaw, ZONES.main.ceiling)
  zones.main.add(tv.group)
  root.updateMatrixWorld(true)
  root.traverse((o) => {
    o.matrixAutoUpdate = o.name.startsWith('door:')
    o.userData.shared = true
  })

  return {
    root,
    zones,
    doorsGroup: doors.group,
    doors: doors.doors,
    shells,
    shellMats,
    ctx,
    palette,
    texel,
    power,
    storage,
    tv,
    exterior,
    dispose() {
      tv.dispose()
      exterior.dispose()
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if ((m as THREE.InstancedMesh).isInstancedMesh) (m as THREE.InstancedMesh).dispose()
        if (m.isMesh && !m.name.startsWith('exterior:')) m.geometry.dispose()
      })
      palette.dispose()
      for (const id of ZONE_IDS) shellMats[id].dispose()
    },
  }
}

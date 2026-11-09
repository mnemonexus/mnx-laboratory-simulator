import { BlendMode, NormalBlending, RGFormat, RenderPipeline, type WebGPURenderer, type Scene, type Camera, type Material, type Node, type NodeBuilder } from 'three/webgpu'
import { Fn, pass, mrt, output, normalView, velocity, metalness, roughness, diffuseColor, vec2, vec3, vec4, mix, float, sample, step, smoothstep, max, select, uniform, screenUV, getViewPosition, textureSize } from 'three/tsl'
import { CONTACT_SHADOW, LAMP_VIEW, LIGHT_PANEL } from './kit'
import { probeSpecular } from './lighting'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { ssr } from 'three/addons/tsl/display/SSRNode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { smaa } from 'three/addons/tsl/display/SMAANode.js'
import { traa } from 'three/addons/tsl/display/TRAANode.js'
import type { GraphicsSettings } from '../quality'

/**
 * What the scene pass writes. It is fixed for a world's lifetime: material
 * pipelines depend on the targets, so changing them mid-session would
 * recompile every material on the next frame.
 */
export interface PassLayout { samples: number; normal: boolean; velocity: boolean; gloss: boolean }

/** The scene-pass layout a world created with these settings keeps. */
export function passLayout(s: GraphicsSettings): PassLayout {
  return {
    samples: s.refine ? 0 : s.antialias === 'msaa8' || s.antialias === 'msaa4' ? 4 : 0,
    normal: s.ao !== 'off' || s.ssr !== 'off',
    velocity: s.refine,
    gloss: s.ssr !== 'off',
  }
}

/**
 * The settings this renderer's backend can run. three's SSR node generates
 * GLSL that WebGL 2 rejects (an int/float max() in its step count), so the
 * WebGL 2 fallback keeps the probe reflections only.
 */
export function supported(s: GraphicsSettings, renderer: WebGPURenderer): GraphicsSettings {
  const webgl = (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true
  return webgl && s.ssr !== 'off' ? { ...s, ssr: 'off' } : s
}

/** A light panel's reflectance in the gloss target, far above any surface's (at most 4, see probeSpecular). */
const PANEL_MARK = 16

/**
 * What SSR reads for each pixel (two channels, blended by alpha): roughness,
 * and how strongly the surface reflects. A surface lit by its room's probe
 * reflects the share of the probe's light its lighting model gave it, so a
 * reflection SSR finds is as bright as the probe's it replaces; anything else
 * keeps a weight by gloss. Unlit materials have no roughness of their own; it
 * would read as 0, a mirror, and turned the ceiling under every light halo
 * into one. A transparent unlit overlay (a glow) leaves the surface beneath in
 * charge; an opaque one (lamp lens, screen) is matte, and a light panel is
 * marked by a reflectance no surface has (PANEL_MARK), so its reflections get
 * back the radiance the screen shows only a share of. A contact shadow also
 * hides the reflection beneath it, as dark as it is: otherwise SSR added the
 * room's reflection straight back over every chair's shadow.
 */
const surfaceGloss = Fn((builder: NodeBuilder) => {
  const material = builder.material as Material & { roughness?: number }
  if (typeof material.roughness === 'number') {
    const reflects = material.userData.probeSpecular ? probeSpecular.a : mix(0.5, 0.9, metalness).mul(roughness.oneMinus().pow(4))
    return vec4(roughness, material.transparent ? reflects.mul(diffuseColor.a) : reflects, 0, 1)
  }
  if (material.name === CONTACT_SHADOW) return vec4(1, 0, 0, diffuseColor.a)
  if (material.name === LIGHT_PANEL) return vec4(1, PANEL_MARK, 0, 1)
  return vec4(1, 0, 0, material.transparent ? 0 : 1)
})()

/**
 * The room probe's reflection in each pixel, which SSR replaces where it finds
 * the real one (blended: a contact shadow darkens it with the surface). Glass
 * keeps its own over whatever is behind it, so it replaces nothing.
 */
const probeReflection = Fn((builder: NodeBuilder) => {
  const material = builder.material as Material
  if (material.userData.probeSpecular) return material.transparent ? vec4(0, 0, 0, 1) : vec4(probeSpecular.rgb, 1)
  if (material.name === CONTACT_SHADOW) return vec4(0, 0, 0, diffuseColor.a)
  return vec4(0, 0, 0, material.transparent ? 0 : 1)
})()

/**
 * View-space normals folded onto an octahedron, two channels instead of three:
 * the scene pass has a 32-byte budget per sample (see GpuPipeline).
 */
const foldNormal = Fn(([n]: [Node<'vec3'>]) => {
  const p = n.xy.div(n.x.abs().add(n.y.abs()).add(n.z.abs()))
  const back = vec2(1).sub(p.yx.abs()).mul(step(0, p).mul(2).sub(1))
  return select(n.z.lessThan(0), back, p)
})
const unfoldNormal = Fn(([e]: [Node<'vec2'>]) => {
  const z = float(1).sub(e.x.abs()).sub(e.y.abs())
  const xy = e.sub(step(0, e).mul(2).sub(1).mul(max(z.negate(), 0)))
  return vec3(xy, z).normalize()
})

/** The panels' glow at rest, and how much more when staring into one. */
const BLOOM_STRENGTH = 0.08
const BLOOM_GLARE = 0.8

/** Whether these settings need the node pipeline at all (otherwise the scene draws to the canvas). */
export function needsPipeline(s: GraphicsSettings) {
  return s.ao !== 'off' || s.ssr !== 'off' || s.bloom || s.antialias === 'smaa' || s.refine
}

/**
 * The production node pipeline; it works on WebGPU and its WebGL2 backend.
 * The scene pass lives as long as the world: its render target is part of
 * every material's render-object key, so replacing it would rebuild every
 * room's materials the next time each is seen. Settings only rebuild the
 * post-processing chain behind it.
 */
export class GpuPipeline {
  private readonly renderer: WebGPURenderer
  private readonly camera: Camera
  private readonly layout: PassLayout
  private readonly scenePass: ReturnType<typeof pass>
  private pipeline: RenderPipeline | null = null
  private effects: Node[] = []
  private glow: ReturnType<typeof bloom> | null = null
  constructor(renderer: WebGPURenderer, scene: Scene, camera: Camera, layout: PassLayout) {
    this.renderer = renderer
    this.camera = camera
    this.layout = layout
    const scenePass = pass(scene, camera, { samples: layout.samples })
    this.scenePass = scenePass
    const targets: Record<string, Node> = { output }
    if (layout.normal) targets.normal = foldNormal(normalView)
    if (layout.velocity) targets.velocity = velocity
    if (layout.gloss) {
      targets.gloss = surfaceGloss
      targets.specular = probeReflection
    }
    const outputs = mrt(targets)
    // Targets other than the colour default to no blending, so a transparent
    // overlay would overwrite the surface beneath with its own values.
    if (layout.gloss) {
      outputs.setBlendMode('gloss', new BlendMode(NormalBlending))
      outputs.setBlendMode('specular', new BlendMode(NormalBlending))
    }
    scenePass.setMRT(outputs)
    // A sample may carry 32 bytes of colour targets (the least WebGPU
    // promises; a blended or four-channel target costs 8): the colour, gloss
    // and the probe's reflection at four half floats, folded normals and
    // velocity at two (4 each).
    if (layout.normal) scenePass.getTexture('normal').format = RGFormat
    if (layout.velocity) scenePass.getTexture('velocity').format = RGFormat
  }

  /** (Re)build the post-processing chain for these settings. */
  configure(settings: GraphicsSettings) {
    this.disposeChain()
    const { scenePass, layout, camera } = this
    const beauty = scenePass.getTextureNode('output')
    const depth = scenePass.getTextureNode('depth')
    let color: Node<'vec4'> = beauty
    let occluded: Node<'float'> = float(1)
    // Effects read normals at other pixels too: a sampleable node that unfolds
    // them. Only a layout that writes normals may ask for them: asking adds the
    // target to the pass, and no material would write it.
    const folded = layout.normal ? scenePass.getTextureNode('normal') : null
    const normals = folded && sample((uv: Node<'vec2'>) => vec4(unfoldNormal(folded.sample(uv).xy), 1))
    if (settings.ao !== 'off' && normals) {
      const ambient = ao(depth, normals as unknown as Node<'vec3'>, camera)
      ambient.radius.value = 0.12
      ambient.thickness.value = 0.25
      ambient.samples.value = settings.ao === 'full' ? 16 : 12
      ambient.resolutionScale = settings.ao === 'half' ? 0.5 : 1
      // GTAO renders to a red-channel texture. Sample its scalar occlusion;
      // multiplying by the texture's RGBA result introduces a colour cast.
      const occlusion = ambient.getTextureNode().r
      occluded = mix(1, occlusion, 0.5)
      color = vec4(beauty.rgb.mul(occluded), beauty.a)
      this.effects.push(ambient)
    }
    if (settings.ssr !== 'off' && layout.gloss && folded && normals) {
      // Reflections of the room in polished floors and worktops, in place of
      // the probe's wherever SSR finds them: the probe puts every light and
      // wall about the right place, SSR puts them (and the chairs and equipment
      // in front of them) exactly there. Added over the probe's, every surface
      // reflected twice where SSR hit and once where it missed, which drew the
      // edge of each hit as a line across floors and worktops.
      const gloss = scenePass.getTextureNode('gloss')
      const probe = scenePass.getTextureNode('specular')
      // what a ray finds on screen; a light panel is drawn at LAMP_VIEW of the radiance the probe saw
      const seen = sample((uv: Node<'vec2'>) => {
        const c = beauty.sample(uv)
        return vec4(c.rgb.mul(mix(1, 1 / LAMP_VIEW, step(PANEL_MARK * 0.5, gloss.sample(uv).g))), c.a)
      })
      const reflectance = gloss.g.mul(step(gloss.g, PANEL_MARK * 0.5))
      // Mirror SSR weights each hit by metalness (a dielectric floor would reflect
      // nothing), so it traces at full strength and the surface's own
      // reflectance applies below. Its roughness is 0, so its result is the
      // unblurred mirror reflection: only polished surfaces take it (below).
      const reflections = ssr(seen as unknown as Node<'vec4'>, depth, normals as unknown as Node<'vec3'>, { metalnessNode: float(1), roughnessNode: float(0), reflectNonMetals: true, camera })
      reflections.maxDistance.value = 3
      reflections.thickness.value = 0.04
      reflections.resolutionScale = settings.ssr === 'half' ? 0.5 : 1
      // SSR's result one texel at a time: a pixel's colour, hit and distance
      // must come from the same texel. Filtered, every hit's edge mixed a hit
      // with a miss, and the probe's reflection went without all of SSR's
      // coming back: a dark line round each hit.
      const result = reflections.getTextureNode()
      const size = vec2(textureSize(result) as unknown as Node<'vec2'>)
      const hit = result.sample(screenUV.mul(size).floor().add(0.5).div(size))
      // How much of the probe's reflection SSR's takes over: the weight SSR gave
      // its hit, (1 - d/maxDistance)^2 by its distance d from the surface and
      // 1 - (n.v)^2 by angle, from the hit's distance along the ray (alpha, 0 on
      // a miss). It fades as the reflection it brings does, so where SSR sees
      // what the probe saw, nothing changes across the edge of its hits.
      const n = unfoldNormal(folded.xy)
      const facing = n.dot(getViewPosition(screenUV, depth, uniform(camera.projectionMatrixInverse)).negate().normalize()).clamp(0, 1)
      const near = float(1).sub(hit.a.mul(facing).div(reflections.maxDistance)).clamp(0, 1)
      const taken = step(1e-4, hit.a).mul(near.mul(near)).mul(facing.mul(facing).oneMinus())
      // One mirror ray stands for a polished floor's reflection (roughness
      // about 0.1); a satin top's is a blurred lobe that also takes in the
      // lights above, which the probe's blurred lookup has and a ray seldom
      // finds, so rougher surfaces keep the probe's.
      const mirror = smoothstep(0.3, 0.15, gloss.r)
      const swapped = hit.rgb.mul(reflectance).sub(probe.rgb.mul(occluded).mul(taken)).mul(mirror)
      color = vec4(max(color.rgb.add(swapped), 0), color.a)
      this.effects.push(reflections)
    }
    if (settings.bloom) {
      // Light panels (about 2.6 in view) glow, as through a camera or the eye;
      // lit surfaces (about 1 and below) stay under the threshold.
      const glow = bloom(beauty, BLOOM_STRENGTH, 0.55, 1.6)
      color = color.add(glow)
      this.effects.push(glow)
      this.glow = glow
    }
    if (settings.refine && layout.velocity) {
      const temporal = traa(color, depth, scenePass.getTextureNode('velocity'), camera)
      color = temporal as Node<'vec4'>
      this.effects.push(temporal)
    } else if (settings.antialias === 'smaa' || (settings.antialias !== 'off' && layout.samples === 0)) {
      // Also covers refinement switched off mid-session: the pass stays single-sampled.
      const edges = smaa(color)
      color = edges as unknown as Node<'vec4'>
      this.effects.push(edges)
    }
    this.pipeline = new RenderPipeline(this.renderer, color)
  }

  render() { this.pipeline?.render() }

  /** Staring into a light (0…1, see LabWorld.updateGlare): its glow spreads. */
  setGlare(glare: number) {
    if (this.glow) this.glow.strength.value = BLOOM_STRENGTH + BLOOM_GLARE * glare
  }

  private disposeChain() {
    this.pipeline?.dispose()
    this.pipeline = null
    this.glow = null
    for (const effect of this.effects) effect.dispose()
    this.effects = []
  }

  dispose() { this.disposeChain(); this.scenePass.dispose() }
}

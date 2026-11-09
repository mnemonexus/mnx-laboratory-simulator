import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export interface Aperture { x: number; z: number; radius: number }

/** A moulded housing with broad flat faces, radiused corners and a real counter recess. */
export function pipetteHousingGeometry(segments = 32) {
  // y, width, depth, front-face z, in millimetres. The head is subtly asymmetric.
  const sections = [[140,20.4,19,9.1],[141,21.4,20,9.2],[143,22,20.3,9.2],
    [146.5,22,20.3,9.2],[150,22.1,20.4,9.2],[157,22.2,20.6,9.2],
    [164,22.3,20.8,9.2],[167.5,22.3,20.8,9.2],[176,22.6,21,9.4],
    [184,23,21.3,9.5],[189,23.4,21.6,9.6],[194,23.8,21.6,9.4],
    [197,22.9,20.3,9],[199,21.2,18.6,8.8]]
  const corners = segments <= 20 ? 2 : 4
  const rings = sections.map(([y,w,d,f]) => {
    const hx=w/2, r=4.8, back=f-d
    const points: number[][] = [-hx+r,-4.4,-3.8,0,3.8,4.4,hx-r].map(x=>[x,f])
    const arc=(cx:number,cz:number,start:number)=>{
      for(let i=1;i<=corners;i++) { const angle=(start-i*90/corners)*Math.PI/180;points.push([cx+Math.cos(angle)*r,cz+Math.sin(angle)*r]) }
    }
    arc(hx-r,f-r,90)
    points.push([hx,back+r]);arc(hx-r,back+r,0)
    points.push([-hx+r,back]);arc(-hx+r,back+r,-90)
    points.push([-hx,f-r]);arc(-hx+r,f-r,-180)
    // The last arc point coincides with the start of the ring.
    points.pop()
    return points.map(([x,z])=>{
      const relief=Math.max(0,1-Math.abs(x-3)/6)*Math.max(0,1-Math.abs(y-190)/7)
      return [x*.001,y*.001,(z-(z===f ? .7*relief : 0))*.001]
    })
  })
  const n=rings[0].length, positions:number[]=[],uv:number[]=[],indices:number[]=[]
  rings.forEach((ring,i)=>ring.forEach((v,j)=>{positions.push(...v);uv.push(j/n,i/(rings.length-1))}))
  for(let i=0;i<rings.length-1;i++) for(let j=0;j<n;j++) {
    // Front grid columns 2..4 delimit the 7.6 x 21 mm counter aperture.
    if((j===2||j===3)&&sections[i][0]>=146.5&&sections[i+1][0]<=167.5) continue
    const next=(j+1)%n,a=i*n+j,b=i*n+next,c=(i+1)*n+next,d=(i+1)*n+j
    indices.push(a,b,c,a,c,d)
  }
  for(const ringIndex of [0,rings.length-1]) {
    const center=positions.length/3
    positions.push(0,sections[ringIndex][0]*.001,0);uv.push(.5,.5)
    for(let j=0;j<n;j++) {
      const a=ringIndex*n+j,b=ringIndex*n+(j+1)%n
      indices.push(...(ringIndex===0?[center,b,a]:[center,a,b]))
    }
  }
  const shell=new THREE.BufferGeometry()
  shell.setAttribute('position',new THREE.Float32BufferAttribute(positions,3))
  shell.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));shell.setIndex(indices);shell.computeVertexNormals()
  // Internal walls give the recessed counter its visible moulded depth.
  const walls:number[]=[]
  const quad=(a:number[],b:number[],c:number[],d:number[])=>walls.push(...a,...c,...b,...a,...d,...c)
  const x=.0038,y0=.1465,y1=.1675,z=.0092,inside=.0080
  quad([-x,y0,z],[-x,y1,z],[-x,y1,inside],[-x,y0,inside])
  quad([x,y1,z],[x,y0,z],[x,y0,inside],[x,y1,inside])
  quad([x,y0,z],[-x,y0,z],[-x,y0,inside],[x,y0,inside])
  quad([-x,y1,z],[x,y1,z],[x,y1,inside],[-x,y1,inside])
  const recess=new THREE.BufferGeometry()
  recess.setAttribute('position',new THREE.Float32BufferAttribute(walls,3))
  recess.setAttribute('uv',new THREE.Float32BufferAttribute(new Float32Array(walls.length/3*2),2));recess.computeVertexNormals()
  const flat=shell.toNonIndexed(),result=mergeGeometries([flat,recess],false)!
  shell.dispose();flat.dispose();recess.dispose()
  return result
}

/** Ergonomic grip: flattened front, fuller shoulder and moulded ridges on one flank. */
export function pipetteGripGeometry(segments = 32) {
  const profile=[[78,6.2],[79,6.7],[83,7],[96,8],[115,9],[130,10.2],[133,10.8],[137,10.9],[140,10.5]]
  const ys=new Set(profile.map(([y])=>y))
  if(segments>20) for(let i=0;i<9;i++) {const y=108+i*2.7;ys.add(y-.45);ys.add(y);ys.add(y+.45)}
  const radius=(y:number)=>{
    const i=Math.max(0,profile.findIndex((p,j)=>j<profile.length-1&&y>=p[0]&&y<=profile[j+1][0]))
    const [a,r]=profile[i],[b,s]=profile[Math.min(i+1,profile.length-1)]
    return r+(s-r)*(y-a)/Math.max(.001,b-a)
  }
  const points=[[0,78],...Array.from(ys).sort((a,b)=>a-b).map(y=>[radius(y),y]),[0,140]]
  const geo=new THREE.LatheGeometry(points.map(([r,y])=>new THREE.Vector2(r*.001,y*.001)),segments)
  const pos=geo.getAttribute('position')
  for(let i=0;i<pos.count;i++) {
    const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i)
    const angle=Math.atan2(x,z)
    const flank=Math.max(0,1-Math.abs(angle+1.1)/.55)
    let ridge=0
    if(y>=.107&&y<=.131) for(let k=0;k<9;k++) ridge=Math.max(ridge,Math.max(0,1-Math.abs(y-(.108+k*.0027))/.00045))
    const amount=.00045*flank*ridge
    pos.setXYZ(i,x+Math.sin(angle)*amount,y,Math.min(.0089,z*.88+Math.cos(angle)*amount))
  }
  geo.computeVertexNormals()
  return geo
}

/** Rounded thumb pad and a slight lip around the edge, not a plain cylinder. */
export function pipetteButtonGeometry(segments = 32) {
  return new THREE.LatheGeometry([[0,-4],[6.8,-4],[8,-3.2],[8,2.9],[7.6,3.8],[6.5,4],[0,4]]
    .map(([r,y])=>new THREE.Vector2(r*.001,y*.001)),segments)
}

/** Hollow, shouldered polypropylene tip; lower end remains at -27 mm. */
export function pipetteTipGeometry(segments = 24) {
  return new THREE.LatheGeometry([[.35,-27],[3,22],[3.3,24],[3.3,27],[2.8,27],[2.6,23],[.16,-26.6]]
    .map(([r,y])=>new THREE.Vector2(r*.001,y*.001)),segments)
}

/** A low finger saddle, thick at its root and thin at the curled outer lip. */
export function pipetteFingerRestGeometry(curveSegments = 8) {
  const s=new THREE.Shape()
  s.moveTo(.006,.197)
  s.bezierCurveTo(-.006,.203,-.027,.203,-.033,.193)
  s.quadraticCurveTo(-.035,.1885,-.031,.1885)
  s.quadraticCurveTo(-.0285,.1885,-.028,.192)
  s.bezierCurveTo(-.023,.198,-.012,.199,-.005,.194)
  s.lineTo(.006,.191);s.closePath()
  const geo=new THREE.ExtrudeGeometry(s,{depth:.014,bevelEnabled:true,bevelThickness:.0006,bevelSize:.0007,bevelSegments:1,curveSegments,steps:1})
  geo.translate(0,0,-.007)
  const pos=geo.getAttribute('position')
  for(let i=0;i<pos.count;i++) {const taper=Math.max(0,Math.min(1,(-pos.getX(i)-.004)/.029));pos.setZ(i,pos.getZ(i)*(1-taper*.55))}
  geo.computeVertexNormals()
  return geo
}

/** Short clear reagent vial: broad closure, a short neck and a substantial heel. */
export function reagentVialGeometry(segments = 40) {
  const profile = segments <= 16
    ? [[0, 0], [15.5, 0], [17.5, 2.6], [17.5, 48], [16, 54], [13.6, 57], [13.6, 67],
      [12.7, 67], [12.7, 57], [16.5, 51], [16.5, 1.6], [0, 1.6]]
    : [[0, 0], [15.5, 0], [17, .8], [17.5, 2.6], [17.5, 48],
    [17.2, 51], [15.7, 54], [13.6, 56], [13.6, 58], [14.1, 58.5], [14.1, 59.4],
    [13.6, 60], [13.6, 67], [12.7, 67], [12.7, 57], [16.5, 51], [16.5, 3], [15, 1.6], [0, 1.6]]
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r * .001, y * .001)), segments)
}

/** Low-form glassware: thick heel, thin straight wall and a formed pouring lip. */
export function beakerGeometry(radius = 0.03, height = 0.08, segments = 48) {
  const wall = 0.0012
  const points = [[0, 0], [radius - 0.003, 0], [radius - 0.0007, 0.0015], [radius, 0.004],
    [radius, height - 0.004], [radius + 0.0008, height - 0.001], [radius + 0.0005, height],
    [radius - 0.0007, height], [radius - wall, height - 0.003], [radius - wall, 0.004],
    [radius - 0.003, 0.0025], [0, 0.0025]]
  const geo = new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments)
  const pos = geo.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    // +z spout is pulled out of both wall surfaces, so it stays genuinely hollow.
    const angle = Math.atan2(x, z)
    const flare = Math.pow(Math.max(0, 1 - Math.abs(angle) / 0.42), 2) * Math.pow(Math.max(0, (y / height - 0.82) / 0.18), 2)
    pos.setXYZ(i, x, y - flare * 0.002, z + flare * radius * 0.22)
  }
  geo.computeVertexNormals()
  return geo
}

/** Screw-cap media bottle; height includes the glass neck, but excludes closure. */
export function mediaBottleGeometry(radius: number, height: number, segments = 32) {
  const neck = radius * 0.64, t = Math.min(0.0015, radius * 0.06)
  return new THREE.LatheGeometry([[0, 0], [radius * 0.87, 0], [radius, height * 0.035],
    [radius, height * 0.66], [radius * 0.97, height * 0.72], [radius * 0.83, height * 0.82],
    [neck, height * 0.88], [neck, height], [neck - t, height], [neck - t, height * 0.89],
    [radius * 0.83 - t, height * 0.82], [radius - t, height * 0.7], [radius - t, t * 2], [0, t * 2]]
    .map(([r, y]) => new THREE.Vector2(r, y)), segments)
}

/** Open tapered moulded container, including its floor and inner walls. */
export function wasteBodyGeometry(width: number, depth: number, height: number, wall = 0.002) {
  const outer = new THREE.Shape([new THREE.Vector2(-width / 2, -depth / 2), new THREE.Vector2(width / 2, -depth / 2), new THREE.Vector2(width / 2, depth / 2), new THREE.Vector2(-width / 2, depth / 2)])
  const inner = new THREE.Path([new THREE.Vector2(-width / 2 + wall, -depth / 2 + wall), new THREE.Vector2(-width / 2 + wall, depth / 2 - wall), new THREE.Vector2(width / 2 - wall, depth / 2 - wall), new THREE.Vector2(width / 2 - wall, -depth / 2 + wall)])
  outer.holes.push(inner)
  const geo = new THREE.ExtrudeGeometry(outer, { depth: height, bevelEnabled: false, steps: 1 })
  geo.rotateX(-Math.PI / 2)
  const p = geo.getAttribute('position')
  for (let i = 0; i < p.count; i++) { const scale = 0.84 + p.getY(i) / height * 0.16; p.setX(i, p.getX(i) * scale); p.setZ(i, p.getZ(i) * scale) }
  geo.computeVertexNormals()
  const floor = new THREE.BoxGeometry(width * 0.84, wall, depth * 0.84).translate(0, wall / 2, 0)
  const flatFloor = floor.toNonIndexed()
  const merged = mergeGeometries([geo, flatFloor], false)!
  geo.dispose(); floor.dispose(); flatFloor.dispose()
  return merged
}

/** Extruded side elevation: flat manufactured faces and a small edge break. */
export function profiledSolid(width: number, profile: [number, number][], bevel = 0.001) {
  const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(-z, y)))
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1, steps: 1, curveSegments: 1 })
  geometry.translate(0, 0, bevel - width / 2)
  geometry.rotateY(Math.PI / 2)
  return geometry
}

export interface InstrumentCasing {
  width: number
  depth: number
  deckHeight: number
  frontHeight: number
  shoulderDepth: number
  baseHeight: number
  holes: Aperture[]
  wall?: number
  segments?: number
}

/** Sheet/cast casing with an inclined control shoulder and an unobstructed chamber. */
export function instrumentCasingGeometry(o: InstrumentCasing) {
  const { width: w, depth: d, deckHeight: h, frontHeight: f, shoulderDepth: s, baseHeight: y, holes } = o
  const t = o.wall ?? 0.003
  const profile: [number, number][] = [[-d / 2, y], [d / 2, y], [d / 2, f], [d / 2 - s, h], [-d / 2, h]]
  const parts: THREE.BufferGeometry[] = []
  for (const side of [-1, 1]) parts.push(profiledSolid(t, profile, 0).translate(side * (w - t) / 2, 0, 0))
  parts.push(new THREE.BoxGeometry(w - t * 2, f - y, t).translate(0, (f + y) / 2, (d - t) / 2))
  parts.push(new THREE.BoxGeometry(w - t * 2, h - y, t).translate(0, (h + y) / 2, -(d - t) / 2))
  parts.push(new THREE.BoxGeometry(w - t * 2, t, d - t * 2).translate(0, y + t / 2, 0))
  const angle = -Math.atan2(s, h - f)
  parts.push(new THREE.BoxGeometry(w - t * 2, Math.hypot(s, h - f), t).rotateX(angle).translate(0, (h + f) / 2, d / 2 - s / 2 - t / 2))
  parts.push(perforatedDeck(w, d - s, t, holes.map(hole => ({ ...hole, z: hole.z + s / 2 })), 0.002, o.segments ?? 24).translate(0, h - t, -s / 2))
  const flat = parts.map(g => g.index ? g.toNonIndexed() : g)
  const result = mergeGeometries(flat, false)!
  new Set([...flat, ...parts]).forEach(g => g.dispose())
  return result
}

/** Front panel with a true rectangular loading opening, in the XY plane. */
export function loadingPanelGeometry(width: number, height: number, thickness: number, hole: { x: number; y: number; width: number; height: number }) {
  const shape = new THREE.Shape()
  shape.moveTo(-width / 2, -height / 2); shape.lineTo(width / 2, -height / 2)
  shape.lineTo(width / 2, height / 2); shape.lineTo(-width / 2, height / 2); shape.closePath()
  const aperture = new THREE.Path()
  const x = hole.x, y = hole.y, w = hole.width / 2, h = hole.height / 2
  aperture.moveTo(x - w, y - h); aperture.lineTo(x - w, y + h)
  aperture.lineTo(x + w, y + h); aperture.lineTo(x + w, y - h); aperture.closePath()
  shape.holes.push(aperture)
  return new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, steps: 1 })
}

/** A continuous rotor face with elliptical fixed-angle bores, not exposed funnels. */
export function rotorCrownGeometry(count = 24, segments = 16, radius = 0.096) {
  const shape = new THREE.Shape()
  shape.absarc(0, 0, radius, 0, Math.PI * 2, false)
  for (let i = 0; i < count; i++) {
    const mouth = new THREE.Vector3(0, 0.04, 0).applyMatrix4(rotorSocket(i, count))
    const hole = new THREE.Path()
    hole.absellipse(mouth.x, -mouth.z, 0.0109, 0.0078, 0, Math.PI * 2, true, -i * Math.PI * 2 / count)
    shape.holes.push(hole)
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.003, bevelEnabled: false, steps: 1, curveSegments: segments / 2 })
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, 0.05, 0)
  return geometry
}

/** A horizontal moulding with actual through holes; origin is its bottom face. */
export function perforatedDeck(width: number, depth: number, height: number, holes: Aperture[], radius = 0.002, segments = 16, bevel = 0) {
  const x = width / 2 - bevel, z = depth / 2 - bevel
  const r = Math.min(radius, x, z)
  const shape = new THREE.Shape()
  shape.moveTo(-x + r, -z)
  shape.lineTo(x - r, -z)
  shape.quadraticCurveTo(x, -z, x, -z + r)
  shape.lineTo(x, z - r)
  shape.quadraticCurveTo(x, z, x - r, z)
  shape.lineTo(-x + r, z)
  shape.quadraticCurveTo(-x, z, -x, z - r)
  shape.lineTo(-x, -z + r)
  shape.quadraticCurveTo(-x, -z, -x + r, -z)
  for (const hole of holes) {
    const path = new THREE.Path()
    path.absarc(hole.x, -hole.z, hole.radius + bevel, 0, Math.PI * 2, true)
    shape.holes.push(path)
  }
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height - bevel * 2, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: Math.max(3, segments / 2), steps: 1 })
  geometry.translate(0, 0, bevel)
  geometry.rotateX(-Math.PI / 2)
  return geometry
}

/** Thin closed-bottom vessel. Inner wall and floor remain visible from above. */
export function vesselGeometry(topRadius: number, bottomRadius: number, height: number, wall: number, segments = 20) {
  return new THREE.LatheGeometry([
    new THREE.Vector2(0, 0),
    new THREE.Vector2(bottomRadius, 0),
    new THREE.Vector2(topRadius, height - wall * 0.5),
    new THREE.Vector2(topRadius - wall * 0.25, height),
    new THREE.Vector2(topRadius - wall, height),
    new THREE.Vector2(Math.max(wall, bottomRadius - wall), wall),
    new THREE.Vector2(0, wall),
  ], segments)
}

/** Static self-occlusion for tiny vessels that do not earn a realtime AO pass. */
export function shadeVesselInterior(geometry: THREE.BufferGeometry, height: number) {
  const pos = geometry.getAttribute('position'), normal = geometry.getAttribute('normal')
  const colors = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const inner = pos.getX(i) * normal.getX(i) + pos.getZ(i) * normal.getZ(i) < -0.00001 || normal.getY(i) > 0.5 && pos.getY(i) < height * 0.2
    const shade = inner ? 0.28 + 0.56 * Math.min(1, pos.getY(i) / height) : 1
    colors.set([shade, shade, shade], i * 3)
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
}

/** All parts in a fixed-angle socket use this same local frame. */
export function rotorSocket(index: number, count = 24) {
  const a = index * Math.PI * 2 / count
  const direction = new THREE.Vector3(Math.cos(a), 1, Math.sin(a)).normalize()
  const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction)
  return new THREE.Matrix4().compose(new THREE.Vector3(Math.cos(a) * 0.05, 0.024, Math.sin(a) * 0.05), rotation, new THREE.Vector3(1, 1, 1))
}

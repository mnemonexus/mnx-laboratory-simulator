// Exercise the production effects graph on a neutral fixture. AO is a scalar
// mask: its texture layout must never introduce a tint, at any quality/backend.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { findChromium, playwright, GPU_ARGS, findGpuChromium } from '../addon/env.mjs'
const browser = await playwright().chromium.launch({ executablePath: findGpuChromium(), args: GPU_ARGS })
const out = 'output/performance/color-regression'
mkdirSync(out, { recursive: true })
const results = [], projectionResults = [], errors = []
try {
 const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
 page.on('pageerror', e => errors.push(e.message))
 page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
 await page.route('**/__lab_colour_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0"></body>' }))
 await page.goto(`${process.env.LAB_URL ?? 'http://localhost:5173'}/__lab_colour_test__`)
 for (const forceWebGL of [false, true]) {
  const cases = await page.evaluate(async forceWebGL => {
   // the very module the app's code imports: Vite tags optimised deps with a
   // version query, and a second, untagged copy of three would render the
   // app's nodes with classes it does not recognise (no MRT outputs, no AO)
   const source = await (await fetch('/src/three/lab/gpuPipeline.ts')).text()
   const THREE = await import(source.match(/["'](\/node_modules\/\.vite\/deps\/three_webgpu\.js[^"']*)["']/)?.[1] ?? '/node_modules/.vite/deps/three_webgpu.js')
   const { GpuPipeline, passLayout, supported } = await import('/src/three/lab/gpuPipeline.ts')
   const { PRESETS } = await import('/src/three/quality.ts')
   const { patchMaterial, createEnvBoxUniforms } = await import('/src/three/lab/lighting.ts')
   const r = new THREE.WebGPURenderer({ forceWebGL, antialias: false })
   await r.init(); r.setSize(320,240); r.outputColorSpace = THREE.SRGBColorSpace
   document.body.appendChild(r.domElement)
   const scene = new THREE.Scene(); scene.background = new THREE.Color('#808080')
   const camera = new THREE.PerspectiveCamera(45,4/3,0.1,30)
   camera.position.set(2,2,4); camera.lookAt(0,0.5,0)
   const mat = new THREE.MeshBasicMaterial({ color: '#b0b0b0' })
   const cube = new THREE.Mesh(new THREE.BoxGeometry(),mat); cube.position.y=0.5; scene.add(cube)
   const floor = new THREE.Mesh(new THREE.PlaneGeometry(12,12),mat); floor.rotation.x=-Math.PI/2; scene.add(floor)
   const rows = [], projections = []; let baseline
   const readPixels = async () => {
    const image=new Image();image.src=r.domElement.toDataURL('image/png');await image.decode()
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=240
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0)
    return ctx.getImageData(0,0,320,240).data
   }
   try {
    for (const effects of [false,true]) for (const ao of ['off','half','full']) {
     // what the world runs on this backend (WebGL 2 has no SSR)
     const settings = supported({...PRESETS.high,antialias:'off',refine:effects,bloom:effects,ssr:effects?'half':'off',ao},r)
     const pipeline = new GpuPipeline(r,scene,camera,passLayout(settings)); pipeline.configure(settings)
     try {
      // Capture in the render callback's turn; WebGL clears its default
      // framebuffer after presentation when preserveDrawingBuffer is false.
      for(let i=0;i<(effects?36:4);i++){await new Promise(requestAnimationFrame);pipeline.render()}
      const png=r.domElement.toDataURL('image/png')
      const img = new Image(); img.src=png; await img.decode()
      const c=document.createElement('canvas'); c.width=320;c.height=240
      const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const pixels=ctx.getImageData(0,0,320,240).data
      let tinted=0,maxChannelSpread=0,darkened=0
      for(let i=0;i<pixels.length;i+=4){
       const spread=Math.max(pixels[i],pixels[i+1],pixels[i+2])-Math.min(pixels[i],pixels[i+1],pixels[i+2])
       maxChannelSpread=Math.max(maxChannelSpread,spread);if(spread>2)tinted++
       if(baseline&&baseline[i]-pixels[i]>3)darkened++
      }
      if(!effects&&ao==='off')baseline=pixels.slice()
      rows.push({ backend:r.backend.constructor.name,ao,effects,tinted,maxChannelSpread,darkened,png })
     } finally {pipeline.dispose()}
    }
    // In a uniform white environment, changing reflection coordinates must
    // not change illumination. Include exact and nearly axis-aligned rays.
    const environmentScene=new THREE.Scene();environmentScene.background=new THREE.Color('#ffffff')
    const generator=new THREE.PMREMGenerator(r), environment=generator.fromScene(environmentScene)
    const physical=new THREE.MeshStandardMaterial({color:'#808080',roughness:1,envMap:environment.texture})
    const bounds=createEnvBoxUniforms();bounds.envBoxMin.value.set(-6,0,-6);bounds.envBoxMax.value.set(6,3,6);bounds.envProbePos.value.set(0,1.5,0)
    cube.material=physical;floor.material=physical
    try {
     for(const offset of [0,-0.0001,0.0001]) {
      camera.position.set(offset,2,4);camera.lookAt(0,0.5,0)
      physical.envNode=null;physical.needsUpdate=true
      await new Promise(requestAnimationFrame);r.render(scene,camera);const native=await readPixels()
      patchMaterial(physical,{boxProject:true},bounds)
      await new Promise(requestAnimationFrame);r.render(scene,camera);const projected=await readPixels()
      let maxDifference=0,sum=0
      for(let i=0;i<native.length;i++)if(i%4!==3){const difference=Math.abs(native[i]-projected[i]);maxDifference=Math.max(maxDifference,difference);sum+=difference}
      projections.push({backend:r.backend.constructor.name,fixture:'uniform',offset,maxDifference,meanDifference:sum/(320*240*3)})
     }
     // A nonuniform environment with specular disabled isolates irradiance.
     // Box projection must leave diffuse room lighting exactly unchanged.
     const gradientScene=new THREE.Scene();gradientScene.background=new THREE.Color('#202020')
     const ceiling=new THREE.Mesh(new THREE.PlaneGeometry(20,20),new THREE.MeshBasicMaterial({color:'#ffffff'}))
     ceiling.rotation.x=Math.PI/2;ceiling.position.y=3;gradientScene.add(ceiling)
     const diffuseEnvironment=generator.fromScene(gradientScene)
     const diffuse=new THREE.MeshPhysicalMaterial({color:'#808080',roughness:1,specularIntensity:0,envMap:diffuseEnvironment.texture})
     cube.material=diffuse;floor.material=diffuse
     try {
      for(const offset of [0,-0.0001,0.0001]) {
       camera.position.set(offset,2,4);camera.lookAt(0,0.5,0)
       diffuse.envNode=null;diffuse.needsUpdate=true
       await new Promise(requestAnimationFrame);r.render(scene,camera);const native=await readPixels()
       patchMaterial(diffuse,{boxProject:true},bounds)
       await new Promise(requestAnimationFrame);r.render(scene,camera);const projected=await readPixels()
       let maxDifference=0,sum=0
       for(let i=0;i<native.length;i++)if(i%4!==3){const difference=Math.abs(native[i]-projected[i]);maxDifference=Math.max(maxDifference,difference);sum+=difference}
       projections.push({backend:r.backend.constructor.name,fixture:'diffuse',offset,maxDifference,meanDifference:sum/(320*240*3)})
      }
     }finally{diffuse.dispose();diffuseEnvironment.dispose();ceiling.geometry.dispose();ceiling.material.dispose()}
    }finally{physical.dispose();environment.dispose();generator.dispose()}
   } finally {cube.geometry.dispose();floor.geometry.dispose();mat.dispose();r.dispose();r.domElement.remove()}
   return {rows,projections}
  }, forceWebGL)
  for (const {png,...row} of cases.rows) {
   writeFileSync(`${out}/${row.backend}-${row.ao}-${row.effects?'effects':'plain'}.png`,Buffer.from(png.split(',')[1],'base64'))
   results.push(row);console.log(JSON.stringify(row))
   assert.equal(row.tinted,0,'Neutral geometry must remain neutral with AO/effects')
   if(row.ao!=='off')assert.ok(row.darkened>50,'AO must still provide actual shading')
  }
  for(const row of cases.projections){projectionResults.push(row);console.log(JSON.stringify(row));assert.ok(row.maxDifference<=2,'Box projection must preserve uniform radiance and unprojected diffuse irradiance')}
 }
 assert.equal(errors.length,0,errors.join('\n'))
} finally {
 writeFileSync(`${out}/report.json`,JSON.stringify({ sourceSha256:createHash('sha256').update(readFileSync('src/three/lab/gpuPipeline.ts')).digest('hex'),lightingSha256:createHash('sha256').update(readFileSync('src/three/lab/lighting.ts')).digest('hex'),results,projectionResults,errors,scope:'Neutral effects and uniform-environment projection fixtures through production code on Chromium WebGPU and WebGL2. Real lab screenshots are checked separately.' },null,2))
 await browser.close()
}

import {playwright,findChromium,GPU_ARGS,findGpuChromium} from '../addon/env.mjs'
import {mkdirSync,writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const out='output/performance/lighting-stability'
mkdirSync(out,{recursive:true})
const results=[],errors=[]
const b=await playwright().chromium.launch({executablePath:findGpuChromium(),args:GPU_ARGS})
try{
 const p=await b.newPage({viewport:{width:1440,height:960}});p.setDefaultTimeout(120000)
 p.on('pageerror',e=>errors.push(e.message))
 await p.goto(process.env.LAB_URL??'http://localhost:5173');await p.getByTestId('station-station-selector').click();await p.waitForFunction(()=>window.__lab?.ready)
 await p.getByRole('button',{name:'Graphics settings'}).first().click();await p.locator('[data-preset=high]').click();await p.keyboard.press('Escape')
 await p.waitForFunction(()=>window.__lab?.ready&&!window.__lab.disposed&&window.__lab.settings.lighting==='high')
 await p.waitForFunction(()=>{const w=window.__lab;return w.ready&&w.debugInfo().bake.main==='final'})
 await p.evaluate(()=>{const w=window.__lab;w.setMode('walk');w.setView({x:2.8,y:1.4,z:.7},{x:-4.4,y:1.27,z:.7});window.__baseYaw=w.yaw;window.__basePitch=w.pitch;window.__stableWorld=w})
 for(const mode of ['plain','refine','high-default','ultra-effects','no-projection']){
  await p.evaluate(mode=>{
   const w=window.__lab;w.setLive({...w.settings,minDynamicScale:1,refine:['refine','high-default','ultra-effects'].includes(mode),bloom:['high-default','ultra-effects'].includes(mode),ao:mode==='ultra-effects'?'full':'off'})
   if(mode==='no-projection'){w.scene.traverse(o=>{for(const m of Array.isArray(o.material)?o.material:[o.material])if(m?.envNode){m.envNode=null;m.needsUpdate=true}})}
  },mode)
  for(const [name,delta] of [['a',0],['b',.0005],['back',0]]){
   await p.evaluate(d=>{const w=window.__lab;if(w!==window.__stableWorld||w.disposed)throw new Error('World changed during comparison');w.player.set(2.8,1.4,.7);w.yaw=window.__baseYaw+d;w.pitch=window.__basePitch;w.applyView();w.requestRender()},delta)
   // Frames must be flowing before the wait: the first switch to a new post
   // chain can stall the GPU process for seconds (no animation frames), and a
   // capture then read a stale frame with the glare frozen mid-ease.
   await p.evaluate(()=>new Promise(r=>{let n=0;const f=()=>(++n>=10?r():(window.__lab.requestRender(),requestAnimationFrame(f)));requestAnimationFrame(f)}))
   await p.waitForTimeout(1500)
   const shot=await p.evaluate(async({mode,name})=>{
    const w=window.__lab,png=w.renderer.domElement.toDataURL('image/png')
    const img=new Image();img.src=png;await img.decode()
    const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0)
    const pixels=ctx.getImageData(0,0,c.width,c.height).data
    if(name==='a')window.__lightingBaseline=pixels.slice()
    let sum=0,max=0;for(let i=0;i<pixels.length;i++)if(i%4!==3){const d=Math.abs(pixels[i]-window.__lightingBaseline[i]);sum+=d;max=Math.max(max,d)}
    // Temporal AA/AO can change fine edge/stipple pixels between converged
    // frames. Measure regional illumination separately from that fine detail.
    const grid=[]
    for(let gy=0;gy<12;gy++)for(let gx=0;gx<16;gx++){
     const sums=[0,0,0];let count=0
     for(let y=Math.floor(gy*c.height/12);y<Math.floor((gy+1)*c.height/12);y++)for(let x=Math.floor(gx*c.width/16);x<Math.floor((gx+1)*c.width/16);x++){
      const i=(y*c.width+x)*4;sums[0]+=pixels[i];sums[1]+=pixels[i+1];sums[2]+=pixels[i+2];count++
     }
     grid.push(...sums.map(value=>value/count))
    }
    if(name==='a')window.__lightingGrid=grid
    const regionalMeanDifference=grid.reduce((total,value,i)=>total+Math.abs(value-window.__lightingGrid[i]),0)/grid.length
    return {png,meanDifference:sum/(c.width*c.height*3),regionalMeanDifference,maxDifference:max,settings:w.settings,eye:w.player.toArray(),yaw:w.yaw,pitch:w.pitch}
   },{mode,name})
   const {png,...metrics}=shot;results.push({mode,name,delta,...metrics})
   writeFileSync(`${out}/${mode}-${name}.png`,Buffer.from(png.split(',')[1],'base64'))
   console.log('SHOT',mode,name,metrics.meanDifference,'regional',metrics.regionalMeanDifference)
   if(name==='back')assert.ok(mode==='plain'||mode==='no-projection'?metrics.meanDifference<0.01:metrics.regionalMeanDifference<1,'Returning to the same pose must restore stable regional illumination')
  }
 }
 assert.equal(errors.length,0,errors.join('\n'))
}finally{writeFileSync(`${out}/report.json`,JSON.stringify({results,errors,scope:'Fixed High geometry/world, tiny yaw move and return; separate plain, refinement, shipped High effects, Ultra effects and unprojected-reference variants. Ultra shadow/geometry costs are not emulated.'},null,2));await b.close()}

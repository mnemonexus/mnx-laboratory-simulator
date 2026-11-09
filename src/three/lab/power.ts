import * as THREE from 'three'
import type { LabCtx } from './context'
import type { Batch } from './kit'
import { outlet } from './casework'
import { ANCHORS, DOORS, TV, WINDOWS, ZONES, doorWidth, type ZoneId } from './layout'
import { powerInlet, powerRecords, type PowerDevice, type PowerSocket } from './powerRecords'

export interface PowerConnectionReport {
  zone: string
  devices: number
  sockets: number
  connected: number
  connections: { id: string; kind: string; supply: string; socket: string; port: number; start: number[]; end: number[]; length: number }[]
}

function nearestWall(zone: ZoneId, p: THREE.Vector3, sockets: PowerSocket[]) {
  const def = ZONES[zone], floor = def.floor
  const center = floor.reduce((s,v) => s.add(new THREE.Vector2(...v)),new THREE.Vector2()).multiplyScalar(1/floor.length)
  const candidates: { point: THREE.Vector3; normal: THREE.Vector3; distance: number }[] = []
  for(let i=0;i<floor.length;i++) {
    const a=new THREE.Vector2(...floor[i]),b=new THREE.Vector2(...floor[(i+1)%floor.length]),v=b.clone().sub(a),len=v.length()
    const t=Math.max(.12,Math.min(len-.12,new THREE.Vector2(p.x,p.z).sub(a).dot(v)/len))
    v.multiplyScalar(1/len)
    const normal=new THREE.Vector3(-v.y,0,v.x)
    if(normal.x*(center.x-a.x)+normal.z*(center.y-a.y)<0) normal.negate()
    for(const offset of [0,.18,-.18,.36,-.36,.6,-.6,1,-1]) {
      const along=Math.max(.12,Math.min(len-.12,t+offset))
      const point=new THREE.Vector3(a.x+v.x*along,0,a.y+v.y*along).addScaledVector(normal,.002)
      if(DOORS.some(d=>(d.a===zone||d.b===zone)&&Math.hypot(point.x-d.center[0],point.z-d.center[1])<doorWidth(d)/2+.13)) continue
      if(sockets.some(s=>new THREE.Vector3().setFromMatrixPosition(s.frame).distanceTo(new THREE.Vector3(point.x,s.frame.elements[13],point.z))<.17)) continue
      candidates.push({point,normal,distance:Math.hypot(p.x-point.x,p.z-point.z)})
    }
  }
  candidates.sort((a,b)=>a.distance-b.distance)
  if(!candidates.length) throw new Error(`No available power service position in ${zone}`)
  return candidates[0]
}

function serviceSocket(b: Batch, device: PowerDevice) {
  const records=powerRecords(b),wall=nearestWall(b.zone,device.inlet,records.sockets)
  // A central instrument gets a flush floor service box beneath its table, not a lead across an aisle.
  if(wall.distance>1.4) {
    const p=device.lead.clone();p.y=.018
    while(records.sockets.some(s=>new THREE.Vector3().setFromMatrixPosition(s.frame).distanceTo(p)<.17)) p.x+=.18
    const frame=new THREE.Matrix4().makeRotationX(-Math.PI/2).setPosition(p)
    if(device.supply==='fixed') {
      b.within(frame,()=>{
        b.box('frame',0,0,-.005,.13,.13,.012,{color:'#797f82',radius:b.detail==='full'?.002:undefined})
        b.box('plastic',0,0,.006,.086,.086,.012,{color:'#e9eae5',radius:b.detail==='full'?.002:undefined})
        b.box('plastic',0,.007,.014,.028,.036,.005,{color:'#8c3937',radius:b.detail==='full'?.001:undefined})
      })
      const socket:PowerSocket={id:`${b.zone}:floor-isolator:${records.sockets.length}`,frame,ports:[{position:new THREE.Vector3(0,-.031,.018).applyMatrix4(frame)}]}
      records.sockets.push(socket)
      return socket
    }
    b.within(frame,()=>{
      b.box('frame',0,0,-.005,.176,.116,.012,{color:'#797f82',radius:b.detail==='full'?.002:undefined})
      outlet(b,0,0,0)
    })
    return records.sockets[records.sockets.length-1]
  }
  const p=wall.point
  p.y=device.baseY>.65&&device.baseY<1.3?Math.max(1.08,device.baseY+.15):device.baseY>=1.3?Math.max(.3,device.inlet.y-.10):.35
  for(const w of WINDOWS) {
    if(w.zone!==b.zone)continue
    const tangent=new THREE.Vector3(w.normal[1],0,-w.normal[0])
    const delta=p.clone().sub(new THREE.Vector3(w.center[0],p.y,w.center[1]))
    if(Math.abs(delta.dot(tangent))<w.width/2+.1&&Math.abs(delta.x*w.normal[0]+delta.z*w.normal[1])<.12&&p.y>w.sill-.05&&p.y<w.head+.05) p.y=w.sill-.052
  }
  const frame=new THREE.Matrix4().makeRotationY(Math.atan2(wall.normal.x,wall.normal.z)).setPosition(p)
  if(device.supply==='fixed') {
    b.within(frame,()=>{
      b.box('plastic',0,0,.006,.086,.086,.012,{color:'#e9eae5',radius:b.detail==='full'?.002:undefined})
      b.box('plastic',0,.007,.014,.028,.036,.005,{color:'#8c3937',radius:b.detail==='full'?.001:undefined})
      b.cyl('rubber',0,-.031,.018,.005,.005,.012,{color:'#30373a',seg:8})
    })
    const socket:PowerSocket={id:`${b.zone}:isolator:${records.sockets.length}`,frame,ports:[{position:new THREE.Vector3(0,-.031,.018).applyMatrix4(frame)}]}
    records.sockets.push(socket)
    return socket
  }
  b.within(frame,()=>outlet(b,0,0,0))
  return records.sockets[records.sockets.length-1]
}

function plug(b: Batch, socket: PowerSocket, port: number, fixed: boolean) {
  const frame=socket.frame.clone(), local=new THREE.Vector3().copy(socket.ports[port].position).applyMatrix4(frame.clone().invert())
  frame.multiply(new THREE.Matrix4().makeTranslation(local.x,local.y,local.z))
  if(fixed) return socket.ports[port].position.clone()
  b.within(frame,()=>{
    b.box('rubber',0,0,.013,.042,.045,.025,{color:'#252c30',radius:b.detail==='full'?.002:undefined})
    b.box('rubber',0,.002,.026,.025,.027,.001,{color:'#333a3e',radius:b.detail==='full'?.001:undefined})
    b.cyl('rubber',0,-.028,.013,.0045,.004,.014,{color:'#2c3336',seg:8})
  })
  return new THREE.Vector3(0,-.035,.013).applyMatrix4(frame)
}

export function connectPower(ctx: LabCtx): PowerConnectionReport[] {
  const reports:PowerConnectionReport[]=[]
  for(const [zone,b] of Object.entries(ctx.batch)) {
    const records=powerRecords(b)
    for(const device of records.devices) {
      if(device.connection)continue
      const candidates=records.sockets.flatMap(socket=>socket.ports.map((port,index)=>({socket,port,index,distance:port.position.distanceTo(device.lead)})))
        .filter(c=>!c.port.occupied&&c.distance<1.7&&device.supply==='plug'&&
          (new THREE.Vector3(0,0,1).transformDirection(c.socket.frame).y>.8 ||
            (device.baseY<.5?c.port.position.y<.7:device.baseY>1.3?c.port.position.y>1.3:c.port.position.y>.8)))
        .sort((a,b)=>a.distance-b.distance)
      const chosen=candidates[0]
      const socket=chosen?.socket??serviceSocket(b,device),index=chosen?.index??0
      const port=socket.ports[index]
      if(port.occupied) throw new Error(`Power socket port reused: ${socket.id}:${index}`)
      port.occupied=device.id
      const tail=plug(b,socket,index,device.supply==='fixed')
      const back=new THREE.Vector3(0,0,-1).transformDirection(device.frame)
      const normal=new THREE.Vector3(0,0,1).transformDirection(socket.frame)
      const surface=device.baseY>.65&&device.baseY<1.3?device.baseY+.005:device.baseY>=1.3?Math.min(tail.y,device.lead.y)-.045:.008
      const start=device.lead.clone(),clear=start.clone().addScaledVector(back,.035)
      const low=clear.clone();low.y=normal.y>.8?.09:surface
      const wall=tail.clone().addScaledVector(normal,.03);wall.y=normal.y>.8?.06:surface
      const rise=tail.clone().addScaledVector(normal,.012);rise.y=Math.max(wall.y,tail.y-.04)
      const path=[start,clear,low,low.clone().lerp(wall,.45),wall,rise,tail]
      const curve=new THREE.CatmullRomCurve3(path,false,'centripetal')
      const geo=new THREE.TubeGeometry(curve,b.detail==='full'?32:16,.003,b.detail==='full'?6:4,false)
      const pos=geo.getAttribute('position')
      const minY=normal.y>.8?.006:Math.min(surface,start.y,tail.y)-.003
      for(let i=0;i<pos.count;i++) pos.setY(i,Math.max(minY,pos.getY(i)))
      b.add('rubber',geo,undefined,'#242b2e')
      device.connection={socket:socket.id,port:index,path}
    }
    const connections=records.devices.map(d=>{
      if(!d.connection)throw new Error(`Unconnected mains device: ${d.id}`)
      const c=d.connection
      const socket=records.sockets.find(s=>s.id===c.socket),port=socket?.ports[c.port]
      if(!port||port.occupied!==d.id||c.path.length<2||c.path[0].distanceTo(d.lead)>.00001||c.path[c.path.length-1].distanceTo(port.position)>.05||c.path.some(p=>![p.x,p.y,p.z].every(Number.isFinite))) {
        throw new Error(`Invalid physical power connection: ${d.id}`)
      }
      return {id:d.id,kind:d.kind,supply:d.supply,socket:c.socket,port:c.port,start:c.path[0].toArray(),end:c.path[c.path.length-1].toArray(),length:c.path.slice(1).reduce((n,p,i)=>n+p.distanceTo(c.path[i]),0)}
    })
    reports.push({zone,devices:records.devices.length,sockets:records.sockets.length,connected:connections.length,connections})
  }
  return reports
}

/** These instruments are persistent runtime models, so their cable endpoints have fixed anchors. */
export function permanentInstrumentPower(ctx: LabCtx) {
  const add=(zone:string,kind:string,pos:number[],yaw:number,back:number,height:number)=>ctx.batch[zone].at(pos[0],pos[1],pos[2],yaw,()=>powerInlet(ctx.batch[zone],kind,0,height,-back,'plug',0))
  add('main','working plate reader',ANCHORS.reader.pos,ANCHORS.reader.yaw,.255,.065)
  add('cold','working centrifuge',ANCHORS.centrifuge.pos,ANCHORS.centrifuge.yaw,.24,.06)
  add('cold','chromatography pump',ANCHORS.chromatography.skid,0,.13,.06)
  const yaw=Math.atan2(TV.faces[0]-TV.pos[0],TV.faces[1]-TV.pos[2])
  add('main','wall display',[...TV.pos],yaw,.035,-.12)
}

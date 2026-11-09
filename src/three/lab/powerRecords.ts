import * as THREE from 'three'
import type { Batch } from './kit'

export interface PowerDevice {
  id: string
  kind: string
  frame: THREE.Matrix4
  inlet: THREE.Vector3
  lead: THREE.Vector3
  bounds?: THREE.Box3
  baseY: number
  supply: 'plug' | 'fixed'
  connection?: { socket: string; port: number; path: THREE.Vector3[] }
}
export interface PowerSocket {
  id: string
  frame: THREE.Matrix4
  ports: { position: THREE.Vector3; occupied?: string }[]
}
export interface PowerRecords { devices: PowerDevice[]; sockets: PowerSocket[] }
const inventories = new WeakMap<Batch, PowerRecords>()
export function powerRecords(b: Batch) {
  let records = inventories.get(b)
  if (!records) { records = { devices: [], sockets: [] }; inventories.set(b, records) }
  return records
}
export function registerSocket(b: Batch, x: number, y: number, z: number) {
  const records = powerRecords(b)
  const frame = b.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, z))
  const center = new THREE.Vector3().setFromMatrixPosition(frame)
  const existing = records.sockets.find(s => new THREE.Vector3().setFromMatrixPosition(s.frame).distanceTo(center) < .01)
  if (existing) return existing
  const socket: PowerSocket = { id:`${b.zone}:socket:${records.sockets.length}`,frame,
    ports:[-.033,.033].map(px => ({ position:new THREE.Vector3(px,0,.012).applyMatrix4(frame) })) }
  records.sockets.push(socket)
  return socket
}

/** IEC inlet and cable grip are part of the appliance, in its own transformed frame. */
export function powerInlet(b: Batch, kind: string, x: number, y: number, z: number, supply: 'plug' | 'fixed' = 'plug', baseY = 0) {
  const records = powerRecords(b), frame = b.matrix.clone()
  const inlet = new THREE.Vector3(x,y,z).applyMatrix4(frame)
  const existing = records.devices.find(d => d.kind === kind && d.inlet.distanceTo(inlet) < .015)
  if (existing) return existing
  const device: PowerDevice = { id:`${b.zone}:${kind}:${records.devices.length}`,kind,frame,inlet,
    lead:new THREE.Vector3(x,y,z-.024).applyMatrix4(frame),supply,baseY:new THREE.Vector3(0,baseY,0).applyMatrix4(frame).y }
  records.devices.push(device)
  b.box('rubber',x,y,z,.024,.016,.004,{color:'#24292c',radius:b.detail==='full'?.001:undefined})
  b.box('rubber',x,y,z-.010,.019,.012,.018,{color:'#181e21',radius:b.detail==='full'?.001:undefined})
  b.cyl('rubber',x,y,z-.022,.004,.0035,.009,{color:'#252b2e',rx:Math.PI/2,seg:8})
  return device
}

/** A powered builder must create physical geometry before its inlet is registered. */
export function appliance(b: Batch, kind: string, build: () => void, supply: 'plug' | 'fixed' = 'plug') {
  const measured = b.measure(build), box = measured.first
  if (box.isEmpty()) throw new Error(`Powered appliance ${kind} has no physical body`)
  // the housing (first part built) shades the bench and wall around it in the bake
  b.occlude(box)
  const height = box.max.y - box.min.y
  const y = box.min.y + Math.min(height * .35, height > .65 ? .18 : .04)
  const device = powerInlet(b,kind,(box.min.x+box.max.x)/2,y,box.min.z-.002,supply,box.min.y)
  device.bounds = measured.bounds.clone().applyMatrix4(b.matrix)
  return device
}

/** Fixed luminaires and control plates terminate in a junction behind their mounting surface. */
export function fixedFeed(b: Batch, kind: string, point: THREE.Vector3, termination: THREE.Vector3) {
  const records=powerRecords(b),frame=b.matrix.clone()
  const start=point.clone().applyMatrix4(frame),end=termination.clone().applyMatrix4(frame)
  const id=`${b.zone}:${kind}:${records.devices.length}`,socket=`${b.zone}:junction:${records.sockets.length}`
  records.sockets.push({id:socket,frame:new THREE.Matrix4().setPosition(end),ports:[{position:end,occupied:id}]})
  records.devices.push({id,kind,frame,inlet:start,lead:start,baseY:start.y,supply:'fixed',connection:{socket,port:0,path:[start,end]}})
  b.rod('frame',point,termination,.0025,'#a0a7aa')
  b.box('frame',termination.x,termination.y,termination.z,.022,.016,.022,{color:'#b8bdbe'})
}

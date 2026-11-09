import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { LabCtx } from './context'
import { connectPower } from './power'
import { appliance, fixedFeed, powerRecords } from './powerRecords'
import { outlet } from './casework'
import { doorVariation, veneerBox } from './furnitureFinishes'

const atlas={texture:new THREE.Texture(),uv:()=>[0,0,1,1] as [number,number,number,number]}

describe('mains connections',()=>{
  it('measures an appliance body in its own frame and attaches its inlet to the back',()=>{
    const ctx=new LabCtx('reduced',atlas),b=ctx.batch.main
    b.at(1,.9,-1.5,Math.PI/2,()=>appliance(b,'test instrument',()=>b.box('plastic',0,.1,0,.4,.2,.3)))
    const d=powerRecords(b).devices[0]
    const local=d.inlet.clone().applyMatrix4(d.frame.clone().invert())
    expect(local.x).toBeCloseTo(0);expect(local.y).toBeCloseTo(.04);expect(local.z).toBeCloseTo(-.152)
  })

  it('allocates a different socket port to every device and adds capacity instead of overlapping plugs',()=>{
    const ctx=new LabCtx('reduced',atlas),b=ctx.batch.main
    b.at(0,0,-1.8,0,()=>outlet(b,0,1.1))
    for(let i=0;i<3;i++)b.at(i*.15,.9,-1.4,0,()=>appliance(b,`device ${i}`,()=>b.box('plastic',0,.05,0,.1,.1,.1)))
    const report=connectPower(ctx).find(r=>r.zone==='main')!
    expect(report.connected).toBe(3)
    expect(new Set(report.connections.map(c=>`${c.socket}:${c.port}`)).size).toBe(3)
    expect(report.sockets).toBeGreaterThanOrEqual(2)
    const records=powerRecords(b)
    for(const d of records.devices) {
      expect(d.connection!.path[0].distanceTo(d.lead)).toBeLessThan(1e-8)
      const socket=records.sockets.find(s=>s.id===d.connection!.socket)!
      expect(socket.ports[d.connection!.port].occupied).toBe(d.id)
      expect(d.connection!.path.at(-1)!.distanceTo(socket.ports[d.connection!.port].position)).toBeLessThan(.05)
    }
    expect(connectPower(ctx).find(r=>r.zone==='main')!.connected).toBe(3)
  })

  it('rejects a dangling or corrupted connection even when marked connected',()=>{
    const ctx=new LabCtx('reduced',atlas),b=ctx.batch.main
    appliance(b,'test supply',()=>b.box('plastic',0,.1,0,.2,.2,.2))
    connectPower(ctx)
    powerRecords(b).devices[0].connection!.socket='missing'
    expect(()=>connectPower(ctx)).toThrow('Invalid physical power connection')
  })

  it('uses floor service ports for central equipment and reuses only free ports',()=>{
    const ctx=new LabCtx('reduced',atlas),b=ctx.batch.main
    for(let i=0;i<3;i++)b.at(i*.05,.9,0,0,()=>appliance(b,`central instrument ${i}`,()=>b.box('plastic',0,.1,0,.1,.2,.15)))
    const report=connectPower(ctx).find(r=>r.zone==='main')!
    expect(report.connected).toBe(3)
    const records=powerRecords(b)
    expect(records.sockets.length).toBe(2)
    expect(records.sockets.every(s=>new THREE.Vector3(0,0,1).transformDirection(s.frame).y>.9)).toBe(true)
    expect(report.connections.every(c=>c.length<1.5)).toBe(true)
  })

  it('keeps new wall sockets below window glazing',()=>{
    const ctx=new LabCtx('reduced',atlas),b=ctx.batch.main
    b.at(4,.9,0,0,()=>appliance(b,'window instrument',()=>b.box('plastic',0,.05,0,.12,.1,.12)))
    connectPower(ctx)
    const socket=powerRecords(b).sockets[0]
    expect(socket.frame.elements[13]+.043).toBeLessThan(1)
  })

  it('terminates fixed lights behind their mounting surface and rejects empty appliance declarations',()=>{
    const ctx=new LabCtx('reduced',atlas),b=ctx.batch.main
    fixedFeed(b,'task light',new THREE.Vector3(0,1.44,0),new THREE.Vector3(0,1.48,0))
    expect(connectPower(ctx).find(r=>r.zone==='main')!.connected).toBe(1)
    expect(powerRecords(b).devices[0].supply).toBe('fixed')
    expect(()=>appliance(b,'missing model',()=>{})).toThrow('no physical body')
  })
})

describe('door veneer mapping',()=>{
  it('keeps grain continuous between leaf pieces and gives each door a stable variation',()=>{
    const a=veneerBox(0,.5,.012,2.11,-.022,.022,.91,2.12,'entrance')
    const b=veneerBox(.5,.91,.012,2.11,-.022,.022,.91,2.12,'entrance')
    const atEdge=(g:THREE.BufferGeometry)=>{
      const p=g.getAttribute('position'),uv=g.getAttribute('uv'),result:number[][]=[]
      for(let i=0;i<p.count;i++)if(Math.abs(p.getX(i)-.5)<1e-6&&Math.abs(p.getY(i)-2.11)<1e-6)result.push([uv.getX(i),uv.getY(i)])
      return result
    }
    expect(atEdge(a)[0][0]).toBeCloseTo(atEdge(b)[0][0],6)
    expect(atEdge(a)[0][1]).toBeCloseTo(atEdge(b)[0][1],6)
    expect(doorVariation('entrance')).toEqual(doorVariation('entrance'))
    expect(doorVariation('entrance')).not.toEqual(doorVariation('cold'))
    for(let i=0;i<80;i++) {
      const v=doorVariation(`door-${i}`)
      expect(v.x+v.scale).toBeLessThan(1);expect(v.y+v.scale).toBeLessThan(1)
    }
    a.dispose();b.dispose()
  })
})

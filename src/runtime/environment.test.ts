import { describe, expect, it } from 'vitest'
import { EnvironmentMachines, machinePolicy } from './environment'

describe('room apparatus empty runs', () => {
  it('blocks measurement without manufacturing a reading', () => {
    const machines = new EnvironmentMachines()
    expect(machines.activate('main:plate reader:0', 'plate reader').message).toContain('No sample loaded')
    expect(machines.isRunning('main:plate reader:0')).toBe(false)
    expect(machines.update(100)).toEqual([])
  })
  it('runs and completes an empty centrifuge with an explicit non-result', () => {
    const machines = new EnvironmentMachines()
    expect(machines.activate('cold:centrifuge:0', 'working centrifuge').message).toContain('Empty rotor')
    expect(machines.isRunning('cold:centrifuge:0')).toBe(true)
    expect(machines.update(3)).toEqual([])
    expect(machines.update(3)[0].message).toContain('No pellet')
    expect(machines.isRunning('cold:centrifuge:0')).toBe(false)
    expect(machines.update(10)).toEqual([])
  })
  it('supports stopping and restarting a running machine', () => {
    const machines = new EnvironmentMachines()
    machines.activate('main:vortex:0', 'vortex mixer')
    expect(machines.activate('main:vortex:0', 'vortex mixer').message).toContain('Stopped')
    expect(machines.update(10)).toEqual([])
    machines.activate('main:vortex:0', 'vortex mixer')
    expect(machines.update(6)).toHaveLength(1)
  })
  it('allows an empty optical scan but reports only an unusable background', () => {
    const machines = new EnvironmentMachines()
    expect(machines.activate('C01:spec:0', 'spec').message).toContain('background')
    expect(machines.update(6)[0].message).toContain('no valid sample spectrum')
  })
  it('keeps sample-independent controls on until switched off', () => {
    const machines = new EnvironmentMachines()
    machines.activate('main:microscope:0', 'compound microscope')
    expect(machines.update(600)).toEqual([])
    expect(machines.isRunning('main:microscope:0')).toBe(true)
    machines.activate('main:microscope:0', 'compound microscope')
    expect(machines.isRunning('main:microscope:0')).toBe(false)
  })
  it('distinguishes dry-operation hazards, interlocks and empty thermal cycles', () => {
    expect(machinePolicy('waterBath').blocked).toContain('working liquid')
    expect(machinePolicy('chromatography pump').blocked).toContain('working liquid')
    expect(machinePolicy('UV transilluminator').blocked).toContain('shield')
    expect(machinePolicy('thermal cycler').blocked).toBeUndefined()
    expect(machinePolicy('thermal cycler').warning).toContain('hot')
  })
})

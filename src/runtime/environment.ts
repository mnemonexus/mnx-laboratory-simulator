// Room apparatus controls. Empty runs have mechanical outcomes only: they never
// manufacture a sample, measurement, assessment or practical completion.
export interface MachinePolicy {
  action: string
  blocked?: string
  running: string
  complete: string
  continuous?: boolean
  warning?: string
}

export function machinePolicy(kind: string): MachinePolicy {
  const name = kind.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase()
  if (/uv|transilluminator|tlc lamp|laser|xray|x ray/.test(name)) return {
    action: 'Check interlock', blocked: 'Start blocked: a closed, verified safety shield is required. Use a configured practical to operate this instrument.', running: '', complete: '',
  }
  if (/water bath|sonicator|ultrasonic|pump|hplc|chromatography|rotavap|organ bath|bioreactor|digester|furnace/.test(name)) return {
    action: 'Start', blocked: 'Start blocked: no working liquid or configured load. Load and configure this instrument in a practical first.', running: '', complete: '',
  }
  if (/\bspec\b|spectrophotometer|ftir|polarimeter/.test(name)) return {
    action: 'Scan empty holder', running: 'Scanning an empty holder. Any signal is unreferenced background, not a sample measurement.',
    complete: 'Empty-holder scan finished. Only background was observed; no valid sample spectrum or concentration can be reported.',
  }
  if (/reader|analyser|analyzer|counter|calorimeter|melting point|potentiostat|instrument|gc|\bms\b|nmr/.test(name)) return {
    action: 'Read', blocked: 'No sample loaded. A valid reading needs a sample and the appropriate blank or calibration. Prepare these in the instrument workspace or a practical.', running: '', complete: '',
  }
  if (/balance/.test(name)) return {
    action: 'Tare empty pan', running: 'Taring the empty pan…', complete: 'Empty pan tared. There is no sample mass to record.',
  }
  if (/microscope/.test(name)) return {
    action: 'Switch on', running: 'Illumination on. No slide is on the stage: only an empty illuminated field is visible.', complete: 'Illumination off.', continuous: true,
  }
  if (/vortex|stirrer|shaker|ball mill/.test(name)) return {
    action: 'Run empty', running: 'Running empty. The drive is on, but there is no sample to mix.', complete: 'Empty run finished. No mixing or sample change occurred.',
  }
  if (/centrifuge|microfuge/.test(name)) return {
    action: 'Run empty', running: 'Empty rotor cycle. No separation or pellet can be produced.', complete: 'Empty rotor stopped. No pellet or supernatant was produced.',
  }
  if (/thermal|thermocycler|oven|incubator|stirrer|hotplate|heater/.test(name)) return {
    action: 'Start empty cycle', running: 'Empty chamber cycle running. No sample is being processed.', complete: 'Empty cycle finished. No product was generated.', warning: 'Heating cycle: the chamber may become hot even without a sample.',
  }
  if (/fridge|freezer|cold|hood|bsc|extractor/.test(name)) return {
    action: 'Switch on', running: 'Environmental control on. It can operate without a sample; no experiment result is generated.', complete: 'Environmental control stopped.', continuous: true,
  }
  if (/computer|display|console|pc/.test(name)) return {
    action: 'Switch on', running: 'Power on. No acquisition is configured.', complete: 'Power off.', continuous: true,
  }
  return { action: 'Inspect', blocked: 'No load or operating method configured. Select a practical to configure this apparatus.', running: '', complete: '' }
}

export interface MachineState { running: boolean; remaining: number; policy: MachinePolicy }
export interface EnvironmentNotice { tone: 'info' | 'warning'; title: string; message: string }

export class EnvironmentMachines {
  readonly states = new Map<string, MachineState>()
  activate(id: string, kind: string): EnvironmentNotice {
    const policy = machinePolicy(kind)
    let state = this.states.get(id)
    if (!state) { state = { running: false, remaining: 0, policy }; this.states.set(id, state) }
    if (state.running) {
      state.running = false; state.remaining = 0
      return { tone: 'info', title: kind, message: 'Stopped. No sample was processed.' }
    }
    if (policy.blocked) return { tone: 'warning', title: kind, message: policy.blocked }
    state.running = true; state.remaining = policy.continuous ? Infinity : 6
    return { tone: policy.warning || /empty/i.test(policy.running) ? 'warning' : 'info', title: kind, message: [policy.warning, policy.running].filter(Boolean).join(' ') }
  }
  update(dt: number): EnvironmentNotice[] {
    const notices: EnvironmentNotice[] = []
    for (const [id, state] of this.states) {
      if (!state.running || !Number.isFinite(state.remaining)) continue
      state.remaining -= dt
      if (state.remaining <= 0) {
        state.running = false; state.remaining = 0
        notices.push({ tone: 'info', title: id.split(':').slice(1, -1).join(' ') || 'Instrument', message: state.policy.complete })
      }
    }
    return notices
  }
  isRunning(id: string) { return this.states.get(id)?.running === true }
}

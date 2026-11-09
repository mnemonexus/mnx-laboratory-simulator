import { installScientificNumerics, type ScientificNumerics } from '../../packages/lab-core/src/models/numerics.ts'
import { SCIENCE_WASM_BASE64, SCIENCE_WASM_SHA256 } from './science.wasm.gen.ts'
import type { AcidBaseSystem } from '../../packages/lab-core/src/models/acidbase.ts'
import type { ComplexSystem, Speciation } from '../../packages/lab-core/src/models/complexation.ts'

export const RUST_SCIENCE_ABI = 6

/**
 * The few WebAssembly calls used, typed locally so this module also compiles where DOM typings are
 * absent (the CLI and tests check against the core's no-DOM configuration).
 */
interface WasmApi { instantiate(bytes: Uint8Array): Promise<{ instance: { exports: unknown } }> }
const wasm = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly

interface RustExports {
  memory: { buffer: ArrayBuffer }
  lab_api_version: () => number
  lab_scratch_ptr: () => number
  lab_scratch_capacity: () => number
  lab_solve_ph: (length: number, temperatureK: number) => number
  lab_population_delta: (viable: number, rate: number, dt: number, available: number) => number
  lab_speciate: (length: number, pH: number) => number
  lab_solve_complex_ph: (length: number, temperatureK: number) => number
  lab_redox: (length: number, pH: number, temperatureK: number, volumeL: number) => number
  lab_enthalpy: (length: number, volumeL: number, temperatureK: number, pH: number) => number
  lab_fit_four_pl: (count: number) => number
  lab_fit_michaelis_menten: (count: number) => number
  lab_equilibrium: (length: number) => number
}
export async function createRustScience(bytes?: Uint8Array): Promise<ScientificNumerics> {
  const binary = bytes ?? Uint8Array.from(atob(SCIENCE_WASM_BASE64), character => character.charCodeAt(0))
  const compiled = await wasm.instantiate(binary as Uint8Array<ArrayBuffer>)
  const exports = compiled.instance.exports as RustExports
  if (exports.lab_api_version() !== RUST_SCIENCE_ABI) throw new Error('Unsupported Rust scientific ABI')
  const capacity = exports.lab_scratch_capacity()
  const finite = (result: number) => { if (!Number.isFinite(result)) throw new Error('Scientific input is outside the Rust model domain'); return result }
  const fitBatch = (xs: readonly number[], ys: readonly number[], fields: number, solve: (count: number) => number) => {
    const n = xs.length
    if (n !== ys.length) throw new Error('Scientific fit requires paired x and y observations')
    if (n > Math.floor((capacity - fields) / 3)) throw new Error('Scientific batch exceeds the Rust ABI capacity')
    const input = new Float64Array(exports.memory.buffer, exports.lab_scratch_ptr(), capacity)
    xs.forEach((x, index) => { input[2 * index] = x; input[2 * index + 1] = ys[index] })
    if (solve(n) !== 1) throw new Error('Scientific fit input is outside the Rust model domain')
    // Fitting allocates Jacobians and may grow memory. Output is copied so the
    // next scientific batch cannot mutate an already-recorded fit.
    const output = new Float64Array(exports.memory.buffer, exports.lab_scratch_ptr() + 2 * n * 8, fields + n)
    return { values: Array.from(output.subarray(0, fields)), residuals: Array.from(output.subarray(fields), finite), n }
  }
  const complexBatch = (cs: ComplexSystem, warm?: { z?: number[] }, systems: readonly AcidBaseSystem[] = []) => {
    // One batch crosses the ABI for a complete coupled pH/speciation solve.
    // No JS callback or JSON serialization occurs inside the Newton iterations.
    const values = [cs.ligands.length, cs.ions.length, cs.pairs.length]
    for (const ligand of cs.ligands) values.push(ligand.total, ligand.pKa.length, ...ligand.pKa)
    values.push(...cs.ions.map(ion => ion.total))
    for (const pair of cs.pairs) values.push(pair.ligand, pair.ion, pair.logK)
    const n = cs.ligands.length + cs.ions.length
    const start = warm?.z?.length === n ? warm.z : []
    values.push(start.length, ...start, systems.length)
    for (const system of systems) values.push(system.total, system.charge, system.spectator, system.pKa.length, ...system.pKa, cs.ligands.findIndex(ligand => ligand.substance === system.substance))
    const outputLength = n + cs.pairs.length + cs.ions.length
    if (values.length + outputLength > capacity) throw new Error('Scientific batch exceeds the Rust ABI capacity')
    new Float64Array(exports.memory.buffer, exports.lab_scratch_ptr(), capacity).set(values)
    return { length: values.length, n }
  }
  const complexResult = (cs: ComplexSystem, batch: { length: number; n: number }, warm?: { z?: number[] }): Speciation => {
    // Reacquire after the call; Rust allocations may grow the Wasm memory.
    const memory = new Float64Array(exports.memory.buffer, exports.lab_scratch_ptr(), capacity)
    let cursor = batch.length
    if (warm) warm.z = Array.from(memory.subarray(cursor, cursor + batch.n))
    cursor += batch.n
    const bound: Speciation['bound'] = Object.fromEntries(cs.ligands.map(ligand => [ligand.substance, {}]))
    for (const pair of cs.pairs) {
      const ligand = bound[cs.ligands[pair.ligand].substance], ion = cs.ions[pair.ion].ion
      ligand[ion] = (ligand[ion] ?? 0) + finite(memory[cursor++])
    }
    const freeIon = Object.fromEntries(cs.ions.map(ion => [ion.ion, finite(memory[cursor++])]))
    return { bound, freeIon }
  }
  return {
    version: 'lab-numerics/1', implementation: 'rust-wasm',
    solvePH(systems, temperatureK, complexes, warm) {
      if (complexes) {
        const batch = complexBatch(complexes, warm, systems)
        const pH = finite(exports.lab_solve_complex_ph(batch.length, temperatureK))
        complexResult(complexes, batch, warm)
        return pH
      }
      // Refresh on every batch: a Wasm memory.grow invalidates earlier views.
      const memory = new Float64Array(exports.memory.buffer, exports.lab_scratch_ptr(), capacity)
      let cursor = 0
      for (const system of systems) {
        if (cursor + 4 + system.pKa.length > capacity) throw new Error('Scientific batch exceeds the Rust ABI capacity')
        memory[cursor++] = system.total; memory[cursor++] = system.charge; memory[cursor++] = system.spectator; memory[cursor++] = system.pKa.length
        memory.set(system.pKa, cursor); cursor += system.pKa.length
      }
      return finite(exports.lab_solve_ph(cursor, temperatureK))
    },
    speciate(complexes, pH, warm) {
      const batch = complexBatch(complexes, warm)
      if (exports.lab_speciate(batch.length, pH) !== 1) throw new Error('Scientific input is outside the Rust model domain')
      return complexResult(complexes, batch, warm)
    },
    redox(couples, pH, temperatureK, volumeL) {
      const length = 6 * couples.length
      if (length + 2 + couples.length > capacity) throw new Error('Scientific batch exceeds the Rust ABI capacity')
      const input = new Float64Array(exports.memory.buffer, exports.lab_scratch_ptr(), capacity)
      couples.forEach((couple, index) => input.set([couple.n, couple.e0, couple.protons, couple.k, couple.oxMol, couple.redMol], 6 * index))
      if (exports.lab_redox(length, pH, temperatureK, volumeL) !== 1) throw new Error('Scientific input is outside the Rust model domain')
      const output = new Float64Array(exports.memory.buffer, exports.lab_scratch_ptr(), capacity)
      const potentialV = finite(output[length])
      return output[length + 1] === 1 ? { potentialV, reducedMol: Array.from(output.subarray(length + 2, length + 2 + couples.length), finite) } : { potentialV }
    },
    populationDelta(viable, rate, dt, available) { return finite(exports.lab_population_delta(viable, rate, dt, available)) },
    fitFourPL(xs, ys) {
      const { values: v, residuals, n } = fitBatch(xs, ys, 10, exports.lab_fit_four_pl)
      return { model: 'four-pl', a: v[0], d: v[1], c: v[2], b: v[3], seA: v[4], seD: v[5], seC: v[6], seB: v[7], r2: v[8], sy: v[9], n, residuals }
    },
    fitMichaelisMenten(xs, ys) {
      const { values: v, residuals, n } = fitBatch(xs, ys, 5, exports.lab_fit_michaelis_menten)
      return { model: 'michaelis-menten', vmax: v[0], km: v[1], seVmax: v[2], seKm: v[3], r2: v[4], n, residuals }
    },
    equilibrium(problem, warm) {
      const n0 = problem.totals.length
      const charges = problem.charges?.length === n0 ? problem.charges : new Array<number>(n0).fill(0)
      const values: number[] = [n0, ...problem.totals, ...charges, problem.charges?.length === n0 ? (problem.daviesA ?? 0) : 0, problem.species.length]
      for (const sp of problem.species) {
        values.push(sp.lnBeta, sp.terms.length)
        for (const [j, a] of sp.terms) values.push(j, a)
      }
      values.push(problem.solids.length)
      for (const so of problem.solids) {
        values.push(so.lnK, so.terms.length)
        for (const [j, b] of so.terms) values.push(j, b)
      }
      const start = warm && warm.length === problem.totals.length ? warm : []
      values.push(start.length, ...start)
      const n = problem.totals.length
      if (values.length + 1 + n + problem.species.length + problem.solids.length > capacity) throw new Error('Scientific batch exceeds the Rust ABI capacity')
      new Float64Array(exports.memory.buffer, exports.lab_scratch_ptr(), capacity).set(values)
      if (exports.lab_equilibrium(values.length) !== 1) throw new Error('Scientific input is outside the Rust model domain')
      // Reacquire the view: Rust allocations may grow the Wasm memory.
      const out = new Float64Array(exports.memory.buffer, exports.lab_scratch_ptr(), capacity)
      let cursor = values.length
      const converged = out[cursor++] === 1
      const z = Array.from(out.subarray(cursor, cursor + n), finite); cursor += n
      const conc = Array.from(out.subarray(cursor, cursor + problem.species.length), finite); cursor += problem.species.length
      const solid = Array.from(out.subarray(cursor, cursor + problem.solids.length), finite)
      return { converged, z, conc, solid }
    },
    chemicalEnthalpy(systems, volumeL, temperatureK, pH) {
      const input = new Float64Array(exports.memory.buffer, exports.lab_scratch_ptr(), capacity)
      let cursor = 0
      for (const system of systems) {
        if (system.pKa.length !== system.ionisationJ.length) throw new Error('Scientific enthalpy sites must pair pKa and ionisation energy')
        if (cursor + 2 + 2 * system.pKa.length > capacity) throw new Error('Scientific batch exceeds the Rust ABI capacity')
        input[cursor++] = system.moles; input[cursor++] = system.pKa.length
        system.pKa.forEach((pKa, index) => { input[cursor++] = pKa; input[cursor++] = system.ionisationJ[index] })
      }
      return finite(exports.lab_enthalpy(cursor, volumeL, temperatureK, pH))
    },
  }
}
export async function initialiseRustScience() {
  const kernel = await createRustScience()
  installScientificNumerics(kernel)
  return { implementation: kernel.implementation, abi: kernel.version, wasmAbi: RUST_SCIENCE_ABI, sha256: SCIENCE_WASM_SHA256 }
}

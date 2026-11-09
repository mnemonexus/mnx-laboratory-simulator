import type { AcidBaseSystem } from './acidbase.ts'
import type { ComplexSystem, Speciation } from './complexation.ts'
import type { FourPLFit, MichaelisMentenFit } from '../analysis/analysis.ts'

/** Versioned numerical engine. Browser production installs the Rust/Wasm implementation. */
export interface ScientificNumerics {
  readonly version: 'lab-numerics/1'
  readonly implementation: 'rust-wasm'
  solvePH(systems: readonly AcidBaseSystem[], temperatureK: number, complexes?: ComplexSystem, warm?: { z?: number[] }): number
  speciate(complexes: ComplexSystem, pH: number, warm?: { z?: number[] }): Speciation
  redox(couples: readonly RedoxCouple[], pH: number, temperatureK: number, volumeL: number): { potentialV: number; reducedMol?: number[] }
  chemicalEnthalpy(systems: readonly EnthalpySystem[], volumeL: number, temperatureK: number, pH: number): number
  populationDelta(viable: number, ratePerS: number, seconds: number, availableCells: number): number
  fitFourPL(xs: readonly number[], ys: readonly number[]): FourPLFit
  fitMichaelisMenten(xs: readonly number[], ys: readonly number[]): MichaelisMentenFit
  /** General aqueous equilibrium (tableau method with Davies activities, ABI v6): see models/ionic.ts. */
  equilibrium(problem: EquilibriumProblem, warm?: readonly number[]): EquilibriumSolution
}
/** Scientific inputs only; catalogue identities and inventory transactions stay in the core. */
export interface RedoxCouple { n: number; e0: number; protons: number; k: number; oxMol: number; redMol: number }
export interface EnthalpySystem { moles: number; pKa: readonly number[]; ionisationJ: readonly number[] }
/**
 * Components' totals (mol/L; component 0 is H⁺), species as ln β with their composition in
 * components, and solids as ln K of dissolution with their composition: a solid is present only
 * where Π (free component)^b reaches K.
 */
export interface EquilibriumProblem {
  totals: number[]
  /** Each component's charge and the Davies A (log₁₀ units): with A > 0, z is log activity and γ follows the ionic strength. */
  charges?: number[]
  daviesA?: number
  species: Array<{ lnBeta: number; terms: Array<[number, number]> }>
  solids: Array<{ lnK: number; terms: Array<[number, number]> }>
}
/** Log free activities of the components (concentrations when ideal), each species' concentration and each solid's amount (mol/L). */
export interface EquilibriumSolution { converged: boolean; z: number[]; conc: number[]; solid: number[] }
let installed: ScientificNumerics | null = null
export function installScientificNumerics(kernel: ScientificNumerics | null) { installed = kernel }
export function scientificNumerics() { return installed }
/**
 * The installed engine, for kernels that exist only in Rust (the general equilibrium solver). The
 * add-on installs it at start-up, the tests in their set-up and the CLI when it starts.
 */
export function requireNumerics(): ScientificNumerics {
  if (!installed) throw new Error('The Rust science module is not installed (initialiseRustScience)')
  return installed
}
export function populationDelta(viable: number, ratePerS: number, seconds: number, availableCells = Infinity) {
  return installed ? installed.populationDelta(viable, ratePerS, seconds, availableCells)
    : ratePerS < 0 ? viable * (Math.exp(ratePerS * seconds) - 1) : Math.min(viable * ratePerS * seconds, availableCells)
}

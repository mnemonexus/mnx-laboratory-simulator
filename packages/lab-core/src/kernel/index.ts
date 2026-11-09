export * from './state.ts'
export * from './kernel.ts'
export * from './materials.ts'
export * from './world.ts'
export { BENCH_OPERATIONS } from './ops-bench.ts'
export { DATA_OPERATIONS, calibrationOf, type CalibrationResult, type GroupMean, type Layout, type LayoutEntry, type StoredFit } from './ops-data.ts'
import { BENCH_OPERATIONS } from './ops-bench.ts'
import { DATA_OPERATIONS } from './ops-data.ts'
import { MICRO_OPERATIONS } from './ops-micro.ts'
import { SEPARATION_OPERATIONS } from './ops-separation.ts'
import { MOLBIO_OPERATIONS } from './ops-molbio.ts'
import { MICROSCOPE_OPERATIONS } from './ops-microscope.ts'
import { STATS_OPERATIONS } from './ops-stats.ts'
import { SEQUENCE_OPERATIONS } from './ops-sequence.ts'
import { ATMOSPHERE_OPERATIONS } from './ops-atmosphere.ts'
import { GAS_OPERATIONS } from './ops-gas.ts'
import { ELECTRO_OPERATIONS } from './ops-electro.ts'
import { GASLAW_OPERATIONS } from './ops-gaslaws.ts'
import { GENETICS_OPERATIONS } from './ops-genetics.ts'
import { BEHAVIOUR_OPERATIONS } from './ops-behaviour.ts'
import { FLAME_OPERATIONS } from './ops-flame.ts'
import type { Catalogue } from '../catalogue/catalogue.ts'
import { Kernel, type KernelOptions } from './kernel.ts'
import type { World } from './state.ts'

/** Every operation the kernel implements, by catalogue id. */
export const OPERATIONS = { ...BENCH_OPERATIONS, ...DATA_OPERATIONS, ...MICRO_OPERATIONS, ...SEPARATION_OPERATIONS, ...MOLBIO_OPERATIONS, ...MICROSCOPE_OPERATIONS, ...STATS_OPERATIONS, ...SEQUENCE_OPERATIONS, ...ATMOSPHERE_OPERATIONS, ...GAS_OPERATIONS, ...FLAME_OPERATIONS, ...ELECTRO_OPERATIONS, ...GASLAW_OPERATIONS, ...GENETICS_OPERATIONS, ...BEHAVIOUR_OPERATIONS }

export function createKernel(cat: Catalogue, world: World, options: Partial<KernelOptions> = {}): Kernel {
  return new Kernel(cat, world, OPERATIONS, options)
}

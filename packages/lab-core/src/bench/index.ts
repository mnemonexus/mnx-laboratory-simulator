// Focused bench tools (learning tools "From Laboratory Simulator"): see bench.ts.
import { Catalogue } from '../catalogue/catalogue.ts'
import type { PackContent } from '../catalogue/types.ts'
import {
  BENCH_ASKS, BENCH_CHECKER_VERSION, BENCH_VERSION, benchAnswer, benchIssues, benchWrongBeliefs, checkBench, evaluateBench, indicatorColours,
  type BenchScene, type BenchTask, type BenchResponse,
} from './bench.ts'
import { BENCH_EQUIPMENT, BENCH_SUBSTANCES } from './slice.ts'

export * from './bench.ts'
export * from './slice.ts'

/** A bench over a set of packs (the whole catalogue, or the slice a host embeds), with every call bound to it. */
export function createBench(packs: readonly PackContent[]) {
  const { catalogue: cat } = Catalogue.build([...packs])
  const substances = BENCH_SUBSTANCES.filter((id) => cat.substances.has(id)).map((id) => {
    const def = cat.substances.get(id)!
    return { id, name: def.identity.name, formula: def.identity.formula, indicator: def.identity.class === 'indicator', colours: def.identity.class === 'indicator' ? indicatorColours(cat, id) : [] }
  })
  const equipment = BENCH_EQUIPMENT.filter((id) => cat.equipment.has(id)).map((id) => ({
    id, label: cat.equipment.get(id)!.label, kind: ['core:burette', 'core:volumetric-pipette', 'core:volumetric-flask', 'core:conical-flask', 'core:beaker'].find((c) => cat.isA(id, c)) ?? 'core:container',
  }))
  return {
    version: BENCH_VERSION,
    checkerVersion: BENCH_CHECKER_VERSION,
    asks: BENCH_ASKS,
    substances,
    equipment,
    issues: (scene: BenchScene, task?: BenchTask) => benchIssues(cat, scene, task),
    evaluate: (scene: BenchScene) => evaluateBench(cat, scene),
    answer: (scene: BenchScene, task: BenchTask) => benchAnswer(cat, scene, task),
    check: (scene: BenchScene, task: BenchTask, response: BenchResponse | null | undefined) => checkBench(cat, scene, task, response),
    wrongBeliefs: (scene: BenchScene, task: BenchTask) => benchWrongBeliefs(cat, scene, task),
    colours: (indicator: string) => indicatorColours(cat, indicator),
  }
}
export type Bench = ReturnType<typeof createBench>

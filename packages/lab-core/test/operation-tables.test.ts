// The kernel's operation table is merged from one table per file; a name used in two of them would
// silently replace the earlier operation (a gas syringe's "set volume" once replaced the pipette's).
import { describe, expect, it } from 'vitest'
import { ATMOSPHERE_OPERATIONS } from '../src/kernel/ops-atmosphere.ts'
import { BEHAVIOUR_OPERATIONS } from '../src/kernel/ops-behaviour.ts'
import { BENCH_OPERATIONS } from '../src/kernel/ops-bench.ts'
import { DATA_OPERATIONS } from '../src/kernel/ops-data.ts'
import { ELECTRO_OPERATIONS } from '../src/kernel/ops-electro.ts'
import { FLAME_OPERATIONS } from '../src/kernel/ops-flame.ts'
import { GAS_OPERATIONS } from '../src/kernel/ops-gas.ts'
import { GASLAW_OPERATIONS } from '../src/kernel/ops-gaslaws.ts'
import { GENETICS_OPERATIONS } from '../src/kernel/ops-genetics.ts'
import { MICRO_OPERATIONS } from '../src/kernel/ops-micro.ts'
import { MICROSCOPE_OPERATIONS } from '../src/kernel/ops-microscope.ts'
import { MOLBIO_OPERATIONS } from '../src/kernel/ops-molbio.ts'
import { SEPARATION_OPERATIONS } from '../src/kernel/ops-separation.ts'
import { SEQUENCE_OPERATIONS } from '../src/kernel/ops-sequence.ts'
import { STATS_OPERATIONS } from '../src/kernel/ops-stats.ts'

describe('operation tables', () => {
  it('no operation is defined in two files', () => {
    const tables = { ATMOSPHERE_OPERATIONS, BEHAVIOUR_OPERATIONS, BENCH_OPERATIONS, DATA_OPERATIONS, ELECTRO_OPERATIONS, FLAME_OPERATIONS, GAS_OPERATIONS, GASLAW_OPERATIONS, GENETICS_OPERATIONS, MICRO_OPERATIONS, MICROSCOPE_OPERATIONS, MOLBIO_OPERATIONS, SEPARATION_OPERATIONS, SEQUENCE_OPERATIONS, STATS_OPERATIONS }
    const where = new Map<string, string[]>()
    for (const [table, ops] of Object.entries(tables)) for (const id of Object.keys(ops)) where.set(id, [...(where.get(id) ?? []), table])
    expect([...where].filter(([, t]) => t.length > 1)).toEqual([])
  })
})

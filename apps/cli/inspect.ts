// Developer helper: rehearse a definition and print chosen step outputs as JSON.
//   node apps/cli/inspect.ts <def.json> <stepId>[.field] ... [--seed N] [--realism ideal|low|default|high] [--variant id]
import { Catalogue, compile, expandDefinition } from '../../packages/lab-core/src/index.ts'
import { loadAllPacks, readJson } from './fs-packs.ts'
import { initialiseRustScience } from '../../src/runtime/rustScience.ts'

// The production Rust/Wasm numerics, as in the add-on and the tests (some kernels exist only there).
await initialiseRustScience()

const args = process.argv.slice(2)
const take = (flag: string) => {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const seed = Number(take('--seed') ?? 1)
const realism = take('--realism') as 'ideal' | 'low' | 'default' | 'high' | undefined
const variant = take('--variant')
const [file, ...paths] = args
const { catalogue } = Catalogue.build(loadAllPacks())
const expanded = expandDefinition(readJson(file)).definitions
const chosen = expanded.find((d) => (variant ? d.id === variant : !d.variant))
if (!chosen) throw new Error(`No variant ${variant}; have ${expanded.map((d) => d.id).join(', ')}`)
const r = compile(chosen.json, catalogue, { seed, realism })
if (paths.includes('notebook')) for (const e of r.kernel?.world.notebook ?? []) console.log('notebook', e.field, JSON.stringify(e.value))
if (paths.includes('issues')) console.log('issues', JSON.stringify(r.rehearsal?.issues ?? r.validation.findings, null, 1))
for (const p of paths.filter((x) => x !== 'notebook' && x !== 'issues')) {
  const [step, ...fields] = p.split('.')
  let v: unknown = r.run?.outputs[step]
  for (const f of fields) v = (v as Record<string, unknown> | undefined)?.[f]
  console.log(p, JSON.stringify(v))
}

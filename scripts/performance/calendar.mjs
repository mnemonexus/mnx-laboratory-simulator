// Run with Bun: isolate the existing calendar scenario through the same mock
// host/browser runner used by addon:check, without changing its drive steps.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { kitDir, project } from '../addon/env.mjs'
const { runHeadless } = await import(pathToFileURL(join(kitDir(), 'tools/src/headless.ts')).href)
const scenario = { ...JSON.parse(readFileSync(join(project, 'scenarios/calendar.json'), 'utf8')), name: 'calendar', kind: 'experience' }
const result = await runHeadless(project, [scenario])
mkdirSync('output/performance', { recursive: true })
writeFileSync('output/performance/calendar-isolated.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
assert.ok(result.ran && result.outcomes.length === 1 && result.outcomes[0].ok, 'Unmodified calendar scenario passes in isolation')

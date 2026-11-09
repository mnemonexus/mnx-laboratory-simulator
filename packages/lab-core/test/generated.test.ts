import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generatedFiles, SCHEMA_DIR, transportSchema } from '../../../apps/cli/generated.ts'
import { schemaDepth } from '../src/schema/schema.ts'

const ALLOWED = new Set(['type', 'properties', 'required', 'items', 'enum', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'additionalProperties'])

function keywords(schema: unknown, out = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== 'object') return out
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    out.add(k)
    if (k === 'properties') for (const p of Object.values(v as object)) keywords(p, out)
    else if (k === 'items') keywords(v, out)
  }
  return out
}

describe('generated files', () => {
  it('are up to date (run npm run lab:generate)', () => {
    for (const [name, text] of Object.entries(generatedFiles())) {
      expect(readFileSync(join(SCHEMA_DIR, name), 'utf8'), name).toBe(text)
    }
  })

  it('the transport schema stays inside the host subset', () => {
    const t = transportSchema()
    expect([...keywords(t)].filter((k) => !ALLOWED.has(k))).toEqual([])
    expect(schemaDepth(t)).toBeLessThanOrEqual(12)
    expect(JSON.stringify(t)).not.toMatch(/anyOf|oneOf|\$ref/)
  })
})

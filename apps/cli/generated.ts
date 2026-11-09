// Files generated from the framework's sources and checked in under packages/lab-core/schema/.
// `npm run lab:generate` rewrites them; a test fails if they are out of date.
import { join } from 'node:path'
import { Catalogue, DEFINITION_DEFS, definitionSchema, exportManifest, FRAMEWORK_VERSION, toJsonSchema } from '../../packages/lab-core/src/index.ts'
import { loadAllPacks, REPO_ROOT } from './fs-packs.ts'

export const SCHEMA_DIR = join(REPO_ROOT, 'packages', 'lab-core', 'schema')

export function fullSchema() {
  return toJsonSchema(definitionSchema, {
    id: 'urn:lab-framework:schema:lab-experiment:0.1',
    title: 'Laboratory experiment definition (lab-experiment 0.1)',
    description: 'Generated from packages/lab-core/src/format/schema.ts by `npm run lab:generate`. Do not edit by hand.',
    defs: DEFINITION_DEFS,
  })
}

/** The host transport profile (format spec §19): the MnemoNexus learning-schema subset. */
export function transportSchema() {
  return toJsonSchema(definitionSchema, { id: '', title: '', defs: DEFINITION_DEFS, transport: { maxRefDepth: 3 } })
}

export function manifestText(cat?: Catalogue): string {
  const c = cat ?? Catalogue.build(loadAllPacks()).catalogue
  return JSON.stringify(exportManifest(c, { version: FRAMEWORK_VERSION, build: `lab-core-${FRAMEWORK_VERSION}` }), null, 2) + '\n'
}

export function generatedFiles(): Record<string, string> {
  return {
    'lab-experiment.schema.json': JSON.stringify(fullSchema(), null, 2) + '\n',
    'lab-experiment.transport.schema.json': JSON.stringify(transportSchema(), null, 2) + '\n',
    'capability-manifest.json': manifestText(),
  }
}

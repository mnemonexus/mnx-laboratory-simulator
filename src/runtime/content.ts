// The framework content the add-on ships: the catalogue packs and the curated definitions, read
// once at start-up from the pack's assets (assets/content/, written by `npm run content` from
// packages/pack-*/ and content.build.json), then the catalogue built from them and the launcher
// entries. Nothing here names a particular experiment.
//
// Loading is asynchronous and never throws (an uncaught error ends the run): its progress is a
// small external store (contentStatus / subscribeContent). Once it is ready, catalogue() and
// practicals() answer synchronously; before then they are empty.
import { Catalogue, expandDefinition, type LearningContext, type PackContent } from '../../packages/lab-core/src/index.ts'

/** The asset every build ships: which bundles to read, and the packs in install order. */
export const CONTENT_INDEX = 'assets/content/index.json'
/** Must match FORMAT in scripts/runtime/content.mjs. */
export const CONTENT_FORMAT = 'mnx-lab-content/1'

/** A curated definition, as its pack ships it. */
export interface DefinitionSource {
  pack: string
  file: string
  json: Record<string, unknown>
}

export interface LabContent {
  /** The catalogue packs, core first. */
  packs: PackContent[]
  /** The curated experiment definitions, by pack. */
  definitions: DefinitionSource[]
}

export type ContentStatus =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; packs: number; definitions: number }
  | { state: 'failed'; message: string }

/** Reads one of the pack's declared asset files (`host.asset`); null when it is unavailable. */
export type AssetReader = (path: string) => Promise<ArrayBuffer | Uint8Array | null>

let content: LabContent = { packs: [], definitions: [] }
let status: ContentStatus = { state: 'idle' }
let pending: Promise<ContentStatus> | null = null
let reader: AssetReader | null = null
const subs = new Set<() => void>()

export const contentStatus = (): ContentStatus => status

export function subscribeContent(fn: () => void): () => void {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

function setStatus(next: ContentStatus): ContentStatus {
  status = next
  for (const fn of subs) {
    try {
      fn()
    } catch (e) {
      console.error('Content subscriber failed:', e)
    }
  }
  return next
}

/**
 * Read the content from the pack's assets. Start it once at start-up; later calls share the same
 * load (or, after a failure, try again). Resolves with the outcome and never rejects.
 */
export function loadContent(read: AssetReader): Promise<ContentStatus> {
  if (status.state === 'ready') return Promise.resolve(status)
  if (pending) return pending
  reader = read
  setStatus({ state: 'loading' })
  const run = (async (): Promise<ContentStatus> => {
    try {
      const index = await readJson(read, CONTENT_INDEX)
      const paths = bundlePaths(index)
      if (typeof paths === 'string') return setStatus({ state: 'failed', message: paths })
      const bundles = await Promise.all(paths.map((p) => readJson(read, p)))
      const assembled = assembleContent(index, new Map(paths.map((p, i) => [p, bundles[i]])))
      if (typeof assembled === 'string') return setStatus({ state: 'failed', message: assembled })
      return installContent(assembled)
    } catch (e) {
      console.warn('The laboratory content could not be loaded:', e)
      return setStatus({ state: 'failed', message: (e as Error)?.message ?? String(e) })
    } finally {
      pending = null
    }
  })()
  pending = run
  return run
}

/** Try the last load again (the launcher's "Try again"). */
export function retryContent(): Promise<ContentStatus> {
  return reader ? loadContent(reader) : Promise.resolve(status)
}

/** True once the content is ready; false if it failed or nothing is loading it. */
export function whenContentReady(): Promise<boolean> {
  if (status.state === 'ready') return Promise.resolve(true)
  if (status.state !== 'loading' || !pending) return Promise.resolve(false)
  return pending.then(
    (s) => s.state === 'ready',
    () => false,
  )
}

/**
 * Install content directly (Node tests and tools: src/runtime/content.node.ts reads the same
 * asset files from disk). Replaces whatever was installed.
 */
export function installContent(next: LabContent): ContentStatus {
  content = next
  built = null
  entries = null
  return setStatus({ state: 'ready', packs: next.packs.length, definitions: next.definitions.length })
}

async function readJson(read: AssetReader, path: string): Promise<unknown> {
  const bytes = await read(path)
  if (!bytes) throw new Error(`The content file "${path}" is not available. The add-on may need reinstalling.`)
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (e) {
    throw new Error(`The content file "${path}" is damaged (${(e as Error).message}).`)
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The bundle files an index lists, or what is wrong with it. */
export function bundlePaths(index: unknown): string[] | string {
  if (!isObject(index) || index.format !== CONTENT_FORMAT) return `The content index is not in the expected format (${CONTENT_FORMAT}).`
  const paths = index.bundles
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) return 'The content index does not list its bundles.'
  return paths as string[]
}

/** The content from its index and bundles (parsed JSON, by path), or what is wrong with them. */
export function assembleContent(index: unknown, bundles: ReadonlyMap<string, unknown>): LabContent | string {
  const paths = bundlePaths(index)
  if (typeof paths === 'string') return paths
  const order = (index as { packs?: unknown }).packs
  if (!Array.isArray(order) || !order.every((p) => isObject(p) && typeof p.id === 'string')) return 'The content index does not list its packs.'
  const packs = new Map<string, PackContent>()
  const definitions: DefinitionSource[] = []
  for (const path of paths) {
    const b = bundles.get(path)
    if (!isObject(b) || b.format !== CONTENT_FORMAT || !Array.isArray(b.packs) || !Array.isArray(b.definitions)) return `The content file "${path}" is not in the expected format (${CONTENT_FORMAT}).`
    for (const p of b.packs) {
      const id = isObject(p) && isObject(p.pack) ? p.pack.id : undefined
      if (typeof id !== 'string') return `The content file "${path}" holds a pack without an id.`
      packs.set(id, p as unknown as PackContent)
    }
    for (const d of b.definitions) {
      if (!isObject(d) || typeof d.pack !== 'string' || typeof d.file !== 'string' || !isObject(d.json)) return `The content file "${path}" holds a damaged definition.`
      definitions.push(d as unknown as DefinitionSource)
    }
  }
  const ids = (order as Array<{ id: string }>).map((p) => p.id)
  const missing = ids.filter((id) => !packs.has(id))
  if (missing.length) return `The content is incomplete: no pack ${missing.map((id) => `"${id}"`).join(', ')}.`
  const rank = new Map(ids.map((id, i) => [id, i]))
  return {
    packs: ids.map((id) => packs.get(id)!),
    // By pack in install order, each pack's definitions in the order its bundle lists them.
    definitions: definitions.filter((d) => rank.has(d.pack)).sort((a, b) => rank.get(a.pack)! - rank.get(b.pack)!),
  }
}

let built: { catalogue: Catalogue; problems: string[] } | null = null
let empty: Catalogue | null = null

/** The catalogue, built on first use. Problems are reported, not thrown (an uncaught error ends the run). */
export function catalogue(): { catalogue: Catalogue; problems: string[] } {
  if (status.state !== 'ready') {
    empty ??= Catalogue.build([]).catalogue
    return { catalogue: empty, problems: ['The laboratory content has not loaded.'] }
  }
  if (!built) {
    const r = Catalogue.build(content.packs)
    built = { catalogue: r.catalogue, problems: r.findings.filter((f) => f.severity === 'error').map((f) => `${f.code} ${f.path}: ${f.message}`) }
  }
  return built
}

export interface PracticalEntry {
  id: string
  /** The definition this came from; a template's variants share it. */
  base: string
  title: string
  summary: string
  briefing?: string
  pack: string
  discipline: string
  contexts: LearningContext[]
  /** Audience level as the definition gives it ("ages-14-16", "undergraduate-1" …). */
  level?: string
  curricula: string[]
  topics: string[]
  /** Everything the catalogue search matches against, lower-cased. */
  searchText: string
  json: Record<string, unknown>
}

const CONTEXT_ORDER: LearningContext[] = ['practical-session', 'lecture-introduction', 'spaced-recall', 'transferal', 'assessment', 'open-exploration']

interface DefinitionJson {
  id: string
  title: string
  summary?: string
  briefing?: string
  context?: {
    intendedContexts?: LearningContext[]
    audience?: { level?: string; disciplines?: string[] }
    keywords?: string[]
    curricula?: string[]
    topics?: string[]
    concepts?: Array<{ label: string }>
  }
}

let entries: PracticalEntry[] | null = null

/** The curated definitions, each variant as its own practical, as the launcher lists them (none until the content is ready). */
export function practicals(): PracticalEntry[] {
  if (status.state !== 'ready') return []
  if (entries) return entries
  const labels = new Map(content.packs.map((p) => [p.pack.id, p.pack.label]))
  const out: PracticalEntry[] = []
  for (const d of content.definitions) {
    // A definition whose variants do not expand cleanly is left out rather than ending the run.
    const { definitions, problems } = expandDefinition(d.json)
    if (problems.length) {
      console.warn(`Definition ${(d.json as { id?: string }).id}: ${problems.map((p) => `${p.path} ${p.message}`).join('; ')}`)
      continue
    }
    for (const x of definitions) {
      const j = x.json as unknown as DefinitionJson
      const c = j.context ?? {}
      const contexts = (c.intendedContexts ?? ['practical-session']).filter((k) => CONTEXT_ORDER.includes(k))
      const discipline = labels.get(d.pack) ?? d.pack
      const searchText = [j.title, j.summary, discipline, ...(c.audience?.disciplines ?? []), ...(c.keywords ?? []), ...(c.curricula ?? []), ...(c.topics ?? []), ...(c.concepts ?? []).map((k) => k.label)]
        .filter(Boolean)
        .join(' | ')
        .toLowerCase()
      out.push({
        id: j.id,
        base: x.base,
        title: j.title,
        summary: j.summary ?? j.briefing ?? '',
        ...(j.briefing ? { briefing: j.briefing } : {}),
        pack: d.pack,
        discipline,
        contexts: contexts.length ? contexts : ['practical-session'],
        ...(c.audience?.level ? { level: c.audience.level } : {}),
        curricula: c.curricula ?? [],
        topics: c.topics ?? [],
        searchText,
        json: x.json as unknown as Record<string, unknown>,
      })
    }
  }
  entries = out
  return out
}

/**
 * Practicals matching a search: every word must appear somewhere in an entry (title, summary,
 * subject, keywords, curricula, topics, concepts). Title matches rank first.
 */
export function searchPracticals(list: readonly PracticalEntry[], query: string): PracticalEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...list]
  const scored: Array<[number, PracticalEntry]> = []
  for (const e of list) {
    if (!words.every((w) => e.searchText.includes(w))) continue
    const title = e.title.toLowerCase()
    scored.push([words.reduce((n, w) => n + (title.includes(w) ? 2 : 0) + (e.topics.some((t) => t.toLowerCase().includes(w)) ? 1 : 0), 0), e])
  }
  return scored.sort((a, b) => b[0] - a[0]).map(([, e]) => e)
}

/** Plain names for audience levels. */
export const LEVEL_LABELS: Record<string, string> = {
  'ages-14-16': 'Ages 14–16',
  'ages-16-19': 'Ages 16–19',
  'pre-university': 'Ages 16–19',
  technician: 'Technician',
  'undergraduate-1': 'University year 1',
  'undergraduate-2': 'University year 2',
}

export const CONTEXT_LABELS: Record<LearningContext, string> = {
  'practical-session': 'Practical session',
  'lecture-introduction': 'First look (guided)',
  'spaced-recall': 'Recall drill',
  transferal: 'Challenge',
  assessment: 'Assessment',
  'open-exploration': 'Open exploration',
}

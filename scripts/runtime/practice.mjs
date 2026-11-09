// Publish what the add-on can practise (practice-v1): assets/practice/catalogue.json, which
// MnemoNexus reads from the pack to offer the right practical beside the right material. The add-on
// itself never reads it.
//
// It is built from the content the add-on ships (assets/content/, which content.mjs writes first),
// through the same practicals() the launcher lists, so each template variant is its own activity and
// a launch finds exactly the practical the catalogue names. Everything comes from each definition's
// own metadata and the catalogue. Nothing here names a particular experiment.
//
//   npm run content                             regenerate (runs before dev, build and the addon scripts)
//   node scripts/runtime/practice.mjs --check   fail if the catalogue is stale or undeclared
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '../../packages/lab-core/src/index.ts'
import { assembleContent, bundlePaths, catalogue, CONTENT_INDEX, installContent, practicals } from '../../src/runtime/content.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const ASSET = 'assets/practice/catalogue.json'
const check = process.argv.includes('--check')

/** The contract's limits (PRACTICE_LIMITS). */
const MAX_TERMS = 32
const MAX_TERM_CHARS = 80
const MAX_SKILLS = 16
const MAX_REQUIRES = 16
const MAX_SUMMARY_CHARS = 600
const RECALL_MINUTES = 5
/** A study task runs at most 30 minutes (master plan 02 §4). */
const STUDY_MINUTES = 30
/** One bench action, read, chosen and done by someone who knows the practical. An estimate: no run has been timed. */
const SECONDS_PER_ACTION = 25

/** Which learning context suits each surface, best first. */
const STUDY_CONTEXTS = ['lecture-introduction', 'practical-session', 'transferal']
const PLANNER_CONTEXTS = ['transferal', 'practical-session', 'lecture-introduction']
const LEVELS = { 'ages-14-16': 1, 'ages-16-19': 2, 'pre-university': 2, technician: 2, 'undergraduate-1': 2, 'undergraduate-2': 3 }

const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'))

// ---- The content the add-on ships ----
if (!existsSync(join(root, CONTENT_INDEX))) {
  console.error(`${CONTENT_INDEX} is missing. Run "npm run content".`)
  process.exit(1)
}
const index = read(CONTENT_INDEX)
const paths = bundlePaths(index)
const content = typeof paths === 'string' ? paths : assembleContent(index, new Map(paths.map((p) => [p, read(p)])))
if (typeof content === 'string') {
  console.error(content)
  process.exit(1)
}
installContent(content)
const cat = catalogue().catalogue
const entries = practicals()

// ---- What a definition says about itself ----
const stepsOf = (list) => (list ?? []).flatMap((step) => [step, ...stepsOf(step.steps)])
const techniquesOf = (json) => [...new Set(stepsOf(json.procedure?.steps).map((step) => step.ref).filter((ref) => ref && cat.technique(ref)))]
const objectivesOf = (json) => json.context?.objectives ?? []
const objectiveSkills = (json) => [...new Set(objectivesOf(json).flatMap((o) => o.skills ?? []))]

/** Compare terms as MnemoNexus does: words only, ignoring case. */
const wordsOf = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Enough to mean something alone: several words, or a name ("SDS-PAGE", "pH"). */
const named = (phrase) => phrase.includes(' ') || /\S[A-Z0-9-]/.test(phrase)
/** A long word can too, in a title. In a label it is usually only the verb's object ("difference"). */
const tellsAlone = (phrase) => named(phrase) || phrase.length >= 10

/**
 * The phrases inside a title or a label, so the words a lecture would use can match without the
 * whole of it: "Water hardness by EDTA titration" gives "Water hardness" and "EDTA titration", and
 * "Prepare a dilution series" gives "dilution series". Only ever words already there; questions and
 * bracketed asides are dropped ("copper(II)" is not an aside).
 */
function phrasesOf(text, keep = tellsAlone) {
  return text
    .replace(/\s+\([^)]*\)/g, '')
    .split(/[:;?,]|\s+(?:by|from|with|using|and|for|in|on|at|to|under|across)\s+/i)
    .map((part) => part.trim().replace(/^(?:the|a|an)\s+/i, ''))
    .filter((part) => part && !/^(?:what|which|who|where|why|how|is|are|did|does|do|can)\b/i.test(part))
    .map((part) => {
      const topic = part.replace(/^\S+\s+(?:a|an|the)\s+/i, '').replace(/^\p{L}+ing\s+/iu, '')
      return keep(topic) ? topic : part
    })
    .filter(keep)
}

/** The instruments a practical uses, without their specifications. Glassware and consumables say nothing about the topic. */
function instrumentsOf(plan) {
  const items = Object.values(plan.bindings).map((binding) => cat.equipment.get(binding.equipment)).filter((item) => item?.kind === 'instrument')
  return [...new Set(items.map((item) => item.label.split(/[,(]/)[0].trim()))].filter(tellsAlone)
}

function termsFor(entry, plan) {
  const context = entry.json.context ?? {}
  const seen = new Set()
  const terms = []
  const add = (term) => {
    const words = typeof term === 'string' ? wordsOf(term) : ''
    if (words.length < 2 || term.length > MAX_TERM_CHARS || seen.has(words) || terms.length >= MAX_TERMS) return
    seen.add(words)
    terms.push(term.trim())
  }
  // Most specific first: the limit drops the least telling.
  for (const concept of context.concepts ?? []) add(concept.label)
  for (const topic of context.topics ?? []) add(topic)
  for (const keyword of context.keywords ?? []) add(keyword)
  add(entry.title)
  for (const phrase of phrasesOf(entry.title)) add(phrase)
  const labels = [...techniquesOf(entry.json).map((id) => cat.technique(id).label), ...objectiveSkills(entry.json).map((id) => cat.skills.get(id)?.label)].filter(Boolean)
  for (const label of labels) {
    if (!label.includes(' ')) add(label)
    for (const phrase of phrasesOf(label, named)) add(phrase)
  }
  for (const instrument of instrumentsOf(plan)) add(instrument)
  return terms
}

/** What it practises: its objectives first, then what its techniques and operations exercise. */
function skillsFor(json) {
  const refs = stepsOf(json.procedure?.steps).map((step) => step.ref).filter(Boolean)
  const exercised = refs.flatMap((ref) => [...(cat.technique(ref)?.skills ?? []), ...(cat.operations.get(ref)?.skills ?? [])])
  return [...new Set([...objectiveSkills(json), ...exercised])].filter((id) => cat.skills.has(id)).slice(0, MAX_SKILLS)
}

// ---- Families: what the host schedules, and rotates variants within ----
const spread = new Map() // skill → how many definitions (not variants) practise it
const bases = new Map() // base definition → its first entry
for (const entry of entries) if (!bases.has(entry.base)) bases.set(entry.base, entry)
for (const entry of bases.values()) for (const skill of objectiveSkills(entry.json)) spread.set(skill, (spread.get(skill) ?? 0) + 1)

/** The most specific skill of the weightiest objective, else the first technique, else the definition itself. */
function familyOf(json, base) {
  const weight = (objective) => objective.weight ?? 1
  const lead = objectivesOf(json).filter((o) => o.skills?.length).sort((a, b) => weight(b) - weight(a))[0]
  const skill = lead && [...lead.skills].sort((a, b) => (spread.get(a) ?? 0) - (spread.get(b) ?? 0))[0]
  return skill ?? techniquesOf(json)[0] ?? base
}

// ---- The activities ----
const left = []

/** The plan for a context and its estimated length, or null if this build cannot start it. */
function planFor(entry, context) {
  const { plan } = compile(entry.json, cat, { context, seed: 1, rehearse: false })
  if (!plan || plan.coverage.verdict === 'not-supported') return null
  const collapsed = new Set(plan.support.steps.filter((step) => step.collapsed).map((step) => step.step))
  const actions = (nodes) => nodes.reduce((sum, node) => sum + (node.children?.length ? actions(node.children) : 1), 0)
  const done = actions(plan.tree.filter((node) => !collapsed.has(node.id)))
  return { plan, minutes: Math.max(2, Math.ceil((done * SECONDS_PER_ACTION) / 60)) }
}

function activityFor(entry) {
  const contexts = {}
  const surfaces = []
  const pick = (options) => options.find((context) => entry.contexts.includes(context))
  const study = pick(STUDY_CONTEXTS)
  const planner = pick(PLANNER_CONTEXTS)
  const bench = planner ? planFor(entry, planner) : null
  const recall = entry.contexts.includes('spaced-recall') ? planFor(entry, 'spaced-recall') : null
  const fitsRecall = recall !== null && recall.minutes <= RECALL_MINUTES
  if (!bench && !fitsRecall) {
    left.push(`${entry.id} (${bench === null && !recall ? 'it cannot start in any context' : `its recall run takes about ${recall.minutes} minutes`})`)
    return null
  }
  const minutes = fitsRecall ? recall.minutes : bench.minutes
  if (fitsRecall) {
    surfaces.push('recall')
    contexts.recall = 'spaced-recall'
  }
  if (bench && study && bench.minutes <= STUDY_MINUTES) {
    surfaces.push('study')
    contexts.study = study
  }
  if (bench && bench.minutes > RECALL_MINUTES) {
    surfaces.push('planner')
    contexts.planner = planner
  }
  if (!surfaces.length) {
    left.push(`${entry.id} (no surface fits it)`)
    return null
  }
  const requires = (entry.json.context?.prerequisites?.skills ?? []).slice(0, MAX_REQUIRES)
  return {
    id: entry.id,
    title: entry.title,
    ...(entry.summary ? { summary: entry.summary.slice(0, MAX_SUMMARY_CHARS) } : {}),
    minutes,
    level: LEVELS[entry.level] ?? 1,
    terms: termsFor(entry, (bench ?? recall).plan),
    skills: skillsFor(entry.json),
    surfaces,
    family: familyOf(bases.get(entry.base).json, entry.base),
    ...(requires.length ? { requires } : {}),
    launch: { definition: entry.id, contexts },
  }
}

const activities = entries.map(activityFor).filter(Boolean)
const skills = Object.fromEntries([...cat.skills.values()].sort((a, b) => a.id.localeCompare(b.id)).map((skill) => [skill.id, { label: skill.label }]))
const practice = { version: 1, skills, activities }

// The kit may be absent where only the headless core is built; the app validates the catalogue on load either way.
const sdk = await import('@mnemonexus/addon-sdk/practice').catch(() => null)
if (sdk) {
  try {
    sdk.validatePracticeCatalogue(practice)
  } catch (e) {
    console.error(`The practice catalogue is not valid: ${e.message}`)
    process.exit(1)
  }
} else console.warn('warning: the add-on SDK is not installed, so the practice catalogue was not validated.')

// One activity per line, so a change shows as a small diff.
const text = `{"version":1,\n"skills":${JSON.stringify(skills)},\n"activities":[\n${activities.map((a) => JSON.stringify(a)).join(',\n')}\n]}\n`
const tally = (surface) => activities.filter((a) => a.surfaces.includes(surface)).length
const summary = `${activities.length} activities (study ${tally('study')}, recall ${tally('recall')}, planner ${tally('planner')}), ${new Set(activities.map((a) => a.family)).size} families, ${Object.keys(skills).length} skills`

// ---- The add-on manifest must publish it ----
const manifest = read('manifest.json')
const problems = [
  ...(manifest.practice?.catalogue === ASSET ? [] : [`manifest.json must have "practice": { "version": 1, "catalogue": "${ASSET}" }.`]),
  ...((manifest.assets ?? []).some((a) => a?.logicalPath === ASSET) ? [] : [`manifest.json does not declare "${ASSET}". Add { "logicalPath": "${ASSET}", "mimeType": "application/json" } to its "assets".`]),
]
for (const id of left) console.warn(`Not in the practice catalogue: ${id}.`)

const file = join(root, ASSET)
const current = existsSync(file) ? readFileSync(file, 'utf8') : null
if (check) {
  for (const p of problems) console.error(`error: ${p}`)
  if (current !== text) console.error(`The practice catalogue is stale (${ASSET}). Run "npm run content".`)
  if (current !== text || problems.length) process.exit(1)
  console.log(`The practice catalogue is up to date: ${summary}.`)
  process.exit(0)
}
for (const p of problems) console.warn(`warning: ${p}`)
if (current !== text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  console.log(`Wrote the practice catalogue: ${summary}.`)
}

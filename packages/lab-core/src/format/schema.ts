// The definition format's schema (format spec §3–§16), written once. It gives V1 validation
// and both published JSON Schemas: the full authoring schema and the transport schema (§19).
import {
  any,
  arr,
  bool,
  enm,
  int,
  map,
  num,
  obj,
  ref,
  type Schema,
  type SchemaDefs,
  str,
  union,
} from '../schema/schema.ts'
import { CATALOGUE_REF, LOCAL_ID, SEMVER } from './formats.ts'
import { FORMAT_ID, LEARNING_CONTEXTS, STEP_KINDS, VALIDITY_VERDICTS } from './types.ts'

const id = (description?: string) => str({ pattern: LOCAL_ID, description })
const catalogueRef = (description?: string) => str({ pattern: CATALOGUE_REF, description })
const text = (description?: string) => str({ description })
const quantity = (dimension?: string[], description?: string) =>
  str({ format: 'quantity', formatArgs: dimension ? { dimension } : undefined, description })
const predicate = (description?: string) => str({ format: 'predicate', description })
const ids = (description?: string) => arr(id(), { description })

const PROVENANCE_CLASSES = [
  'source-explicit',
  'source-inferred',
  'reference-standard',
  'general-knowledge',
  'framework-default',
  'author-choice',
  'simulation-derived',
] as const

const FIDELITY = ['prescribed', 'prescribed-tolerant', 'objective', 'open'] as const

const vary = obj(
  { vary: union([str({ format: 'quantity-or-range' }), arr(union([str(), num()], 0))], 0, { description: 'A range "lo..hi unit" or a list of choices' }) },
  { description: 'A value sampled from the run seed (normalised into variation.params for transport)' },
)

const varying = (description: string) => union([str({ format: 'quantity-or-expression' }), vary], 0, { description })

const concentration = obj(
  {
    substance: str({ description: 'A material id from materials.substances, or a catalogue reference' }),
    'conc?': varying('Concentration ("2.0 mg/mL")'),
    'count?': varying('Organisms or cells per volume ("1e9 CFU/mL")'),
    'mass?': varying('Mass of this component in a solid mixture ("1.0 g")'),
    'purity?': str({ format: 'quantity', description: 'Purity of a solid ("99.95 %")' }),
    'viability?': varying('Counted cells: the fraction alive ("92 %")'),
  },
  { description: 'One component; exactly one of conc, count or mass' },
)

const supply = obj(
  {
    id: id(),
    label: text('What the label says'),
    'role?': enm(['unknown', 'standard', 'control-positive', 'control-negative', 'blank', 'specimen', 'culture', 'product', 'reagent']),
    'contains?': arr(concentration),
    'solvent?': str(),
    'preparation?': catalogueRef('A catalogue preparation (recipe)'),
    'amount?': union([quantity(['volume', 'mass']), enm(['unlimited'])], 0, { description: 'A volume or mass, or "unlimited" for a bench supply' }),
    'container?': catalogueRef('An equipment class or model for the container'),
    'storage?': quantity(['temperature']),
    'water?': quantity(['volume'], "A wet solid's liquid (soil water): the components given by conc or count are in it"),
    'count?': union([int({ minimum: 1 }), obj({ vary: arr(int({ minimum: 1 })) })], 0),
    'truth?': obj(
      { 'contains?': arr(concentration), 'activityFactor?': num({ minimum: 0 }) },
      { description: 'Hidden truth overriding the label (faults, mislabelled stocks)' },
    ),
  },
  { description: 'A material present at the start' },
)

/** The flat step object (§8.1). Group steps nest through the Step definition. */
const step: Schema = obj(
  {
    id: id('Unique within the definition; stable across versions'),
    kind: enm(STEP_KINDS),
    'ref?': str({ description: 'Catalogue id of the operation, technique, data technique or design; or a purpose id' }),
    'title?': text(),
    'instructions?': text('Learner-facing text; overrides technique templates'),
    'params?': map(any(), { description: 'Parameters; quantities as strings; "=…" are expressions (checked at V3 against the referenced parameter specs)' }),
    'bind?': map(str(), { description: 'Role bindings: role → equipment role, material, container, or "learner"' }),
    'after?': ids('Dependencies'),
    'order?': enm(['strict', 'advisory']),
    'forEach?': obj({ var: str({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }), in: str({ format: 'expression' }), 'index?': str({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }) }),
    'repeat?': obj({ 'until?': predicate(), 'times?': union([int({ minimum: 1 }), str({ format: 'expression' })], 0), 'max?': int({ minimum: 1, maximum: 10000 }) }),
    'when?': predicate('The step is skipped unless this holds'),
    'duration?': quantity(['time']),
    'background?': bool(),
    'session?': id(),
    'critical?': arr(enm(['safety', 'quality', 'irreversible'])),
    'fidelity?': enm(FIDELITY),
    'objectives?': ids(),
    'prompt?': text(),
    'options?': arr(obj({ id: id(), label: text(), 'then?': id() })),
    'correctWhen?': predicate(),
    'outcome?': obj({ 'model?': catalogueRef(), 'declared?': text() }),
    'steps?': arr(ref('Step')),
    'notes?': text('Author notes; never shown to learners'),
    'let?': map(str({ format: 'expression' }), { description: 'Techniques: local values (name → expression)' }),
    'reference?': map(any(), { description: 'Techniques: what the reference agent chooses for learner choices' }),
  },
  { description: 'One step of a procedure or technique' },
)

export const DEFINITION_DEFS: SchemaDefs = { Step: step }

export const definitionSchema: Schema = obj(
  {
    format: enm([FORMAT_ID]),
    formatVersion: str({ pattern: '^[0-9]+\\.[0-9]+$', description: 'major.minor' }),
    id: id(),
    version: str({ pattern: SEMVER, description: "The definition's semantic version" }),
    title: text(),
    'language?': str({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }),
    'requires?': obj({
      'framework?': str({ description: 'Version range, e.g. ">=0.1"' }),
      'manifest?': str(),
      'capabilities?': arr(map(any())),
    }),
    'summary?': text(),
    'briefing?': text(),
    'context?': obj({
      'intendedContexts?': arr(enm(LEARNING_CONTEXTS)),
      'audience?': obj({ 'level?': str(), 'disciplines?': arr(str()) }),
      'keywords?': arr(str(), { description: 'Search terms for the catalogue' }),
      'curricula?': arr(str(), { description: 'Courses and qualifications where this practical appears (GCSE, A level, IB, AP …)' }),
      'topics?': arr(str(), { description: 'Catalogue topics (titration, electrochemistry, enzymes …)' }),
      'prerequisites?': obj({ 'skills?': arr(catalogueRef()), 'definitions?': arr(str()) }),
      'concepts?': arr(obj({ id: id(), label: text(), 'xref?': str() })),
      'objectives?': arr(
        obj({
          id: id(),
          kind: enm(['skill', 'outcome', 'reasoning', 'concept', 'practice', 'design', 'analysis']),
          statement: text(),
          'skills?': arr(catalogueRef()),
          'goal?': id(),
          'weight?': num({ minimum: 0 }),
        }),
      ),
    }),
    'materials?': obj({
      'substances?': arr(obj({ id: id(), 'ref?': catalogueRef(), 'inline?': map(any()) })),
      'supplies?': arr(supply),
      'samples?': arr(supply),
      'waste?': arr(obj({ stream: catalogueRef(), 'accepts?': ids() })),
    }),
    'equipment?': obj({
      'roles?': arr(obj({ id: id(), requires: map(any()), 'count?': int({ minimum: 1 }), 'truth?': obj({ 'bias?': text() }) })),
      'prescribed?': arr(obj({ role: id(), 'asNamed?': text(), 'class?': catalogueRef(), 'model?': catalogueRef() })),
      'excluded?': arr(obj({ class: catalogueRef(), 'reason?': text() })),
    }),
    'procedure?': obj({
      'fidelity?': enm(FIDELITY),
      'sessions?': arr(obj({ id: id(), 'title?': text() })),
      'steps?': arr(ref('Step')),
    }),
    'goals?': obj({
      'predicates?': arr(obj({ id: id(), 'statement?': text(), check: predicate() })),
      'expectedObservations?': arr(obj({ id: id(), 'at?': id(), statement: text(), 'check?': predicate(), 'source?': enm(PROVENANCE_CLASSES) })),
      'expectedResults?': arr(obj({ 'id?': id(), quantity: text(), value: quantity(), 'source?': enm(PROVENANCE_CLASSES), 'calibrateTo?': bool() })),
    }),
    'data?': obj({
      'datasets?': arr(obj({ id: id(), from: id(), 'description?': text() })),
      'notebook?': obj({
        'sections?': arr(str()),
        'required?': arr(obj({ id: id(), section: str(), prompt: text(), 'check?': predicate() })),
        'manualRecording?': arr(obj({ measurement: id(), mode: enm(['auto', 'manual', 'manual-checked']) })),
      }),
      'calculations?': arr(
        obj({
          id: id(),
          statement: text(),
          'inputs?': arr(str()),
          'answer?': obj({ 'unit?': str({ format: 'unit' }), 'per?': str() }),
          'accept?': obj({ 'fromOwnData?': quantity(), 'fromTruth?': quantity() }),
        }),
      ),
      'graphs?': arr(obj({ id: id(), kind: str(), x: text(), y: text(), 'fit?': arr(str()), 'learnerBuilds?': bool() })),
      'questions?': arr(obj({ id: id(), kind: str(), prompt: text(), 'rubric?': predicate(), 'options?': arr(str()) })),
      'report?': obj({ template: catalogueRef(), 'sections?': arr(str()) }),
    }),
    'assessment?': obj({
      'emphasis?': map(union([num({ minimum: 0 }), enm(['gate'])], 0)),
      'criteria?': arr(
        obj({
          id: id(),
          statement: text(),
          check: predicate(),
          'objective?': id(),
          'severity?': enm(['critical', 'major', 'minor']),
          'feedback?': obj({ 'kind?': str(), 'timing?': enm(['immediate', 'step-end', 'review', 'by-competence']) }),
          'tags?': arr(str()),
        }),
      ),
      'validity?': arr(obj({ when: predicate(), cap: enm(VALIDITY_VERDICTS), reason: text() })),
      'evidence?': obj({ 'checkpoints?': ids(), 'criteria?': union([enm(['all']), ids()], 0) }),
    }),
    'variation?': obj({
      'params?': arr(obj({ path: str({ format: 'pointer' }), domain: union([str({ format: 'quantity-or-range' }), arr(union([str(), num()], 0))], 0), 'step?': quantity() })),
      'constraints?': arr(predicate()),
      'faults?': arr(obj({ id: id(), 'probability?': num({ minimum: 0, maximum: 1 }), apply: map(any()), 'diagnostics?': arr(str()) })),
      'noise?': enm(['ideal', 'low', 'default', 'high']),
    }),
    'presentation?': obj({
      'scope?': enm(['station', 'bench', 'room', 'wing', 'facility']),
      'startAt?': obj({ 'place?': str() }),
      'insightLayers?': arr(str()),
      'time?': map(str()),
    }),
    'provenance?': obj({
      'sources?': arr(obj({ id: id(), kind: str(), title: text(), 'locator?': str(), 'access?': str(), 'date?': str() })),
      'defaultClass?': enm(PROVENANCE_CLASSES),
      'annotations?': arr(
        obj({
          path: str({ format: 'pointer' }),
          class: enm(PROVENANCE_CLASSES),
          'source?': id(),
          'quote?': text(),
          'confidence?': enm(['high', 'medium', 'low']),
          'note?': text(),
        }),
      ),
      'review?': obj({
        status: enm(['draft', 'generated-unreviewed', 'validated', 'reviewed', 'curated']),
        'generator?': obj({ name: str(), version: str() }),
        'reviewer?': str(),
      }),
    }),
    'parameters?': map(obj({ default: any(), 'description?': text() }), {
      keyPattern: '^[a-zA-Z][a-zA-Z0-9_-]*$',
      description: 'Variant parameters: "{{name}}" anywhere in the definition takes the value (§23)',
    }),
    'variants?': arr(
      obj({
        id: id(),
        title: text(),
        'summary?': text(),
        'briefing?': text(),
        'values?': map(any()),
        'keywords?': arr(str()),
        'curricula?': arr(str()),
      }),
      { description: 'Further practicals from this definition, each with its own parameter values (§23)' },
    ),
    'extensions?': map(any(), { keyPattern: '^[a-z][a-z0-9-]*$', description: 'Namespaced extension blocks; preserved, never interpreted by the core' }),
  },
  { description: 'An experiment definition (lab-experiment format)' },
)


// Functional-group reactions (contract kinetics.functional-group, T2). A class of reaction is
// declared once, by what it does to a functional group: an acid and an alcohol esterify, acidified
// dichromate oxidises a primary or secondary alcohol or an aldehyde, an anhydride acetylates a
// phenol or an amine. The class gives the rate law (its orders in its roles, its reagents and any
// catalyst; its order in H⁺ or OH⁻ from the liquid's pH), the rate constant at a temperature with
// its Arrhenius energy, the by-products, and, for a reversible class, its equilibrium constant.
// Each compound it applies to is one line in the class's `instances`: which substances fill its
// roles, what they make, and a relative rate where that compound reacts faster or slower. So a new
// ester, aldehyde or amide is a substance and one line of data, never a new reaction. Conditions
// decide the outcome through the same laws: temperature through the Arrhenius term, a catalyst
// through its order, an excess of one reagent through mass action and the equilibrium, reflux or
// distilling as it forms through where the product goes (models/stillhead.ts).
// Ideal: K is taken as independent of temperature (esterification is nearly thermoneutral), and
// the reaction's heat is not released.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { ModelDecl } from '../catalogue/types.ts'
import { parseValue } from '../units/quantity.ts'
import type { Reaction } from './processes.ts'

type Template = NonNullable<ModelDecl['template']>
type Instance = NonNullable<ModelDecl['instances']>[number]

/** The concrete mass-action reactions of one class for one instance: forward, and the reverse if it is reversible. */
export function instantiate(id: string, t: Template, inst: Instance): Reaction[] {
  const fill = (name: string): string => inst.from[name] ?? name
  const reactants: Array<[string, number]> = [...Object.entries(t.roles).map(([role, nu]): [string, number] => [fill(role), nu]), ...Object.entries(t.reagents ?? {})]
  const products: Array<[string, number]> = [[inst.product, t.product ?? 1], ...Object.entries(t.byproducts ?? {})]
  const orders: Array<[string, number]> = t.orders ? Object.entries(t.orders).map(([s, n]): [string, number] => [fill(s), n]) : reactants
  const atK = t.at ? parseValue(t.at).si : 298.15
  const eaJPerMol = t.ea ? parseValue(t.ea).si : 0
  const k = t.k * (inst.rate ?? 1)
  const forward: Reaction = { id: `${id}/${inst.product}`, reactants, products, orders, heterogeneous: [], hydroxide: t.hydroxide ?? 0, acid: t.acid ?? 0, k, atK, eaJPerMol }
  const K = inst.K ?? t.K
  if (!(K && K > 0)) return [forward]
  // The reverse runs at k/K, first order in each product (by its coefficient) and in the same
  // catalysts (what the forward orders name beyond its reactants), so the two balance at K.
  const used = new Set(reactants.map(([s]) => s))
  const catalysts = orders.filter(([s]) => !used.has(s))
  const reverse: Reaction = {
    id: `${id}/${inst.product}/reverse`,
    reactants: products,
    products: reactants,
    orders: [...products, ...catalysts],
    heterogeneous: [],
    hydroxide: t.hydroxide ?? 0,
    acid: t.acid ?? 0,
    k: k / K,
    atK,
    eaJPerMol,
  }
  return [forward, reverse]
}

/** Every functional-group class in the catalogue expanded into its mass-action reactions. */
export function functionalGroupReactions(cat: Catalogue): Reaction[] {
  const out: Reaction[] = []
  for (const m of cat.models.values()) {
    if (m.contract !== 'kinetics.functional-group' || !m.template) continue
    for (const inst of m.instances ?? []) out.push(...instantiate(m.id, m.template, inst))
  }
  return out
}

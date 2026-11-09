// Catalogue entries (capability model; composition model §5–§6; state model §3–§4).
// Everything here is data shipped in packs (packages/pack-*/catalogue/*.json). Operations and
// models are implemented in code and *declared* here, so that definitions, the manifest and
// gap reports can name them.
import type { StepDef } from '../format/types.ts'

export type Status = 'stable' | 'experimental' | 'stub'

export interface Provenance {
  /** Citations for numbers (tolerances, constants). */
  references?: string[]
  review?: 'pending' | 'reviewed'
  notes?: string
}

export interface PackManifest {
  /** The namespace: core, bio, chem, molbio, micro, cell, biomed, or a third-party one. */
  id: string
  version: string
  label: string
  description?: string
  dependsOn?: string[]
}

// ---- Purposes (capability model §3) ----

export interface PurposeDef {
  /** Un-namespaced, dotted: "measure-out.volume". The taxonomy is shared by all packs. */
  id: string
  label: string
  parent?: string
  signature?: { in: string[]; out: string[] }
  /** Performance dimensions by which providers are compared. */
  dimensions?: string[]
  /** Purposes that must happen first (measure.absorbance requires calibrate.blank). */
  requires?: string[]
  status: Status
  description?: string
}

// ---- Parameters and roles ----

export type ParamType =
  | 'quantity'
  | 'number'
  | 'integer'
  | 'text'
  | 'boolean'
  | 'enum'
  | 'material'
  | 'container'
  | 'equipment'
  | 'place'
  | 'list'
  | 'record'
  | 'any'

export interface ParamSpec {
  type: ParamType
  /** For quantities: the dimension name (volume, molarConcentration …). */
  dimension?: string
  values?: string[]
  items?: ParamSpec
  default?: unknown
  required?: boolean
  description?: string
}

export interface RoleSpec {
  kind: 'equipment' | 'container' | 'material' | 'place'
  /** Requirement fields: purpose, class, capacity (expression), accepts … (capability model §6.1). */
  requires?: Record<string, string>
  prefer?: string[]
  /** For a list of containers: how many (expression over parameters). */
  count?: string
  description?: string
}

// ---- Operations (composition model §5.1): declared here, implemented in the kernel ----

export interface OperationDecl {
  id: string
  label: string
  purposes: string[]
  /** bench operations change the material world; data operations act on records. */
  domain: 'bench' | 'data'
  params: Record<string, ParamSpec>
  status: Status
  description?: string
  /** Skills exercised when performed interactively. */
  skills?: string[]
}

// ---- Techniques (composition model §6) ----

export interface CriterionDef {
  id: string
  statement: string
  /** Expression over the run (evidence query). */
  check: string
  severity?: 'critical' | 'major' | 'minor'
  skills?: string[]
  feedbackKind?: 'procedural' | 'calculation' | 'measurement' | 'design' | 'interpretive' | 'practice' | 'safety'
}

export interface ErrorDef {
  id: string
  statement: string
  /** How it arises and which operation error channel produces its consequences. */
  consequence: string
  tag?: string
}

export interface TechniqueDef {
  id: string
  version: number
  status: Status
  label: string
  description?: string
  /** bench techniques act on materials; data techniques on records; design on plans. */
  mode?: 'bench' | 'data' | 'design'
  purposes: string[]
  params: Record<string, ParamSpec>
  roles?: Record<string, RoleSpec>
  /** Derived values: name → expression over parameters (evaluated in order). */
  derived?: Record<string, string>
  steps: StepDef[]
  /** Outputs: name → expression evaluated after the steps. */
  outputs?: Record<string, string>
  quality?: CriterionDef[]
  errors?: ErrorDef[]
  skills: string[]
  safety?: string[]
  variants?: Record<string, { label: string; params?: Record<string, unknown>; description?: string }>
  /** Default guidance per step id. */
  support?: Record<string, string>
  presentation?: { station?: string }
  provenance?: Provenance
}

// ---- Equipment (capability model §4–§5) ----

export interface CapabilityDescriptor {
  purpose: string
  /** Parameter ranges, as quantity strings ("20..200 uL"). */
  params?: Record<string, string>
  /** Performance per dimension ("0.8 %", "good"). */
  performance?: Record<string, string>
  /** Conditions for validity, as expressions over `material` and `context`. */
  constraints?: string[]
  /** Other purposes needed (a pipette needs a tip; absorbance needs a blank). */
  requires?: string[]
}

export interface ErrorPoint {
  volume: string
  /** Maximum systematic error, percent of nominal (ISO 8655 style). */
  systematic: number
  /** Maximum random error (CV), percent. */
  random: number
}

export interface EquipmentDef {
  id: string
  label: string
  level: 'class' | 'model'
  /** The class a model belongs to, or the parent class of a class. */
  parent?: string
  kind: 'container' | 'plate' | 'tool' | 'instrument' | 'device' | 'place' | 'consumable'
  capabilities: CapabilityDescriptor[]
  /** Physical properties: capacity, deadVolume, material, tareMass, pathLength, resolution … */
  properties?: Record<string, string | number | boolean>
  /** Plates: geometry and well properties. */
  format?: { rows: number; cols: number; well: Record<string, string | number | boolean> }
  /** Liquid-handling tools: error table by volume. */
  errors?: ErrorPoint[]
  representation: 'full' | 'panel' | 'stand-in' | 'abstract' | 'narrated'
  access?: 'self-use' | 'submission' | 'authorised'
  /** Skills exercised by using it. */
  skills?: string[]
  consumables?: string[]
  status: Status
  description?: string
  provenance?: Provenance
}

// ---- Substances and preparations (state model §3–§4) ----

export interface SubstanceDef {
  id: string
  identity: {
    name: string
    class:
      | 'small-molecule'
      | 'ion'
      | 'salt'
      | 'metal'
      | 'gas'
      | 'solvent'
      | 'protein'
      | 'enzyme'
      | 'nucleic-acid'
      | 'organism'
      | 'cell-line'
      | 'particle'
      | 'matrix'
      | 'indicator'
      | 'dye'
      | 'specimen'
    formula?: string
    synonyms?: string[]
    xrefs?: string[]
  }
  physical?: {
    molarMass?: string
    density?: string
    phase?: 'solid' | 'liquid' | 'gas'
    /** Melting point of the pure solid, and its enthalpy of fusion (for the depression of impure samples). */
    meltingPoint?: string
    enthalpyOfFusion?: string
    /** Enthalpy of vaporisation (kJ/mol, an average over the liquid range): with the boiling point it gives the vapour pressure. */
    enthalpyOfVaporisation?: string
    /**
     * A solid that melts into another substance's liquid (ice into water): it melts and freezes at its
     * melting point, taking or giving its enthalpy of fusion. A solid without it melts into itself.
     */
    meltsTo?: string
    /** Specific heat capacity, J/(g·K): how much heat a solid (a metal block) or a non-aqueous liquid holds. */
    specificHeat?: number
    /** How a solute thickens water: ln(η / mPa·s) rises by this much per unit of its volume fraction. */
    viscosityCoefficient?: number
    /** At 589 nm. A liquid close to glass's (about 1.52) is an immersion medium for oil objectives. */
    refractiveIndex?: number
    /** Undissolved grains (a powder): their diameter, which with the density sets how fast they settle out of a liquid (Stokes). */
    particleSize?: string
    /** Boiling point at 1 atm: what boils off first, and the temperature a refluxing solvent holds. */
    boilingPoint?: string
    /**
     * log₁₀ of the octanol–water partition coefficient of the uncharged form, taken as its partition
     * between an organic solvent layer and water. A substance without one stays in the water.
     */
    logP?: number
    /** A solvent that does not mix with water: how much of it water dissolves, and how much water it dissolves (per litre of solvent). */
    immiscible?: { inWater: string; holdsWater: string }
  }
  /**
   * A fluorophore: its emission maximum (nm), band half-width (nm), quantum yield, and, for a probe,
   * how it emits when bound to a protein (sites per protein, Kd).
   */
  fluorescence?: { emission: number; width?: number; yield: number; bound?: { to: string; kd: string; sites?: number; yield: number; emission: number } }
  /** Electrospray: how readily it ionises in each mode (0..1), where its groups alone would mislead. */
  ms?: { positive?: number; negative?: number }
  /** A drying agent: each mole binds up to `water` moles of water, becoming its hydrate. */
  drying?: { hydrate: string; water: number }
  /**
   * Solubility in water: a constant limit, or a curve over temperature (interpolated log-linearly).
   * For acids and bases the limit is for one acid–base form (`form`, default the uncharged one).
   */
  solubility?: {
    maxConc?: string
    curve?: Array<{ temperature: string; conc: string }>
    form?: number
    /** Salting out (Cohn): log₁₀ S (g/L) = beta − ks × [salt] (mol/L). */
    saltingOut?: { salt: string; beta: number; ks: number }
    /** What comes out of solution: crystals that settle, or a fine precipitate that stays suspended until centrifuged. */
    precipitate?: 'crystalline' | 'fine'
  }
  /** Molar absorption coefficients: [wavelength nm, ε in L mol⁻¹ cm⁻¹]; interpolated. */
  /**
   * Light absorbed (molar absorptivity by wavelength) and, for a colloid (casein micelles, colloidal
   * sulfur), light scattered: `turbidity` is the optical depth per (mg/mL × cm) at 600 nm, falling as
   * 1/λ; the colloid's body colour is its `look`.
   */
  optics?: { epsilon?: Array<[number, number]>; colour?: string; turbidity?: number }
  /** Infrared bands: [wavenumber cm^-1, relative strength, half-width cm^-1]. */
  ir?: Array<[number, number, number]>
  /**
   * Acid–base system: pKa values (ascending), the charge of the most protonated form, and
   * spectator ions supplied with it (Na⁺ in NaOH: +1; 2 Na⁺ in Na₂HPO₄: +2). Optional per-form
   * optics for indicators, from most to least protonated.
   */
  acidBase?: {
    pKa: number[]
    /** Ionisation enthalpy of each site (kJ/mol, in the order of pKa): what is absorbed when it loses its proton. */
    dH?: number[]
    charge?: number
    spectator?: number
    forms?: Array<{ epsilon?: Array<[number, number]>; colour?: string }>
  }
  /**
   * An ion carrier in the ionic model (models/ionic.ts): the ion as it is free in water, and the
   * species it forms with protons ("H+": −1 for a hydroxo complex) and other carriers (by
   * substance id), with log K of formation at 25 °C and ΔH (kJ/mol). A carrier stands for its
   * neutral acid or base (chloride for HCl, sodium for NaOH): protons are implicit.
   */
  aqueous?: {
    formula?: string
    charge: number
    species?: Array<{ formula: string; logK: number; dH?: number; with?: Record<string, number>; epsilon?: Array<[number, number]>; colour?: string }>
    /** A metal ion: the metal it is reduced to (a fine deposit) and the standard potential of the couple (V). */
    metal?: { deposit: string; e0: number }
    /** Standard enthalpy of formation of the ion at infinite dilution, kJ/mol (H⁺ = 0): what reaction heats are reckoned from. */
    dHf?: number
  }
  /** What the substance is made of in ion carriers (substance id → count): a salt dissolves to these. */
  ions?: Record<string, number>
  /**
   * A solid that dissolves to its `ions` (protons implicit: Cu(OH)₂ is Cu²⁺ less two protons) with
   * log K at 25 °C and ΔH of dissolution (kJ/mol); its body colour (display sRGB, 0–1) and look.
   */
  solid?: { logK: number; dH?: number; rgb?: [number, number, number]; look?: string; phase?: 'gas' }
  /**
   * Standard enthalpy of formation (kJ/mol) of the substance as a solid (a crystalline salt, marble)
   * or, for one outside the ionic model, as a solute (hydrogen peroxide); and the water its formula
   * holds beyond its ion carriers and their implicit protons (a hydroxide one, a pentahydrate five);
   * for a solid outside the ionic model, its enthalpy of solution at infinite dilution (kJ/mol).
   */
  thermo?: { dHf: number; water?: number; solution?: number }
  /** How a solid reagent looks in the vessel (a ribbon, chips, a deposit): its colour (display sRGB, 0–1) and a description. */
  look?: { rgb?: [number, number, number]; description: string }
  /**
   * A solid that reacts where the liquid touches it: specific surface area (ribbon, granules, powder,
   * chips) and its shape, which sets how the area falls as it is used up: a sheet (ribbon, foil) keeps
   * its area as it thins, a rod's goes as mass^½, a particle's (the default) as mass^⅔.
   */
  surface?: { m2PerG: number; shape?: 'sheet' | 'rod' | 'particle' }
  /**
   * A metal: the ion carrier it becomes, electrons lost per atom and the standard potential of
   * that couple (V). Rates per m² of surface (mol m⁻² s⁻¹ per mol/L): with acid (hydrogen given
   * off) and with ions of less reactive metals (displacement); activation energy in kJ/mol.
   */
  /** `corrodesTo`: the ion it ends as when it corrodes in air and water, where that is not `ion` (iron rusts to iron(III)). */
  metal?: { ion: string; charge: number; e0: number; acidK?: number; displaceK?: number; ea?: number; corrodesTo?: string }
  /** A solid that dissolves at its surface at a rate (marble chips, not a fresh precipitate): k × area × [H⁺]^order. */
  dissolution?: { k: number; order?: number; ea?: number }
  /**
   * A solid catalyst (manganese(IV) oxide on hydrogen peroxide): the substrate reacts on its surface
   * at k × area × [substrate] mol/s (k in mol m⁻² s⁻¹ per mol/L), giving these products per mol
   * (core:water joins the liquid); the catalyst itself is not used up.
   */
  catalyst?: { substrate: string; products: Record<string, number>; k: number; ea?: number }
  /** A gas: Henry's-law solubility (mol/L per atm) at 25 °C and its enthalpy of solution (kJ/mol); the aqueous species it is in equilibrium with. */
  gas?: { henry: number; dH?: number; species?: string }
  /**
   * An element's light in a flame (models/flame.ts): atomic lines and molecular bands, each with its
   * radiant power per mol in a Bunsen flame (the sodium D lines total 1000), a band's width (nm), and
   * the partner a band needs on the wire (CuCl needs chloride).
   */
  emission?: { lines: Array<{ nm: number; weight: number; width?: number; with?: string }> }
  /** First-order loss (activity for proteins, amount for labile reagents) at reference temperatures. */
  stability?: { halfLife4?: string; halfLife25?: string; halfLife37?: string; tm?: string }
  protein?: {
    pI?: number
    epsilon280?: number
    /** First-order activity loss: half-life at reference temperatures ("h"). */
    stability?: { halfLife4?: string; halfLife25?: string; halfLife37?: string; tm?: string }
    /** Colorimetric assay response relative to BSA. */
    assayResponse?: Record<string, number>
    /** Polypeptide chains: what SDS-PAGE separates (absent = one chain of the molar mass). */
    subunits?: Array<{ kDa: number; count: number }>
    /** A protein size marker: its bands (kDa) and the mass fraction in each. */
    ladder?: Array<{ kDa: number; fraction: number }>
    /** Dyed already, so it shows on a membrane without detection (a prestained marker). */
    prestained?: boolean
  }
  /**
   * DNA-binding proteins: the DNAs carrying their site, the dissociation constant, and an inducer
   * that weakens binding (IPTG on LacI) by `factor` when bound. A `nonspecific` binder takes any DNA
   * (only DNA with free ends if it `requiresEnds`: no closed circles), with one site per `footprintBp`.
   */
  dnaBinding?: { targets?: string[]; kd: string; inducer?: { substance: string; kd: string; factor: number }; nonspecific?: boolean; requiresEnds?: boolean; footprintBp?: number }
  /** Detergents: a denaturing one (SDS) unfolds proteins and coats them with charge. */
  detergent?: { denaturing: boolean }
  enzyme?: {
    substrates: string[]
    products: string[]
    /** Mol of each product per turnover where it is not one (catalase: half an O₂ per H₂O₂). */
    yields?: Record<string, number>
    kcat: string
    km: Record<string, string>
    inhibitors?: Record<string, { type: 'competitive' | 'uncompetitive' | 'noncompetitive' | 'mixed'; ki: string; alpha?: number }>
    /** pH dependence: an essential group that must be deprotonated (acidPKa) and one that must stay protonated (basePKa). */
    pHActivity?: { acidPKa: number; basePKa: number }
    /** Other reactions the same active site catalyses (alternative substrates): they compete with the first and with each other. */
    alternatives?: Array<{ substrates: string[]; products: string[]; yields?: Record<string, number>; kcat: string; km: Record<string, string> }>
    /** Mechanism-based inactivators: kobs = kinact [I] / (KI (1 + Σ[S]/Km) + [I]); substrate protects the site. */
    inactivators?: Record<string, { kinact: string; ki: string }>
    /**
     * Driven by light (photosynthesis, chloroplasts reducing DCPIP): the rate rises as I / (I + half)
     * with the light falling on the vessel (µmol photons m⁻² s⁻¹), weighted by how well it uses the
     * colour a filter passes (`action`: red, green, blue; 1 for white light). No light, no reaction.
     */
    light?: { half: number; action?: Record<string, number> }
  }
  hazard?: { ghs?: string[]; wasteStream?: string; containment?: 'bench' | 'fume-hood' | 'bsc' }
  /** Organisms (state model §3, §6): Gram class, shape, biosafety and growth. */
  organism?: {
    gram?: 'positive' | 'negative' | 'variable'
    morphology?: 'cocci' | 'rods' | 'spirilla' | 'yeast' | 'algae'
    /** A cell's diameter (a rod's width). Left out, typical of its morphology. */
    size?: string
    arrangement?: string
    /** Oxygen requirement: where it grows in an agar deep (aerobes at the top only, anaerobes only below it). */
    oxygen?: 'aerobe' | 'facultative' | 'microaerophile' | 'anaerobe' | 'aerotolerant'
    bsl?: number
    doublingTime?: string
    colony?: string
    /** Turbidity: optical density at 600 nm per (cell/mL) over 1 cm (bacteria about 1.25e-9). */
    od600PerCell?: number
    markers?: string[]
    /** Plasmids the organism carries of its own (a wild strain's R plasmid): their markers are its, and lysis releases them. */
    plasmids?: string[]
    /** The proteins in each cell (a stand-in proteome, by mass per cell), released when the cells burst. */
    proteins?: Array<{ substance: string; perCell: string }>
    /** Chemically competent cells (they can take up plasmid DNA in a heat shock). */
    competent?: boolean
    /**
     * Cardinal temperatures and the density a culture levels off at; cardinal pH values (growth only
     * between pHMin and pHMax, fastest at pHOpt, Rosso's cardinal pH model), where pH matters to it.
     */
    growth?: { tMin?: string; tOpt?: string; tMax?: string; maxDensity?: string; pHMin?: number; pHOpt?: number; pHMax?: number }
    /**
     * What it makes from a substrate as it grows and lives (Luedeking–Piret): `perCell` of the
     * substrate for each new cell, and `rate` per cell per second at its optimum temperature (slowed
     * as growth is by temperature and pH; it stops below `pHMin`, the growth pHMin unless given).
     * Each substrate used gives `products` (lactose to four lactic acid). With `fuel` it grows only
     * while that substrate (or another fuel) is there. Half-saturation `ks` (default 1 mM).
     */
    metabolism?: Array<{ substrate: string; products: Record<string, number>; perCell?: string; rate?: string; ks?: string; pHMin?: number; fuel?: boolean }>
    /**
     * A phototroph (an alga): it grows on light, carbon dioxide and minerals instead of organic
     * nutrients, at I / (I + lightHalf) of its rate under the light where it stands (µmol photons m⁻² s⁻¹).
     */
    photosynthetic?: { lightHalf: number }
    /** This organism's MIC of particular antibiotics (by substance id), where it differs from the antibiotic's own. */
    susceptibility?: Record<string, string>
    /**
     * Growth factors it cannot make (an auxotroph): each new cell uses `perCell` of it, and growth
     * slows as it runs short (Monod, half-saturation `ks`, default 1 µM), stopping when it is used up.
     */
    requires?: Array<{ substance: string; perCell: string; ks?: string }>
    /**
     * Mutants it gives rise to (a revertant, a resistant mutant): the organism they are, the kind of
     * mutation (matched against mutagens' potencies), the spontaneous rate per cell division, and
     * their share of a grown culture (`frequency`, staged with it).
     */
    mutants?: Array<{ to: string; kind: string; rate: number; frequency?: number }>
    /** Heat killing above its maximum growth temperature: the decimal reduction time at 60 °C and the rise (K) that cuts it tenfold. */
    heatResistance?: { d60: string; z: number }
  }
  /** Plasmids: size, the markers they carry, and which markers an inducer switches on. */
  /** Plasmids: size, markers, which markers an inducer switches on, and copies per cell (default 20). */
  plasmid?: {
    sizeBp: number
    markers: string[]
    regulated?: Record<string, string>
    copyNumber?: number
    /** Proteins it makes in each cell: always, or once its inducer is present (`basal`: the share made without it). */
    expresses?: Array<{ substance: string; perCell: string; inducer?: string; basal?: number }>
  }
  /** Antibiotics: the marker that confers resistance, and the lowest concentration that selects. */
  /** Antibiotics: the marker that resists them, the MIC for susceptible organisms, and how fast they diffuse in agar (m2/s). */
  /**
   * `interactions`: the fractional inhibitory concentration index with another antibiotic (by id),
   * where it is not additive (1): below 0.5 synergy (sulfamethoxazole with trimethoprim), above 4
   * antagonism.
   */
  antibiotic?: { resistance: string; effective?: string; diffusion?: string; interactions?: Record<string, number> }
  /**
   * Mutagens: induced mutations per cell division per µM, by kind of mutation (base-substitution,
   * frameshift); the concentration that kills cells outright; how fast it diffuses in agar (m2/s).
   */
  mutagen?: { potency: Record<string, number>; toxic?: string; diffusion?: string }
  /** Gelling agents (agar): a liquid holding at least `minConc` sets when cooled below `sets` and melts again only above `melts`. */
  gel?: { sets: string; melts: string; minConc: string }
  /** Growth media components: nutrients let cells grow. */
  /**
   * Growth media: a nutrient and the concentration at which it supports full density (yield scales
   * with it below); a selective medium inhibits one Gram class; a differential one colours the
   * colonies of organisms with a marker (lactose fermenters pink on MacConkey).
   */
  /**
   * Growth media: a nutrient (only for organisms with the marker `usableWith`, a sole carbon source
   * such as hexadecane), and what a selective medium inhibits: one Gram class, and/or every organism
   * lacking the marker `unless` (CFC supplement spares the pseudomonads). A `mineral` (nitrogen or
   * phosphorus, at `fullStrength` for full density) is what growth on a sole carbon source also needs.
   */
  medium?: { nutrient?: boolean; fullStrength?: string; usableWith?: string; mineral?: 'nitrogen' | 'phosphorus'; inhibits?: { gram?: 'positive' | 'negative'; unless?: string }; differential?: Differential }
  /**
   * A solid that holds water (soil): its field capacity (water held per gram after draining), and
   * what dissolves from it into that water (per mass of solid: its extractable mineral nitrogen).
   */
  wettable?: { fieldCapacity: string; releases?: Array<{ substance: string; content: string }> }
  /** Solvents as TLC eluents: eluotropic strength ε° on silica (hexane 0.01, ethyl acetate 0.48, ethanol 0.68). */
  eluotropic?: number
  /** Adsorption on chromatographic phases: S on silica (log k = S − 10 ε; higher = held more strongly). */
  adsorption?: { silica: number }
  /** Spot-test reagents: the organism marker the test reveals, and what a positive and a negative look like. */
  spotTest?: { marker: string; positive: string; negative: string }
  /**
   * DNA: a length (a single molecule), or fragments with their share of the mass (a ladder), and
   * the products that primer pairs amplify from it (a product lists itself, so it re-amplifies).
   */
  dna?: {
    lengthBp?: number
    /** GC share of a short duplex, for its melting temperature (default 0.5). */
    gcFraction?: number
    fragments?: Array<{ bp: number; fraction: number }>
    amplicons?: Array<{ forward: string; reverse: string; product: string }>
    /** This DNA is the chromosome of an organism: each cell of it releases one copy when it bursts. */
    genomeOf?: string
    /** Circular DNA (a plasmid) runs as supercoiled and nicked forms until it is cut. */
    topology?: 'linear' | 'circular'
    /** Share of an uncut circular preparation that is nicked (open circle). */
    nicked?: number
    /** Recognition sites by restriction enzyme: cut positions (bp from the map's origin). */
    sites?: Record<string, number[]>
    /** A fluorescent or radioactive label: what a label-detecting imager sees (a probe). */
    label?: string
    /** Its bases (5′→3′, one strand), for sequencing and sequence analysis. */
    sequence?: string
    /** Annotated genes on it: coding sequences, 1-based and inclusive, forward strand. */
    features?: Array<{ gene: string; product?: string; start: number; end: number }>
    /** Where it comes from, as a database entry would name it ("Salmonella enterica serovar Typhimurium, his operon"). */
    source?: string
    /** A reference sequence: one of those a sequence search looks through. */
    reference?: boolean
  }
  /** Restriction enzymes (contract cleavage.restriction): the site they cut and their activity. */
  restriction?: { site: string; unitsPerMg: number; cofactor: string; optimum?: string }
  /** Chelators: the metal ions they bind one to one (EDTA takes up Mg²⁺). */
  chelates?: string[]
  /** Antibodies: what they bind (a substance, or "tag:<name>"), the dissociation constant and the on-rate (L mol⁻¹ s⁻¹). */
  antibody?: { target: string; kd: string; kon?: number }
  /** Labels other substances can recognise (an antibody's species and class, "mouse-igg"). */
  tags?: string[]
  /** PCR reagents: primers (with Tm), the polymerase (with its speed), nucleotides. */
  /**
   * Redox couples: which couple this is a form of, which form, and its partner form; the electrons
   * and protons one reduction takes, and the standard potential (V vs SHE).
   */
  redox?: { couple: string; form: 'oxidised' | 'reduced'; partner: string; electrons: number; e0: number; protons?: number; reducedPer?: number }
  /** What a substance offers for complexation: the metal ion a salt releases (and how many per formula unit), or I₂ for starch. */
  cation?: { ion: string; count?: number }
  /** Ligands: 1:1 complexes with metal ions (log10 K for the fully deprotonated ligand), and how a complex absorbs. */
  complexes?: Array<{ ion: string; logK: number; epsilon?: Array<[number, number]>; colour?: string }>
  /** PCR roles; a dsDNA dye (SYBR Green) fluoresces when bound, which a real-time cycler reads. */
  pcr?: { role: 'primer' | 'polymerase' | 'nucleotides' | 'dsdna-dye'; tm?: string; bpPerS?: number }
  /** Tracking dyes in loading buffer: the DNA length they run alongside in a 1 % gel. */
  tracking?: { apparentBp: number }
  /** Stains (contract staining): what the reagent does to fixed cells. */
  stain?: { role: 'primary' | 'mordant' | 'decolouriser' | 'counterstain' | 'vital'; colour?: string }
  /**
   * Specimens mounted on prepared slides (contract microscopy): what there is to see. `size` is the
   * finest feature that shows the structure's form, `density` how many there are per mm² of slide
   * (left out for one object in the middle), `text` marks writing (seen upside down). For measuring
   * with an eyepiece graticule: `length`, how long one is along its longest axis (the mean, where it
   * differs from `size`), and `spread`, how much they differ (a share, 0.15 if unset); a ruled scale
   * (a stage micrometer) gives the length of one `division`.
   */
  specimen?: { structures: Array<{ label: string; size: string; contrast: 'absorbing' | 'transparent'; colour?: string; arrangement?: string; density?: number; text?: boolean; stains?: Record<string, string>; state?: 'turgid' | 'plasmolysed'; length?: string; spread?: number; division?: string }> }
  /**
   * Plant tissue cut into pieces (contract membranes.tissue): its water mass fraction, the sap's
   * osmolality (osmol/kg), the fresh tissue's water potential and wall modulus (MPa), how fast a 1 g
   * piece exchanges water, a pigment held in its cells (mol per g), and what damages its membranes.
   */
  /**
   * A leafy shoot losing water through its leaves: leaf area (cm² per g of shoot) and stomatal
   * conductance with the stomata fully open (mol m⁻² s⁻¹). Stomata open with light, half open at
   * `lightHalf` µmol m⁻² s⁻¹, from a fraction `darkOpen` in the dark.
   */
  transpiration?: { area: number; conductance: number; lightHalf?: number; darkOpen?: number }
  /**
   * A product formed at an anode from an ion carrier (chlorine from chloride): `count` carriers give
   * one product for `electrons` electrons, at standard potential `e0` (V).
   */
  anodic?: { from: string; count: number; electrons: number; e0: number }
  /**
   * A living thing that respires aerobically (seeds, woodlice): µmol of oxygen per gram per minute
   * at 25 °C, its Q10 (2 if unset) and respiratory quotient (CO₂ per O₂, 1 if unset).
   */
  respiration?: { rate: number; q10?: number; rq?: number }
  /**
   * An animal's preferences in a choice chamber (taxis and kinesis): for humid over dry, and dark
   * over light (negative for the opposite). At equilibrium the sides hold it in the ratio e^(2·preference).
   */
  taxis?: { humid?: number; dark?: number }
  /**
   * A small animal whose heart can be watched under a microscope (Daphnia): beats a minute at 20 °C,
   * Q10, and drugs in the water that change it by 1 + change × c / (c + EC50).
   */
  heart?: { bpm: number; q10?: number; drugs?: Record<string, { ec50: string; change: number }> }
  /** A solid that soaks up a gas from the air around it (soda lime: carbon dioxide). */
  absorbs?: string
  /** A sexually reproducing species' genetics (Drosophila): its loci, sex chromosome, brood and generation time. */
  genetics?: GeneticsDef
  /** A true-breeding strain of a species with `genetics`: its mutant alleles by locus (wild type elsewhere). */
  strain?: { species: string; alleles: Record<string, string> }
  /** An amphiphile that spreads on water as a film one molecule thick: the area each molecule takes, nm². */
  monolayer?: { areaNm2: number }
  /** An electrode material: the overpotentials (V) for hydrogen and oxygen on it at classroom currents. */
  electrode?: { hydrogenOverpotential?: number; oxygenOverpotential?: number }
  tissue?: {
    water: number
    osmolality: number
    waterPotential: number
    modulus?: number
    exchangeTime?: string
    pigment?: { substance: string; molPerG: number }
    membranes?: { tm?: string; width?: number; solvents?: Record<string, number> }
  }
  status: Status
  provenance?: Provenance
}

export interface PreparationDef {
  id: string
  label: string
  components: Array<{ substance: string; conc: string }>
  solvent: string
  pH?: number
  /** Default storage temperature. */
  storage?: string
  status: Status
  description?: string
  provenance?: Provenance
}

// ---- Skills, rules, models ----

export interface SkillDef {
  id: string
  label: string
  kind: 'technique' | 'operation' | 'equipment' | 'analysis' | 'design' | 'practice' | 'reasoning' | 'concept'
  description?: string
}

export interface RuleDef {
  id: string
  kind: 'chemical' | 'optical' | 'thermal' | 'format' | 'containment' | 'sterility' | 'mechanical' | 'disposal'
  /** Expression over the context of an operation (material, container, equipment). */
  when: string
  severity: 'impossible' | 'unsafe' | 'poor-practice' | 'suboptimal'
  message: string
}

export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4'

export interface ModelDecl {
  id: string
  contract: string
  tier: Tier
  kind: 'process' | 'measurement'
  status: Status
  /** Facets needed on participating substances. */
  requires?: string[]
  /** Model parameters (for parameterised templates such as colour development). */
  params?: Record<string, string | number>
  /** Species that must be present for a process to run in a phase. */
  trigger?: string[]
  /**
   * A mass-action reaction (contract kinetics.mass-action): stoichiometry, orders (default: the
   * reactants' coefficients), the rate constant k at a reference temperature in litre, mole and
   * second units (L mol⁻¹ s⁻¹ for second order), and the activation energy for Arrhenius.
   */
  /**
   * A mass-action reaction. `heterogeneous` reactants are undissolved (a metal powder): their term is
   * what is suspended in, or settled under, the liquid per litre of it, and they are in excess (not used up).
   */
  /**
   * A mass-action reaction. `hydroxide`: its order in hydroxide ion, taken from the liquid's pH (a
   * base-catalysed reaction: the hydroxide is not used up by the reaction itself; the acid–base
   * equilibrium deals with what the products take). `acid`: likewise its order in hydrogen ion.
   * Reactants of the ionic model are named by their carriers (aq:chromate for dichromate, aq:silver).
   */
  reaction?: { reactants: Record<string, number>; products: Record<string, number>; orders?: Record<string, number>; heterogeneous?: string[]; hydroxide?: number; acid?: number; k: number; at?: string; ea?: string }
  /**
   * A class of functional-group reaction (contract kinetics.functional-group, models/organic.ts):
   * its roles (role name → coefficient), reagents used and by-products formed (substance → coefficient),
   * the coefficient of what it makes, orders by role name or substance id (a catalyst appears only
   * here), H⁺ or OH⁻ orders, k at a temperature with its activation energy, and for a reversible
   * class its equilibrium constant K (the reverse runs at k/K).
   */
  template?: {
    roles: Record<string, number>
    reagents?: Record<string, number>
    product?: number
    byproducts?: Record<string, number>
    orders?: Record<string, number>
    hydroxide?: number
    acid?: number
    k: number
    at?: string
    ea?: string
    K?: number
  }
  /** The compounds a functional-group class applies to: which substances fill its roles, what they make, and their own relative rate and K where they differ. */
  instances?: Array<{ from: Record<string, string>; product: string; rate?: number; K?: number }>
  /** A binary vapour-liquid equilibrium at 1 atm (contract equilibrium.vapour-liquid): mole fraction of the light component in the liquid (x) and the vapour (y), and the boiling temperature (°C). */
  vle?: { light: string; x: number[]; y: number[]; T: number[] }
  validity?: Record<string, string>
  description?: string
  provenance?: Provenance
}

/**
 * A differential medium's colours: one marker (positive or negative look), or rules taken in order,
 * the first marker the organism has deciding (EMB: a strong acid-former's green sheen, then any
 * lactose fermenter's pink), the last rule's `negative` for the rest.
 */
export type Differential = { marker: string; positive: string; negative: string } | Array<{ marker: string; positive: string; negative?: string }>

export interface PackContent {
  pack: PackManifest
  purposes?: PurposeDef[]
  operations?: OperationDecl[]
  techniques?: TechniqueDef[]
  equipment?: EquipmentDef[]
  substances?: SubstanceDef[]
  preparations?: PreparationDef[]
  skills?: SkillDef[]
  rules?: RuleDef[]
  models?: ModelDecl[]
}

export type EntryKind = Exclude<keyof PackContent, 'pack'>

export const ENTRY_KINDS: EntryKind[] = ['purposes', 'operations', 'techniques', 'equipment', 'substances', 'preparations', 'skills', 'rules', 'models']

/**
 * A species' Mendelian genetics: loci (two alleles each, wild type '+' and the mutant named by the
 * locus) at map positions (cM) on chromosomes, the trait each shows, which chromosome is the X
 * (males have one), whether males cross over, the mean brood per female and the generation time
 * (days at 25 °C).
 */
export interface GeneticsDef {
  loci: Array<{ id: string; name?: string; chromosome: string; position: number; dominant?: boolean; mutantTrait: string }>
  sexChromosome: string
  maleRecombination?: boolean
  brood: number
  generationDays: number
}

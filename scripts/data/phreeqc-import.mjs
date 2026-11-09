// Generate packages/pack-aqueous (namespace "aq") from the MINTEQ v4 thermodynamic database
// distributed with PHREEQC (U.S. Geological Survey), plus a hand-authored overlay: names, visible
// spectra and colours, the solids that form quickly at room temperature, species the database
// lacks, and reagent salts.
//
//   node scripts/data/phreeqc-import.mjs <path/to/minteq.v4.dat>
//
// Get minteq.v4.dat from https://github.com/usgs-coupled/phreeqc3/tree/master/database. The
// generated data are a modified extract of it (see packages/pack-aqueous/NOTICE-PHREEQC.txt).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chargeOf, parseDatabase } from './phreeqc-db.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(root, 'packages/pack-aqueous')
const SOURCE = 'MINTEQ v4 thermodynamic database (minteq.v4.dat, $Id 11091 2016-04-21), distributed with PHREEQC by the U.S. Geological Survey'

// ---------------------------------------------------------------------------------------------
// Carriers: database master species → our substance, with name and visible spectrum.
// Spectra are molar absorption coefficients (L mol⁻¹ cm⁻¹) at wavelengths (nm), approximate values
// from standard references; a colourless ion has none.
const CARRIERS = {
  'Na+': { id: 'aq:sodium', name: 'Sodium ion', formula: 'Na⁺', flame: 'sodium' },
  'K+': { id: 'aq:potassium', name: 'Potassium ion', formula: 'K⁺', flame: 'potassium' },
  'Li+': { id: 'aq:lithium', name: 'Lithium ion', formula: 'Li⁺', flame: 'lithium' },
  'NH4+': { id: 'aq:ammonium', name: 'Ammonium ion', formula: 'NH₄⁺' },
  'Ca+2': { id: 'aq:calcium', name: 'Calcium ion', formula: 'Ca²⁺', flame: 'calcium' },
  'Mg+2': { id: 'aq:magnesium', name: 'Magnesium ion', formula: 'Mg²⁺' },
  'Ba+2': { id: 'aq:barium', name: 'Barium ion', formula: 'Ba²⁺', flame: 'barium' },
  'Sr+2': { id: 'aq:strontium', name: 'Strontium ion', formula: 'Sr²⁺', flame: 'strontium' },
  'Cu+2': {
    id: 'aq:copper-ii', name: 'Copper(II) ion', formula: 'Cu²⁺', flame: 'copper', colour: 'pale blue',
    epsilon: [[350, 1.2], [400, 0.3], [450, 0.15], [500, 0.35], [550, 1.4], [600, 4.2], [650, 7.5], [700, 10], [750, 11.6], [800, 12.2], [850, 12], [900, 11]],
  },
  'Ag+': { id: 'aq:silver', name: 'Silver ion', formula: 'Ag⁺' },
  'Zn+2': { id: 'aq:zinc', name: 'Zinc ion', formula: 'Zn²⁺' },
  'Pb+2': { id: 'aq:lead-ii', name: 'Lead(II) ion', formula: 'Pb²⁺' },
  'Fe+2': { id: 'aq:iron-ii', name: 'Iron(II) ion', formula: 'Fe²⁺', colour: 'pale green', epsilon: [[400, 0.1], [500, 0.1], [600, 0.4], [700, 1], [800, 1.8], [900, 2.2]] },
  'Fe+3': { id: 'aq:iron-iii', name: 'Iron(III) ion', formula: 'Fe³⁺', colour: 'pale yellow', epsilon: [[300, 3000], [340, 1500], [380, 300], [400, 100], [420, 30], [450, 5], [500, 0]] },
  'Mn+2': { id: 'aq:manganese-ii', name: 'Manganese(II) ion', formula: 'Mn²⁺' },
  'Al+3': { id: 'aq:aluminium', name: 'Aluminium ion', formula: 'Al³⁺' },
  'Ni+2': { id: 'aq:nickel-ii', name: 'Nickel(II) ion', formula: 'Ni²⁺', colour: 'green', epsilon: [[350, 1.5], [395, 5.2], [450, 1], [500, 0.3], [600, 0.8], [656, 1.9], [720, 2.1], [800, 1.2]] },
  'Co+2': { id: 'aq:cobalt-ii', name: 'Cobalt(II) ion', formula: 'Co²⁺', colour: 'pink', epsilon: [[400, 0.3], [450, 1.5], [480, 3.5], [510, 4.8], [530, 4.3], [560, 2.2], [600, 0.5], [650, 0.1]] },
  'Cl-': { id: 'aq:chloride', name: 'Chloride ion', formula: 'Cl⁻' },
  'Br-': { id: 'aq:bromide', name: 'Bromide ion', formula: 'Br⁻' },
  'I-': { id: 'aq:iodide', name: 'Iodide ion', formula: 'I⁻' },
  'F-': { id: 'aq:fluoride', name: 'Fluoride ion', formula: 'F⁻' },
  'NO3-': { id: 'aq:nitrate', name: 'Nitrate ion', formula: 'NO₃⁻' },
  'SO4-2': { id: 'aq:sulfate', name: 'Sulfate ion', formula: 'SO₄²⁻' },
  'CO3-2': { id: 'aq:carbonate', name: 'Carbonate', formula: 'CO₃²⁻' },
  'PO4-3': { id: 'aq:phosphate', name: 'Phosphate', formula: 'PO₄³⁻' },
  'CrO4-2': {
    id: 'aq:chromate', name: 'Chromate ion', formula: 'CrO₄²⁻', colour: 'yellow',
    epsilon: [[300, 1500], [340, 3500], [372, 4830], [400, 3500], [420, 2000], [450, 500], [480, 80], [500, 0]],
  },
  'Acetate-': { id: 'aq:acetate', name: 'Ethanoate (acetate) ion', formula: 'CH₃COO⁻' },
}

// Flame emission (models/flame.ts): atomic lines at NIST wavelengths, their radiant power per mol in a
// Bunsen flame from gA·exp(−E/kT) at 2200 K with each element's share free as atoms (relative units:
// the sodium D lines total 1000); molecular bands (CaOH, SrOH and SrCl, BaOH and BaO, CuOH, CuCl with
// chloride) from flame spectra, given the share of the light they carry. [nm, weight, width?, with?]
const EMISSION = {
  'aq:sodium': [[589.0, 667], [589.6, 333]],
  'aq:potassium': [[766.5, 2700], [769.9, 1350], [404.4, 0.04], [404.7, 0.02]],
  'aq:lithium': [[670.8, 450], [610.4, 0.05]],
  'aq:calcium': [[422.7, 2], [622, 60, 12], [554, 20, 8]],
  'aq:strontium': [[460.7, 7], [606, 50, 8], [646, 25, 10], [682, 60, 10]],
  'aq:barium': [[553.5, 40], [487, 5, 6], [513, 15, 6], [524, 15, 6], [580, 8, 10]],
  'aq:copper-ii': [[535, 15, 15], [435, 12, 6, 'aq:chloride'], [488, 8, 5, 'aq:chloride'], [498, 8, 5, 'aq:chloride'], [526, 10, 6, 'aq:chloride'], [538, 10, 6, 'aq:chloride']],
}
const emissionOf = (id) => EMISSION[id] ? { emission: { lines: EMISSION[id].map(([nm, weight, width, partner]) => ({ nm, weight, ...(width ? { width } : {}), ...(partner ? { with: partner } : {}) })) } } : {}

// Species colours (where a species, not its carrier, gives the colour).
const SPECIES_OPTICS = {
  'FeOH+2': { colour: 'yellow', epsilon: [[300, 2000], [340, 2400], [380, 1300], [400, 700], [420, 350], [450, 100], [500, 10], [550, 0]] },
  'Fe(OH)2+': { colour: 'yellow-brown', epsilon: [[300, 2500], [350, 1500], [400, 600], [450, 150], [500, 20], [550, 0]] },
  'FeCl+2': { colour: 'yellow', epsilon: [[300, 2500], [340, 2800], [380, 900], [400, 400], [450, 60], [500, 0]] },
  // Still octahedral with water about it: pink, like the aqua ion.
  'CoCl+': { colour: 'pink', epsilon: [[400, 0.3], [450, 1.5], [480, 3.5], [510, 5], [530, 4.5], [560, 2.3], [600, 0.5], [650, 0.1]] },
  'HCrO4-': { colour: 'orange', epsilon: [[300, 2000], [350, 1600], [380, 900], [400, 650], [440, 320], [470, 220], [500, 110], [550, 10], [600, 0]] },
  'CrO3Cl-': { colour: 'orange', epsilon: [[300, 2500], [350, 2500], [400, 1200], [450, 450], [500, 150], [550, 15], [600, 0]] },
  'H2CrO4': { colour: 'orange', epsilon: [[300, 2500], [350, 2400], [400, 1100], [450, 400], [500, 130], [550, 10], [600, 0]] },
  'Cr2O7-2': { colour: 'orange', epsilon: [[300, 2500], [350, 3150], [400, 1500], [440, 370], [470, 250], [500, 120], [550, 10], [600, 0]] },
  'CuNH3+2': { colour: 'blue', epsilon: [[450, 1], [500, 3], [600, 15], [700, 26], [750, 27], [800, 24], [900, 15]] },
}

// Species the database lacks (literature constants, ionic strength near zero unless noted).
const EXTRA_SPECIES = [
  // Copper ammines (Bjerrum's stepwise constants; overall log β): the deep blue tetraammine.
  { carrier: 'Cu+2', formula: 'Cu(NH3)2+2', logK: 7.82 - 2 * 9.244, with: { 'NH4+': 2, 'H+': -2 }, colour: 'blue', epsilon: [[450, 2], [500, 6], [550, 18], [600, 30], [650, 36], [700, 34], [800, 22], [900, 12]], ref: 'log β₂ 7.82 for Cu²⁺ + 2NH₃ (formation constants at I → 0, standard tables)' },
  { carrier: 'Cu+2', formula: 'Cu(NH3)3+2', logK: 10.2 - 3 * 9.244, with: { 'NH4+': 3, 'H+': -3 }, colour: 'deep blue', epsilon: [[450, 3], [500, 9], [550, 30], [600, 45], [650, 46], [700, 38], [800, 20], [900, 10]], ref: 'log β₃ 10.2 (standard tables)' },
  { carrier: 'Cu+2', formula: 'Cu(NH3)4+2', logK: 13.04 - 4 * 9.244, with: { 'NH4+': 4, 'H+': -4 }, colour: 'deep blue', epsilon: [[350, 120], [380, 25], [400, 8], [420, 4], [450, 3], [500, 12], [550, 35], [600, 52], [650, 47], [700, 32], [750, 20], [800, 13], [900, 8]], ref: 'Kf 1.1 × 10¹³ (log β₄ 13.04, standard tables); λmax 600 nm, ε ≈ 50' },
  // Cobalt(II) chloro complex: blue, favoured by heat and chloride (endothermic).
  { carrier: 'Co+2', formula: 'CoCl4-2', logK: -3.5, dH: 50, with: { 'Cl-': 4 }, colour: 'deep blue', epsilon: [[420, 3], [450, 8], [480, 40], [500, 70], [525, 100], [550, 150], [580, 220], [600, 280], [630, 450], [665, 550], [690, 600], [720, 350], [750, 100], [800, 10]], ref: 'Illustrative overall constant for Co(H₂O)₆²⁺ + 4Cl⁻ ⇌ CoCl₄²⁻ + 6H₂O, endothermic (blue on heating, pink on cooling); λmax 690 nm, ε ≈ 600' },
  // Nickel hexaammine (blue-violet).
  { carrier: 'Ni+2', formula: 'Ni(NH3)6+2', logK: 8.74 - 6 * 9.244, with: { 'NH4+': 6, 'H+': -6 }, colour: 'violet', epsilon: [[350, 5], [400, 2], [450, 0.5], [500, 2], [580, 6], [650, 3], [700, 1.5], [900, 4]], ref: 'Kf 5.5 × 10⁸ (log β₆ 8.74, standard tables)' },
  // Silver diammine (also in the database as a single step; this is the overall constant).
  // Zinc tetraammine (colourless) dissolves zinc hydroxide in excess ammonia.
  { carrier: 'Zn+2', formula: 'Zn(NH3)4+2', logK: 9.46 - 4 * 9.244, with: { 'NH4+': 4, 'H+': -4 }, ref: 'Kf 2.9 × 10⁹ (log β₄ 9.46, standard tables)' },
]

// Thiocyanate: not in MINTEQ; a carrier with iron(III) complexes (blood red).
const EXTRA_CARRIERS = [
  {
    id: 'aq:thiocyanate', name: 'Thiocyanate ion', formula: 'SCN⁻', charge: -1, master: 'SCN-',
    species: [],
    ref: 'Thiocyanate',
  },
]
const EXTRA_CARRIER_SPECIES = [
  { carrier: 'Fe+3', formula: 'FeSCN+2', logK: 3.03, dH: -5, with: { 'SCN-': 1 }, colour: 'red', epsilon: [[350, 1800], [400, 3800], [447, 4700], [480, 4300], [500, 3700], [530, 2500], [550, 1700], [580, 700], [600, 350], [650, 60], [700, 0]], ref: 'log K 3.03 (I → 0); λmax 447 nm, ε 4700, a broad band reaching 580 nm' },
  { carrier: 'Fe+3', formula: 'Fe(SCN)2+', logK: 4.6, with: { 'SCN-': 2 }, colour: 'red', epsilon: [[400, 4000], [460, 7000], [500, 6000], [550, 3000], [580, 1200], [600, 500], [650, 80], [700, 0]], ref: 'log β₂ 4.6' },
]

// ---------------------------------------------------------------------------------------------
// Solids that form within seconds at room temperature, by database phase name: our id, name,
// body colour (display sRGB) and look. Slow-forming phases (oxides, dolomite, apatite …) are left out.
// How a fresh precipitate settles (Stokes' law in processes.ts): a typical density and a
// Stokes-equivalent diameter by texture, so that in a beaker crystals fall within a minute, curdy
// silver halides within a few, gelatinous hydroxide flocs in about ten and fine barium sulfate in
// about an hour.
function settling(look = '') {
  const size = /crystalline/.test(look) ? 25 : /curdy/.test(look) ? 14 : /gelatinous/.test(look) ? 8 : /fine/.test(look) ? 4 : 7
  return { density: '3000 g/L', particleSize: `${size} um` }
}

const SOLIDS = {
  'Cu(OH)2': ['aq:copper-ii-hydroxide', 'Copper(II) hydroxide', [0.45, 0.72, 0.88], 'gelatinous pale blue'],
  'Zn(OH)2(am)': ['aq:zinc-hydroxide', 'Zinc hydroxide', [0.95, 0.95, 0.94], 'gelatinous white'],
  'Al(OH)3(am)': ['aq:aluminium-hydroxide', 'Aluminium hydroxide', [0.95, 0.95, 0.95], 'gelatinous white'],
  // Fresh precipitate is the amorphous hydroxide, far more soluble than aged ferrihydrite: WATEQ4F's Fe(OH)3(a).
  Ferrihydrite: ['aq:iron-iii-hydroxide', 'Iron(III) hydroxide', [0.62, 0.3, 0.1], 'gelatinous rust-brown', { logK: 4.891, note: 'log K 4.891 of Fe(OH)3(a) from the WATEQ4F database (wateq4f.dat, PHREEQC distribution) in place of MINTEQ ferrihydrite (3.191): fresh precipitate is amorphous.' }],
  'Fe(OH)2': ['aq:iron-ii-hydroxide', 'Iron(II) hydroxide', [0.42, 0.55, 0.38], 'gelatinous dirty green'],
  'Ni(OH)2': ['aq:nickel-ii-hydroxide', 'Nickel(II) hydroxide', [0.55, 0.75, 0.5], 'gelatinous green'],
  'Co(OH)2': ['aq:cobalt-ii-hydroxide', 'Cobalt(II) hydroxide', [0.35, 0.45, 0.75], 'blue'],
  Pyrochroite: ['aq:manganese-ii-hydroxide', 'Manganese(II) hydroxide', [0.92, 0.88, 0.84], 'off-white'],
  Brucite: ['aq:magnesium-hydroxide', 'Magnesium hydroxide', [0.96, 0.96, 0.96], 'white'],
  Portlandite: ['aq:calcium-hydroxide', 'Calcium hydroxide', [0.96, 0.96, 0.96], 'white'],
  'Pb(OH)2': ['aq:lead-ii-hydroxide', 'Lead(II) hydroxide', [0.96, 0.96, 0.95], 'white'],
  Ag2O: ['aq:silver-oxide', 'Silver oxide', [0.35, 0.25, 0.18], 'brown'],
  Cerargyrite: ['aq:silver-chloride', 'Silver chloride', [0.95, 0.95, 0.94], 'curdy white'],
  Bromyrite: ['aq:silver-bromide', 'Silver bromide', [0.96, 0.93, 0.78], 'cream'],
  Iodyrite: ['aq:silver-iodide', 'Silver iodide', [0.98, 0.94, 0.6], 'pale yellow'],
  Cotunnite: ['aq:lead-ii-chloride', 'Lead(II) chloride', [0.97, 0.97, 0.97], 'white crystalline'],
  PbBr2: ['aq:lead-ii-bromide', 'Lead(II) bromide', [0.97, 0.97, 0.95], 'white'],
  PbI2: ['aq:lead-ii-iodide', 'Lead(II) iodide', [0.98, 0.82, 0.1], 'bright yellow'],
  Fluorite: ['aq:calcium-fluoride', 'Calcium fluoride', [0.96, 0.96, 0.96], 'white'],
  MgF2: ['aq:magnesium-fluoride', 'Magnesium fluoride', [0.96, 0.96, 0.96], 'white'],
  BaF2: ['aq:barium-fluoride', 'Barium fluoride', [0.96, 0.96, 0.96], 'white'],
  Calcite: ['aq:calcium-carbonate', 'Calcium carbonate', [0.97, 0.97, 0.96], 'white'],
  Witherite: ['aq:barium-carbonate', 'Barium carbonate', [0.97, 0.97, 0.96], 'white'],
  Strontianite: ['aq:strontium-carbonate', 'Strontium carbonate', [0.97, 0.97, 0.96], 'white'],
  Cerussite: ['aq:lead-ii-carbonate', 'Lead(II) carbonate', [0.97, 0.97, 0.96], 'white'],
  Smithsonite: ['aq:zinc-carbonate', 'Zinc carbonate', [0.97, 0.97, 0.96], 'white'],
  Malachite: ['aq:basic-copper-carbonate', 'Basic copper(II) carbonate', [0.25, 0.6, 0.5], 'blue-green'],
  Ag2CO3: ['aq:silver-carbonate', 'Silver carbonate', [0.96, 0.92, 0.7], 'pale yellow'],
  NiCO3: ['aq:nickel-ii-carbonate', 'Nickel(II) carbonate', [0.6, 0.8, 0.6], 'pale green'],
  CoCO3: ['aq:cobalt-ii-carbonate', 'Cobalt(II) carbonate', [0.85, 0.55, 0.65], 'pink'],
  Siderite: ['aq:iron-ii-carbonate', 'Iron(II) carbonate', [0.85, 0.87, 0.8], 'off-white'],
  Rhodochrosite: ['aq:manganese-ii-carbonate', 'Manganese(II) carbonate', [0.95, 0.85, 0.82], 'pale pink'],
  Nesquehonite: ['aq:magnesium-carbonate', 'Magnesium carbonate', [0.97, 0.97, 0.97], 'white'],
  Barite: ['aq:barium-sulfate', 'Barium sulfate', [0.98, 0.98, 0.98], 'fine white'],
  Celestite: ['aq:strontium-sulfate', 'Strontium sulfate', [0.97, 0.97, 0.97], 'white'],
  Anglesite: ['aq:lead-ii-sulfate', 'Lead(II) sulfate', [0.97, 0.97, 0.97], 'white'],
  Gypsum: ['aq:calcium-sulfate', 'Calcium sulfate dihydrate', [0.97, 0.97, 0.97], 'white crystalline'],
  Ag2SO4: ['aq:silver-sulfate', 'Silver sulfate', [0.97, 0.97, 0.97], 'white'],
  PbCrO4: ['aq:lead-ii-chromate', 'Lead(II) chromate', [0.98, 0.8, 0.05], 'bright yellow'],
  BaCrO4: ['aq:barium-chromate', 'Barium chromate', [0.95, 0.85, 0.25], 'yellow'],
  Ag2CrO4: ['aq:silver-chromate', 'Silver chromate', [0.62, 0.2, 0.12], 'brick red'],
  SrCrO4: ['aq:strontium-chromate', 'Strontium chromate', [0.95, 0.86, 0.3], 'yellow'],
  Ag3PO4: ['aq:silver-phosphate', 'Silver phosphate', [0.95, 0.88, 0.35], 'yellow'],
  'Ca3(PO4)2(beta)': ['aq:calcium-phosphate', 'Calcium phosphate', [0.97, 0.97, 0.97], 'white'],
  'Zn3(PO4)2:4H2O': ['aq:zinc-phosphate', 'Zinc phosphate', [0.97, 0.97, 0.97], 'white'],
  'Cu3(PO4)2': ['aq:copper-ii-phosphate', 'Copper(II) phosphate', [0.4, 0.7, 0.75], 'blue-green'],
  'Pb3(PO4)2': ['aq:lead-ii-phosphate', 'Lead(II) phosphate', [0.97, 0.97, 0.97], 'white'],
  Strengite: ['aq:iron-iii-phosphate', 'Iron(III) phosphate', [0.95, 0.9, 0.75], 'pale yellow'],
  'Mg3(PO4)2': ['aq:magnesium-phosphate', 'Magnesium phosphate', [0.97, 0.97, 0.97], 'white'],
  // Blue crystals from a concentrated solution (copper(II) sulfate's solubility, about 1.3 M at 20 °C).
  Chalcanthite: ['aq:copper-ii-sulfate-pentahydrate', 'Copper(II) sulfate pentahydrate', [0.2, 0.5, 0.88], 'crystalline blue', { logK: -2.2, note: 'Effective log K −2.20 in place of −2.64: Davies activity coefficients cannot follow a saturated copper(II) sulfate solution (ionic strength about 5), so the constant is set for the model to give the measured solubility, 1.40 mol/kg at 25 °C and 1.30 at 20 °C.' }],
  // A gas phase at 1 atm: what the solution cannot hold bubbles out.
  'CO2(g)': ['aq:carbon-dioxide', 'Carbon dioxide', [1, 1, 1], 'gas', { phase: 'gas' }],
}

// Reagent salts: id, name, formula, carriers (by master species) and counts.
// Standard enthalpies of formation at 25 °C, kJ/mol (Wagman et al. 1982, the NBS tables of chemical
// thermodynamic properties, J. Phys. Chem. Ref. Data 11, suppl. 2): aqueous ions at infinite
// dilution (H⁺ = 0), from which reaction heats are reckoned with PHREEQC's ΔH for species and solids.
const CARRIER_DHF = {
  'Na+': -240.12, 'K+': -252.38, 'Li+': -278.49, 'NH4+': -132.51, 'Ca+2': -542.83, 'Mg+2': -466.85,
  'Ba+2': -537.64, 'Sr+2': -545.8, 'Cu+2': 64.77, 'Ag+': 105.579, 'Zn+2': -153.89, 'Pb+2': -1.7,
  'Fe+2': -89.1, 'Fe+3': -48.5, 'Mn+2': -220.75, 'Al+3': -531, 'Ni+2': -54, 'Co+2': -58.2,
  'Cl-': -167.159, 'Br-': -121.55, 'I-': -55.19, 'F-': -332.63, 'NO3-': -205, 'SO4-2': -909.27,
  'CO3-2': -677.14, 'PO4-3': -1277.4, 'CrO4-2': -881.15, 'Acetate-': -486.01, 'SCN-': 76.44,
}
// Crystalline reagent salts (same source), for heats of solution: [ΔfH°, water the formula holds
// beyond its carriers and implicit protons]. A hydroxide holds one water per hydroxide; dichromate
// is two chromates less one water.
const SALT_THERMO = {
  'aq:silver-nitrate': [-124.39], 'aq:barium-chloride': [-858.6], 'aq:barium-nitrate': [-992.07], 'aq:lead-ii-nitrate': [-451.9],
  'aq:iron-iii-chloride': [-399.49], 'aq:iron-ii-sulfate': [-928.4], 'aq:copper-ii-sulfate': [-771.36], 'aq:copper-ii-chloride': [-220.1],
  'aq:copper-ii-nitrate': [-302.9], 'aq:zinc-sulfate': [-982.8], 'aq:zinc-chloride': [-415.05], 'aq:aluminium-sulfate': [-3440.84],
  'aq:aluminium-chloride': [-704.2], 'aq:nickel-ii-sulfate': [-872.91], 'aq:cobalt-ii-chloride': [-312.5], 'aq:manganese-ii-sulfate': [-1065.25],
  'aq:calcium-chloride': [-795.8], 'aq:calcium-nitrate': [-938.39], 'aq:magnesium-sulfate': [-1284.9], 'aq:magnesium-chloride': [-641.32],
  'aq:strontium-chloride': [-828.9], 'aq:lithium-chloride': [-408.61], 'aq:sodium-chloride': [-411.15], 'aq:potassium-chloride': [-436.75],
  'aq:potassium-bromide': [-393.8], 'aq:potassium-iodide': [-327.9], 'aq:sodium-fluoride': [-573.65], 'aq:sodium-nitrate': [-467.85],
  'aq:sodium-sulfate': [-1387.08], 'aq:sodium-carbonate': [-1130.68], 'aq:sodium-hydrogencarbonate': [-950.81], 'aq:sodium-phosphate': [-1917.4],
  'aq:sodium-hydroxide': [-425.61, 1], 'aq:potassium-hydroxide': [-424.76, 1], 'aq:ammonium-chloride': [-314.43],
  'aq:potassium-chromate': [-1403.7], 'aq:potassium-dichromate': [-2061.5, -1], 'aq:potassium-thiocyanate': [-200.16], 'aq:sodium-ethanoate': [-708.81],
  'aq:ammonium-nitrate': [-365.56], 'aq:potassium-nitrate': [-494.63], 'aq:copper-ii-sulfate-pentahydrate': [-2279.65, 5],
}

const SALTS = [
  ['aq:silver-nitrate', 'Silver nitrate', 'AgNO3', { 'Ag+': 1, 'NO3-': 1 }],
  ['aq:barium-chloride', 'Barium chloride', 'BaCl2', { 'Ba+2': 1, 'Cl-': 2 }],
  ['aq:barium-nitrate', 'Barium nitrate', 'Ba(NO3)2', { 'Ba+2': 1, 'NO3-': 2 }],
  ['aq:lead-ii-nitrate', 'Lead(II) nitrate', 'Pb(NO3)2', { 'Pb+2': 1, 'NO3-': 2 }],
  ['aq:iron-iii-chloride', 'Iron(III) chloride', 'FeCl3', { 'Fe+3': 1, 'Cl-': 3 }],
  ['aq:iron-iii-nitrate', 'Iron(III) nitrate', 'Fe(NO3)3', { 'Fe+3': 1, 'NO3-': 3 }],
  ['aq:iron-ii-sulfate', 'Iron(II) sulfate', 'FeSO4', { 'Fe+2': 1, 'SO4-2': 1 }],
  ['aq:copper-ii-sulfate', 'Copper(II) sulfate', 'CuSO4', { 'Cu+2': 1, 'SO4-2': 1 }],
  ['aq:copper-ii-chloride', 'Copper(II) chloride', 'CuCl2', { 'Cu+2': 1, 'Cl-': 2 }],
  ['aq:copper-ii-nitrate', 'Copper(II) nitrate', 'Cu(NO3)2', { 'Cu+2': 1, 'NO3-': 2 }],
  ['aq:zinc-sulfate', 'Zinc sulfate', 'ZnSO4', { 'Zn+2': 1, 'SO4-2': 1 }],
  ['aq:zinc-chloride', 'Zinc chloride', 'ZnCl2', { 'Zn+2': 1, 'Cl-': 2 }],
  ['aq:aluminium-sulfate', 'Aluminium sulfate', 'Al2(SO4)3', { 'Al+3': 2, 'SO4-2': 3 }],
  ['aq:aluminium-chloride', 'Aluminium chloride', 'AlCl3', { 'Al+3': 1, 'Cl-': 3 }],
  ['aq:nickel-ii-sulfate', 'Nickel(II) sulfate', 'NiSO4', { 'Ni+2': 1, 'SO4-2': 1 }],
  ['aq:cobalt-ii-chloride', 'Cobalt(II) chloride', 'CoCl2', { 'Co+2': 1, 'Cl-': 2 }],
  ['aq:manganese-ii-sulfate', 'Manganese(II) sulfate', 'MnSO4', { 'Mn+2': 1, 'SO4-2': 1 }],
  ['aq:calcium-chloride', 'Calcium chloride', 'CaCl2', { 'Ca+2': 1, 'Cl-': 2 }],
  ['aq:calcium-nitrate', 'Calcium nitrate', 'Ca(NO3)2', { 'Ca+2': 1, 'NO3-': 2 }],
  ['aq:magnesium-sulfate', 'Magnesium sulfate', 'MgSO4', { 'Mg+2': 1, 'SO4-2': 1 }],
  ['aq:magnesium-chloride', 'Magnesium chloride', 'MgCl2', { 'Mg+2': 1, 'Cl-': 2 }],
  ['aq:strontium-chloride', 'Strontium chloride', 'SrCl2', { 'Sr+2': 1, 'Cl-': 2 }],
  ['aq:lithium-chloride', 'Lithium chloride', 'LiCl', { 'Li+': 1, 'Cl-': 1 }],
  ['aq:sodium-chloride', 'Sodium chloride', 'NaCl', { 'Na+': 1, 'Cl-': 1 }],
  ['aq:potassium-chloride', 'Potassium chloride', 'KCl', { 'K+': 1, 'Cl-': 1 }],
  ['aq:potassium-bromide', 'Potassium bromide', 'KBr', { 'K+': 1, 'Br-': 1 }],
  ['aq:potassium-iodide', 'Potassium iodide', 'KI', { 'K+': 1, 'I-': 1 }],
  ['aq:sodium-fluoride', 'Sodium fluoride', 'NaF', { 'Na+': 1, 'F-': 1 }],
  ['aq:sodium-nitrate', 'Sodium nitrate', 'NaNO3', { 'Na+': 1, 'NO3-': 1 }],
  ['aq:sodium-sulfate', 'Sodium sulfate', 'Na2SO4', { 'Na+': 2, 'SO4-2': 1 }],
  ['aq:sodium-carbonate', 'Sodium carbonate', 'Na2CO3', { 'Na+': 2, 'CO3-2': 1 }],
  ['aq:sodium-hydrogencarbonate', 'Sodium hydrogencarbonate', 'NaHCO3', { 'Na+': 1, 'CO3-2': 1 }],
  ['aq:sodium-phosphate', 'Trisodium phosphate', 'Na3PO4', { 'Na+': 3, 'PO4-3': 1 }],
  ['aq:sodium-hydroxide', 'Sodium hydroxide', 'NaOH', { 'Na+': 1 }],
  ['aq:potassium-hydroxide', 'Potassium hydroxide', 'KOH', { 'K+': 1 }],
  ['aq:hydrochloric-acid', 'Hydrochloric acid', 'HCl', { 'Cl-': 1 }],
  ['aq:nitric-acid', 'Nitric acid', 'HNO3', { 'NO3-': 1 }],
  ['aq:sulfuric-acid', 'Sulfuric acid', 'H2SO4', { 'SO4-2': 1 }],
  ['aq:ammonia', 'Ammonia', 'NH3', { 'NH4+': 1 }],
  ['aq:ammonium-chloride', 'Ammonium chloride', 'NH4Cl', { 'NH4+': 1, 'Cl-': 1 }],
  ['aq:potassium-chromate', 'Potassium chromate', 'K2CrO4', { 'K+': 2, 'CrO4-2': 1 }],
  ['aq:potassium-dichromate', 'Potassium dichromate', 'K2Cr2O7', { 'K+': 2, 'CrO4-2': 2 }],
  ['aq:potassium-thiocyanate', 'Potassium thiocyanate', 'KSCN', { 'K+': 1, 'SCN-': 1 }],
  ['aq:sodium-ethanoate', 'Sodium ethanoate', 'CH3COONa', { 'Na+': 1, 'Acetate-': 1 }],
  ['aq:ammonium-nitrate', 'Ammonium nitrate', 'NH4NO3', { 'NH4+': 1, 'NO3-': 1 }],
  ['aq:potassium-nitrate', 'Potassium nitrate', 'KNO3', { 'K+': 1, 'NO3-': 1 }],
  ['aq:copper-ii-sulfate-pentahydrate', 'Copper(II) sulfate pentahydrate', 'CuSO4:5H2O', { 'Cu+2': 1, 'SO4-2': 1 }],
]

// Metal ions and the metals they are reduced to (standard potentials, V, at 25 °C): what a more
// reactive metal displaces as a deposit.
const COUPLES = {
  'Cu+2': ['aq:copper-metal', 0.34], 'Ag+': ['aq:silver-metal', 0.8], 'Pb+2': ['aq:lead-metal', -0.13], 'Ni+2': ['aq:nickel-metal', -0.25],
  'Co+2': ['aq:cobalt-metal', -0.28], 'Fe+2': ['aq:iron-metal', -0.44], 'Zn+2': ['aq:zinc-metal', -0.76], 'Mg+2': ['aq:magnesium-metal', -2.37],
  'Al+3': ['aq:aluminium-metal', -1.66],
}

// Metals that react at their surface: id, name, element, ion master, charge, E°, rate constants
// (mol m⁻² s⁻¹ per mol/L: with H⁺, with a nobler metal's ions), Ea (kJ/mol), specific surface
// (m²/g, from shape and size: ribbon 0.2 mm thick, powder about 50 µm, granules about 3 mm,
// filings about 0.5 mm, foil 16 µm), colour and description. Rates are calibrated to classroom
// timings: 5 cm of magnesium ribbon is gone in about a minute in 1 M hydrochloric acid; zinc
// granules fizz steadily; iron slowly; copper not at all. Zinc powder in copper(II) sulfate is over within about a minute.
const METALS = [
  ['aq:magnesium-ribbon', 'Magnesium ribbon', 'Mg', 'Mg+2', 2, -2.37, 0.17, 0.03, 40, 0.00575, [0.78, 0.78, 0.8], 'a strip of shiny grey ribbon'],
  ['aq:magnesium-powder', 'Magnesium powder', 'Mg', 'Mg+2', 2, -2.37, 0.17, 0.03, 40, 0.069, [0.7, 0.7, 0.72], 'grey powder'],
  ['aq:zinc-granules', 'Zinc granules', 'Zn', 'Zn+2', 2, -0.76, 0.02, 0.05, 45, 0.00028, [0.7, 0.72, 0.75], 'dull grey granules'],
  ['aq:zinc-powder', 'Zinc powder', 'Zn', 'Zn+2', 2, -0.76, 0.02, 0.05, 45, 0.0168, [0.62, 0.64, 0.66], 'grey powder'],
  ['aq:iron-filings', 'Iron filings', 'Fe', 'Fe+2', 2, -0.44, 0.004, 0.005, 50, 0.0015, [0.35, 0.35, 0.36], 'dark grey filings'],
  ['aq:copper-turnings', 'Copper turnings', 'Cu', 'Cu+2', 2, 0.34, 0, 0.02, 40, 0.0022, [0.78, 0.45, 0.3], 'pink-brown copper turnings'],
  ['aq:aluminium-foil', 'Aluminium foil', 'Al', 'Al+3', 3, -1.66, 0.004, 0.002, 50, 0.046, [0.85, 0.86, 0.88], 'crumpled aluminium foil'],
  // Electrodes: strips 0.25 mm thick (2/(ρt)) and a nail 2.5 mm across (4/(ρd)).
  ['aq:zinc-strip', 'Zinc strip (electrode)', 'Zn', 'Zn+2', 2, -0.76, 0.02, 0.05, 45, 0.0011, [0.7, 0.72, 0.75], 'a strip of dull grey zinc'],
  ['aq:copper-strip', 'Copper strip (electrode)', 'Cu', 'Cu+2', 2, 0.34, 0, 0.02, 40, 0.0009, [0.82, 0.5, 0.35], 'a strip of shiny pink-brown copper'],
  ['aq:lead-strip', 'Lead strip (electrode)', 'Pb', 'Pb+2', 2, -0.13, 0.0005, 0.005, 50, 0.0007, [0.5, 0.5, 0.53], 'a strip of dull grey lead'],
  ['aq:iron-nail', 'Iron nail', 'Fe', 'Fe+2', 2, -0.44, 0.004, 0.005, 50, 0.0002, [0.45, 0.45, 0.47], 'an iron nail'],
]
// Deposits: the metal a displacement leaves (fine, so it reacts readily itself).
const DEPOSITS = [
  ['aq:copper-metal', 'Copper (deposit)', 'Cu', 'Cu+2', 2, 0.34, 0, 0.02, 40, 0.05, [0.6, 0.3, 0.18], 'a red-brown deposit'],
  ['aq:silver-metal', 'Silver (deposit)', 'Ag', 'Ag+', 1, 0.8, 0, 0, 40, 0.05, [0.72, 0.72, 0.72], 'grey silver crystals'],
  ['aq:lead-metal', 'Lead (deposit)', 'Pb', 'Pb+2', 2, -0.13, 0.0005, 0.005, 50, 0.05, [0.5, 0.5, 0.52], 'a dark grey deposit'],
  ['aq:nickel-metal', 'Nickel (deposit)', 'Ni', 'Ni+2', 2, -0.25, 0.001, 0.005, 50, 0.05, [0.55, 0.55, 0.52], 'a grey deposit'],
  ['aq:cobalt-metal', 'Cobalt (deposit)', 'Co', 'Co+2', 2, -0.28, 0.001, 0.005, 50, 0.05, [0.5, 0.5, 0.52], 'a grey deposit'],
  ['aq:iron-metal', 'Iron (deposit)', 'Fe', 'Fe+2', 2, -0.44, 0.004, 0.005, 50, 0.05, [0.3, 0.3, 0.3], 'a black deposit'],
  ['aq:zinc-metal', 'Zinc (deposit)', 'Zn', 'Zn+2', 2, -0.76, 0.02, 0.01, 45, 0.05, [0.55, 0.56, 0.58], 'a grey deposit'],
  ['aq:magnesium-metal', 'Magnesium (deposit)', 'Mg', 'Mg+2', 2, -2.37, 0.17, 0.03, 40, 0.05, [0.7, 0.7, 0.72], 'a grey deposit'],
  ['aq:aluminium-metal', 'Aluminium (deposit)', 'Al', 'Al+3', 3, -1.66, 0.004, 0.002, 50, 0.05, [0.8, 0.8, 0.82], 'a grey deposit'],
]
// Carbonates that dissolve at their surface: id, name, rate constant (per mol/L H⁺), Ea, specific
// surface (6/(ρd): chips about 6 mm, small 3 mm, large 12 mm, powder about 0.2 mm), colour, description. 2 g of chips in 50 mL of
// 1 M hydrochloric acid fizz for about five minutes.
const CHIPS = [
  ['aq:marble-chips', 'Marble chips (calcium carbonate)', 0.08, 40, 0.00037, [0.92, 0.92, 0.9], 'white marble chips'],
  ['aq:marble-chips-small', 'Small marble chips (calcium carbonate)', 0.08, 40, 0.00074, [0.92, 0.92, 0.9], 'small white marble chips'],
  ['aq:marble-chips-large', 'Large marble chips (calcium carbonate)', 0.08, 40, 0.000185, [0.92, 0.92, 0.9], 'large white marble chips'],
  ['aq:powdered-marble', 'Powdered marble (calcium carbonate)', 0.08, 40, 0.011, [0.95, 0.95, 0.93], 'white powder'],
]
// Metal oxides (fine powders, about 1 m²/g) that dissolve in acid at their surface: id, name, formula,
// ion master, rate constant at 25 °C (mol m⁻² s⁻¹ per mol/L H⁺), Ea (kJ/mol), ΔfH° (NBS), colour,
// description. Copper(II) oxide hardly dissolves in cold dilute sulfuric acid but goes within
// minutes near 70 °C; magnesium oxide dissolves at once. Not solids of the ionic model: the
// hydroxides precipitate first, and the oxides form only on heating or ageing.
const OXIDES = [
  ['aq:copper-ii-oxide', 'Copper(II) oxide (powder)', 'CuO', 'Cu+2', 4e-6, 60, -157.3, [0.12, 0.12, 0.12], 'black powder'],
  ['aq:magnesium-oxide', 'Magnesium oxide (powder)', 'MgO', 'Mg+2', 1e-4, 40, -601.6, [0.97, 0.97, 0.96], 'white powder'],
  ['aq:zinc-oxide', 'Zinc oxide (powder)', 'ZnO', 'Zn+2', 2e-5, 50, -350.5, [0.98, 0.98, 0.96], 'white powder'],
]

// Solid catalysts: id, name, formula, substrate, products per mol, rate constant (mol m⁻² s⁻¹ per
// mol/L), Ea (kJ/mol), specific surface (m²/g), colour, description. 0.5 g of manganese(IV) oxide
// in 20 mL of 0.5 M hydrogen peroxide gives most of its oxygen within about a minute.
const CATALYSTS = [
  ['aq:manganese-dioxide', 'Manganese(IV) oxide (powder)', 'MnO2', 'core:hydrogen-peroxide', { 'core:water': 1, 'core:oxygen': 0.5 }, 1.3e-4, 50, 5, [0.16, 0.15, 0.14], 'black powder'],
]

// Gases: id, name, formula, Henry's constant (mol/L per atm, 25 °C), ΔH of solution (kJ/mol), the
// aqueous species it is in equilibrium with.
const GASES = [
  ['aq:carbon-dioxide', 'Carbon dioxide', 'CO2', 0.0339, -19.4, 'H2CO3'],
  ['aq:hydrogen', 'Hydrogen', 'H2', 0.00078, -4.2, undefined],
  ['aq:ammonia-gas', 'Ammonia (gas)', 'NH3', 57, -34, 'NH3'],
]

// ---------------------------------------------------------------------------------------------
const ATOMIC = { H: 1.008, Li: 6.94, C: 12.011, N: 14.007, O: 15.999, F: 18.998, Na: 22.99, Mg: 24.305, Al: 26.982, P: 30.974, S: 32.06, Cl: 35.45, K: 39.098, Ca: 40.078, Cr: 51.996, Mn: 54.938, Fe: 55.845, Co: 58.933, Ni: 58.693, Cu: 63.546, Zn: 65.38, Br: 79.904, Sr: 87.62, Ag: 107.868, I: 126.904, Ba: 137.327, Pb: 207.2 }

/** Molar mass of a formula like "Cu3(PO4)2:3H2O" or "CaSO4:2H2O". */
function molarMass(formula) {
  return formula.split(/[:·]/).reduce((sum, part) => {
    const m = /^(\d+(?:\.\d+)?)?(.*)$/.exec(part)
    return sum + (m[1] ? Number(m[1]) : 1) * massOf(m[2])
  }, 0)
}
function massOf(f) {
  let i = 0
  const group = () => {
    let total = 0
    while (i < f.length && f[i] !== ')') {
      if (f[i] === '(') {
        i++
        const inner = group()
        i++
        total += inner * count()
      } else {
        const m = /^[A-Z][a-z]?/.exec(f.slice(i))
        if (!m) throw new Error(`Cannot read ${f}`)
        i += m[0].length
        if (!(m[0] in ATOMIC)) throw new Error(`No atomic mass for ${m[0]} in ${f}`)
        total += ATOMIC[m[0]] * count()
      }
    }
    return total
  }
  const count = () => {
    const m = /^\d+(?:\.\d+)?/.exec(f.slice(i))
    if (!m) return 1
    i += m[0].length
    return Number(m[0])
  }
  return group()
}

// ---------------------------------------------------------------------------------------------
const dbPath = process.argv[2]
if (!dbPath) {
  console.error('usage: node scripts/data/phreeqc-import.mjs <path/to/minteq.v4.dat>')
  process.exit(2)
}
const db = parseDatabase(readFileSync(dbPath, 'utf8'))
const ALKALI = new Set(['Na+', 'K+', 'Li+'])
const known = new Set([...Object.keys(CARRIERS), 'SCN-'])
const carrierId = (master) => (master === 'SCN-' ? 'aq:thiocyanate' : CARRIERS[master]?.id)

/** A reaction's defined species as a composition in carriers and protons, or undefined. */
function composition(reaction) {
  const comp = {}
  for (const [s, k] of reaction.terms) {
    if (s === reaction.defined || s === 'H2O') continue
    if (s === 'e-') return undefined
    if (s !== 'H+' && !known.has(s)) return undefined
    comp[s] = (comp[s] ?? 0) - k
  }
  return comp
}

const entries = new Map()
const round = (x) => Math.round(x * 1e4) / 1e4
for (const [master, c] of Object.entries(CARRIERS)) {
  entries.set(c.id, {
    id: c.id,
    identity: { name: c.name, class: 'ion', synonyms: [c.formula] },
    // A carrier stands for its neutral acid or base less water: its mass includes the implicit protons.
    physical: { molarMass: `${round(molarMass(master.replace(/[+-]\d*$/, '').replace('Acetate', 'C2H3O2')) - chargeOf(master) * 1.008)} g/mol` },
    aqueous: { formula: master, charge: chargeOf(master), species: [], ...(COUPLES[master] ? { metal: { deposit: COUPLES[master][0], e0: COUPLES[master][1] } } : {}), ...(CARRIER_DHF[master] !== undefined ? { dHf: CARRIER_DHF[master] } : {}) },
    ...(c.epsilon ? { optics: { epsilon: c.epsilon, colour: c.colour } } : {}),
    ...emissionOf(c.id),
    status: 'experimental',
    provenance: { notes: `Ion carrier: stands for its neutral acid or base, protons implicit. Species and constants from the ${SOURCE}.${EMISSION[c.id] ? ' Flame emission: NIST line wavelengths, powers from Boltzmann factors at 2200 K; bands from flame spectra.' : ''}`, review: 'pending' },
  })
}
for (const x of EXTRA_CARRIERS) {
  entries.set(x.id, {
    id: x.id,
    identity: { name: x.name, class: 'ion', synonyms: [x.formula] },
    physical: { molarMass: '59.09 g/mol' },
    aqueous: { formula: x.master, charge: x.charge, species: [], ...(CARRIER_DHF[x.master] !== undefined ? { dHf: CARRIER_DHF[x.master] } : {}) },
    status: 'experimental',
    provenance: { notes: 'Ion carrier (not in MINTEQ v4); its iron(III) complexes are from the literature.', review: 'pending' },
  })
}

// Database species, attached to the first carrier in their composition.
let speciesCount = 0
for (const sp of db.species) {
  const defined = sp.reaction.defined
  if (!defined || known.has(defined)) continue
  const comp = composition(sp.reaction)
  if (!comp) continue
  const carriers = Object.keys(comp).filter((s) => s !== 'H+')
  if (carriers.length === 0) continue
  // Ion pairs of the alkali metals matter little at school concentrations: left out.
  if (carriers.some((s) => ALKALI.has(s)) && carriers.length > 1) continue
  const first = carriers[0]
  const entry = entries.get(carrierId(first))
  const withTerms = {}
  for (const [s, k] of Object.entries(comp)) {
    if (s === first && k === 1) continue
    if (s === first) {
      // A polynuclear species (Cu2(OH)2+2): the extra copies of the carrier itself.
      withTerms[carrierId(s)] = k - 1
      continue
    }
    withTerms[s === 'H+' ? 'H+' : carrierId(s)] = k
  }
  if (comp[first] !== 1 && !withTerms[carrierId(first)]) continue
  const optics = SPECIES_OPTICS[defined]
  entry.aqueous.species.push({
    formula: defined,
    logK: sp.logK,
    ...(sp.dH !== undefined ? { dH: round(sp.dH) } : {}),
    ...(Object.keys(withTerms).length ? { with: withTerms } : {}),
    ...(optics ? { epsilon: optics.epsilon, colour: optics.colour } : {}),
  })
  speciesCount++
}
for (const x of [...EXTRA_SPECIES, ...EXTRA_CARRIER_SPECIES]) {
  const entry = entries.get(carrierId(x.carrier))
  const withTerms = Object.fromEntries(Object.entries(x.with).map(([s, k]) => [s === 'H+' ? 'H+' : carrierId(s), k]))
  entry.aqueous.species = entry.aqueous.species.filter((s) => s.formula !== x.formula)
  entry.aqueous.species.push({ formula: x.formula, logK: round(x.logK), ...(x.dH !== undefined ? { dH: x.dH } : {}), with: withTerms, ...(x.epsilon ? { epsilon: x.epsilon, colour: x.colour } : {}) })
  entry.provenance.references = [...(entry.provenance.references ?? []), `${x.formula}: ${x.ref}`]
}

// Solids, by the allowlist.
let solidCount = 0
for (const ph of db.phases) {
  const meta = SOLIDS[ph.name]
  if (!meta) continue
  const [id, name, rgb, look, override] = meta
  const formula = ph.reaction.lhs[0][1]
  const ions = {}
  let protons = 0
  for (const [s, k] of ph.reaction.terms) {
    if (s === formula || s === 'H2O') continue
    if (s === 'H+') {
      protons += k
      continue
    }
    if (!known.has(s)) throw new Error(`${ph.name}: ${s} is not a carrier`)
    ions[carrierId(s)] = k
  }
  // Protons are implicit: dissolving gives the ions and −Σ charge protons; the database must agree.
  const implied = -[...ph.reaction.terms].reduce((a, [s, k]) => (s === formula || s === 'H2O' || s === 'H+' ? a : a + k * chargeOf(s)), 0)
  if (Math.abs(implied - protons) > 1e-9) throw new Error(`${ph.name}: protons ${protons} differ from the implied ${implied}`)
  entries.set(id, {
    id,
    identity: { name, class: override?.phase === 'gas' ? 'gas' : 'salt', formula: formula.replace(':', '·') },
    physical: { molarMass: `${round(molarMass(formula))} g/mol`, phase: override?.phase === 'gas' ? 'gas' : 'solid', ...(override?.phase === 'gas' ? {} : settling(look)) },
    ions,
    solid: { logK: override?.logK ?? ph.logK, ...(ph.dH !== undefined ? { dH: round(ph.dH) } : {}), rgb, look, ...(override?.phase ? { phase: override.phase } : {}) },
    status: 'experimental',
    provenance: { notes: `Phase "${ph.name}" (${ph.reaction.text}) from the ${SOURCE}.${override?.note ? ' ' + override.note : ''}`, review: 'pending' },
  })
  solidCount++
}
const missingSolids = Object.keys(SOLIDS).filter((n) => !db.phases.some((p) => p.name === n))
if (missingSolids.length) throw new Error(`Not in the database: ${missingSolids.join(', ')}`)

for (const [id, name, formula, carriers] of SALTS) {
  // A salt that is also a solid of the ionic model (chalcanthite) keeps its solid facet and settling.
  const solidEntry = entries.get(id)
  entries.set(id, {
    ...(solidEntry?.solid ? { solid: solidEntry.solid } : {}),
    id,
    identity: { name, class: 'salt', formula },
    physical: { molarMass: `${round(molarMass(formula))} g/mol`, phase: 'solid', ...(solidEntry?.solid ? settling(solidEntry.solid.look) : {}) },
    ions: Object.fromEntries(Object.entries(carriers).map(([m, k]) => [carrierId(m), k])),
    ...(SALT_THERMO[id] ? { thermo: { dHf: SALT_THERMO[id][0], ...(SALT_THERMO[id][1] ? { water: SALT_THERMO[id][1] } : {}) } } : {}),
    status: 'experimental',
  })
}

for (const [id, name, el, master, charge, e0, acidK, displaceK, ea, area, rgb, description] of [...METALS, ...DEPOSITS]) {
  entries.set(id, {
    id,
    identity: { name, class: 'metal', formula: el },
    physical: { molarMass: `${ATOMIC[el]} g/mol`, phase: 'solid' },
    // Iron rusts on to iron(III) in air and water.
    metal: { ion: carrierId(master), charge, e0, ...(acidK ? { acidK } : {}), ...(displaceK ? { displaceK } : {}), ea, ...(el === 'Fe' ? { corrodesTo: 'aq:iron-iii' } : {}) },
    surface: { m2PerG: area, ...(/ribbon|foil|strip/.test(id) ? { shape: 'sheet' } : /nail/.test(id) ? { shape: 'rod' } : {}) },
    look: { rgb, description },
    status: 'experimental',
    provenance: { notes: `Reacts at its surface (models/surface.ts): standard potential ${e0} V; rate constants illustrative, calibrated to classroom timings.`, review: 'pending' },
  })
}
for (const [id, name, k, ea, area, rgb, description] of CHIPS) {
  entries.set(id, {
    id,
    identity: { name, class: 'salt', formula: 'CaCO3' },
    physical: { molarMass: `${round(molarMass('CaCO3'))} g/mol`, phase: 'solid', density: '2710 g/L' },
    ions: { 'aq:calcium': 1, 'aq:carbonate': 1 },
    // Calcite, ΔfH° (NBS).
    thermo: { dHf: -1206.92 },
    dissolution: { k, order: 1, ea },
    surface: { m2PerG: area },
    look: { rgb, description },
    status: 'experimental',
    provenance: { notes: 'Dissolves at its surface in acid (models/surface.ts); its CO₂ bubbles out through the ionic model. Rate constant illustrative, calibrated to classroom timings.', review: 'pending' },
  })
}
for (const [id, name, formula, master, k, ea, dHf, rgb, description] of OXIDES) {
  entries.set(id, {
    id,
    identity: { name, class: 'salt', formula },
    physical: { molarMass: `${round(molarMass(formula))} g/mol`, phase: 'solid' },
    ions: { [carrierId(master)]: 1 },
    // The oxide holds one water beyond its ion and the protons it takes up (CuO = Cu²⁺ − 2H⁺ + H₂O).
    thermo: { dHf, water: 1 },
    dissolution: { k, order: 1, ea },
    surface: { m2PerG: 1 },
    look: { rgb, description },
    status: 'experimental',
    provenance: { notes: 'Dissolves in acid at its surface (models/surface.ts). Rate constant and activation energy illustrative, calibrated to classroom timings; ΔfH° from the NBS tables.', review: 'pending' },
  })
}
for (const [id, name, formula, substrate, products, k, ea, area, rgb, description] of CATALYSTS) {
  entries.set(id, {
    id,
    identity: { name, class: 'salt', formula },
    physical: { molarMass: `${round(molarMass(formula))} g/mol`, phase: 'solid' },
    catalyst: { substrate, products, k, ea },
    surface: { m2PerG: area },
    look: { rgb, description },
    status: 'experimental',
    provenance: { notes: 'A catalyst at its surface (models/surface.ts); not used up. Rate constant illustrative, calibrated to classroom timings.', review: 'pending' },
  })
}
for (const [id, name, formula, henry, dH, species] of GASES) {
  const e = entries.get(id) ?? { id, identity: { name, class: 'gas', formula }, physical: { molarMass: `${round(molarMass(formula))} g/mol`, phase: 'gas' }, status: 'experimental' }
  e.gas = { henry, dH, ...(species ? { species } : {}) }
  entries.set(id, e)
}

mkdirSync(join(OUT, 'catalogue'), { recursive: true })
const list = [...entries.values()]
writeFileSync(join(OUT, 'catalogue/substances.json'), JSON.stringify(list, null, 2) + '\n')
console.log(`aq: ${Object.keys(CARRIERS).length + EXTRA_CARRIERS.length} ion carriers, ${speciesCount} database species + ${EXTRA_SPECIES.length + EXTRA_CARRIER_SPECIES.length} literature species, ${solidCount} solids, ${SALTS.length} salts`)

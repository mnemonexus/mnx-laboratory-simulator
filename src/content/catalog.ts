// Data-driven content: reagents, instruments, experiences.
// Add a new experience by adding JSON-like data here + a grading rule id.
// No simulation logic lives in this file.

export interface PipetteDef {
  id: string
  min: number
  max: number
  label: string
}

export const PIPETTES: PipetteDef[] = [
  { id: 'P2', min: 0.2, max: 2, label: 'P2 · 0.2–2 µL' },
  { id: 'P10', min: 0.5, max: 10, label: 'P10 · 0.5–10 µL' },
  { id: 'P20', min: 2, max: 20, label: 'P20 · 2–20 µL' },
  { id: 'P200', min: 20, max: 200, label: 'P200 · 20–200 µL' },
  { id: 'P1000', min: 100, max: 1000, label: 'P1000 · 100–1000 µL' },
]

export interface WavelengthDef {
  nm: number
  label: string
  short: string
}

export const WAVELENGTHS: WavelengthDef[] = [
  { nm: 280, label: '280 nm — protein UV', short: '280' },
  { nm: 340, label: '340 nm — NADH', short: '340' },
  { nm: 450, label: '450 nm — colorimetric', short: '450' },
  { nm: 562, label: '562 nm — BCA/RCA protein assay', short: '562' },
  { nm: 595, label: '595 nm — Bradford', short: '595' },
]

export type ReagentKind = 'protein' | 'standard' | 'substrate' | 'water' | 'assay' | 'unknown'

export interface ReagentDef {
  id: string
  name: string
  conc: number // µM
  kind: ReagentKind
  color: string
  activity: number
  degraded?: boolean
  hint?: string
  volume?: number
}

export interface ExperienceDef {
  id: string
  title: string
  level: string
  tagline: string
  objective: string
  brief: string[]
  formula: string
  reagents: ReagentDef[]
  plateLabel: string
  grading: string // grading rule id in sim/grading.ts
  accent: string
  icon: string
  truth: Record<string, number | string>
  tasks: string[]
}

export const EXPERIENCES: ExperienceDef[] = [
  {
    id: 'bca',
    title: 'Protein concentration (BCA assay)',
    level: 'Level 1 · Quantitative fundamentals',
    tagline: 'Construct a 562 nm standard curve and quantify four unknown protein samples.',
    objective: 'Determine unknown protein concentrations using BCA colorimetric standard curve interpolation.',
    brief: [
      'Prepare BSA standards: 0, 0.25, 0.5, 1.0, 1.5, 2.0 mg/mL in duplicate wells A1–A6 & B1–B6.',
      'Dispense unknown samples U1, U2, U3, and U4 into row C with appropriate dilution buffer.',
      'Add 200 µL BCA working reagent to each well, incubate at 37 °C for 30 minutes.',
      'Measure absorbance at 562 nm on the BioSim PR-960 microplate reader with blank subtraction.',
      'Identify saturated samples (A > 1.2), re-dilute, re-read and report final concentrations.',
    ],
    formula: 'A₅₆₂ = m·[Protein] + c   ·   linear range: 0.05 – 1.50 mg/mL   ·   R² ≥ 0.995',
    reagents: [
      { id: 'bsa', name: 'BSA Standard 2.0 mg/mL', conc: 2000, kind: 'standard', color: '#e0e7ff', activity: 1 },
      { id: 'buffer', name: 'Tris-HCl 50 mM pH 7.4', conc: 0, kind: 'water', color: '#bae6fd', activity: 1 },
      { id: 'bca_reagent', name: 'BCA Working Reagent', conc: 100, kind: 'assay', color: '#818cf8', activity: 1 },
      { id: 'u1', name: 'Unknown U1', conc: 620, kind: 'unknown', color: '#cbd5e1', activity: 1 },
      { id: 'u2', name: 'Unknown U2 (high)', conc: 3460, kind: 'unknown', color: '#cbd5e1', activity: 1 },
      { id: 'u3', name: 'Unknown U3', conc: 430, kind: 'unknown', color: '#cbd5e1', activity: 1 },
      { id: 'u4', name: 'Unknown U4', conc: 1070, kind: 'unknown', color: '#cbd5e1', activity: 1 },
    ],
    plateLabel: 'BCA-96',
    grading: 'bradford',
    accent: '#38bdf8',
    icon: '◈',
    truth: { p7: 620, p12: 3460, stdTop: 2000, eps595: 0.000721 },
    tasks: ['Prepare BSA standard series (0–2.0 mg/mL)', 'Prepare unknown samples U1–U4', 'Add BCA working reagent & incubate', 'Measure plate at 562 nm', 'Analyse results & identify saturated U2', 'Complete lab notebook'],
  },
  {
    id: 'kinetics',
    title: 'Enzyme kinetics: Determine Km and Vmax',
    level: 'Level 3 · Enzyme biochemistry',
    tagline: 'Lactate dehydrogenase substrate series to extract initial rates and fit Michaelis–Menten parameters.',
    objective: 'Determine Km and Vmax of lactate dehydrogenase from coupled NADH oxidation at 340 nm.',
    brief: [
      'Stocks: Tris-HCl 50 mM pH 7.4, NADH 10 mM, Pyruvate 100 mM, and LDH Enzyme stock.',
      'Prepare substrate dilution series: 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0 mM pyruvate.',
      'Prepare assay mix with NADH cofactor in 96-well plate or microcuvettes.',
      'Add enzyme to initiate the reaction and quickly measure absorbance at 340 nm over 10 minutes.',
      'Extract linear initial rate (ΔA/min) for each [S] and fit Michaelis–Menten & Lineweaver–Burk.',
    ],
    formula: 'v₀ = Vmax·[S] / (Km + [S])   ·   1/v₀ = (Km/Vmax)(1/[S]) + 1/Vmax',
    reagents: [
      { id: 'tris', name: 'Tris-HCl 50 mM pH 7.4', conc: 50000, kind: 'water', color: '#e0f2fe', activity: 1 },
      { id: 'nadh', name: 'NADH 10 mM', conc: 10000, kind: 'substrate', color: '#fef08a', activity: 1 },
      { id: 'pyruvate', name: 'Pyruvate 100 mM', conc: 100000, kind: 'substrate', color: '#bbf7d0', activity: 1 },
      { id: 'ldh', name: 'LDH Enzyme stock', conc: 50, kind: 'protein', color: '#fde68a', activity: 1, volume: 1500 },
    ],
    plateLabel: 'LDH-96',
    grading: 'kinetics',
    accent: '#a78bfa',
    icon: '⬡',
    truth: { vmax: 52, km: 180 },
    tasks: ['Prepare substrate dilutions', 'Prepare assay mix', 'Add enzyme', 'Incubate and measure (340 nm)', 'Analyse initial rates & fit Km/Vmax', 'Complete lab notebook'],
  },
  {
    id: 'inhibitor',
    title: 'Unknown inhibitor: Determine mechanism',
    level: 'Level 4 · Enzyme regulation',
    tagline: 'Characterise inhibitor X: measure IC50 and discriminate competitive vs non-competitive inhibition.',
    objective: 'Determine whether inhibitor X is competitive, non-competitive, or uncompetitive and calculate Ki.',
    brief: [
      'Plan experimental design with independent and dependent variables, blanks, and controls.',
      'Prepare 8 inhibitor concentrations (0 – 100 µM) with 3 replicates per condition.',
      'Assay target enzyme at both low and high substrate concentrations in the presence of inhibitor.',
      'Construct dose-response curve and reciprocal Lineweaver–Burk plots to infer mechanism.',
    ],
    formula: '% Inhibition = (1 - Vi/V0) × 100   ·   v = Vmax[S] / (Km(1 + [I]/Ki) + [S])',
    reagents: [
      { id: 'inhibitor_x', name: 'Inhibitor X (10 mM)', conc: 10000, kind: 'substrate', color: '#fed7aa', activity: 1 },
      { id: 'substrate', name: 'Substrate Stock (50 mM)', conc: 50000, kind: 'substrate', color: '#bbf7d0', activity: 1 },
      { id: 'enzyme_y', name: 'Enzyme Y Stock', conc: 50, kind: 'protein', color: '#fde68a', activity: 1 },
      { id: 'buffer', name: 'Assay Buffer pH 7.4', conc: 0, kind: 'water', color: '#bae6fd', activity: 1 },
    ],
    plateLabel: 'INH-96',
    grading: 'kinetics',
    accent: '#38bdf8',
    icon: '◈',
    truth: { ic50: 14.5, mechanism: 'competitive', ki: 6.2, vmax: 48, km: 160 },
    tasks: ['Design experimental protocol & controls', 'Prepare inhibitor dilution series', 'Run kinetic plate assay', 'Estimate IC50 from dose-response', 'Determine competitive inhibition mechanism'],
  },
  {
    id: 'purification',
    title: 'Protein purification: Size exclusion chromatography',
    level: 'Level 5 · Protein biochemistry',
    tagline: 'Separate target enzyme from crude lysate using gel filtration chromatography and fraction collection.',
    objective: 'Purify target enzyme while preserving specific activity and construct a purification table.',
    brief: [
      'Load 2.0 mL crude lysate onto Superdex 200 column equilibrated in 20 mM Tris, 150 mM NaCl.',
      'Run elution at 1.0 mL/min and collect 1.0 mL fractions across the elution profile.',
      'Monitor UV 280 nm absorbance peaks and conductivity curve in real time.',
      'Test fractions for enzyme activity and pool fractions 15–18 containing the target peak.',
      'Verify purity by SDS-PAGE and calculate yield and purification fold.',
    ],
    formula: 'Yield (%) = (Total Activity_final / Total Activity_initial) × 100',
    reagents: [
      { id: 'crude', name: 'Crude Cell Lysate', conc: 15000, kind: 'protein', color: '#d8b4fe', activity: 0.65 },
      { id: 'buffer_a', name: 'Running Buffer (20 mM Tris)', conc: 20000, kind: 'water', color: '#e0f2fe', activity: 1 },
      { id: 'buffer_b', name: 'Elution Buffer (1 M NaCl)', conc: 1000000, kind: 'water', color: '#bae6fd', activity: 1 },
    ],
    plateLabel: 'SEC-COL',
    grading: 'bradford',
    accent: '#10b981',
    icon: '⬡',
    truth: { p7: 15000, p12: 24000, stdTop: 50000, eps595: 0.0021 },
    tasks: ['Equilibrate column with Buffer A', 'Inject sample & start elution', 'Monitor UV 280 nm & conductivity', 'Select fractions 15–18 to pool', 'Calculate yield and specific activity'],
  },
  {
    id: 'troubleshoot',
    title: 'Troubleshooting: Dead control assay',
    level: 'Level 2 · Experimental validity',
    tagline: 'The control reaction shows only 40% expected rate. Diagnose with discriminating experiments.',
    objective: 'Investigate why an established control assay failed using evidence instead of guesses.',
    brief: [
      'Observed result: The control reaction shows only 40% of the expected activity.',
      'Formulate hypotheses: enzyme inactive, wrong pH, substrate degraded, instrument calibration.',
      'Run parallel diagnostic assays of Enzyme E-α vs Enzyme E-β under identical conditions.',
      'Measure 280 nm absorbance to demonstrate that protein mass does not guarantee activity.',
      'Identify thermal denaturation / freeze-thaw damage as root cause with confirming test.',
    ],
    formula: 'control rate ≈ Vmax ≈ 40 µM/min   ·   A₂₈₀ = εcl (mass, not activity)',
    reagents: [
      { id: 'ctrl', name: 'Enzyme E-α (suspect)', conc: 50, kind: 'protein', color: '#f2dfae', activity: 0.06, degraded: true, hint: 'repeated freeze-thaws' },
      { id: 'ebeta', name: 'Enzyme E-β (fresh)', conc: 50, kind: 'protein', color: '#eecfb8', activity: 1 },
      { id: 'sub', name: 'Substrate Stock (10 mM)', conc: 10000, kind: 'substrate', color: '#b9f0cd', activity: 1 },
      { id: 'buffer', name: 'Assay Buffer pH 7.4', conc: 0, kind: 'water', color: '#9fd8ff', activity: 1 },
    ],
    plateLabel: 'TS-96',
    grading: 'troubleshoot',
    accent: '#f59e0b',
    icon: '◎',
    truth: { culprit: 'ctrl', controlRate: 40 },
    tasks: ['Review abnormal control rate', 'Check substrate & buffer pH', 'Run E-α vs E-β in parallel', 'Perform A280 check (mass vs activity)', 'Submit root cause diagnosis'],
  },
]

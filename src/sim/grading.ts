// Deterministic grading: process + result scored separately.
// Pure functions over (defs, LabState, answers). Worker-safe.
import type { Answers, GradeResult, LabState } from './model'
import { fitLinear, fitMichaelis } from './engine'
import type { ExperienceDef } from '../content/catalog'

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.abs(b)

const STD_CONCS = [0, 100, 500, 2500, 5000, 10000, 25000, 50000]
const STD_WELLS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2']

function gradeBradford(def: ExperienceDef, state: LabState, answers: Answers): GradeResult {
  const mis: string[] = []
  const truth = def.truth
  const eps = Number(truth.eps595)
  const read = [...state.measurements].reverse().find((m) => m.plate === def.plateLabel)
  let stdScore = 0
  let saturated = false
  if (read && !read.raw) {
    const meas = STD_WELLS.map((w) => read.values[w] ?? NaN)
    const fit = fitLinear(STD_CONCS.slice(1), meas.slice(1).map((m) => (isNaN(m) ? 0 : m)))
    const errs = STD_CONCS.slice(1).map((c) => {
      const pred = fit.slope * c + fit.intercept
      return Math.abs(pred - eps * c) / (eps * c)
    })
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length
    stdScore = Math.max(0, 100 - mean * 400) * (fit.r2 >= 0.99 ? 1 : 0.6)
    if (fit.r2 < 0.99) mis.push('Standard curve R² < 0.99 — check the dilution series or blank.')
    const p12v = read.values['C2'] ?? NaN
    if (!isNaN(p12v) && p12v > eps * Number(truth.stdTop) * 1.05) saturated = true
  } else if (read) {
    mis.push('Plate read without a blank — calibration carries a background offset.')
    stdScore = 20
  }
  const p7a = parseFloat(answers.p7 ?? '')
  const p12a = parseFloat(answers.p12 ?? '')
  const p7ok = isFinite(p7a) && near(p7a, Number(truth.p7), 0.12)
  const p12ok = isFinite(p12a) && near(p12a, Number(truth.p12), 0.15)
  if (!isFinite(p12a) || !near(p12a, Number(truth.p12), 0.5))
    mis.push('Saturation ignored — a signal above the calibrated range is not a measurement.')
  const domains: GradeResult['domains'] = [
    {
      name: 'Experimental design & controls', weight: 20, score: read ? (read.raw ? 30 : stdScore) : 10,
      feedback: read && !read.raw ? 'Blank used; series spans the calibrated range.' : read ? 'Read without a blank.' : 'Plate never measured.',
    },
    {
      name: 'Dilution & preparation', weight: 20, score: stdScore,
      feedback: stdScore > 70 ? 'Standards recovered within a few percent.' : 'Measured standards deviate from theory — recheck dilution ratios.',
    },
    {
      name: 'Measurement validity', weight: 20, score: saturated ? 75 : stdScore,
      feedback: saturated ? 'P-12 saturated the detector yet was not diluted and re-run.' : 'All wells within the linear range.',
    },
    {
      name: 'Calibration & quantification', weight: 40, score: p7ok ? (p12ok ? 100 : 45) : p12ok ? 30 : 5,
      feedback: `${p7ok ? 'P-7 ✓' : 'P-7 ✗'} (≈${Number(truth.p7).toLocaleString()} µM) · ${p12ok ? 'P-12 ✓' : 'P-12 ✗'} (≈${Number(truth.p12).toLocaleString()} µM, needs dilution factor).`,
    },
  ]
  return {
    domains,
    validity: p7ok && p12ok ? 'Valid' : p7ok ? 'Partially interpretable' : 'Invalid',
    summary:
      p7ok && p12ok
        ? 'Both unknowns quantified through a defensible calibration. The saturated sample is the lesson: signal outside the validated range is not a measurement.'
        : 'Not every unknown has a defensible value. Trace the chain — dilution, blank, range — to find the broken link.',
    misconceptions: mis,
  }
}

function gradeKinetics(def: ExperienceDef, state: LabState, answers: Answers): GradeResult {
  const mis: string[] = []
  const V = Number(def.truth.vmax)
  const K = Number(def.truth.km)
  const tc = Object.values(state.timeCourses).find((t) => t.length > 0)
  let rates: { S: number; v: number; r2: number }[] = []
  const raw = state.flags.rates
  if (typeof raw === 'string') {
    try {
      rates = JSON.parse(raw)
    } catch {
      rates = []
    }
  }
  const ran = !!tc
  if (!ran) mis.push('No kinetic run performed — no time-course data to analyse.')
  let rateScore = 0
  if (rates.length >= 3) {
    const errs = rates.map((r) => Math.abs(r.v - ((V * r.S) / (K + r.S))) / Math.max(0.05, (V * r.S) / (K + r.S)))
    const worst = Math.max(...errs)
    rateScore = Math.max(0, 100 - worst * 120)
    if (worst > 0.25) mis.push('Initial-rate region poorly chosen — slopes deviate from true rates.')
  } else mis.push('Fewer than three initial rates — parameters cannot be estimated.')
  const pos = rates.map((r) => r.S).filter((s) => s > 0)
  const maxS = pos.length ? Math.max(...pos) : 0
  const minS = pos.length ? Math.min(...pos) : Infinity
  let span = 100
  if (maxS < 4 * K) {
    span = 35
    mis.push('All [S] far below saturation — Vmax is unidentifiable.')
  }
  if (minS > K * 3) {
    span = Math.min(span, 35)
    mis.push('All [S] far above Km — Km cannot be estimated.')
  }
  const nn = rates.length >= 3 ? fitMichaelis(rates.map((r) => r.S), rates.map((r) => r.v)) : null
  const vmaxA = parseFloat(answers.vmax ?? '')
  const kmA = parseFloat(answers.km ?? '')
  const vmaxOk = !!nn && isFinite(vmaxA) && near(vmaxA, nn.Vmax, 0.2)
  const kmOk = !!nn && isFinite(kmA) && near(kmA, nn.Km, 0.25)
  if (nn && isFinite(kmA) && !kmOk) mis.push('Reported Km outside ±25% of the fitted value — check units and region.')
  const fitTotal = ((vmaxOk ? 100 : 0) + (kmOk ? 100 : 0)) / 2
  const domains: GradeResult['domains'] = [
    {
      name: 'Experimental design (substrate range)', weight: 20, score: (ran ? 100 : 15) * 0.5 + span * 0.5,
      feedback: span === 100 ? 'Series brackets Km; both parameters identifiable.' : 'Concentrations do not span the transition region.',
    },
    { name: 'Procedure execution', weight: 15, score: ran ? 100 : 10, feedback: ran ? 'Kinetic run at 340 nm.' : 'No kinetic measurement.' },
    { name: 'Initial-rate extraction', weight: 25, score: rateScore, feedback: rateScore > 70 ? 'Linear-region slopes reproduce true rates.' : 'Recorded rates disagree with the reaction — region selection matters.' },
    {
      name: 'Parameter estimation', weight: 40, score: fitTotal,
      feedback: nn ? `Fit: Vmax=${nn.Vmax.toFixed(1)}, Km=${nn.Km.toFixed(0)} (true ${V}/${K}). ${vmaxOk ? 'Vmax ✓' : 'Vmax ✗'} ${kmOk ? 'Km ✓' : 'Km ✗'}` : 'Insufficient rates.',
    },
  ]
  return {
    domains,
    validity: !ran ? 'Invalid' : vmaxOk && kmOk ? 'Valid' : 'Partially interpretable',
    summary:
      vmaxOk && kmOk
        ? 'Parameters recovered from data you generated — mix → signal → rate → model all closed. Compare nonlinear vs Lineweaver–Burk estimates.'
        : 'No trustworthy parameters yet. Usual culprits: range never brackets Km, or regions contaminated by lag/depletion.',
    misconceptions: mis,
  }
}

function gradeTroubleshoot(_def: ExperienceDef, state: LabState, answers: Answers): GradeResult {
  const mis: string[] = []
  const tc = Object.values(state.timeCourses).find((t) => t.length > 0)
  const tested: string[] = []
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 12; c++) {
      const w = state.plate.wells[r][c]
      if (w && w.enzyme && w.volume >= 100) tested.push(`${r},${c}`)
    }
  const both = tested.length >= 2
  const ran = !!tc
  const answer = (answers.cause ?? '').toLowerCase()
  const causeOk = /e-?α|denatur|inactiv|freeze|therm|storage|heat/.test(answer)
  if (!both && ran) mis.push('Single-condition measurement cannot localise the failure (enzyme vs reagent vs instrument).')
  if (/random|no idea|unsure/.test(answer) && answer) mis.push('Random troubleshooting — run the experiment that best separates the hypotheses.')
  const domains: GradeResult['domains'] = [
    {
      name: 'Diagnostic experiment design', weight: 35, score: ran ? (both ? 100 : 55) : 15,
      feedback: ran ? (both ? 'Both stocks assayed in parallel — the enzyme is isolated as the variable.' : 'Only one enzyme measured; fault cannot be localised.') : 'No kinetic comparison.',
    },
    {
      name: 'Quantity vs function', weight: 30,
      score: (state.measurements.some((m) => m.settings.startsWith('280')) ? 45 : 10) + (both && ran ? 45 : 0),
      feedback: state.measurements.some((m) => m.settings.startsWith('280'))
        ? '280 nm confirms protein mass — but mass ≠ activity, which is the crux.'
        : 'No absorbance check. Mass tells you nothing about activity.',
    },
    {
      name: 'Root-cause identification', weight: 35,
      score: causeOk ? 100 : /reagent|substrate|nadh|instrument|wavelength/.test(answer) ? 25 : 0,
      feedback: causeOk
        ? 'Correct: E-α is inactivated (thermal/freeze–thaw denaturation). E-β exonerates reagents and instrument.'
        : answer ? 'E-β running normally rules out shared reagents and instrument. The defect is specific to E-α.' : 'No cause stated.',
    },
  ]
  return {
    domains,
    validity: 'Valid',
    summary: causeOk
      ? 'Well diagnosed. The parallel assay was the discriminating move: identical conditions, one variable changed.'
      : 'Failure mode: denatured control enzyme. Re-run E-β in parallel — if it is normal, only E-α is faulty.',
    misconceptions: mis,
  }
}

export function gradeExperience(def: ExperienceDef, state: LabState, answers: Answers): GradeResult {
  switch (def.grading) {
    case 'bradford':
      return gradeBradford(def, state, answers)
    case 'kinetics':
      return gradeKinetics(def, state, answers)
    case 'troubleshoot':
      return gradeTroubleshoot(def, state, answers)
    default:
      return { domains: [], validity: 'Inconclusive', summary: 'Unknown grading rule.', misconceptions: [] }
  }
}

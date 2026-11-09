import React from 'react'
import { EXPERIENCES, type ExperienceDef } from '../content/catalog'
import type { ActiveStation } from './Navbar'
import { ThreeLabScene } from './ThreeLabScene'

interface HomeDashboardProps {
  onStartExperience: (exp: ExperienceDef) => void
  onSelectStation: (s: ActiveStation) => void
  currentExp: ExperienceDef | null
}

const HUB = [
  { title: 'Continue', sub: 'Enzyme kinetics · LDH', action: 'kinetics' as const },
  { title: 'Browse stations', sub: 'Bench, reader, centrifuge, chromatography', action: 'stations' as const },
  { title: 'Quick practice', sub: 'Pipetting, blanks, plate layout', action: 'prep' as const },
  { title: 'Notebook', sub: 'Calculations, timeline, conclusions', action: 'notebook' as const },
]

export const HomeDashboard: React.FC<HomeDashboardProps> = ({
  onStartExperience,
  onSelectStation,
}) => {
  return (
    <div className="relative w-full min-h-[calc(100vh-3rem)] overflow-y-auto ui-page">
      <div className="absolute inset-0 z-0">
        <ThreeLabScene variant="home" showCameraUI={false} />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(90deg, var(--overlay-strong) 0%, var(--overlay) 48%, transparent 100%)' }} />
      </div>

      <div className="relative z-10 max-w-6xl mx-auto px-6 py-12 grid grid-cols-1 lg:grid-cols-12 gap-10">
        <div className="lg:col-span-7 space-y-8">
          <div>
            <div className="ui-chip mb-4">Virtual laboratory</div>
            <h1 className="ui-title text-[42px] sm:text-[52px] leading-[1.02] max-w-xl">
              Experimental Biochemistry Workbench
            </h1>
            <p className="mt-4 text-[15px] text-[var(--muted)] max-w-lg leading-relaxed">
              Practise the decisions that make an experiment valid — pipetting, plates, kinetics,
              purification — without the cost of a wet lab.
            </p>
          </div>

          <div className="flex flex-wrap gap-2.5">
            <button
              onClick={() => onStartExperience(EXPERIENCES[0])}
              data-testid="start-experience"
              className="ui-btn-solid h-10 px-5 text-[13px]"
            >
              Start experience
              <span className="opacity-75">→</span>
            </button>
            <button onClick={() => onSelectStation('practical')} data-testid="open-practicals" className="ui-btn h-10 px-4">
              Practicals
            </button>
            <button onClick={() => onSelectStation('station-selector')} className="ui-btn h-10 px-4">
              Enter the lab
            </button>
          </div>

          <div className="divide-y divide-[var(--line)] border-y border-[var(--line)] max-w-xl">
            {HUB.map((item) => (
              <button
                key={item.title}
                onClick={() => {
                  if (item.action === 'kinetics') onStartExperience(EXPERIENCES[1])
                  else if (item.action === 'stations') onSelectStation('station-selector')
                  else if (item.action === 'prep') onSelectStation('sample-prep')
                  else onSelectStation('notebook')
                }}
                className="w-full py-3.5 flex items-center justify-between text-left group"
              >
                <span>
                  <span className="block text-[13.5px] font-medium text-[var(--ink)]">{item.title}</span>
                  <span className="block text-[12px] text-[var(--muted)] mt-0.5">{item.sub}</span>
                </span>
                <span className="text-[var(--faint)] group-hover:text-[var(--ink)] transition-colors">→</span>
              </button>
            ))}
          </div>

          <p className="text-[12px] text-[var(--faint)] font-serif-ui italic">
            Better questions. Better experiments.
          </p>
        </div>

        <div className="lg:col-span-5 space-y-3">
          <div className="ui-panel p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="ui-kicker">In progress</span>
              <span className="font-mono-ui text-[11px] text-[var(--muted)]">3 / 8</span>
            </div>
            <div className="text-[14px] font-medium">Protein concentration (BCA)</div>
            <div className="text-[12px] text-[var(--muted)] mt-0.5">Prepare standards</div>
            <div className="mt-3 h-[3px] bg-[var(--bg-2)] rounded-full overflow-hidden">
              <div className="h-full bg-[var(--ink)] w-[40%]" />
            </div>
            <button onClick={() => onStartExperience(EXPERIENCES[0])} className="ui-btn w-full mt-4">
              Resume session
            </button>
          </div>

          <div className="ui-panel p-4">
            <div className="ui-kicker mb-3">Experiences</div>
            <div className="space-y-0.5">
              {EXPERIENCES.map((exp) => (
                <button
                  key={exp.id}
                  data-testid={`experience-${exp.id}`}
                  onClick={() => onStartExperience(exp)}
                  className="w-full text-left px-2 py-2.5 rounded-md hover:bg-[var(--bg-2)] transition-colors"
                >
                  <div className="text-[13px] font-medium text-[var(--ink)]">{exp.title}</div>
                  <div className="text-[11.5px] text-[var(--muted)] mt-0.5 line-clamp-1">{exp.tagline}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

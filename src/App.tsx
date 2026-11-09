import { useState, useEffect } from 'react'
import { Navbar, type ActiveStation } from './components/Navbar'
import { HomeDashboard } from './components/HomeDashboard'
import { StationSelector } from './components/StationSelector'
import { SamplePrepBench } from './components/SamplePrepBench'
import { MicroplateReaderStation } from './components/MicroplateReaderStation'
import { DataAnalysisStation } from './components/DataAnalysisStation'
import { CentrifugeStation } from './components/CentrifugeStation'
import { ChromatographyStation } from './components/ChromatographyStation'
import { LabNotebookView } from './components/LabNotebookView'
import { ExperimentalDesignView } from './components/ExperimentalDesignView'
import { TroubleshootingView } from './components/TroubleshootingView'
import { PracticalView } from './components/practical/PracticalView'
import { PracticalCtx } from './components/practical/usePractical'
import type { PracticalRuntime } from './runtime/practical'

import { EXPERIENCES, type ExperienceDef } from './content/catalog'
import { makeLab, transfer, readPlate, runKinetics } from './sim/engine'
import type { LabState } from './sim/model'
import { useLabHost } from './host/context'

export default function App({ practical }: { practical: PracticalRuntime }) {
  const host = useLabHost()
  // A practical the host chose is already running: there is no home screen to pass through.
  const [activeStation, setActiveStation] = useState<ActiveStation>(practical.launched ? 'practical' : 'home')
  const [currentExp, setCurrentExp] = useState<ExperienceDef>(EXPERIENCES[0])
  const [lab, setLab] = useState<LabState>(() => makeLab(EXPERIENCES[0].plateLabel, EXPERIENCES[0].reagents))
  const [labClock, setLabClock] = useState<number>(14 * 3600 + 32 * 60) // 14:32:00
  const [notebookOpen, setNotebookOpen] = useState<boolean>(false)
  // Whether the learner started an experience or did lab work. Only then does
  // ending the session count as a completed session in MnemoNexus.
  const [worked, setWorked] = useState(false)

  // Simulation Clock tick
  useEffect(() => {
    const timer = setInterval(() => {
      setLabClock((c) => c + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // Start Experience Handler
  const handleStartExperience = (exp: ExperienceDef) => {
    setCurrentExp(exp)
    setLab(makeLab(exp.plateLabel, exp.reagents))
    setActiveStation('sample-prep')
    setWorked(true)
  }

  // Liquid transfer handler
  const handleTransfer = (
    source: string,
    dest: string,
    vol: number,
    pipette: string,
    newTip: boolean,
    discard: boolean
  ) => {
    const res = transfer(lab, {
      source,
      dest,
      vol,
      pipette,
      newTip,
      discard,
    })
    setLab(res.next)
    setWorked(true)
  }

  // Plate reader handler
  const handleReadPlate = (settings: { wavelength: number; blank: string }) => {
    const res = readPlate(lab, settings, `${settings.wavelength} nm`)
    setLab(res.next)
    setWorked(true)
  }

  // Kinetics run handler
  const handleRunKinetics = (settings: { wavelength: number; blank: string }) => {
    const res = runKinetics(lab, settings)
    setLab(res.next)
    setWorked(true)
  }

  const handleEndSession = () => {
    const p = practical.getSnapshot()
    if (p.result || practical.launched) host.finish(practical.outcome())
    else if (worked || p.worked) host.finish()
    else host.leave()
  }

  return (
    <PracticalCtx.Provider value={practical}>
    <div className="ui-page w-full h-screen overflow-hidden flex flex-col" style={{ height: '100dvh' }}>
      {/* Top Application Navigation */}
      <Navbar
        activeStation={activeStation}
        onSelectStation={(s) => setActiveStation(s)}
        taskTitle={currentExp.tasks[0] || 'Prepare samples for plate assay'}
        labClock={labClock}
        onOpenNotebook={() => setNotebookOpen(!notebookOpen)}
        notebookCount={lab.notes.length}
        onEndSession={handleEndSession}
      />

      {/* Main View Area */}
      <main className="flex-1 w-full overflow-hidden relative">
        {activeStation === 'practical' && <PracticalView />}

        {activeStation === 'home' && (
          <HomeDashboard
            onStartExperience={handleStartExperience}
            onSelectStation={(s) => setActiveStation(s)}
            currentExp={currentExp}
          />
        )}

        {activeStation === 'station-selector' && (
          <StationSelector
            onSelectStation={(s) => setActiveStation(s)}
            labClock={labClock}
          />
        )}

        {activeStation === 'sample-prep' && (
          <SamplePrepBench
            exp={currentExp}
            lab={lab}
            onTransfer={handleTransfer}
            onSelectStation={(s) => setActiveStation(s as ActiveStation)}
          />
        )}

        {activeStation === 'plate-reader' && (
          <MicroplateReaderStation
            lab={lab}
            onReadPlate={handleReadPlate}
            onRunKinetics={handleRunKinetics}
            onSelectStation={(s) => setActiveStation(s as ActiveStation)}
          />
        )}

        {activeStation === 'centrifuge' && (
          <CentrifugeStation
            onSelectStation={(s) => setActiveStation(s as ActiveStation)}
          />
        )}

        {activeStation === 'chromatography' && (
          <ChromatographyStation
            onSelectStation={(s) => setActiveStation(s as ActiveStation)}
          />
        )}

        {activeStation === 'analysis' && (
          <DataAnalysisStation
            lab={lab}
            onSelectStation={(s) => setActiveStation(s as ActiveStation)}
          />
        )}

        {activeStation === 'notebook' && (
          <LabNotebookView
            lab={lab}
            onSelectStation={(s) => setActiveStation(s as ActiveStation)}
          />
        )}

        {activeStation === 'design' && (
          <ExperimentalDesignView
            onProceedToLab={() => setActiveStation('sample-prep')}
          />
        )}

        {activeStation === 'troubleshoot' && (
          <TroubleshootingView
            onBackToLab={() => setActiveStation('sample-prep')}
          />
        )}
      </main>
    </div>
    </PracticalCtx.Provider>
  )
}

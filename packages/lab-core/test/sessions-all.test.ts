// Every curated definition also runs as a lab session (the runtime the add-on drives): starting
// it and demonstrating each step in turn reaches the end, and the goals are met.
import { describe, expect, it } from 'vitest'
import { curatedDefinitions, loadAllPacks } from '../../../apps/cli/fs-packs.ts'
import { Catalogue } from '../src/catalogue/catalogue.ts'
import { LabSession } from '../src/session/session.ts'

const { catalogue } = Catalogue.build(loadAllPacks())

describe('every curated definition as a demonstrated session', () => {
  for (const d of curatedDefinitions()) {
    it(d.name, () => {
      expect(d.problems).toEqual([])
      const started = LabSession.start(d.json, catalogue, { seed: 1 })
      if (!started.ok) throw new Error(started.message)
      const s = started.session
      const failures: string[] = []
      for (let i = 0; i < 200 && s.view().current; i++) {
        const step = s.view().current!
        const r = s.demonstrate(step)
        if (!r.ok) {
          failures.push(`${step}: ${r.issues.join('; ')}`)
          break
        }
      }
      expect(failures).toEqual([])
      expect(s.view().current).toBeUndefined()
      const { result } = s.finish()
      const unmet = result.objectives.filter((o) => o.goal && !o.met).map((o) => o.id)
      expect(unmet).toEqual([])
      // The heaviest definitions (a whole ELISA plate) take minutes when the machine is busy.
    }, 300000)
  }
})

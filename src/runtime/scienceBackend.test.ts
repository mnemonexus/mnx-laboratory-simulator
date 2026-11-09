import { describe, expect, it } from 'vitest'
import { catalogue, practicals } from './content'
import { ScienceBackend } from './scienceBackend'

describe('shared scientific backend', () => {
  for (const id of ['chem6-buffer-capacity', 'micro4-growth-curve']) {
    it(`keeps ${id} replayable through commands and versioned exports`, () => {
      const definition = practicals().find(p => p.id === id)!.json
      const opened = ScienceBackend.start(definition, catalogue().catalogue, { seed: 17, rehearse: false })
      expect(opened.ok).toBe(true)
      if (!opened.ok) return
      const backend = opened.session
      const initial = backend.snapshot()!
      expect(backend.snapshot(initial.revision)).toBeNull()
      expect(backend.submit([{ kind: 'note', field: 'observation', value: 'Before measuring' }, { kind: 'perform', op: 'not-supported', params: {} }]).map(r => r.ok)).toEqual([true, false])
      const changed = backend.snapshot(initial.revision)!
      expect(changed.revision).toBe(2)
      const restored = ScienceBackend.loadState(backend.saveState(), definition, catalogue().catalogue)
      expect(restored.ok).toBe(true)
      if (restored.ok) expect(restored.session.view()).toEqual(backend.view())
      const legacy = ScienceBackend.restore(backend.save(), definition, catalogue().catalogue)
      expect(legacy.ok).toBe(true)
      if (legacy.ok) expect(legacy.session.view()).toEqual(backend.view())
      expect(ScienceBackend.loadState({ ...backend.saveState(), format: 'future' } as never, definition, catalogue().catalogue).ok).toBe(false)
      expect(ScienceBackend.restore({ ...backend.save(), definition: { id, version: 'future' } }, definition, catalogue().catalogue).ok).toBe(false)
      backend.destroy()
      expect(() => backend.view()).toThrow(/destroyed/)
    })
  }
})

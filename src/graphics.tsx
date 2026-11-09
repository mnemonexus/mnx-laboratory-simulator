import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { PRESETS, TIERS, detectTier, lowerTier, type GraphicsSettings, type Preset, type Tier } from './three/quality'
import { useLabHost } from './host/context'
import type { LabHost, QualitySetting } from './host/mnx'

export interface Stored {
  preset: Preset
  base: Tier
  custom: Partial<GraphicsSettings>
  showStats: boolean
  /** The add-on's "Graphics quality" setting when these choices were made. */
  setting: QualitySetting
  /** Auto's tier limit after a session ran slow; applies from the next launch */
  cap?: Tier
}

interface GraphicsCtxValue {
  preset: Preset
  /** tier the current settings derive from */
  base: Tier
  settings: GraphicsSettings
  autoTier: Tier
  gpu: string
  showStats: boolean
  setPreset: (p: Tier | 'auto') => void
  setOption: <K extends keyof GraphicsSettings>(key: K, value: GraphicsSettings[K]) => void
  setShowStats: (v: boolean) => void
  /** frame-time watchdog: in Auto, step one tier down from the next launch */
  reportSlow: () => void
}

const STORAGE_KEY = 'graphics'

const GraphicsCtx = createContext<GraphicsCtxValue | null>(null)

function fromSetting(setting: QualitySetting, showStats = false): Stored {
  return { preset: setting, base: setting === 'auto' ? 'medium' : setting, custom: {}, showStats, setting }
}

/**
 * The graphics choices to start with. The add-on's "Graphics quality" setting
 * (set in MnemoNexus) is the lasting preference; changes made in the lab's own
 * menu are kept in host storage until that setting changes.
 */
export async function restoreGraphics(host: LabHost): Promise<Stored> {
  const setting = host.settings().graphicsQuality
  const raw = await host.load(STORAGE_KEY)
  if (!raw) return fromSetting(setting)
  try {
    const parsed = JSON.parse(raw) as Partial<Stored>
    if (parsed.setting !== setting) return fromSetting(setting)
    const preset = parsed.preset && (['auto', 'custom', ...TIERS] as string[]).includes(parsed.preset) ? parsed.preset : setting
    const base = parsed.base && TIERS.includes(parsed.base) ? parsed.base : 'medium'
    const custom = { ...parsed.custom }
    if (custom.antialias === 'msaa8') custom.antialias = 'msaa4'
    const cap = parsed.cap && TIERS.includes(parsed.cap) ? parsed.cap : undefined
    return { preset, base, custom, showStats: Boolean(parsed.showStats), setting, cap }
  } catch {
    return fromSetting(setting)
  }
}

export function GraphicsProvider({ initial, children }: { initial: Stored; children: ReactNode }) {
  const host = useLabHost()
  const [stored, setStored] = useState<Stored>(initial)
  // A slow earlier session lowers Auto from launch; within a session the world
  // only sheds runtime effects, so the lab never rebuilds while it is in use.
  const [sessionCap] = useState<Tier | null>(initial.cap ?? null)
  const gpu = useMemo(() => detectTier(), [])

  useEffect(() => {
    void host.save(STORAGE_KEY, JSON.stringify(stored))
  }, [host, stored])

  // Changing the setting in MnemoNexus while the lab is open applies at once.
  useEffect(
    () =>
      host.onSettings(({ graphicsQuality }) =>
        setStored((s) => (s.setting === graphicsQuality ? s : fromSetting(graphicsQuality, s.showStats))),
      ),
    [host],
  )

  const autoTier = sessionCap && TIERS.indexOf(sessionCap) < TIERS.indexOf(gpu.tier) ? sessionCap : gpu.tier

  const base: Tier = stored.preset === 'auto' ? autoTier : stored.preset === 'custom' ? stored.base : stored.preset
  const settings = useMemo<GraphicsSettings>(
    () => (stored.preset === 'custom' ? { ...PRESETS[base], ...stored.custom } : stored.preset === 'auto' && /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent) && base === 'low' ? { ...PRESETS[base], fpsCap: 30 } : PRESETS[base]),
    [stored.preset, stored.custom, base],
  )

  const setPreset = useCallback((p: Tier | 'auto') => {
    setStored((s) => ({ ...s, preset: p, base: p === 'auto' ? s.base : p, custom: {} }))
  }, [])

  const setOption = useCallback(
    <K extends keyof GraphicsSettings>(key: K, value: GraphicsSettings[K]) => {
      setStored((s) => {
        const from: Tier = s.preset === 'auto' ? autoTier : s.preset === 'custom' ? s.base : s.preset
        const custom = s.preset === 'custom' ? s.custom : {}
        return { ...s, preset: 'custom', base: from, custom: { ...custom, [key]: value } }
      })
    },
    [autoTier],
  )

  const setShowStats = useCallback((v: boolean) => setStored((s) => ({ ...s, showStats: v })), [])

  const reportSlow = useCallback(() => {
    if (stored.preset !== 'auto') return
    setStored((s) => {
      const current = s.cap ?? sessionCap ?? gpu.tier
      const cap = current === 'low' ? current : lowerTier(current)
      return cap === s.cap ? s : { ...s, cap }
    })
  }, [stored.preset, gpu.tier, sessionCap])

  const value = useMemo<GraphicsCtxValue>(
    () => ({
      preset: stored.preset,
      base,
      settings,
      autoTier,
      gpu: gpu.renderer,
      showStats: stored.showStats,
      setPreset,
      setOption,
      setShowStats,
      reportSlow,
    }),
    [stored.preset, stored.showStats, base, settings, autoTier, gpu.renderer, setPreset, setOption, setShowStats, reportSlow],
  )

  return <GraphicsCtx.Provider value={value}>{children}</GraphicsCtx.Provider>
}

export function useGraphics() {
  const ctx = useContext(GraphicsCtx)
  if (!ctx) throw new Error('useGraphics must be used inside GraphicsProvider')
  return ctx
}

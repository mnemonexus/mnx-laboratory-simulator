// The MnemoNexus bridge: the only module that touches `window.mnx`.
//
// MnemoNexus runs the lab in a sandboxed frame and hands it `window.mnx`
// (protocol 1; docs/master-plan/02-platform-and-packaging.md §3). This adapter
// turns it into what the lab needs: settings, the theme, storage, and ending
// the run. Every call is made safe, because inside MnemoNexus any uncaught
// error or unhandled rejection ends the run.
import { getExperienceHost, type AddonTheme, type ExperienceProps, type LaunchSurface } from '@mnemonexus/addon-sdk'
import type { PracticeLaunch } from '@mnemonexus/addon-sdk/practice'
import type { RunOutcome } from '../runtime/practice'
import { TIERS, type Tier } from '../three/quality'

export type QualitySetting = 'auto' | Tier

/** The settings declared in manifest.json, validated. */
export interface LabSettings {
  graphicsQuality: QualitySetting
}

export interface LabTheme {
  scheme: 'light' | 'dark'
  reducedMotion: boolean
}

export interface LabHost {
  readonly root: HTMLElement
  readonly surface: LaunchSurface
  /** The activity MnemoNexus chose to run (practice-v1), when it chose one. */
  readonly practice?: PracticeLaunch
  settings(): LabSettings
  onSettings(fn: (s: LabSettings) => void): () => void
  /** The user's look from MnemoNexus, or null when the host leaves it to the lab. */
  theme(): LabTheme | null
  onTheme(fn: (t: LabTheme) => void): () => void
  /**
   * `mnx.storage`; null when missing or unavailable. Durable only in study
   * launches: elsewhere it lasts while MnemoNexus stays open.
   */
  load(key: string): Promise<string | null>
  save(key: string, value: string): Promise<void>
  /** One of the pack's declared `assets/…` files (`mnx.asset`); null when unavailable. */
  asset(path: string): Promise<ArrayBuffer | null>
  /**
   * End the run: by default as a completed session (the host counts it as a use). A practical
   * passes the quality of the run (0–5, the recall grade) when it has one, and a run the host chose
   * also passes what happened, with `completed: false` if it was left early.
   */
  finish(outcome?: RunOutcome): void
  /** End the run without completing it. */
  leave(): void
}

const QUALITY: readonly QualitySetting[] = ['auto', ...TIERS]

function readSettings(props: ExperienceProps): LabSettings {
  const q = props.settings?.graphicsQuality
  return { graphicsQuality: QUALITY.find((v) => v === q) ?? 'auto' }
}

const readTheme = (t: AddonTheme): LabTheme => ({ scheme: t.scheme === 'dark' ? 'dark' : 'light', reducedMotion: t.reducedMotion })

function subscribe<T>(subs: Set<(v: T) => void>, fn: (v: T) => void) {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

function notify<T>(subs: Set<(v: T) => void>, value: T) {
  subs.forEach((fn) => {
    try {
      fn(value)
    } catch (err) {
      console.error('Host update handler failed:', err)
    }
  })
}

/** Connect to MnemoNexus. Throws on a launch this add-on does not support, which fails the run with that message. */
export function connectHost(): LabHost {
  const mnx = getExperienceHost()
  const started = performance.now()
  const settingsSubs = new Set<(s: LabSettings) => void>()
  const themeSubs = new Set<(t: LabTheme) => void>()
  let settings = readSettings(mnx.props)
  let theme = mnx.capabilities?.includes('theme-v1') && mnx.theme ? readTheme(mnx.theme) : null
  let ended = false

  mnx.onUpdate((props) => {
    settings = readSettings(props)
    notify(settingsSubs, settings)
  })
  mnx.onTheme?.((t) => {
    theme = readTheme(t)
    notify(themeSubs, theme)
  })

  const canStore = mnx.props.permissions.includes('storage:local')

  return {
    root: mnx.root,
    surface: mnx.props.surface,
    practice: mnx.props.practice,
    settings: () => settings,
    onSettings: (fn) => subscribe(settingsSubs, fn),
    theme: () => theme,
    onTheme: (fn) => subscribe(themeSubs, fn),
    async load(key) {
      if (!canStore) return null
      try {
        return await mnx.storage.get(key)
      } catch {
        return null
      }
    },
    async save(key, value) {
      if (!canStore) return
      try {
        await mnx.storage.set(key, value)
      } catch (err) {
        console.warn(`Could not save "${key}":`, err)
      }
    },
    async asset(path) {
      try {
        return await mnx.asset(path)
      } catch {
        return null
      }
    },
    finish(outcome) {
      if (ended) return
      ended = true
      const elapsedSeconds = Math.min(86400, Math.round((performance.now() - started) / 1000))
      const q = outcome?.quality
      const quality = typeof q === 'number' && Number.isFinite(q) ? Math.max(0, Math.min(5, Math.round(q))) : undefined
      mnx.complete({
        completed: outcome?.completed ?? true,
        elapsedSeconds,
        ...(quality !== undefined ? { quality } : {}),
        ...(outcome?.practice ? { practice: outcome.practice } : {}),
      })
    },
    leave() {
      if (ended) return
      ended = true
      mnx.exit()
    },
  }
}

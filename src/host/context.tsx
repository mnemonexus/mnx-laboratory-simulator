import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { LabHost, LabTheme } from './mnx'

export const HostCtx = createContext<LabHost | null>(null)

export function HostProvider({ host, children }: { host: LabHost; children: ReactNode }) {
  return <HostCtx.Provider value={host}>{children}</HostCtx.Provider>
}

export function useLabHost(): LabHost {
  const host = useContext(HostCtx)
  if (!host) throw new Error('useLabHost must be used inside HostProvider')
  return host
}

/** The host's theme, or null when the lab picks its own look. */
export function useHostTheme(): LabTheme | null {
  const host = useLabHost()
  return useSyncExternalStore(host.onTheme, host.theme)
}

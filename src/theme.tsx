import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useHostTheme } from './host/context'

type Mode = 'light' | 'dark'

const ThemeCtx = createContext<{ mode: Mode; hostControlled: boolean; toggle: () => void }>({
  mode: 'dark',
  hostControlled: false,
  toggle: () => {},
})

function apply(mode: Mode) {
  const root = document.documentElement
  root.classList.toggle('dark', mode === 'dark')
  root.classList.toggle('light', mode === 'light')
}

/**
 * Light or dark. Inside MnemoNexus the user's look decides (and can change
 * while the lab is open); otherwise the lab follows the system and offers a
 * toggle that lasts for the session.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const hostTheme = useHostTheme()
  const [localMode, setLocalMode] = useState<Mode>(() =>
    window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
  )
  const mode = hostTheme?.scheme ?? localMode
  const hostControlled = hostTheme !== null

  useEffect(() => {
    apply(mode)
  }, [mode])

  const value = useMemo(
    () => ({
      mode,
      hostControlled,
      toggle: () => setLocalMode((m) => (m === 'dark' ? 'light' : 'dark')),
    }),
    [mode, hostControlled],
  )

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}

export function useTheme() {
  return useContext(ThemeCtx)
}

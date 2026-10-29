// The Phones extension's setup page. Odyn shows it in a sealed box inside the
// extension's settings window. It lists what this Mac still needs for each
// kind of phone and asks the helper to install it.
import '@fontsource-variable/inter'
import './panel.css'
import { StrictMode, useCallback, useEffect, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { connectSurface } from '@odyn-app/api'
import { IconCheckOutline18 } from 'nucleo-ui-essential-outline-18'
import { Button, SettingRow, Skeleton } from '@odyn-app/api/ui'
import type { SetupStatus } from './helper'

type SetupItem = SetupStatus['installing'][number]

interface SetupRow {
  readonly item: SetupItem
  readonly title: string
  readonly ready: string
  readonly needed: string
  readonly action: string
  /** Installed with Homebrew, so the button waits until Homebrew is there. */
  readonly needsHomebrew: boolean
}

const SETUP_ROWS: readonly SetupRow[] = [
  {
    item: 'xcode',
    title: 'iPhone simulator',
    ready: 'Xcode is installed.',
    needed: "Needs Xcode, Apple's free app from the App Store. It's a large download.",
    action: 'Open App Store',
    needsHomebrew: false,
  },
  {
    item: 'axe',
    title: 'iPhone taps and typing',
    ready: 'AXe is installed.',
    needed: 'Installs AXe, a small tool that lets the agent tap, swipe and type on the iPhone.',
    action: 'Install',
    needsHomebrew: false,
  },
  {
    item: 'android',
    title: 'Android emulator',
    ready: 'The Android tools and a Pixel 8 phone are installed.',
    needed: "Installs Java, Google's Android tools and a Pixel 8 phone — about 4 GB. Installing accepts Google's Android SDK licence.",
    action: 'Install',
    needsHomebrew: true,
  },
]

const HOMEBREW_NEEDED = ' Needs Homebrew first — install it from brew.sh, then come back.'
/** Re-checks every so often: Xcode installs from the App Store, outside Odyn. */
const RECHECK_MS = 15_000

const odyn = connectSurface()

function isSetupMessage(value: unknown): value is { readonly kind: 'setup'; readonly status: SetupStatus } {
  return typeof value === 'object' && value !== null && (value as { readonly kind?: unknown }).kind === 'setup'
}

function SetupPage(): ReactElement {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => odyn.onContext((context) => {
    document.documentElement.classList.toggle('dark', context.theme === 'dark')
  }), [])

  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      odyn.helper.call<SetupStatus>('setupStatus')
        .then((next) => {
          if (cancelled) return
          setStatus(next)
          setError(null)
        })
        .catch((caught: unknown) => {
          console.warn('[phones] could not read phone setup', caught)
          if (!cancelled) setError('Odyn could not check this Mac. Switch Phones on, then reopen this window.')
        })
    }
    read()
    const timer = setInterval(read, RECHECK_MS)
    const unsubscribe = odyn.helper.onMessage((message) => {
      if (isSetupMessage(message) && !cancelled) setStatus(message.status)
    })
    return () => {
      cancelled = true
      clearInterval(timer)
      unsubscribe()
    }
  }, [])

  const install = useCallback((item: SetupItem) => {
    odyn.helper.call<SetupStatus>('install', item).then(setStatus).catch((caught: unknown) => {
      console.warn(`[phones] could not start installing ${item}`, caught)
    })
  }, [])

  if (error) return <p className="py-3 text-xs text-muted-foreground">{error}</p>

  return (
    <div className="px-px">
      {SETUP_ROWS.map(({ item, title, ready, needed, action, needsHomebrew }) => {
        if (!status) {
          return (
            <div key={item} className="flex items-center justify-between gap-8 py-3">
              <div className="min-w-0 space-y-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-7 w-16 shrink-0 rounded-md" />
            </div>
          )
        }
        const installed = status[item]
        const installing = status.installing.includes(item)
        const blocked = needsHomebrew && !status.homebrew
        const failure = status.errors[item]
        const description = installed
          ? ready
          : installing
            ? 'Installing… this can take a while. You can close this window.'
            : `${failure ? `The last install failed: ${failure} ` : ''}${needed}${blocked ? HOMEBREW_NEEDED : ''}`
        return (
          <SettingRow key={item} title={title} description={description}>
            {installed ? (
              <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                <IconCheckOutline18 className="size-3.5" aria-hidden />
                Ready
              </span>
            ) : (
              <Button size="sm" variant="outline" disabled={installing || blocked} onClick={() => install(item)}>
                {installing ? 'Installing…' : failure ? 'Try again' : action}
              </Button>
            )}
          </SettingRow>
        )
      })}
    </div>
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <SetupPage />
    </StrictMode>,
  )
}

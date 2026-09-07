'use client'

import { useEffect, useState } from 'react'
import { Check, FolderOpen, Minus, Settings as SettingsIcon, TriangleAlert } from 'lucide-react'

import { EmptyState } from '@/components/empty-state'
import { useToast } from '@/components/toast'
import {
  getApiKey,
  setApiKey,
  systemAPI,
  type SystemConfig,
  type SystemStatus,
} from '@/lib/api'
import { Modal } from '@/components/modal'

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
}

export default function SettingsPage() {
  const [config, setConfig] = useState<SystemConfig | null>(null)
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [profileRoot, setProfileRoot] = useState('')
  const [rootBusy, setRootBusy] = useState(false)
  const [nativePickerAvailable, setNativePickerAvailable] = useState(false)
  const [rootError, setRootError] = useState<string | null>(null)
  const [rootWarning, setRootWarning] = useState<Awaited<ReturnType<typeof systemAPI.setProfileRoot>> | null>(null)
  const toast = useToast()

  useEffect(() => {
    // The key lives in localStorage, which does not exist when this page is
    // prerendered into the static export, so it can only be read after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKey(getApiKey())
    const hasNativePicker = () => Boolean(
      (window as Window & { pywebview?: { api?: { choose_profile_root?: unknown } } }).pywebview?.api?.choose_profile_root,
    )
    setNativePickerAvailable(hasNativePicker())
    const onPywebviewReady = () => setNativePickerAvailable(hasNativePicker())
    window.addEventListener('pywebviewready', onPywebviewReady)
    async function load() {
      try {
        const loaded = await systemAPI.config()
        setConfig(loaded)
        setProfileRoot(loaded.profile_root)
        setStatus(await systemAPI.status().catch(() => null))
      } catch (err) {
        setError(String(err instanceof Error ? err.message : err))
      }
    }
    load()
    return () => window.removeEventListener('pywebviewready', onPywebviewReady)
  }, [])

  function saveKey(event: React.FormEvent) {
    event.preventDefault()
    setApiKey(key.trim())
    toast(
      'ok',
      key.trim() ? 'API key saved' : 'API key cleared',
      'Stored in this browser only, and sent as X-API-Key.',
    )
  }

  async function chooseProfileRoot() {
    const picker = (window as Window & { pywebview?: { api?: { choose_profile_root?: () => Promise<string> } } }).pywebview?.api?.choose_profile_root
    if (!picker) return
    const selected = await picker()
    if (selected) {
      setProfileRoot(selected)
      await saveProfileRoot(selected)
    }
  }

  async function saveProfileRoot(path: string, action?: 'import' | 'ignore') {
    setRootBusy(true)
    setRootError(null)
    try {
      const result = await systemAPI.setProfileRoot(path, action)
      if (result.requires_confirmation) {
        setRootWarning(result)
      } else {
        setProfileRoot(result.profile_root)
        setConfig((current) => current ? { ...current, profile_root: result.profile_root } : current)
        setRootWarning(null)
        toast('ok', 'Profile folder updated', action === 'import' ? `Relinked ${result.imported} profile(s).` : 'New profiles will use this folder.')
      }
    } catch (err) {
      setRootError(String(err instanceof Error ? err.message : err))
    } finally {
      setRootBusy(false)
    }
  }

  return (
    <>
      <header className="sticky top-0 z-20 flex h-[52px] items-center gap-3 border-b border-line bg-canvas/85 px-5 backdrop-blur">
        <h1 className="text-[14px] font-semibold">Settings</h1>
      </header>

      {error ? (
        <EmptyState icon={<SettingsIcon size={18} />} title="Cannot reach the API" body={error} />
      ) : !config ? (
        <p className="px-5 py-8 text-ink-faint">Loading…</p>
      ) : (
        <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-5 py-6">
          {/* Security first: these two decide whether this instance is safe to expose. */}
          <Group
            title="Security"
            note="Configured with environment variables; restart to apply changes."
          >
            <Toggle
              on={config.encryption_enabled}
              label="Proxy password encryption"
              onText="Passwords are encrypted at rest with CPM_SECRET_KEY."
              offText="Passwords are stored as plain text. Set CPM_SECRET_KEY to encrypt them."
              warnWhenOff
            />
            <Toggle
              on={config.user_auth_enabled}
              label="User accounts"
              onText="Login is required. Manage accounts with: camoufox-pm user"
              offText="No user accounts. Create one with: camoufox-pm user add <name>"
              warnWhenOff={config.host !== '127.0.0.1' && !config.api_key_set}
            />
            <Toggle
              on={config.api_key_set}
              label="API key"
              onText="Requests must send a matching X-API-Key header."
              offText={
                config.user_auth_enabled
                  ? 'No API key is set. Machine clients have no way in; humans log in.'
                  : 'No API key is set. Anyone who can reach this port can use the API.'
              }
              warnWhenOff={config.host !== '127.0.0.1' && !config.user_auth_enabled}
            />
            {config.api_key_set && (
              <form onSubmit={saveKey} className="flex items-start gap-4 px-4 py-2.5">
                <span className="w-[150px] shrink-0 text-ink-dim">This browser&apos;s key</span>
                <span className="flex flex-1 gap-2">
                  <input
                    type="password"
                    className="field font-mono"
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    placeholder="Paste CPM_API_KEY to keep using this UI"
                    aria-label="API key for this browser"
                    autoComplete="off"
                  />
                  <button type="submit" className="btn btn-default shrink-0">
                    Save
                  </button>
                </span>
              </form>
            )}
            <Row label="Bound to">
              <span className="font-mono">
                {config.host}:{config.port}
              </span>
              {config.host !== '127.0.0.1' && (
                <span className="ml-2 text-danger">reachable beyond this machine</span>
              )}
            </Row>
          </Group>

          <Group title="Instance">
            <Row label="Version">
              <span className="font-mono">{config.version}</span>
            </Row>
            <Row label="Uptime">
              <span className="font-mono">{formatUptime(config.uptime_seconds)}</span>
            </Row>
            <Row label="Database">
              <span className="break-all font-mono text-ink-dim">{config.database_path}</span>
            </Row>
            <Toggle
              on={config.camoufox_available}
              label="Camoufox browser"
              onText="Installed and ready to launch profiles."
              offText="Not installed. Run: camoufox fetch"
              warnWhenOff
            />
          </Group>

          <Group title="Profile storage" note="Existing profiles keep their current locations. This folder applies to new profiles.">
            <div className="px-4 py-3">
              <label htmlFor="profile-root" className="mb-1.5 block text-ink-dim">Profile root directory</label>
              <div className="flex gap-2">
                <input
                  id="profile-root"
                  className="field min-w-0 flex-1 font-mono"
                  value={profileRoot}
                  onChange={(event) => setProfileRoot(event.target.value)}
                  onBlur={() => profileRoot.trim() && saveProfileRoot(profileRoot.trim())}
                  disabled={rootBusy}
                  spellCheck={false}
                />
                {nativePickerAvailable && (
                  <button className="btn btn-default shrink-0" onClick={chooseProfileRoot} disabled={rootBusy} title="Choose folder">
                    <FolderOpen size={14} />
                    <span>Browse</span>
                  </button>
                )}
              </div>
              {rootError && <p className="mt-2 text-danger">{rootError}</p>}
              <p className="mt-2 text-ink-faint">Must already exist and be writable. Profiles are stored directly as <span className="font-mono">profile_&lt;id&gt;</span>.</p>
            </div>
          </Group>

          {status && (
            <Group title="Usage">
              <Row label="Profiles">
                <span className="font-mono">{status.total_profiles}</span>
              </Row>
              <Row label="Groups">
                <span className="font-mono">{status.total_groups}</span>
              </Row>
              <Row label="Running browsers">
                <span className="font-mono">{status.running_browsers}</span>
              </Row>
              <Row label="Memory / disk">
                <span className="font-mono text-ink-dim">
                  {Math.round(status.memory_usage)}% / {Math.round(status.disk_usage)}%
                </span>
              </Row>
            </Group>
          )}
        </div>
      )}

      <Modal
        open={Boolean(rootWarning)}
        title="Profile folders found"
        subtitle="Some folders in this directory match profiles in the database."
        onClose={() => {
          setRootWarning(null)
          setProfileRoot(config?.profile_root ?? '')
        }}
        width={500}
        footer={
          <>
            <button className="btn btn-default" onClick={() => {
              setRootWarning(null)
              setProfileRoot(config?.profile_root ?? '')
            }}>Cancel</button>
            <button className="btn btn-default" onClick={() => rootWarning && saveProfileRoot(rootWarning.profile_root, 'ignore')}>Ignore</button>
            <button className="btn btn-primary" onClick={() => rootWarning && saveProfileRoot(rootWarning.profile_root, 'import')}>Import and relink</button>
          </>
        }
      >
        <p className="text-ink-dim">Importing updates the matching profiles to use these folders. No files are moved or deleted.</p>
        <p className="mt-3 max-h-40 overflow-y-auto rounded border border-line bg-canvas px-3 py-2 font-mono text-ink-faint">
          {rootWarning?.matching_directories.map((id) => `profile_${id}`).join('\n')}
        </p>
      </Modal>
    </>
  )
}

function Group({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h2 className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {title}
      </h2>
      {note && <p className="mb-2 text-ink-faint">{note}</p>}
      <div className="panel divide-y divide-line">{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 px-4 py-2.5">
      <span className="w-[150px] shrink-0 text-ink-dim">{label}</span>
      <span className="flex-1">{children}</span>
    </div>
  )
}

function Toggle({
  on,
  label,
  onText,
  offText,
  warnWhenOff = false,
}: {
  on: boolean
  label: string
  onText: string
  offText: string
  warnWhenOff?: boolean
}) {
  const warn = !on && warnWhenOff
  return (
    <div className="flex gap-4 px-4 py-2.5">
      <span className="w-[150px] shrink-0 text-ink-dim">{label}</span>
      <span className="flex flex-1 items-start gap-2">
        {on ? (
          <Check size={14} className="mt-0.5 shrink-0 text-ok" />
        ) : warn ? (
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-danger" />
        ) : (
          <Minus size={14} className="mt-0.5 shrink-0 text-ink-faint" />
        )}
        <span className={warn ? 'text-danger' : on ? '' : 'text-ink-dim'}>
          {on ? onText : offText}
        </span>
      </span>
    </div>
  )
}

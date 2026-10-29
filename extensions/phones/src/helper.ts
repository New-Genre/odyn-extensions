// The Phones extension's background helper.
//
// It starts and closes iPhone simulators and Android emulators, remembers
// which chat each one belongs to, sends their live screen to Odyn while
// someone is watching, and passes on taps, swipes and typing. It also runs
// the setup installs (AXe, the Android tools) for the settings page.
//
// It runs in Odyn's sealed helper box: every program it runs is one listed in
// this extension's manifest, and Odyn checks each call.
import { defineHelper, type OdynHelperApi, type ScreenInput, type ScreenSession } from '@odyn-app/api'
import { detectPhoneStarts, parseAdbEmulatorSerials, parseAvdList, parseDescribeUiSize, parseSimctlDevices, parseWmSize, toDevice, androidTextArgument, explainInstallError, phoneKey, resolveClaims, androidSystemImage, ANDROID_API_LEVEL, type PendingClaim, type PhoneDevice, type PhonePlatform } from './phones'

/** Pause between one screenshot arriving and asking for the next. */
const FRAME_GAP_MS = 250
/** Pause after a failed screenshot (phone still starting, or just closed). */
const FRAME_RETRY_MS = 2_000
/** How long after a start command a phone may still switch on and count. */
const CLAIM_WINDOW_MS = 2 * 60_000
/** How often running phones are checked while there is anything to track. */
const WATCH_INTERVAL_MS = 2_000
const ANDROID_SWIPE_MS = 250
const INSTALL_TIMEOUT_MS = 60 * 60_000

const AXE_VERSION = '1.8.0'
const AXE_TARBALL_URL = `https://github.com/cameroncooke/AXe/releases/download/v${AXE_VERSION}/AXe-macOS-v${AXE_VERSION}-universal.tar.gz`
/** Checked against the download, so a swapped file is never run. */
const AXE_INTEGRITY = 'sha512-EQ5RcOHTJJM3dbddlK8X2O0c8+Wu2XyiW3V7dO5bHbAiTyqq/EQZyKa6GlGLNpWDPDDqaCTlVN/6TRmogR9YLA=='
const XCODE_APP_STORE_URL = 'macappstore://apps.apple.com/app/id497799835'
const ANDROID_TOOLS_CASK = 'android-commandlinetools'
const JAVA_FORMULA = 'openjdk@21'
const ANDROID_DEVICE_PROFILE = 'pixel_8'
const ANDROID_AVD_NAME = 'Pixel_8'

const ANDROID_BUTTON_KEYS = { power: 'KEYCODE_POWER', 'volume-up': 'KEYCODE_VOLUME_UP', 'volume-down': 'KEYCODE_VOLUME_DOWN' } as const

type SetupItem = 'xcode' | 'axe' | 'android'

export interface SetupStatus {
  readonly homebrew: boolean
  readonly xcode: boolean
  readonly axe: boolean
  readonly android: boolean
  readonly installing: readonly SetupItem[]
  readonly errors: Partial<Readonly<Record<SetupItem, string>>>
}

interface OwnedPhone {
  readonly chatId: string
  readonly platform: PhonePlatform
  readonly id: string
  readonly name: string
}


let odyn: OdynHelperApi | null = null
const owned = new Map<string, OwnedPhone>()
let claims: readonly PendingClaim[] = []
let watchTimer: ReturnType<typeof setTimeout> | null = null
const watchers = new Map<string, { count: number; timer: ReturnType<typeof setTimeout> | null }>()
const screenSizes = new Map<string, { readonly width: number; readonly height: number }>()
const installing = new Set<SetupItem>()
const errors: Partial<Record<SetupItem, string>> = {}

function api(): OdynHelperApi {
  if (!odyn) throw new Error('The Phones helper has not started yet.')
  return odyn
}

function parseKey(sessionId: string): { readonly platform: PhonePlatform; readonly id: string } {
  const index = sessionId.indexOf(':')
  const platform = sessionId.slice(0, index)
  if (platform !== 'ios' && platform !== 'android') throw new Error('That is not a phone.')
  return { platform, id: sessionId.slice(index + 1) }
}

/** Runs a listed program and returns what it printed; a non-zero exit is an error. */
async function run(program: string, args: readonly string[], options: Parameters<OdynHelperApi['programs']['run']>[2] = {}): Promise<string> {
  const result = await api().programs.run(program, args, options)
  if (result.exitCode !== 0) throw new Error(`${program} ${args[0] ?? ''} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  return result.stdout
}

// --- Listing ---------------------------------------------------------------

async function listIphones(): Promise<readonly PhoneDevice[]> {
  try {
    return parseSimctlDevices(await run('xcrun', ['simctl', 'list', 'devices', '--json']))
  } catch (error) {
    console.warn('[phones] could not list iPhone simulators', error)
    return []
  }
}

async function runningAvdNames(): Promise<Map<string, string>> {
  if (!(await api().programs.find('adb'))) return new Map()
  const serials = parseAdbEmulatorSerials(await run('adb', ['devices']))
  const pairs = await Promise.all(serials.map(async (serial): Promise<[string, string] | null> => {
    try {
      const name = (await run('adb', ['-s', serial, 'emu', 'avd', 'name'])).split('\n')[0]?.trim()
      return name ? [name, serial] : null
    } catch (error) {
      console.warn(`[phones] could not ask ${serial} for its name`, error)
      return null
    }
  }))
  return new Map(pairs.filter((pair): pair is [string, string] => pair !== null))
}

async function listAndroids(): Promise<readonly PhoneDevice[]> {
  if (!(await api().programs.find('emulator'))) return []
  try {
    const names = parseAvdList(await run('emulator', ['-list-avds']))
    const running = await runningAvdNames()
    return names.map((name) => ({
      id: name,
      name: name.replaceAll('_', ' '),
      platform: 'android' as const,
      state: running.has(name) ? ('running' as const) : ('stopped' as const),
      osVersion: null,
    }))
  } catch (error) {
    console.warn('[phones] could not list Android emulators', error)
    return []
  }
}

async function listPhones(): Promise<readonly PhoneDevice[]> {
  const [iphones, androids] = await Promise.all([listIphones(), listAndroids()])
  return [...iphones, ...androids]
}

// --- Live screens in the sidebar -------------------------------------------

function announce(): void {
  const sessions: readonly ScreenSession[] = [...owned.values()].map((phone) => ({
    id: phoneKey(phone.platform, phone.id),
    chatId: phone.chatId,
    title: phone.name,
    device: phone.platform === 'ios' ? 'iphone' : 'android',
  }))
  api().sessions.set(sessions).catch((error: unknown) => console.error('[phones] could not update the sidebar', error))
  ensureWatching()
}

// --- Starting and stopping --------------------------------------------------

async function stopPhone(platform: PhonePlatform, id: string): Promise<void> {
  if (owned.delete(phoneKey(platform, id))) announce()
  if (platform === 'ios') {
    await run('xcrun', ['simctl', 'shutdown', id])
    return
  }
  const serial = (await runningAvdNames()).get(id)
  if (serial) await run('adb', ['-s', serial, 'emu', 'kill'])
}

async function stopOwned(phones: readonly OwnedPhone[]): Promise<void> {
  await Promise.all(phones.map((phone) => stopPhone(phone.platform, phone.id).catch((error: unknown) => {
    console.error(`[phones] could not close ${phone.platform} phone "${phone.id}"`, error)
  })))
}

// --- Phones an agent starts itself (see resolveClaims in phones.ts) ------

async function claimPhoneStart(chatId: string, platform: PhonePlatform, target: string | null): Promise<void> {
  const phones = await listPhones()
  const alreadyRunning = new Set(phones.filter((phone) => phone.state === 'running').map((phone) => phoneKey(phone.platform, phone.id)))
  claims = [...claims, { chatId, platform, target, alreadyRunning, deadline: Date.now() + CLAIM_WINDOW_MS }]
  ensureWatching()
}

async function checkPhones(): Promise<void> {
  const phones = await listPhones()
  const now = Date.now()
  let changed = false
  const matches = resolveClaims(claims, phones, new Set(owned.keys()))
  for (const { claim, phone } of matches) {
    owned.set(phoneKey(phone.platform, phone.id), { chatId: claim.chatId, platform: phone.platform, id: phone.id, name: phone.name })
    changed = true
  }
  const used = new Set(matches.map((match) => match.claim))
  claims = claims.filter((claim) => !used.has(claim) && claim.deadline > now)
  // A phone shut down some other way is no longer Odyn's to show or close.
  const running = new Set(phones.filter((phone) => phone.state === 'running').map((phone) => phoneKey(phone.platform, phone.id)))
  for (const key of [...owned.keys()]) {
    if (running.has(key)) continue
    owned.delete(key)
    changed = true
  }
  if (changed) announce()
}

function ensureWatching(): void {
  if (claims.length === 0 && owned.size === 0) {
    if (watchTimer) clearTimeout(watchTimer)
    watchTimer = null
    return
  }
  if (watchTimer) return
  watchTimer = setTimeout(() => {
    watchTimer = null
    checkPhones()
      .catch((error: unknown) => console.warn('[phones] could not check running phones', error))
      .finally(ensureWatching)
  }, WATCH_INTERVAL_MS)
}

// --- Screenshots and input ---------------------------------------------------

async function capture(platform: PhonePlatform, id: string): Promise<{ readonly bytes: Uint8Array; readonly mime: 'image/png' | 'image/jpeg' }> {
  if (platform === 'ios') {
    // `simctl io screenshot` can only save to a file; Odyn hands back its bytes.
    const result = await api().programs.run('xcrun', ['simctl', 'io', id, 'screenshot', '--type=jpeg', '$OUTPUT_FILE'], { outputFile: true })
    if (result.exitCode !== 0 || !result.bytes) throw new Error(result.stderr || 'no screenshot')
    return { bytes: result.bytes, mime: 'image/jpeg' }
  }
  const serial = await requireSerial(id)
  const result = await api().programs.run('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { binary: true })
  if (result.exitCode !== 0 || !result.bytes) throw new Error(result.stderr || 'no screenshot')
  return { bytes: result.bytes, mime: 'image/png' }
}

function scheduleFrame(sessionId: string, delay: number): void {
  const watcher = watchers.get(sessionId)
  if (!watcher || watcher.count === 0) return
  watcher.timer = setTimeout(() => {
    watcher.timer = null
    const { platform, id } = parseKey(sessionId)
    capture(platform, id)
      .then(async ({ bytes, mime }) => {
        // An empty picture is a failed attempt, not a frame.
        if (bytes.byteLength === 0) throw new Error('empty screenshot')
        await api().sessions.frame(sessionId, bytes, mime)
        scheduleFrame(sessionId, FRAME_GAP_MS)
      })
      .catch((error: unknown) => {
        console.warn(`[phones] could not take a screenshot of ${sessionId}`, error)
        scheduleFrame(sessionId, FRAME_RETRY_MS)
      })
  }, delay)
}

async function requireSerial(avdName: string): Promise<string> {
  const serial = (await runningAvdNames()).get(avdName)
  if (!serial) throw new Error(`The Android phone "${avdName}" is not running`)
  return serial
}

async function requireAxe(): Promise<void> {
  if (!(await api().programs.find('axe'))) throw new Error('AXe is not installed — install it from the Phones extension\'s settings')
}

async function screenSize(platform: PhonePlatform, id: string): Promise<{ readonly width: number; readonly height: number }> {
  const key = phoneKey(platform, id)
  const cached = screenSizes.get(key)
  if (cached) return cached
  const size = platform === 'ios'
    ? parseDescribeUiSize(await run('axe', ['describe-ui', '--udid', id]))
    : parseWmSize(await run('adb', ['-s', await requireSerial(id), 'shell', 'wm', 'size']))
  if (!size) throw new Error(`Could not read the screen size of ${platform} phone "${id}"`)
  screenSizes.set(key, size)
  return size
}

async function sendInput(platform: PhonePlatform, id: string, input: ScreenInput): Promise<void> {
  if (platform === 'ios') {
    await requireAxe()
    const udid = ['--udid', id]
    if (input.kind === 'home') return void (await run('axe', ['button', 'home', ...udid]))
    if (input.kind === 'button') {
      // The iPhone simulator can press its side button but has no volume buttons.
      if (input.button !== 'power') throw new Error(`The iPhone simulator cannot press ${input.button}`)
      return void (await run('axe', ['button', 'side-button', ...udid]))
    }
    if (input.kind === 'type') return void (await run('axe', ['type', input.text, ...udid]))
    const size = await screenSize(platform, id)
    const args = input.kind === 'tap'
      ? ['tap', '-x', String(toDevice(input.x, size.width)), '-y', String(toDevice(input.y, size.height))]
      : [
          'swipe',
          '--start-x', String(toDevice(input.fromX, size.width)), '--start-y', String(toDevice(input.fromY, size.height)),
          '--end-x', String(toDevice(input.toX, size.width)), '--end-y', String(toDevice(input.toY, size.height)),
        ]
    await run('axe', [...args, ...udid])
    return
  }
  const serial = await requireSerial(id)
  const shell = (args: readonly string[]): Promise<string> => run('adb', ['-s', serial, 'shell', 'input', ...args])
  if (input.kind === 'home') return void (await shell(['keyevent', 'KEYCODE_HOME']))
  if (input.kind === 'button') return void (await shell(['keyevent', ANDROID_BUTTON_KEYS[input.button]]))
  if (input.kind === 'type') return void (await shell(['text', androidTextArgument(input.text)]))
  const size = await screenSize(platform, id)
  if (input.kind === 'tap') return void (await shell(['tap', String(toDevice(input.x, size.width)), String(toDevice(input.y, size.height))]))
  await shell([
    'swipe',
    String(toDevice(input.fromX, size.width)), String(toDevice(input.fromY, size.height)),
    String(toDevice(input.toX, size.width)), String(toDevice(input.toY, size.height)),
    String(ANDROID_SWIPE_MS),
  ])
}

// --- Setup (the settings page) -----------------------------------------------

async function hasXcode(): Promise<boolean> {
  try {
    // Only a full Xcode has simctl; the slimmer command-line tools do not.
    return (await api().programs.run('xcrun', ['simctl', 'help'])).exitCode === 0
  } catch (error) {
    console.warn('[phones] no Xcode simulator tools', error)
    return false
  }
}

export async function readSetup(): Promise<SetupStatus> {
  const [brew, xcode, axe, androids] = await Promise.all([
    api().programs.find('brew'),
    hasXcode(),
    api().programs.find('axe'),
    listAndroids(),
  ])
  return { homebrew: brew !== null, xcode, axe: axe !== null, android: androids.length > 0, installing: [...installing], errors: { ...errors } }
}

async function installAxe(): Promise<void> {
  const folder = `axe/${AXE_VERSION}`
  const tarball = `axe-${AXE_VERSION}.tar.gz`
  await api().data.download(AXE_TARBALL_URL, tarball, AXE_INTEGRITY)
  try {
    await api().data.remove(folder)
    await api().data.makeFolder(folder)
    await run('tar', ['-xzf', `$DATA/${tarball}`, '-C', `$DATA/${folder}`])
    await run('chmod', ['755', `$DATA/${folder}/axe`])
  } catch (error) {
    // Never leave a half-unpacked copy that looks installed.
    await api().data.remove(folder)
    throw error
  } finally {
    await api().data.remove(tarball)
  }
}

/** The Android phone image for this Mac's chip: Apple Silicon needs arm64. */
async function androidSystemImageForThisMac(): Promise<string> {
  return androidSystemImage((await run('uname', ['-m'])).trim())
}

async function installAndroid(): Promise<void> {
  const brewEnv = { PATH: '/opt/homebrew/bin:/usr/local/bin:$PATH', HOMEBREW_NO_AUTO_UPDATE: '1' }
  const long = { env: brewEnv, timeoutMs: INSTALL_TIMEOUT_MS }
  let javaHome = (await api().programs.run('java_home', [])).stdout.trim()
  if (!javaHome) {
    await run('brew', ['install', JAVA_FORMULA], long)
    const prefix = (await run('brew', ['--prefix', JAVA_FORMULA], long)).trim()
    javaHome = `${prefix}/libexec/openjdk.jdk/Contents/Home`
  }
  if (!(await api().programs.find('sdkmanager')) || !(await api().folders.find('android-sdk'))) {
    await run('brew', ['install', '--cask', ANDROID_TOOLS_CASK], long)
  }
  const sdk = await api().folders.find('android-sdk')
  if (!sdk || !(await api().programs.find('sdkmanager')) || !(await api().programs.find('avdmanager'))) {
    throw new Error('The Android tools installed, but Odyn could not find them.')
  }
  const androidEnv = { ...brewEnv, JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk }
  const image = await androidSystemImageForThisMac()
  // Every licence prompt asks the same y/N question, so answer it up front many times.
  const answer = (text: string): { readonly env: typeof androidEnv; readonly timeoutMs: number; readonly stdin: string; readonly stdinRepeat: number } =>
    ({ env: androidEnv, timeoutMs: INSTALL_TIMEOUT_MS, stdin: `${text}\n`, stdinRepeat: 50 })
  await run('sdkmanager', [`--sdk_root=${sdk}`, '--licenses'], answer('y'))
  await run('sdkmanager', [`--sdk_root=${sdk}`, 'platform-tools', 'emulator', `platforms;android-${ANDROID_API_LEVEL}`, image], answer('y'))
  // "Do you wish to create a custom hardware profile?" — no.
  await run('avdmanager', ['create', 'avd', '--name', ANDROID_AVD_NAME, '--package', image, '--device', ANDROID_DEVICE_PROFILE], answer('no'))
}

async function postSetup(): Promise<SetupStatus> {
  const status = await readSetup()
  await api().pages.post({ kind: 'setup', status })
  return status
}

async function install(item: unknown): Promise<SetupStatus> {
  if (item === 'xcode') {
    await api().openLink(XCODE_APP_STORE_URL)
    return readSetup()
  }
  if ((item !== 'axe' && item !== 'android') || installing.has(item)) return readSetup()
  installing.add(item)
  delete errors[item]
  await postSetup()
  try {
    if (item === 'axe') await installAxe()
    else await installAndroid()
  } catch (error) {
    console.error(`[phones] installing ${item} failed`, error)
    errors[item] = explainInstallError(error instanceof Error ? error.message : String(error))
  } finally {
    installing.delete(item)
  }
  return postSetup()
}

defineHelper({
  start(helperApi) {
    odyn = helperApi
    helperApi.pages.handle('setupStatus', () => readSetup())
    helperApi.pages.handle('install', (item) => install(item))
    announce()
  },
  watch(sessionId) {
    const existing = watchers.get(sessionId)
    if (existing) {
      existing.count += 1
      return
    }
    watchers.set(sessionId, { count: 1, timer: null })
    scheduleFrame(sessionId, 0)
  },
  unwatch(sessionId) {
    const watcher = watchers.get(sessionId)
    if (!watcher) return
    watcher.count -= 1
    if (watcher.count > 0) return
    if (watcher.timer) clearTimeout(watcher.timer)
    watchers.delete(sessionId)
  },
  async input(sessionId, input) {
    const { platform, id } = parseKey(sessionId)
    await sendInput(platform, id, input)
  },
  async close(sessionId) {
    const { platform, id } = parseKey(sessionId)
    // Only phones Odyn started can be closed from here — never the user's own.
    if (!owned.has(sessionId)) return
    await stopPhone(platform, id)
  },
  agentCommand(chatId, command) {
    for (const start of detectPhoneStarts(command)) {
      claimPhoneStart(chatId, start.platform, start.target).catch((error: unknown) => {
        console.warn('[phones] could not track a phone the agent started', error)
      })
    }
  },
  async chatClosed(chatId) {
    await stopOwned([...owned.values()].filter((phone) => phone.chatId === chatId))
  },
  async shutdown() {
    // Switched off or Odyn quitting: close the phones Odyn started, so nothing keeps eating memory.
    await stopOwned([...owned.values()])
  },
})

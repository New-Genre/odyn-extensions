// Pure helpers for the Phones extension: reading what the simulator tools
// print, spotting a "start a phone" command, and converting screen positions.
// No calls out, so every one is unit-tested on its own.

export type PhonePlatform = 'ios' | 'android'
export type PhoneState = 'running' | 'stopped'

export interface PhoneDevice {
  /** iPhone: the simulator's UDID. Android: the emulator (AVD) name. */
  readonly id: string
  readonly name: string
  readonly platform: PhonePlatform
  readonly state: PhoneState
  /** e.g. "iOS 26.2". Null for Android, whose AVD list does not say. */
  readonly osVersion: string | null
}

interface Size {
  readonly width: number
  readonly height: number
}

interface SimctlDevice {
  readonly udid?: unknown
  readonly name?: unknown
  readonly state?: unknown
  readonly isAvailable?: unknown
}

/**
 * Turns `xcrun simctl list devices --json` into iPhones. Only available
 * devices on an iOS runtime are kept — watches, TVs and devices whose runtime
 * was deleted are dropped.
 */
export function parseSimctlDevices(json: string): readonly PhoneDevice[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    console.warn('[phones] could not read the simulator list', error)
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const runtimes = (parsed as { devices?: unknown }).devices
  if (typeof runtimes !== 'object' || runtimes === null) return []

  return Object.entries(runtimes as Record<string, unknown>).flatMap(([runtimeId, devices]) => {
    // Runtime ids look like "com.apple.CoreSimulator.SimRuntime.iOS-26-2".
    const match = /SimRuntime\.iOS-(\d+)(?:-(\d+))?/.exec(runtimeId)
    if (!match || !Array.isArray(devices)) return []
    const osVersion = `iOS ${match[1]}${match[2] ? `.${match[2]}` : ''}`
    return (devices as readonly SimctlDevice[]).flatMap((device): PhoneDevice[] => {
      if (device.isAvailable !== true) return []
      if (typeof device.udid !== 'string' || typeof device.name !== 'string') return []
      return [
        {
          id: device.udid,
          name: device.name,
          platform: 'ios',
          state: device.state === 'Booted' ? 'running' : 'stopped',
          osVersion,
        },
      ]
    })
  })
}

/** Turns `emulator -list-avds` output into AVD names (one per line). */
export function parseAvdList(output: string): readonly string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    // The emulator prints INFO/WARNING lines on some setups — not AVD names.
    .filter((line) => line.length > 0 && !line.includes(' ') && !line.startsWith('INFO'))
}

/** Turns `adb devices` output into the serials of running emulators. */
export function parseAdbEmulatorSerials(output: string): readonly string[] {
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial?.startsWith('emulator-') === true && state === 'device')
    .map(([serial]) => serial as string)
}

/** `adb shell wm size` → pixels. An "Override size" line wins over "Physical size". */
export function parseWmSize(output: string): Size | null {
  const sizes = [...output.matchAll(/(\d+)x(\d+)/g)].map((match) => ({ width: Number(match[1]), height: Number(match[2]) }))
  return sizes.at(-1) ?? null
}

/** `axe describe-ui` → the screen's size in points, from the top element's frame. */
export function parseDescribeUiSize(json: string): Size | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const root: unknown = Array.isArray(parsed) ? parsed[0] : parsed
  if (typeof root !== 'object' || root === null) return null
  const frame = (root as { frame?: unknown }).frame
  if (typeof frame !== 'object' || frame === null) return null
  const { width, height } = frame as { width?: unknown; height?: unknown }
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) return null
  return { width, height }
}

/** A fraction of the screen (clamped to 0–1) as a whole number of units. */
export function toDevice(fraction: number, length: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * length)
}

/** Android's `input text` runs through the phone's shell: spaces become %s, and the whole thing is single-quoted. */
export function androidTextArgument(text: string): string {
  return `'${text.replace(/ /g, '%s').replace(/'/g, `'\\''`)}'`
}

/**
 * Homebrew's failures end in a wall of its own output. The one people hit most
 * — Xcode behind the latest version — gets a plain sentence instead.
 */
export function explainInstallError(message: string): string {
  const outdatedXcode = /Your Xcode \(([\d.]+)\)[^]*?update to Xcode ([\d.]+)/.exec(message)
  if (outdatedXcode) {
    return `Homebrew needs Xcode ${outdatedXcode[2]} and this Mac has Xcode ${outdatedXcode[1]}. Update Xcode from the App Store, then try again.`
  }
  return message
}

export interface PhoneStartIntent {
  readonly platform: PhonePlatform
  /** The UDID, simulator name or AVD name in the command; null when it was a placeholder. */
  readonly target: string | null
}

const SIMCTL_BOOT = /\bxcrun\s+simctl\s+(?:bootstatus|boot)\s+(?:-\w+\s+)*("[^"]+"|'[^']+'|\S+)/
const EMULATOR_AVD = /(?:^|[\s/"'])emulator["']?\s+(?:[^|;&]*?\s)?-avd\s+("[^"]+"|'[^']+'|\S+)/

function cleanTarget(raw: string): string | null {
  const unquoted = raw.replace(/^["']|["']$/g, '')
  // `<UDID>`, `$UDID`, `"$AVD"` — the real value isn't in the command text.
  if (/^[<$]/.test(unquoted) || unquoted.length === 0) return null
  return unquoted
}

/** Every phone start in a shell command, in the order they appear. */
export function detectPhoneStarts(command: string): readonly PhoneStartIntent[] {
  const starts: PhoneStartIntent[] = []
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const ios = SIMCTL_BOOT.exec(segment)
    if (ios?.[1]) {
      starts.push({ platform: 'ios', target: cleanTarget(ios[1]) })
      continue
    }
    const android = EMULATOR_AVD.exec(segment)
    if (android?.[1]) starts.push({ platform: 'android', target: cleanTarget(android[1]) })
  }
  return starts
}

// --- Phones an agent starts itself -----------------------------------------
//
// Agents start phones with their own shell. When one of those commands is
// seen, the chat gets a CLAIM: the next matching phone that switches on in
// time is the chat's. Phones already running are never claimed, so one the
// user started themselves stays theirs.

/** The key a phone is remembered by, e.g. "ios:ABC-123". */
export function phoneKey(platform: PhonePlatform, id: string): string {
  return `${platform}:${id}`
}

export interface PendingClaim {
  readonly chatId: string
  readonly platform: PhonePlatform
  readonly target: string | null
  readonly alreadyRunning: ReadonlySet<string>
  readonly deadline: number
}

/** Which running phone each claim takes. */
export function resolveClaims(
  pending: readonly PendingClaim[],
  phones: readonly PhoneDevice[],
  taken: ReadonlySet<string>,
): readonly { readonly claim: PendingClaim; readonly phone: PhoneDevice }[] {
  const used = new Set(taken)
  const matches: { readonly claim: PendingClaim; readonly phone: PhoneDevice }[] = []
  for (const claim of pending) {
    const phone = phones.find((candidate) => {
      const key = phoneKey(candidate.platform, candidate.id)
      return candidate.platform === claim.platform
        && candidate.state === 'running'
        && !used.has(key)
        && !claim.alreadyRunning.has(key)
        && (claim.target === null || candidate.id === claim.target || candidate.name === claim.target)
    })
    if (!phone) continue
    used.add(phoneKey(phone.platform, phone.id))
    matches.push({ claim, phone })
  }
  return matches
}

/** The Android API level Odyn installs for its emulator. */
export const ANDROID_API_LEVEL = 35

/** The Android phone image for a chip (`uname -m`): Apple Silicon needs arm64. */
export function androidSystemImage(arch: string): string {
  return `system-images;android-${ANDROID_API_LEVEL};google_apis;${arch === 'arm64' ? 'arm64-v8a' : 'x86_64'}`
}

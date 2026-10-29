import { describe, expect, it } from 'bun:test'
import {
  androidSystemImage,
  androidTextArgument,
  detectPhoneStarts,
  explainInstallError,
  parseAdbEmulatorSerials,
  parseAvdList,
  parseDescribeUiSize,
  parseSimctlDevices,
  parseWmSize,
  resolveClaims,
  toDevice,
} from './phones'

describe('parseSimctlDevices', () => {
  it('keeps available iPhones on iOS runtimes and reads their state', () => {
    const json = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
          { udid: 'A', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true },
          { udid: 'B', name: 'iPhone Air', state: 'Shutdown', isAvailable: true },
          { udid: 'C', name: 'Broken', state: 'Shutdown', isAvailable: false },
        ],
        'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
          { udid: 'W', name: 'Apple Watch', state: 'Shutdown', isAvailable: true },
        ],
      },
    })
    expect(parseSimctlDevices(json)).toEqual([
      { id: 'A', name: 'iPhone 17 Pro', platform: 'ios', state: 'running', osVersion: 'iOS 26.2' },
      { id: 'B', name: 'iPhone Air', platform: 'ios', state: 'stopped', osVersion: 'iOS 26.2' },
    ])
  })

  it('returns nothing for output it cannot read', () => {
    expect(parseSimctlDevices('not json')).toEqual([])
    expect(parseSimctlDevices('{}')).toEqual([])
  })
})

describe('parseAvdList', () => {
  it('keeps AVD names and drops blank and info lines', () => {
    expect(parseAvdList('Pixel_9\n\nINFO    | Storing crashdata\nMedium_Phone_API_36\n')).toEqual([
      'Pixel_9',
      'Medium_Phone_API_36',
    ])
  })
})

describe('parseAdbEmulatorSerials', () => {
  it('keeps running emulators only', () => {
    const output = 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR58M\tdevice\n'
    expect(parseAdbEmulatorSerials(output)).toEqual(['emulator-5554'])
  })
})

describe('resolveClaims', () => {
  const phone = (id: string, name: string, platform: 'ios' | 'android' = 'ios', state: 'running' | 'stopped' = 'running') =>
    ({ id, name, platform, state, osVersion: null })
  const claim = (chatId: string, target: string | null, alreadyRunning: readonly string[] = [], platform: 'ios' | 'android' = 'ios') =>
    ({ chatId, platform, target, alreadyRunning: new Set(alreadyRunning), deadline: Number.MAX_SAFE_INTEGER })

  it('gives a newly running phone to the chat that named it', () => {
    const matches = resolveClaims([claim('chat-1', 'iPhone 17 Pro')], [phone('A', 'iPhone 17 Pro')], new Set())
    expect(matches.map((match) => [match.claim.chatId, match.phone.id])).toEqual([['chat-1', 'A']])
  })

  it('never claims a phone that was already running (the user started it)', () => {
    expect(resolveClaims([claim('chat-1', null, ['ios:A'])], [phone('A', 'iPhone')], new Set())).toEqual([])
  })

  it('never claims a phone Odyn already owns', () => {
    expect(resolveClaims([claim('chat-1', null)], [phone('A', 'iPhone')], new Set(['ios:A']))).toEqual([])
  })

  it('waits while the phone is still off, and ignores the other platform', () => {
    expect(resolveClaims([claim('chat-1', 'A')], [phone('A', 'iPhone', 'ios', 'stopped')], new Set())).toEqual([])
    expect(resolveClaims([claim('chat-1', null, [], 'android')], [phone('A', 'iPhone')], new Set())).toEqual([])
  })

  it('hands one phone to one chat only', () => {
    const matches = resolveClaims([claim('chat-1', null), claim('chat-2', null)], [phone('A', 'iPhone')], new Set())
    expect(matches.map((match) => match.claim.chatId)).toEqual(['chat-1'])
  })
})

describe('androidSystemImage', () => {
  it('picks the arm64 image on Apple Silicon', () => {
    expect(androidSystemImage('arm64')).toBe('system-images;android-35;google_apis;arm64-v8a')
  })

  it('picks the x86_64 image on Intel Macs', () => {
    expect(androidSystemImage('x64')).toBe('system-images;android-35;google_apis;x86_64')
  })
})

describe('explainInstallError', () => {
  it('turns Homebrew\'s outdated-Xcode wall into one sentence', () => {
    const raw = 'brew install failed: ==> Installing axe from cameroncooke/axe Error: Your Xcode (26.6) at /Applications/Xcode.app is too outdated. Please update to Xcode 27.0 (or delete it).'
    expect(explainInstallError(raw)).toBe('Homebrew needs Xcode 27.0 and this Mac has Xcode 26.6. Update Xcode from the App Store, then try again.')
  })

  it('leaves every other message as it is', () => {
    expect(explainInstallError('sdkmanager failed: timeout')).toBe('sdkmanager failed: timeout')
  })
})

describe('parseWmSize', () => {
  it('reads the physical size', () => {
    expect(parseWmSize('Physical size: 1080x2400\n')).toEqual({ width: 1080, height: 2400 })
  })
  it('prefers an override size', () => {
    expect(parseWmSize('Physical size: 1080x2400\nOverride size: 720x1600\n')).toEqual({ width: 720, height: 1600 })
  })
  it('gives null for nonsense', () => {
    expect(parseWmSize('error: no devices')).toBeNull()
  })
})

describe('parseDescribeUiSize', () => {
  it('reads the top element frame', () => {
    expect(parseDescribeUiSize(JSON.stringify([{ frame: { x: 0, y: 0, width: 402, height: 874 } }]))).toEqual({ width: 402, height: 874 })
  })
  it('gives null for bad JSON or a missing frame', () => {
    expect(parseDescribeUiSize('not json')).toBeNull()
    expect(parseDescribeUiSize('[{}]')).toBeNull()
  })
})

describe('toDevice', () => {
  it('scales and clamps', () => {
    expect(toDevice(0.5, 402)).toBe(201)
    expect(toDevice(-1, 402)).toBe(0)
    expect(toDevice(2, 402)).toBe(402)
  })
})

describe('androidTextArgument', () => {
  it('escapes spaces and quotes for the phone shell', () => {
    expect(androidTextArgument("it's me")).toBe(`'it'\\''s%sme'`)
  })
})

describe('detectPhoneStarts', () => {
  it('spots an iPhone boot by UDID or name', () => {
    expect(detectPhoneStarts('xcrun simctl boot ABC-123')).toEqual([{ platform: 'ios', target: 'ABC-123' }])
    expect(detectPhoneStarts('xcrun simctl boot "iPhone 17 Pro"')).toEqual([{ platform: 'ios', target: 'iPhone 17 Pro' }])
    expect(detectPhoneStarts('xcrun simctl bootstatus ABC -b')).toEqual([{ platform: 'ios', target: 'ABC' }])
  })

  it('spots an Android emulator start, with or without a full path', () => {
    expect(detectPhoneStarts('emulator -avd Pixel_9 -no-snapshot')).toEqual([{ platform: 'android', target: 'Pixel_9' }])
    expect(detectPhoneStarts('nohup "$ANDROID_HOME/emulator/emulator" -no-boot-anim -avd Pixel_9 >/dev/null 2>&1 &'))
      .toEqual([{ platform: 'android', target: 'Pixel_9' }])
  })

  it('treats placeholders as "any phone of that kind"', () => {
    expect(detectPhoneStarts('xcrun simctl boot "$UDID"')).toEqual([{ platform: 'ios', target: null }])
    expect(detectPhoneStarts('xcrun simctl boot <UDID>')).toEqual([{ platform: 'ios', target: null }])
  })

  it('finds several starts in one command', () => {
    expect(detectPhoneStarts('xcrun simctl boot A && emulator -avd B')).toEqual([
      { platform: 'ios', target: 'A' },
      { platform: 'android', target: 'B' },
    ])
  })

  it('ignores commands that do not start a phone', () => {
    expect(detectPhoneStarts('xcrun simctl list devices --json')).toEqual([])
    expect(detectPhoneStarts('xcrun simctl shutdown ABC')).toEqual([])
    expect(detectPhoneStarts('emulator -list-avds')).toEqual([])
    expect(detectPhoneStarts('adb -s emulator-5554 shell input tap 1 2')).toEqual([])
    expect(detectPhoneStarts('grep -rn "simctl boot" src')).toEqual([])
  })
})

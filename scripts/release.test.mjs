import { describe, expect, test } from 'bun:test'
import { screenshotUrls, withScreenshots } from './release.mjs'

const ROOT = 'https://raw.githubusercontent.com/New-Genre/odyn-extensions'
const entry = { manifest: { id: 'weather', version: '1.0.0' }, url: 'x', size: 1, sha256: 'y' }

describe('screenshot links', () => {
  test('pins each picture to the commit, with each part of the path encoded', () => {
    expect(screenshotUrls('weather', ['shots/rainy day #1.png'], 'abc')).toEqual([`${ROOT}/abc/extensions/weather/shots/rainy%20day%20%231.png`])
  })

  test('adds links, keeps them while the list is the same, and refreshes them when it changes', () => {
    const first = withScreenshots(entry, 'weather', ['shots/1.png'], 'old')
    expect(first.screenshots).toEqual([`${ROOT}/old/extensions/weather/shots/1.png`])
    expect(withScreenshots(first, 'weather', ['shots/1.png'], 'new')).toEqual(first)
    expect(withScreenshots(first, 'weather', ['shots/2.png'], 'new').screenshots).toEqual([`${ROOT}/new/extensions/weather/shots/2.png`])
  })

  test('drops the links when the manifest has none', () => {
    const withLinks = withScreenshots(entry, 'weather', ['shots/1.png'], 'old')
    expect(withScreenshots(withLinks, 'weather', undefined, 'new')).toEqual(entry)
  })
})

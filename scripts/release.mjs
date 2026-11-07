#!/usr/bin/env node
/**
 * Releases every extension whose version isn't in `index.json` yet, and keeps
 * `index.json` — the list Odyn reads — in step with the `extensions/` folder.
 *
 *   node scripts/release.mjs            dry run: builds and packs, changes nothing online
 *   node scripts/release.mjs --publish  also creates the GitHub releases and rewrites index.json
 *
 * To release a change to an extension, raise its `version` in its package.json.
 * Each release is tagged `<id>-v<version>` and carries one `.tar.gz` holding the
 * built folder, with `package.json` at the top. Odyn checks the download's size
 * and SHA-256 checksum (a fingerprint of the file) against `index.json` before
 * unpacking it.
 *
 * An extension's `screenshots` aren't in the download: the list links each one
 * straight from this repo, pinned to a commit so the picture never changes
 * underneath Odyn. The links are refreshed when an extension is released or
 * its list of pictures changes, so changing only the pictures needs no new version.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILD_ROOT, extensionFolders, readPackage } from './build.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_FILE = join(repoRoot, 'index.json')
const PACK_ROOT = join(repoRoot, 'release')
const REPOSITORY = 'New-Genre/odyn-extensions'
const RAW_ROOT = `https://raw.githubusercontent.com/${REPOSITORY}`
/** Odyn refuses downloads above this size. */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024

const publish = process.argv.includes('--publish')

function readIndex() {
  if (!existsSync(INDEX_FILE)) return []
  const parsed = JSON.parse(readFileSync(INDEX_FILE, 'utf8'))
  return Array.isArray(parsed.extensions) ? parsed.extensions : []
}

/** The text of `index.json` for these entries. */
function indexText(entries) {
  const sorted = [...entries].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
  return `${JSON.stringify({ extensions: sorted }, null, 2)}\n`
}

/** The commit being released: the one GitHub is running on, or this checkout's. */
function commitSha() {
  return process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
}

/** Links to an extension's screenshots as they are in commit `sha`. */
export function screenshotUrls(folder, screenshots, sha) {
  return screenshots.map((path) => `${RAW_ROOT}/${sha}/extensions/${folder}/${path.split('/').map(encodeURIComponent).join('/')}`)
}

/**
 * Sets an index entry's `screenshots` links from the manifest's list. Links it
 * already has are kept while the list of pictures is the same, so a run that
 * changes nothing doesn't rewrite them; they stay valid because a link to a
 * commit never changes.
 */
export function withScreenshots(entry, folder, screenshots, sha) {
  const { screenshots: old, ...rest } = entry
  if (!Array.isArray(screenshots) || screenshots.length === 0) return rest
  const oldSha = old?.[0]?.slice(RAW_ROOT.length + 1).split('/')[0]
  const same = oldSha !== undefined && JSON.stringify(screenshotUrls(folder, screenshots, oldSha)) === JSON.stringify(old)
  return { ...rest, screenshots: same ? old : screenshotUrls(folder, screenshots, sha) }
}

function run(command, args) {
  execFileSync(command, args, { cwd: repoRoot, stdio: 'inherit' })
}

function releaseExists(tag) {
  try {
    execFileSync('gh', ['release', 'view', tag, '--repo', REPOSITORY], { cwd: repoRoot, stdio: 'ignore' })
    return true
  } catch {
    // `gh release view` exits non-zero when there is no such release.
    return false
  }
}

/** Builds and packs one extension. Returns its new `index.json` entry. */
function pack(folder) {
  const pkg = readPackage(folder)
  const tag = `${folder}-v${pkg.version}`
  run(process.execPath, [join(repoRoot, 'scripts', 'build.mjs'), folder])
  const archive = join(PACK_ROOT, `${tag}.tar.gz`)
  run('tar', ['-czf', archive, '-C', join(BUILD_ROOT, folder), '.'])
  const bytes = readFileSync(archive)
  const size = statSync(archive).size
  if (size > MAX_DOWNLOAD_BYTES) throw new Error(`${tag} is ${size} bytes; Odyn refuses downloads over ${MAX_DOWNLOAD_BYTES}.`)
  return {
    tag,
    archive,
    entry: {
      manifest: { ...pkg.odyn, version: pkg.version },
      url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${tag}.tar.gz`,
      size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  }
}

function main() {
  const folders = extensionFolders()
  const current = readIndex()
  const released = new Map(current.map((entry) => [entry.manifest.id, entry]))
  const changed = folders.filter((folder) => released.get(folder)?.manifest.version !== readPackage(folder).version)
  const removed = current.filter((entry) => !folders.includes(entry.manifest.id)).map((entry) => entry.manifest.id)

  rmSync(PACK_ROOT, { recursive: true, force: true })
  mkdirSync(PACK_ROOT, { recursive: true })
  const packed = changed.map(pack)

  // The list as it will be: new releases in, removed extensions out, screenshot links up to date.
  const sha = commitSha()
  const next = new Map(released)
  for (const { entry } of packed) next.set(entry.manifest.id, entry)
  for (const id of removed) next.delete(id)
  for (const [id, entry] of next) next.set(id, withScreenshots(entry, id, readPackage(id).odyn?.screenshots, sha))
  const text = indexText([...next.values()])
  if (text === (existsSync(INDEX_FILE) ? readFileSync(INDEX_FILE, 'utf8') : '')) {
    console.log('[release] nothing to release')
    return
  }

  for (const { tag, entry } of packed) console.log(`[release] ${tag}: ${entry.size} bytes, sha256 ${entry.sha256}`)
  for (const id of removed) console.log(`[release] ${id}: removed from the list`)
  if (packed.length === 0 && removed.length === 0) console.log('[release] only screenshot links change')
  if (!publish) {
    console.log('[release] dry run — pass --publish to create the releases and update index.json')
    return
  }

  // The release goes up before the list points at it, so Odyn never sees a link to a missing file.
  for (const { tag, archive, entry } of packed) {
    if (releaseExists(tag)) {
      // A run that stopped halfway made the release but never updated the list: replace its file.
      run('gh', ['release', 'upload', tag, archive, '--repo', REPOSITORY, '--clobber'])
    } else {
      run('gh', ['release', 'create', tag, archive, '--repo', REPOSITORY, '--title', `${entry.manifest.title} ${entry.manifest.version}`, '--notes', entry.manifest.description])
    }
  }
  writeFileSync(INDEX_FILE, text)
  console.log('[release] index.json updated')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()

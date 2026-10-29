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
/** Odyn refuses downloads above this size. */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024

const publish = process.argv.includes('--publish')

function readIndex() {
  if (!existsSync(INDEX_FILE)) return []
  const parsed = JSON.parse(readFileSync(INDEX_FILE, 'utf8'))
  return Array.isArray(parsed.extensions) ? parsed.extensions : []
}

function writeIndex(entries) {
  const sorted = [...entries].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
  writeFileSync(INDEX_FILE, `${JSON.stringify({ extensions: sorted }, null, 2)}\n`)
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

  if (changed.length === 0 && removed.length === 0) {
    console.log('[release] nothing to release')
    return
  }

  rmSync(PACK_ROOT, { recursive: true, force: true })
  mkdirSync(PACK_ROOT, { recursive: true })
  const packed = changed.map(pack)

  for (const { tag, entry } of packed) console.log(`[release] ${tag}: ${entry.size} bytes, sha256 ${entry.sha256}`)
  for (const id of removed) console.log(`[release] ${id}: removed from the list`)
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
    released.set(entry.manifest.id, entry)
  }
  for (const id of removed) released.delete(id)
  writeIndex([...released.values()])
  console.log('[release] index.json updated')
}

main()

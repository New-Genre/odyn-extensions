#!/usr/bin/env node
/**
 * Builds extensions from `extensions/<id>/` into `build/<id>/` — exactly the
 * folder Odyn unpacks when someone installs that extension.
 *
 *   node scripts/build.mjs              builds every extension
 *   node scripts/build.mjs phones       builds only the ones named
 *
 * The building itself is the kit's (`@odyn-app/api/build`), the same one
 * authors run with `odyn-extension build`, so what works on an author's Mac
 * builds the same way here. Every manifest is checked with the checker Odyn
 * runs on a download.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isOdynExtensionId } from '@odyn-app/api'
import { buildExtension, checkExtension as checkManifest } from '@odyn-app/api/build'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SOURCE_ROOT = join(repoRoot, 'extensions')
export const BUILD_ROOT = join(repoRoot, 'build')


/** Every extension folder, by name. */
export function extensionFolders() {
  return readdirSync(SOURCE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SOURCE_ROOT, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort()
}

/** Reads an extension's `package.json`. */
export function readPackage(folder) {
  return JSON.parse(readFileSync(join(SOURCE_ROOT, folder, 'package.json'), 'utf8'))
}

/** Checks one extension's manifest, folder name and owners. Returns the problems found. */
export function checkExtension(folder) {
  const official = isOdynExtensionId(folder)
  const problems = [...checkManifest(join(SOURCE_ROOT, folder), { official })]
  const pkg = readPackage(folder)
  if (pkg.odyn?.id !== folder) problems.push(`odyn.id must match the folder name ("${folder}").`)
  if (!official && !(Array.isArray(pkg.odyn?.owners) && pkg.odyn.owners.length > 0)) {
    problems.push('odyn.owners must list at least one GitHub username — the people who look after it.')
  }
  return problems
}

async function buildOne(folder) {
  const problems = checkExtension(folder)
  if (problems.length > 0) throw new Error(`${folder}: ${problems.join(' ')}`)
  const { version } = await buildExtension(join(SOURCE_ROOT, folder), {
    outputDir: join(BUILD_ROOT, folder),
    official: isOdynExtensionId(folder),
  })
  console.log(`[build] ${folder} ${version}`)
}

async function main() {
  const known = extensionFolders()
  const requested = process.argv.slice(2)
  const unknown = requested.filter((folder) => !known.includes(folder))
  if (unknown.length > 0) throw new Error(`No such extension: ${unknown.join(', ')}`)
  for (const folder of requested.length > 0 ? requested : known) await buildOne(folder)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[build] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}

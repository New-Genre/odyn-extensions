#!/usr/bin/env node
/**
 * Builds extensions from `extensions/<id>/` into `build/<id>/` — exactly the
 * folder Odyn unpacks when someone installs that extension.
 *
 *   node scripts/build.mjs              builds every extension
 *   node scripts/build.mjs phones       builds only the ones named
 *
 * Each built folder holds the extension's `package.json` (its `odyn` section is
 * the manifest), plus whatever it has: commands in `dist/index.js`, a page in
 * `dist/panel/`, a background helper in `dist/helper.js` (each script is one
 * self-contained file), and an agent guide copied as it is. Every manifest is checked with the same checker Odyn runs on
 * a download, so a broken one fails here rather than on someone's Mac.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/postcss'
import { build } from 'vite'
import { validateManifest } from '@odyn-app/api'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SOURCE_ROOT = join(repoRoot, 'extensions')
export const BUILD_ROOT = join(repoRoot, 'build')
const PANEL_DIR = join('dist', 'panel')
const HELPER_SOURCE = join('src', 'helper.ts')
const COMMANDS_SOURCE = join('src', 'index.ts')
/** The Chinese hand-drawn font is 12 MB on its own; Chinese text falls back to a system font. */
const SKIPPED_FONT_FAMILIES = new Set(['Xiaolai'])
/** The drawing library's folder, as it appears in the paths of the files a build uses. */
const DRAWING_LIBRARY_PATH = '/node_modules/@excalidraw/excalidraw/'
/** The only parts of an extension's `package.json` Odyn reads. */
const SHIPPED_PACKAGE_KEYS = ['name', 'version', 'private', 'odyn']

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

/**
 * Stops the build if a page or helper reaches outside its own folder — one
 * extension must never quietly bundle another's files. Installed packages
 * (the kit, React and so on) are fine.
 */
function stayInsideFolder(sourceDir, onDrawingLibrary) {
  return {
    name: 'odyn-stay-inside-folder',
    generateBundle() {
      for (const moduleId of this.getModuleIds()) {
        const library = moduleId.indexOf(DRAWING_LIBRARY_PATH)
        if (library !== -1) onDrawingLibrary(moduleId.slice(0, library + DRAWING_LIBRARY_PATH.length))
        const file = moduleId.split('?')[0]
        if (!file.startsWith('/') || file.includes('/node_modules/') || !existsSync(file)) continue
        if (!file.startsWith(`${sourceDir}/`)) {
          this.error(`${relative(repoRoot, file)} is outside this extension's folder. Extensions may only use their own files and installed packages.`)
        }
      }
    },
  }
}

/** Copies the drawing library's fonts in, when the page uses the library. */
function copyFonts(libraryRoot, panelDir) {
  const fontsRoot = join(libraryRoot, 'dist', 'prod', 'fonts')
  if (!existsSync(fontsRoot)) throw new Error(`Drawing fonts not found at ${fontsRoot}`)
  for (const family of readdirSync(fontsRoot)) {
    if (SKIPPED_FONT_FAMILIES.has(family)) continue
    cpSync(join(fontsRoot, family), join(panelDir, 'fonts', family), { recursive: true })
  }
}

/** Checks one extension's manifest and folder name. Returns the problems found. */
export function checkExtension(folder) {
  const pkg = readPackage(folder)
  const problems = []
  if (pkg.odyn?.id !== folder) problems.push(`odyn.id must match the folder name ("${folder}").`)
  if (pkg.private !== true) problems.push('"private": true is required, so it is never published to npm by mistake.')
  const manifest = { ...pkg.odyn, version: pkg.version }
  problems.push(...validateManifest(manifest, { official: true }))
  return problems
}

async function buildExtension(folder) {
  const problems = checkExtension(folder)
  if (problems.length > 0) throw new Error(`${folder}: ${problems.join(' ')}`)

  const sourceDir = join(SOURCE_ROOT, folder)
  const pkg = readPackage(folder)
  const outputDir = join(BUILD_ROOT, folder)
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })

  if (existsSync(join(sourceDir, 'index.html'))) {
    const panelDir = join(outputDir, PANEL_DIR)
    /** Where the drawing library is installed, once the page is seen to use it. */
    let drawingLibraryRoot = null
    await build({
      configFile: false,
      root: sourceDir,
      base: './',
      logLevel: 'warn',
      plugins: [react(), stayInsideFolder(sourceDir, (root) => { drawingLibraryRoot = root })],
      // Tailwind reads the extension's own folder (and the kit, which its theme points at).
      css: { postcss: { plugins: [tailwindcss({ base: sourceDir })] } },
      build: { outDir: panelDir, emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 4096 },
    })
    if (drawingLibraryRoot !== null) copyFonts(drawingLibraryRoot, panelDir)
  }

  // Commands and the background helper each run in a page with no module
  // loader, so everything is bundled into a single plain script.
  const scripts = [
    { source: COMMANDS_SOURCE, name: 'OdynExtension', fileName: 'index.js' },
    { source: HELPER_SOURCE, name: 'OdynHelper', fileName: 'helper.js' },
  ]
  for (const script of scripts.filter(({ source }) => existsSync(join(sourceDir, source)))) {
    await build({
      configFile: false,
      root: sourceDir,
      logLevel: 'warn',
      plugins: [stayInsideFolder(sourceDir, () => undefined)],
      build: {
        outDir: join(outputDir, 'dist'),
        emptyOutDir: false,
        sourcemap: false,
        minify: false,
        lib: { entry: join(sourceDir, script.source), formats: ['iife'], name: script.name, fileName: () => script.fileName },
      },
    })
  }

  const skillFolder = pkg.odyn?.agent?.skillFolder
  if (typeof skillFolder === 'string' && existsSync(join(sourceDir, skillFolder))) {
    cpSync(join(sourceDir, skillFolder), join(outputDir, skillFolder), { recursive: true })
  }

  const shipped = Object.fromEntries(SHIPPED_PACKAGE_KEYS.filter((key) => key in pkg).map((key) => [key, pkg[key]]))
  writeFileSync(join(outputDir, 'package.json'), `${JSON.stringify(shipped, null, 2)}\n`)
  console.log(`[build] ${folder} ${pkg.version}`)
}

async function main() {
  const known = extensionFolders()
  const requested = process.argv.slice(2)
  const unknown = requested.filter((folder) => !known.includes(folder))
  if (unknown.length > 0) throw new Error(`No such extension: ${unknown.join(', ')}`)
  for (const folder of requested.length > 0 ? requested : known) await buildExtension(folder)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[build] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}

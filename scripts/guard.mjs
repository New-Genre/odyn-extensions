#!/usr/bin/env node
/**
 * The security check every pull request gets. It runs from main (the
 * pull_request_target workflow), so a pull request can't change or switch it
 * off, and it only READS the pull request's files — nothing from them is run.
 *
 *   node scripts/guard.mjs --base <main checkout> --pr <pull request checkout>
 *     --changed <changed.tsv> --author <login> --association <OWNER|MEMBER|…>
 *     --report <report.md>
 *
 * It fails the pull request when:
 *   - someone outside the team changes anything but one extensions/<id>/ folder
 *   - an extension holds compiled or binary files, links, installed packages,
 *     built output, unreadable (minified) code, eval or new Function
 *   - a package.json runs scripts on install, or pulls code from outside npm
 *   - a new dependency runs scripts on install, or doesn't exist
 *   - someone who doesn't own an extension changes who owns it
 * and lists everything else worth a reviewer's eye in a report.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const EXTENSION_PATH = /^extensions\/([a-z0-9]+(?:-[a-z0-9]+)*)\//
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html', '.css'])
const ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.woff', '.woff2'])
const BLOCKED_EXTENSIONS = new Set([
  '.node', '.dylib', '.so', '.dll', '.exe', '.wasm', '.bin', '.jar', '.class', '.pyc',
  '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.dmg', '.pkg', '.app', '.sh', '.command',
])
const BLOCKED_FOLDERS = new Set(['node_modules', 'dist', 'build', '.git', '.github'])
const MAX_FILE_BYTES = 1024 * 1024
const MAX_ASSET_BYTES = 2 * 1024 * 1024
/** A line longer than this in source code is minified or deliberately hidden. */
const MAX_LINE_LENGTH = 1000
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare', 'postprepare']
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
/** Only plain npm version ranges: anything with `:` or `/` is a git, web, file or alias source. */
const REGISTRY_RANGE = /^[\w.^~<>=*|+\s-]+$/
const NEW_PACKAGE_DAYS = 30
/** Odyn's own packages, which are new by design. */
const ODYN_SCOPE = '@odyn-app/'
const DAY_MS = 24 * 60 * 60 * 1000

/** Source-code patterns: [pattern, what it is, whether it fails the check]. */
const CODE_RULES = [
  [/\beval\s*\(/, 'runs text as code (`eval`)', true],
  [/\bnew\s+Function\s*\(/, 'builds code from text (`new Function`)', true],
  [/\bimport\s*\(\s*['"`]https?:/, 'loads code from the internet', true],
  [/<script[^>]+src\s*=\s*['"]?(https?:)?\/\//i, 'loads a script from the internet', true],
  [/\b(atob|fromCharCode)\s*\(/, 'decodes hidden text (`atob` / `fromCharCode`)', false],
  [/[A-Za-z0-9+/=]{200,}/, 'contains a long encoded string', false],
  [/document\.cookie/, 'touches cookies', false],
  [/\bwindow\.open\s*\(/, 'opens windows', false],
]

/** Every changed path, old names included, and whether it may be changed by this author. */
export function folderProblems(changed, { maintainer }) {
  const paths = changed.flatMap(({ filename, previous }) => (previous ? [filename, previous] : [filename]))
  const outside = paths.filter((path) => !EXTENSION_PATH.test(path))
  const ids = [...new Set(paths.map((path) => EXTENSION_PATH.exec(path)?.[1]).filter(Boolean))]
  if (maintainer) return { ids, problems: [], notes: outside.map((path) => `Changes \`${path}\` (outside any extension).`) }
  const problems = []
  if (outside.length > 0) problems.push(`Only files inside one \`extensions/<id>/\` folder may change. This also changes: ${outside.map((path) => `\`${path}\``).join(', ')}.`)
  if (ids.length > 1) problems.push(`Change one extension per pull request. This changes: ${ids.map((id) => `\`${id}\``).join(', ')}.`)
  return { ids, problems, notes: [] }
}

/** Problems and warnings in one source file's text. */
export function scanText(path, text) {
  const problems = []
  const warnings = []
  const lines = text.split('\n')
  const longLine = lines.findIndex((line) => line.length > MAX_LINE_LENGTH)
  if (longLine !== -1) problems.push(`\`${path}\` line ${longLine + 1} is ${lines[longLine].length} characters long. Minified or squashed code can't be reviewed — commit the readable source.`)
  for (const [pattern, what, fails] of CODE_RULES) {
    const line = lines.findIndex((text) => pattern.test(text))
    if (line === -1) continue
    const message = `\`${path}\` line ${line + 1} ${what}.`
    if (fails) problems.push(message)
    else warnings.push(message)
  }
  return { problems, warnings }
}

/** Every file in a folder, with links reported rather than followed. */
function walk(folder) {
  const files = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) files.push({ path, link: true, blocked: false })
      else if (entry.isDirectory() && BLOCKED_FOLDERS.has(entry.name)) files.push({ path, link: false, blocked: true })
      else if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push({ path, link: false, blocked: false })
    }
  }
  visit(folder)
  return files
}

/** Problems and warnings in every file of an extension folder. */
export function scanFolder(folder) {
  const problems = []
  const warnings = []
  let totalBytes = 0
  for (const { path, link, blocked } of walk(folder)) {
    const name = relative(folder, path)
    if (blocked) {
      problems.push(`\`${name}/\` mustn't be committed. Installed packages and built files are made by the release.`)
      continue
    }
    if (link) {
      problems.push(`\`${name}\` is a link. Links aren't allowed — commit the real file.`)
      continue
    }
    const extension = extname(name).toLowerCase()
    const size = lstatSync(path).size
    totalBytes += size
    if (BLOCKED_EXTENSIONS.has(extension)) {
      problems.push(`\`${name}\` is a compiled program, archive or script file. Extensions may only contain source code and images.`)
      continue
    }
    const limit = ASSET_EXTENSIONS.has(extension) ? MAX_ASSET_BYTES : MAX_FILE_BYTES
    if (size > limit) problems.push(`\`${name}\` is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is ${limit / 1024 / 1024} MB.`)
    if (ASSET_EXTENSIONS.has(extension) && extension !== '.svg') continue
    const bytes = readFileSync(path)
    if (bytes.includes(0)) {
      problems.push(`\`${name}\` is a binary file. Extensions may only contain source code and images.`)
      continue
    }
    if (SOURCE_EXTENSIONS.has(extension) || extension === '.svg') {
      const found = scanText(name, bytes.toString('utf8'))
      problems.push(...found.problems)
      warnings.push(...found.warnings)
    }
  }
  return { problems, warnings, totalBytes }
}

function readJson(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) }
  }
}

function dependencies(pkg) {
  return Object.fromEntries(DEPENDENCY_FIELDS.flatMap((field) => Object.entries(pkg?.[field] ?? {})))
}

/** What a manifest change adds or removes, and which parts aren't allowed. */
export function manifestChanges(before, after, { author, maintainer }) {
  const problems = []
  const warnings = []
  const facts = []
  if (after === null) return { problems, warnings, facts: ['Removes this extension.'], newDependencies: [] }
  if (after.unreadable) return { problems: [`package.json isn't valid JSON: ${after.unreadable}`], warnings, facts, newDependencies: [] }
  const was = before?.odyn ?? {}
  const now = after.odyn ?? {}
  const added = (key) => (now[key] ?? []).filter((item) => !(was[key] ?? []).includes(item))
  const removed = (key) => (was[key] ?? []).filter((item) => !(now[key] ?? []).includes(item))

  facts.push(before === null ? `New extension, version ${after.version}.` : before.version === after.version ? `Version stays ${after.version} (won't be released).` : `Version ${before.version} → ${after.version}.`)
  if (added('permissions').length > 0) facts.push(`**Asks for new permissions:** ${added('permissions').map((item) => `\`${item}\``).join(', ')}.`)
  if (removed('permissions').length > 0) facts.push(`Drops permissions: ${removed('permissions').map((item) => `\`${item}\``).join(', ')}.`)
  if (added('allowedHosts').length > 0) facts.push(`**Can now reach:** ${added('allowedHosts').map((item) => `\`${item}\``).join(', ')}.`)
  if (now.agent && !was.agent) facts.push('**Gives the agent tools.**')

  const ownersChanged = JSON.stringify([...(was.owners ?? [])].sort()) !== JSON.stringify([...(now.owners ?? [])].sort())
  if (before !== null && ownersChanged) {
    facts.push(`**Owners:** ${(was.owners ?? []).join(', ') || 'none'} → ${(now.owners ?? []).join(', ') || 'none'}.`)
    if (!maintainer && !(was.owners ?? []).includes(author)) problems.push('Only an existing owner (or Odyn) can change who owns this extension.')
  }

  const hooks = INSTALL_HOOKS.filter((hook) => after.scripts?.[hook] !== undefined)
  if (hooks.length > 0) problems.push(`package.json runs scripts on install (${hooks.map((hook) => `\`${hook}\``).join(', ')}). Remove them.`)
  if (after.trustedDependencies !== undefined) problems.push('package.json lists `trustedDependencies`, which would let packages run scripts on install. Remove it.')

  const oldDeps = dependencies(before)
  const newDeps = dependencies(after)
  const newDependencies = Object.entries(newDeps).filter(([name, range]) => oldDeps[name] !== range)
  for (const [name, range] of newDependencies) {
    if (typeof range !== 'string' || !REGISTRY_RANGE.test(range.trim())) problems.push(`Dependency \`${name}\` comes from \`${range}\`. Only versions published on npm are allowed.`)
  }
  const dropped = Object.keys(oldDeps).filter((name) => !(name in newDeps))
  if (newDependencies.length > 0) facts.push(`Adds or changes packages: ${newDependencies.map(([name, range]) => `\`${name}@${range}\``).join(', ')}.`)
  if (dropped.length > 0) facts.push(`Removes packages: ${dropped.map((name) => `\`${name}\``).join(', ')}.`)
  return { problems, warnings, facts, newDependencies: newDependencies.filter(([, range]) => REGISTRY_RANGE.test(String(range).trim())) }
}

/** Looks a new dependency up on npm. Reads metadata only — nothing is installed. */
function checkPackage(name, range) {
  const problems = []
  const warnings = []
  const view = (field) => JSON.parse(execFileSync('npm', ['view', `${name}@${range}`, field, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || 'null')
  let scripts
  try {
    scripts = view('scripts')
  } catch {
    return { problems: [`Package \`${name}@${range}\` isn't on npm.`], warnings }
  }
  const versions = Array.isArray(scripts) ? scripts : [scripts]
  const hooks = [...new Set(versions.flatMap((entry) => INSTALL_HOOKS.filter((hook) => entry?.[hook] !== undefined)))]
  if (hooks.length > 0) problems.push(`Package \`${name}@${range}\` runs scripts on install (${hooks.join(', ')}). Pick a package that doesn't.`)
  if (name.startsWith(ODYN_SCOPE)) return { problems, warnings }
  try {
    const created = JSON.parse(execFileSync('npm', ['view', name, 'time.created', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    const ageDays = (Date.now() - new Date(created).getTime()) / DAY_MS
    if (ageDays < NEW_PACKAGE_DAYS) warnings.push(`Package \`${name}\` was first published ${Math.max(0, Math.floor(ageDays))} days ago. Check it's the real one.`)
  } catch {
    warnings.push(`Couldn't find when \`${name}\` was first published.`)
  }
  return { problems, warnings }
}

function list(items) {
  return items.map((item) => `- ${item}`).join('\n')
}

/** The comment posted on the pull request. */
export function renderReport({ problems, warnings, sections }) {
  const verdict = problems.length > 0
    ? `❌ **${problems.length} ${problems.length === 1 ? 'thing needs' : 'things need'} fixing before this can be merged.**`
    : '✅ **No problems found.** A reviewer still reads every change before it ships.'
  const parts = ['<!-- odyn-guard -->', '### Security check', '', verdict]
  if (problems.length > 0) parts.push('', '**Must fix**', list(problems))
  if (warnings.length > 0) parts.push('', '**Worth a look**', list(warnings))
  for (const { title, facts } of sections) parts.push('', `**${title}**`, list(facts))
  return `${parts.join('\n')}\n`
}

function args() {
  const values = {}
  const argv = process.argv.slice(2)
  for (let index = 0; index < argv.length; index += 2) values[argv[index].replace(/^--/, '')] = argv[index + 1] ?? ''
  return values
}

async function main() {
  const { base, pr, changed: changedFile, author = '', association = '', report = 'report.md' } = args()
  const { isOdynExtensionId } = await import(join(base, 'node_modules', '@odyn-app', 'api', 'dist', 'index.js'))
  const maintainer = MAINTAINER_ASSOCIATIONS.has(association)
  const changed = readFileSync(changedFile, 'utf8').split('\n').filter(Boolean).map((line) => {
    const [status, filename, previous] = line.split('\t')
    return { status, filename, previous: previous || null }
  })
  const folders = folderProblems(changed, { maintainer })
  const problems = [...folders.problems]
  const warnings = []
  const sections = folders.notes.length > 0 ? [{ title: 'Outside extensions', facts: folders.notes }] : []

  for (const id of folders.ids) {
    const facts = []
    const folder = join(pr, 'extensions', id)
    const before = readJson(join(base, 'extensions', id, 'package.json'))
    const after = existsSync(folder) ? readJson(join(folder, 'package.json')) : null
    if (isOdynExtensionId(id)) warnings.push(`\`${id}\` is one of Odyn's own extensions, which can do more than others. Review it closely.`)
    const manifest = manifestChanges(before, after, { author, maintainer })
    problems.push(...manifest.problems)
    warnings.push(...manifest.warnings)
    facts.push(...manifest.facts)
    if (existsSync(folder)) {
      const scan = scanFolder(folder)
      problems.push(...scan.problems.map((problem) => `${id}: ${problem}`))
      warnings.push(...scan.warnings.map((warning) => `${id}: ${warning}`))
      facts.push(`Source size: ${(scan.totalBytes / 1024).toFixed(0)} KB.`)
    }
    for (const [name, range] of manifest.newDependencies) {
      const found = checkPackage(name, range)
      problems.push(...found.problems)
      warnings.push(...found.warnings)
    }
    sections.push({ title: `\`${id}\``, facts })
  }

  writeFileSync(report, renderReport({ problems, warnings, sections }))
  console.log(readFileSync(report, 'utf8'))
  if (problems.length > 0) process.exit(1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[guard] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}

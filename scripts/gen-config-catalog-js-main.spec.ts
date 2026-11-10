import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectConfigCatalog, render } from './gen-config-catalog.ts'

function fixture(main: string, source?: string): { root: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-config-catalog-'))
  const packageDir = join(root, 'packages', 'extensions', 'js-only')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@test/js-only', main }))
  if (source !== undefined) writeFileSync(join(packageDir, 'index.js'), source)
  return { root, dispose: () => { rmSync(root, { recursive: true, force: true }) } }
}

describe('config catalog JS-only package entry', () => {
  it('classifies an existing package main with a real no-config apply export', () => {
    const source = fixture('./index.js', 'export const inject = ["tools"]; export function apply(ctx) { return ctx }\n')
    try {
      const entries = collectConfigCatalog(source.root)
      expect(entries).toMatchObject([{ pkg: '@test/js-only', kind: 'no-config',
        entry: 'packages/extensions/js-only/index.js', inject: ['tools'] }])
      expect(render(entries)).toContain('packages/extensions/js-only/index.js')
    } finally {
      source.dispose()
    }
  })

  it('rejects missing and escaping JS mains rather than omitting a package', () => {
    for (const main of ['./missing.js', '../outside.js']) {
      const source = fixture(main)
      try {
        expect(() => collectConfigCatalog(source.root)).toThrow('missing or unreadable')
      } finally {
        source.dispose()
      }
    }
  })
})

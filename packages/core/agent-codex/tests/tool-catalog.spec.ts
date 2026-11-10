import { describe, expect, it } from 'vitest'
import { codexToolCatalog } from '../src/tool-catalog.ts'

describe('Codex tool catalog', () => {
  it('sorts tools and hashes their complete JSON schema independent of object key order', () => {
    const first = codexToolCatalog([
      { name: 'zeta', description: 'Z', parameters: { type: 'object', properties: {} } },
      { name: 'alpha', description: 'A', parameters: { type: 'object', properties: {
        query: { type: 'string', description: 'Search' },
      } } },
    ])
    const reordered = codexToolCatalog([
      { name: 'alpha', description: 'A', parameters: { properties: {
        query: { description: 'Search', type: 'string' },
      }, type: 'object' } },
      { name: 'zeta', description: 'Z', parameters: { properties: {}, type: 'object' } },
    ])
    expect(first.tools.map(tool => tool.name)).toEqual(['alpha', 'zeta'])
    expect(first.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(reordered.hash).toBe(first.hash)
    expect(codexToolCatalog([{ name: 'alpha', description: 'changed', parameters: {
      type: 'object', properties: {},
    } }]).hash).not.toBe(first.hash)
  })
})

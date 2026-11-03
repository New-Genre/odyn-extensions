import { describe, expect, test } from 'bun:test'
import type { ExtensionNote } from '@odyn-app/api'
import { saveDecision } from './save-rules'

const STARTED = { id: 'doc-1', title: 'Overview', markdown: '# Old' } as ExtensionNote

function fresh(markdown: string): ExtensionNote {
  return { ...STARTED, markdown }
}

describe('saveDecision', () => {
  test('saves when nobody else changed the document', () => {
    expect(saveDecision(STARTED, fresh('# Old'), '# New')).toBe('save')
  })

  test('skips when the document already says what was typed', () => {
    expect(saveDecision(STARTED, fresh('# New'), '# New')).toBe('skip')
  })

  test('never writes over a newer change from someone else', () => {
    expect(saveDecision(STARTED, fresh('# Teammate edit'), '# New')).toBe('conflict')
  })

  test('treats a deleted document as a clash', () => {
    expect(saveDecision(STARTED, null, '# New')).toBe('conflict')
  })
})

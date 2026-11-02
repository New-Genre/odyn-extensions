import { describe, expect, test } from 'bun:test'
import type { ChatSummary, ExtensionInitiative, ExtensionInitiativeSummary } from '@odyn-app/api'
import {
  chipColor,
  chipFor,
  contextNote,
  dashboardCard,
  initiativeIdFromItem,
  initiativeItem,
  linkedChats,
  linkKey,
  linkValue,
  parseLink,
  readLinks,
  type DashboardRow,
} from './initiatives'

const READ_TOOL = 'ext_initiatives__read_document'

function summary(id: string, overrides: Partial<ExtensionInitiativeSummary> = {}): ExtensionInitiativeSummary {
  return { id, title: `Initiative ${id}`, description: null, status: 'active', documentCount: 0, updatedAt: '2026-11-01', ...overrides }
}

function chat(id: string, workspaceChatId?: string, isWorking = false): ChatSummary {
  return { id, projectId: 'project-1', title: `Chat ${id}`, updatedAt: '2026-11-01', isWorking, ...(workspaceChatId === undefined ? {} : { workspaceChatId }) }
}

const LAUNCH: ExtensionInitiative = {
  id: 'plan-1',
  title: 'Laural launch',
  description: 'Ship the paid plan by 14 Nov',
  status: 'active',
  createdAt: '2026-10-01',
  groups: [],
  documents: [
    { id: 'doc-1', title: 'Overview', description: null, updatedAt: '2026-11-01', updatedBy: 'user', updatedSinceSeen: false, groupId: null },
    { id: 'doc-2', title: 'Pricing', description: null, updatedAt: '2026-11-01', updatedBy: 'agent', updatedSinceSeen: true, groupId: null },
  ],
}

describe('links', () => {
  test('round-trip in the same shape Odyn copies old links into', () => {
    expect(linkKey('chat-1')).toBe('link:chat-1')
    expect(linkValue('plan-1')).toBe('{"initiativeId":"plan-1"}')
    expect(parseLink(linkValue('plan-1'))).toBe('plan-1')
  })

  test('missing, damaged or empty links read as no link', () => {
    expect(parseLink(null)).toBeNull()
    expect(parseLink('not json')).toBeNull()
    expect(parseLink('"plan-1"')).toBeNull()
    expect(parseLink('{"initiativeId":"  "}')).toBeNull()
    expect(parseLink('{"initiativeId":7}')).toBeNull()
  })

  test('readLinks keeps only good link entries', () => {
    const links = readLinks([
      ['link:main-1', linkValue('plan-1')],
      ['link:main-2', 'broken'],
      ['other:main-3', linkValue('plan-3')],
    ])
    expect([...links]).toEqual([['main-1', 'plan-1']])
  })

  test('linkedChats counts every chat in a linked workspace, and a chat with no workspace as its own', () => {
    const links = new Map([['main-1', 'plan-1'], ['solo', 'plan-1'], ['main-2', 'plan-2']])
    const chats = [chat('main-1', 'main-1'), chat('sub-1', 'main-1'), chat('solo'), chat('other', 'main-2')]
    expect(linkedChats(chats, links, 'plan-1').map((entry) => entry.id)).toEqual(['main-1', 'sub-1', 'solo'])
  })
})

describe('page items', () => {
  test('an initiative item round-trips, anything else is not an initiative', () => {
    expect(initiativeIdFromItem(initiativeItem('plan-1'))).toBe('plan-1')
    expect(initiativeIdFromItem('pick')).toBeNull()
    expect(initiativeIdFromItem('initiative:')).toBeNull()
    expect(initiativeIdFromItem(null)).toBeNull()
    expect(initiativeIdFromItem(undefined)).toBeNull()
  })
})

describe('chip', () => {
  test('the same initiative always gets the same colour', () => {
    expect(chipColor('plan-1')).toBe(chipColor('plan-1'))
  })

  test('long titles are shortened to fit the chip', () => {
    const chip = chipFor({ id: 'plan-1', title: 'A'.repeat(100) })
    expect(chip.label.length).toBeLessThanOrEqual(40)
    expect(chip.label.endsWith('…')).toBe(true)
  })
})

describe('context note', () => {
  test('names the initiative and lists documents without their contents', () => {
    const note = contextNote(LAUNCH, READ_TOOL)
    expect(note).toContain('"Laural launch" (id plan-1) — Ship the paid plan by 14 Nov.')
    expect(note).toContain('"Overview" (id doc-1), "Pricing" (id doc-2)')
    expect(note).toContain(READ_TOOL)
  })

  test('says so when there are no documents', () => {
    expect(contextNote({ ...LAUNCH, documents: [] }, READ_TOOL)).toContain('It has no documents yet.')
  })

  test('stays under the context limit', () => {
    const many = Array.from({ length: 200 }, (_, index) => ({ ...LAUNCH.documents[0]!, id: `doc-${index}`, title: `Document number ${index}` }))
    expect(contextNote({ ...LAUNCH, documents: many }, READ_TOOL).length).toBeLessThanOrEqual(2_000)
  })
})

describe('dashboard card', () => {
  test('shows only active initiatives, busiest first, with chat counts', () => {
    const rows: DashboardRow[] = [
      { initiative: summary('quiet'), chats: 1, working: 0 },
      { initiative: summary('busy'), chats: 4, working: 2 },
      { initiative: summary('done', { status: 'shipped' }), chats: 9, working: 9 },
    ]
    const card = dashboardCard(rows)
    expect(card.items.map((item) => item.id)).toEqual(['busy', 'quiet'])
    expect(card.items.map((item) => item.subtitle)).toEqual(['4 chats · 2 working', '1 chat'])
    expect(card.actions?.[0]?.title).toBe('Open initiatives')
  })

  test('caps the list at five and offers to create one when empty', () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({ initiative: summary(`plan-${index}`), chats: 0, working: 0 }))
    expect(dashboardCard(rows).items).toHaveLength(5)
    expect(dashboardCard([]).actions?.[0]?.title).toBe('Create initiative')
  })
})

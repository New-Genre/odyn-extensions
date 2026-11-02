// The Initiatives extension's plain logic: how links are stored, what a linked
// chat is told, what the chip and the dashboard card show. No calls to Odyn
// here, so all of it can be tested on its own.
import type {
  ChatSummary,
  ExtensionChatChip,
  ExtensionChipColor,
  ExtensionDashboardCard,
  ExtensionInitiative,
  ExtensionInitiativeSummary,
} from '@odyn-app/api'

/**
 * A workspace's link lives in the extension's shared storage under
 * `link:<workspaceChatId>`. Odyn copies the links from its old settings into
 * this exact shape when the extension is installed, so both must agree.
 */
export const LINK_PREFIX = 'link:'
/** A page opened with this item shows the "pick an initiative" list for its chat. */
export const PICK_ITEM = 'pick'
/** A page opened with `initiative:<id>` shows that initiative. */
export const INITIATIVE_ITEM_PREFIX = 'initiative:'

const CHIP_MAX_LABEL = 40
const CONTEXT_MAX_CHARS = 2_000
const DASHBOARD_MAX_ITEMS = 5
const DASHBOARD_MAX_TITLE = 80
const DASHBOARD_MAX_SUBTITLE = 140
const CHIP_COLORS: readonly ExtensionChipColor[] = ['blue', 'green', 'amber', 'red', 'purple']

export function linkKey(workspaceChatId: string): string {
  return `${LINK_PREFIX}${workspaceChatId}`
}

export function linkValue(initiativeId: string): string {
  return JSON.stringify({ initiativeId })
}

/** The initiative id inside a stored link, or `null` when the value is missing or damaged. */
export function parseLink(raw: string | null): string | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const initiativeId = (parsed as { readonly initiativeId?: unknown }).initiativeId
    return typeof initiativeId === 'string' && initiativeId.trim() !== '' ? initiativeId : null
  } catch (error) {
    console.warn('[initiatives] ignoring a damaged link', error)
    return null
  }
}

export function initiativeItem(initiativeId: string): string {
  return `${INITIATIVE_ITEM_PREFIX}${initiativeId}`
}

/** The initiative id in a page's `item`, or `null` when it names something else. */
export function initiativeIdFromItem(item: string | null | undefined): string | null {
  if (typeof item !== 'string' || !item.startsWith(INITIATIVE_ITEM_PREFIX)) return null
  const id = item.slice(INITIATIVE_ITEM_PREFIX.length)
  return id === '' ? null : id
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** The same initiative always gets the same dot colour. */
export function chipColor(initiativeId: string): ExtensionChipColor {
  const total = [...initiativeId].reduce((sum, character) => sum + character.charCodeAt(0), 0)
  return CHIP_COLORS[total % CHIP_COLORS.length] ?? 'blue'
}

export function chipFor(initiative: Pick<ExtensionInitiativeSummary, 'id' | 'title'>): ExtensionChatChip {
  return { label: shorten(initiative.title, CHIP_MAX_LABEL), color: chipColor(initiative.id) }
}

/**
 * The short note a linked chat starts with: what the initiative is, which
 * documents it has, and how to open them. Never the documents themselves.
 */
export function contextNote(initiative: ExtensionInitiative, readToolName: string): string {
  const description = initiative.description?.trim() ? ` — ${initiative.description.trim()}` : ''
  const documents = initiative.documents.map((document) => `"${document.title}" (id ${document.id})`)
  const lines = [
    `This chat is part of the initiative "${initiative.title}" (id ${initiative.id})${description}.`,
    documents.length > 0
      ? `Its documents: ${documents.join(', ')}. Open one with ${readToolName} only when you need it.`
      : 'It has no documents yet.',
    'Keep its documents up to date with the Initiatives tools as work finishes.',
  ]
  const text = lines.join('\n')
  return text.length > CONTEXT_MAX_CHARS ? `${text.slice(0, CONTEXT_MAX_CHARS - 1)}…` : text
}

/** Workspace → initiative, from the stored links. Damaged links are left out. */
export function readLinks(entries: ReadonlyArray<readonly [string, string | null]>): ReadonlyMap<string, string> {
  const links = new Map<string, string>()
  for (const [key, raw] of entries) {
    if (!key.startsWith(LINK_PREFIX)) continue
    const initiativeId = parseLink(raw)
    if (initiativeId !== null) links.set(key.slice(LINK_PREFIX.length), initiativeId)
  }
  return links
}

/** The chats whose workspace is linked to this initiative. A chat with no workspace counts as its own. */
export function linkedChats(
  chats: readonly ChatSummary[],
  links: ReadonlyMap<string, string>,
  initiativeId: string,
): readonly ChatSummary[] {
  return chats.filter((chat) => links.get(chat.workspaceChatId ?? chat.id) === initiativeId)
}

export interface DashboardRow {
  readonly initiative: ExtensionInitiativeSummary
  readonly chats: number
  readonly working: number
}

function chatsLine(row: DashboardRow): string {
  const chats = `${row.chats} ${row.chats === 1 ? 'chat' : 'chats'}`
  return row.working > 0 ? `${chats} · ${row.working} working` : chats
}

/** The dashboard card: active initiatives, busiest first. */
export function dashboardCard(rows: readonly DashboardRow[]): ExtensionDashboardCard {
  const active = rows
    .filter((row) => row.initiative.status === 'active')
    .toSorted((a, b) => b.working - a.working || b.chats - a.chats || b.initiative.updatedAt.localeCompare(a.initiative.updatedAt))
    .slice(0, DASHBOARD_MAX_ITEMS)
  return {
    title: 'Initiatives',
    items: active.map((row) => ({
      id: row.initiative.id,
      title: shorten(row.initiative.title, DASHBOARD_MAX_TITLE),
      subtitle: shorten(chatsLine(row), DASHBOARD_MAX_SUBTITLE),
    })),
    actions: [{ id: 'open', title: active.length === 0 ? 'Create initiative' : 'Open initiatives', opensDialog: true }],
  }
}

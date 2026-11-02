// What the page loads from Odyn and the small helpers it shares. Kept apart
// from the drawing so the rules can be tested without a browser.
import type {
  ChatSummary,
  ExtensionInitiative,
  ExtensionNotesList,
  OdynSurfaceApi,
  ProjectSummary,
} from '@odyn-app/api'
import { LINK_PREFIX, readLinks } from './initiatives'

export interface ProjectData {
  readonly list: ExtensionNotesList
  readonly chats: readonly ChatSummary[]
  readonly links: ReadonlyMap<string, string>
}

export async function loadProject(odyn: OdynSurfaceApi, projectId: string): Promise<ProjectData> {
  const [list, chats, keys] = await Promise.all([odyn.notes.list(projectId), odyn.chats.list(projectId), odyn.storage.keys(LINK_PREFIX)])
  const links = readLinks(await Promise.all(keys.map(async (key) => [key, await odyn.storage.get(key)] as const)))
  return { list, chats, links }
}

/**
 * Where the page starts: the project of the chat it was opened for, else the
 * project holding the initiative it was opened on, else the first project.
 */
export async function startingProject(
  odyn: OdynSurfaceApi,
  projects: readonly ProjectSummary[],
  chatId: string | null,
  initiativeId: string | null,
): Promise<string | null> {
  if (chatId !== null) {
    const chat = (await odyn.chats.list()).find((candidate) => candidate.id === chatId)
    if (chat !== undefined) return chat.projectId
  }
  if (initiativeId !== null) {
    for (const project of projects) {
      const found: ExtensionInitiative | null = await odyn.notes.initiative(project.id, initiativeId).catch((error: unknown) => {
        console.warn(`[initiatives] could not look in project ${project.id}`, error)
        return null
      })
      if (found !== null) return project.id
    }
  }
  return projects[0]?.id ?? null
}

/** The id in Odyn's "Created … (id X)" reply, or `null` when it has none. */
export function createdId(reply: string): string | null {
  return /\(id ([^)\s]+)\)/.exec(reply)?.[1] ?? null
}

/** The workspace a chat belongs to: its workspace's main chat, or itself. */
export function workspaceOf(chats: readonly ChatSummary[], chatId: string): string {
  return chats.find((chat) => chat.id === chatId)?.workspaceChatId ?? chatId
}

export function matches(query: string, ...fields: ReadonlyArray<string | null>): boolean {
  const needle = query.trim().toLowerCase()
  return needle === '' || fields.some((field) => field?.toLowerCase().includes(needle) === true)
}

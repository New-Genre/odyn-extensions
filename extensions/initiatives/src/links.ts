// Linking a workspace to an initiative, shared by the extension's code and its
// page. A link covers the whole workspace, so every chat in it gets the chip.
import type { ChatSummary, ExtensionChatChip, ExtensionInitiativeSummary, ExtensionStorage } from '@odyn-app/api'
import { chipFor, linkKey, linkValue, parseLink } from './initiatives'

/** The parts of Odyn linking needs; both the extension's code and its page have them. */
export interface LinkApi {
  readonly storage: ExtensionStorage
  readonly chats: { list(projectId?: string): Promise<readonly ChatSummary[]> }
  readonly ui: { setChatChip(chatId: string, chip: ExtensionChatChip | null): Promise<void> }
}

export async function linkedInitiativeId(api: Pick<LinkApi, 'storage'>, workspaceChatId: string): Promise<string | null> {
  return parseLink(await api.storage.get(linkKey(workspaceChatId)))
}

async function workspaceChats(api: LinkApi, projectId: string, workspaceChatId: string): Promise<readonly ChatSummary[]> {
  const chats = await api.chats.list(projectId)
  return chats.filter((chat) => (chat.workspaceChatId ?? chat.id) === workspaceChatId)
}

export async function linkWorkspace(
  api: LinkApi,
  projectId: string,
  workspaceChatId: string,
  initiative: Pick<ExtensionInitiativeSummary, 'id' | 'title'>,
): Promise<void> {
  await api.storage.set(linkKey(workspaceChatId), linkValue(initiative.id))
  const chip = chipFor(initiative)
  const chats = await workspaceChats(api, projectId, workspaceChatId)
  await Promise.all(chats.map((chat) => api.ui.setChatChip(chat.id, chip)))
}

export async function unlinkWorkspace(api: LinkApi, projectId: string, workspaceChatId: string): Promise<void> {
  await api.storage.set(linkKey(workspaceChatId), null)
  const chats = await workspaceChats(api, projectId, workspaceChatId)
  await Promise.all(chats.map((chat) => api.ui.setChatChip(chat.id, null)))
}

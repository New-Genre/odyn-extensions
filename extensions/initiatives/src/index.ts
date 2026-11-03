// The Initiatives extension's code. Odyn runs it in a sealed box: it answers
// agents' tool calls, gives a linked chat its short opening note, draws the
// dashboard card and opens the full page from the sidebar, the chip and the
// message box's + menu.
import {
  defineExtension,
  type CommandContext,
  type ExtensionInputValue,
  type ExtensionNoteTool,
  type ExtensionToolCaller,
  type ExtensionView,
  type OdynApi,
} from '@odyn-app/api'
import {
  chipFor,
  contextNote,
  dashboardCard,
  initiativeItem,
  linkedChats,
  LINK_PREFIX,
  PICK_ITEM,
  readLinks,
  type DashboardRow,
} from './initiatives'
import { linkedInitiativeId, linkWorkspace } from './links'

/** What agents see the document reader as; must match the `read-document` command. */
const READ_DOCUMENT_TOOL = 'ext_initiatives__read_document'
const CARD_TITLE_MAX = 80

type Inputs = Readonly<Record<string, ExtensionInputValue>>

function requireCaller(caller: ExtensionToolCaller | undefined): ExtensionToolCaller {
  if (caller === undefined) throw new Error('Only a chat can use this.')
  return caller
}

function textInput(input: Inputs | undefined, name: string): string | undefined {
  const value = input?.[name]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function jsonInput(input: Inputs | undefined, name: string): unknown {
  const raw = textInput(input, name)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`\`${name}\` must be valid JSON.`)
  }
}

/** The initiative a tool means: the one it names, or else the one this chat's workspace is linked to. */
async function targetInitiative(odyn: OdynApi, caller: ExtensionToolCaller, input: Inputs | undefined): Promise<string | undefined> {
  return textInput(input, 'initiativeId') ?? (await linkedInitiativeId(odyn, caller.workspaceChatId)) ?? undefined
}

/** Runs one of Odyn's note tools as the calling chat, so edits are recorded as the agent's. */
async function runAsChat(odyn: OdynApi, caller: ExtensionToolCaller, tool: ExtensionNoteTool, input: Readonly<Record<string, unknown>>): Promise<string> {
  const result = await odyn.notes.run(tool, caller.chatId, input)
  if (result.isError) throw new Error(result.text)
  return result.text
}

/** An agent tool that passes its inputs straight to one of Odyn's note tools. */
function noteTool(tool: ExtensionNoteTool, shape?: (input: Inputs | undefined) => Readonly<Record<string, unknown>>) {
  return async ({ odyn, input, caller }: CommandContext): Promise<string> =>
    runAsChat(odyn, requireCaller(caller), tool, shape ? shape(input) : { ...input })
}

/** An agent tool aimed at an initiative, defaulting to the linked one. */
function initiativeTool(tool: ExtensionNoteTool, shape: (input: Inputs | undefined, initiativeId: string | undefined) => Readonly<Record<string, unknown>>) {
  return async ({ odyn, input, caller }: CommandContext): Promise<string> => {
    const from = requireCaller(caller)
    return runAsChat(odyn, from, tool, shape(input, await targetInitiative(odyn, from, input)))
  }
}

async function suggestLink({ odyn, input, caller, actionId }: CommandContext): Promise<ExtensionView | string> {
  const from = requireCaller(caller)
  const initiativeId = textInput(input, 'initiativeId')
  if (initiativeId === undefined) throw new Error('Name the initiative with `initiativeId`.')
  const initiative = await odyn.notes.initiative(from.projectId, initiativeId)
  if (initiative === null) throw new Error(`No initiative ${initiativeId} in this project. ListInitiatives shows the ones there are.`)
  if (actionId === 'not-now') return 'The person chose not to link this chat. Do not ask again in this chat.'
  if (actionId === 'link') {
    await linkWorkspace(odyn, from.projectId, from.workspaceChatId, initiative)
    return `Linked this chat to "${initiative.title}".`
  }
  if ((await linkedInitiativeId(odyn, from.workspaceChatId)) === initiative.id) return `This chat is already linked to "${initiative.title}".`
  const title = `This looks like part of “${initiative.title}”`
  return {
    type: 'card',
    title: title.length > CARD_TITLE_MAX ? `${title.slice(0, CARD_TITLE_MAX - 2)}…”` : title,
    items: [],
    actions: [
      { id: 'not-now', title: 'Not now' },
      { id: 'link', title: 'Link chat' },
    ],
  }
}

async function chatContext({ odyn, caller }: CommandContext): Promise<string | undefined> {
  if (caller === undefined) return undefined
  const initiativeId = await linkedInitiativeId(odyn, caller.workspaceChatId)
  if (initiativeId === null) return undefined
  const initiative = await odyn.notes.initiative(caller.projectId, initiativeId)
  if (initiative === null) return undefined
  // A chat started in a linked workspace after the link was made gets its chip here.
  await odyn.ui.setChatChip(caller.chatId, chipFor(initiative))
  return contextNote(initiative, READ_DOCUMENT_TOOL)
}

async function openFromChip({ odyn, caller }: CommandContext): Promise<void> {
  const from = requireCaller(caller)
  const initiativeId = await linkedInitiativeId(odyn, from.workspaceChatId)
  await odyn.ui.openDialog({ chatId: from.chatId, ...(initiativeId === null ? {} : { item: initiativeItem(initiativeId) }) })
}

async function dashboardRows(odyn: OdynApi): Promise<readonly DashboardRow[]> {
  const [projects, chats, keys] = await Promise.all([odyn.projects.list(), odyn.chats.list(), odyn.storage.keys(LINK_PREFIX)])
  const links = readLinks(await Promise.all(keys.map(async (key) => [key, await odyn.storage.get(key)] as const)))
  const lists = await Promise.all(projects.map(async (project) => {
    try {
      return (await odyn.notes.list(project.id)).initiatives
    } catch (error) {
      console.warn(`[initiatives] skipping project ${project.id} on the dashboard`, error)
      return []
    }
  }))
  return lists.flat().map((initiative) => {
    const linked = linkedChats(chats, links, initiative.id)
    return { initiative, chats: linked.length, working: linked.filter((chat) => chat.isWorking === true).length }
  })
}

async function dashboard({ odyn, itemId }: CommandContext): Promise<ExtensionView | undefined> {
  if (itemId !== undefined) {
    await odyn.ui.openDialog({ item: initiativeItem(itemId) })
    return undefined
  }
  return { type: 'card', ...dashboardCard(await dashboardRows(odyn)) }
}

const noteIdOnly = (input: Inputs | undefined) => ({ noteId: textInput(input, 'noteId') ?? '' })

defineExtension({
  commands: {
    'open-initiatives': async ({ odyn }) => {
      await odyn.ui.openDialog()
    },
    'attach-initiative': async ({ odyn, caller }) => {
      await odyn.ui.openDialog({ ...(caller === undefined ? {} : { chatId: caller.chatId }), item: PICK_ITEM })
    },
    'open-from-chip': openFromChip,
    dashboard,
    context: chatContext,
    'suggest-link': suggestLink,
    'list-initiatives': noteTool('ListInitiatives', (input) => ({ query: textInput(input, 'query') })),
    'read-initiative': initiativeTool('ReadInitiative', (_input, initiativeId) => ({ initiativeId })),
    'read-document': noteTool('ReadNote', (input) => ({
      ...noteIdOnly(input),
      section: textInput(input, 'section'),
      outline: input?.outline === true,
    })),
    'list-notes': noteTool('ListNotes', (input) => ({ limit: typeof input?.limit === 'number' ? input.limit : undefined })),
    'create-initiative': noteTool('CreateInitiative', (input) => ({
      title: textInput(input, 'title') ?? '',
      description: textInput(input, 'description'),
    })),
    'create-document': initiativeTool('CreateNote', (input, initiativeId) => ({
      title: textInput(input, 'title') ?? '',
      markdown: textInput(input, 'markdown') ?? '',
      description: textInput(input, 'description'),
      group: textInput(input, 'group'),
      initiativeId: input?.loose === true ? undefined : initiativeId,
    })),
    'edit-document': noteTool('EditNote', (input) => ({ ...noteIdOnly(input), markdown: textInput(input, 'markdown') ?? '' })),
    'patch-document': noteTool('PatchNote', (input) => ({
      ...noteIdOnly(input),
      version: typeof input?.version === 'number' ? input.version : undefined,
      edits: jsonInput(input, 'edits'),
    })),
    'rename-document': noteTool('RenameNote', (input) => ({ ...noteIdOnly(input), title: textInput(input, 'title') ?? '' })),
    'delete-document': noteTool('DeleteNote', noteIdOnly),
    'move-notes': initiativeTool('MoveNotesToInitiative', (input, initiativeId) => ({
      initiativeId,
      noteIds: (textInput(input, 'noteIds') ?? '').split(',').map((id) => id.trim()).filter((id) => id !== ''),
      makePrivate: input?.makePrivate === true,
      group: textInput(input, 'group'),
    })),
    'mark-complete': initiativeTool('MarkInitiativeComplete', (input, initiativeId) => ({
      initiativeId,
      summary: textInput(input, 'summary') ?? '',
    })),
    'edit-groups': initiativeTool('EditInitiativeGroups', (input, initiativeId) => {
      const changes = jsonInput(input, 'changes')
      if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) throw new Error('`changes` must be a JSON object.')
      return { ...changes, initiativeId }
    }),
  },
})

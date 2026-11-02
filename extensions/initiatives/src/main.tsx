// The Initiatives page. Odyn shows it full-window from the sidebar button, the
// dashboard card, a chat's chip and the message box's + menu. Initiatives and
// loose notes are listed on the left; the open one shows on the right.
import '@fontsource-variable/inter'
import './panel.css'
import { StrictMode, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { connectSurface, type ExtensionInitiative, type ProjectSummary, type SurfaceContext } from '@odyn-app/api'
import { Button, cn, Skeleton } from '@odyn-app/api/ui'
import { IconFileContentOutline18, IconLinkOutline18, IconMagnifierOutline18, IconPlusOutline18 } from 'nucleo-ui-essential-outline-18'
import { chipColor, initiativeIdFromItem, linkedChats, PICK_ITEM } from './initiatives'
import { linkWorkspace, unlinkWorkspace } from './links'
import { NoteEditor } from './note-editor'
import { createdId, loadProject, matches, startingProject, workspaceOf, type ProjectData } from './page-data'

const odyn = connectSurface()

type Selection =
  | { readonly kind: 'initiative'; readonly id: string }
  | { readonly kind: 'note'; readonly id: string; readonly initiativeId: string | null }
  | null

/** Dot classes per chip colour, matching the chip in the chat header. */
const DOT_CLASS: Readonly<Record<string, string>> = {
  blue: 'bg-info',
  green: 'bg-success',
  amber: 'bg-warning',
  red: 'bg-destructive',
  purple: 'bg-purple-500',
}
const SKELETON_ROWS = ['a', 'b', 'c', 'd', 'e', 'f'] as const

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function Dot({ initiativeId }: { readonly initiativeId: string }): ReactElement {
  return <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[chipColor(initiativeId)])} />
}

function PageSkeleton(): ReactElement {
  return (
    <div className="flex h-full" aria-busy="true" aria-label="Loading initiatives">
      <div className="flex w-72 shrink-0 flex-col gap-2 border-e p-3">
        <Skeleton className="h-8 w-full" />
        {SKELETON_ROWS.map((row) => <Skeleton key={row} className="h-7 w-full" />)}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-6">
        <Skeleton className="h-7 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  )
}

/** A one-field form that appears in place of a "New …" button. */
function TitleForm({ label, onSubmit, onCancel }: {
  readonly label: string
  readonly onSubmit: (title: string) => Promise<void>
  readonly onCancel: () => void
}): ReactElement {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (title.trim() === '') return
    setBusy(true)
    try {
      await onSubmit(title.trim())
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="flex items-center gap-2" onSubmit={(event) => void submit(event)}>
      <label className="sr-only" htmlFor="new-title">{label}</label>
      <input
        id="new-title"
        type="text"
        autoFocus
        value={title}
        placeholder={label}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') onCancel() }}
        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      <Button size="sm" type="submit" disabled={busy}>Create</Button>
    </form>
  )
}

function InitiativeView({ initiative, data, chatId, picking, projectId, onOpenNote, onChanged }: {
  readonly initiative: ExtensionInitiative
  readonly data: ProjectData
  readonly chatId: string | null
  readonly picking: boolean
  readonly projectId: string
  readonly onOpenNote: (noteId: string) => void
  readonly onChanged: () => Promise<void>
}): ReactElement {
  const [adding, setAdding] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const linked = linkedChats(data.chats, data.links, initiative.id)
  const workspace = chatId === null ? null : workspaceOf(data.chats, chatId)
  const isLinkedHere = workspace !== null && data.links.get(workspace) === initiative.id
  const working = linked.filter((chat) => chat.isWorking === true).length

  async function toggleLink(): Promise<void> {
    if (workspace === null) return
    setLinkError(null)
    try {
      if (isLinkedHere) await unlinkWorkspace(odyn, projectId, workspace)
      else await linkWorkspace(odyn, projectId, workspace, initiative)
      await onChanged()
      if (!isLinkedHere && picking) odyn.composer.close()
    } catch (error) {
      console.error('[initiatives] linking failed', error)
      setLinkError(errorText(error))
    }
  }

  async function addDocument(title: string): Promise<void> {
    const reply = await odyn.notes.run('CreateNote', { projectId }, { title, markdown: `# ${title}\n`, initiativeId: initiative.id })
    if (reply.isError) throw new Error(reply.text)
    setAdding(false)
    await onChanged()
    const id = createdId(reply.text)
    if (id !== null) onOpenNote(id)
  }

  const groups = [
    ...initiative.groups.map((group) => ({ key: group.id, name: group.name, documents: initiative.documents.filter((doc) => doc.groupId === group.id) })),
    { key: 'none', name: initiative.groups.length > 0 ? 'Other' : 'Documents', documents: initiative.documents.filter((doc) => doc.groupId === null) },
  ].filter((group) => group.documents.length > 0)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-balance">
            <Dot initiativeId={initiative.id} />
            {initiative.title}
          </h1>
          {initiative.description !== null && <p className="text-sm text-muted-foreground text-pretty">{initiative.description}</p>}
          {initiative.status !== 'active' && <p className="text-xs text-muted-foreground capitalize">{initiative.status}</p>}
        </div>
        {workspace !== null && (
          <Button variant={isLinkedHere ? 'outline' : 'default'} size="sm" onClick={() => void toggleLink()}>
            <IconLinkOutline18 />
            {isLinkedHere ? 'Unlink this chat' : 'Link this chat'}
          </Button>
        )}
      </header>
      {linkError !== null && <p role="alert" className="text-sm text-destructive">{linkError}</p>}

      <section className="flex flex-col gap-2" aria-labelledby="documents-heading">
        <div className="flex items-center justify-between">
          <h2 id="documents-heading" className="text-sm font-medium">Documents</h2>
          {!adding && (
            <Button variant="ghost" size="xs" onClick={() => setAdding(true)}>
              <IconPlusOutline18 />
              New document
            </Button>
          )}
        </div>
        {adding && <TitleForm label="Document title" onSubmit={addDocument} onCancel={() => setAdding(false)} />}
        {groups.length === 0 && !adding && <p className="text-sm text-muted-foreground">No documents yet. Add one to write down the plan.</p>}
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-1">
            {groups.length > 1 && <h3 className="text-xs text-muted-foreground">{group.name}</h3>}
            {group.documents.map((doc) => (
              <button
                key={doc.id}
                type="button"
                onClick={() => onOpenNote(doc.id)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <IconFileContentOutline18 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate" title={doc.title}>{doc.title}</span>
                {doc.updatedSinceSeen && <span className="text-xs whitespace-nowrap text-info">Updated</span>}
              </button>
            ))}
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="chats-heading">
        <h2 id="chats-heading" className="text-sm font-medium">
          Linked chats <span className="font-normal text-muted-foreground tabular-nums">{linked.length}{working > 0 ? ` · ${working} working` : ''}</span>
        </h2>
        {linked.length === 0
          ? <p className="text-sm text-muted-foreground">No chats linked yet. Use “Attach initiative” in a chat’s + menu to link one.</p>
          : linked.map((chat) => (
            <div key={chat.id} className="flex items-center gap-2 px-2 py-1 text-sm">
              <span className="min-w-0 flex-1 truncate" title={chat.title}>{chat.title}</span>
              {chat.isWorking === true && <span role="status" className="text-xs whitespace-nowrap text-success">● Working</span>}
            </div>
          ))}
      </section>
    </div>
  )
}

function App(): ReactElement {
  const [context, setContext] = useState<SurfaceContext | null>(null)
  const [projects, setProjects] = useState<readonly ProjectSummary[] | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [data, setData] = useState<ProjectData | null>(null)
  const [initiative, setInitiative] = useState<ExtensionInitiative | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState<'initiative' | 'note' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => odyn.onContext(setContext), [])
  useEffect(() => {
    if (context !== null) document.documentElement.classList.toggle('dark', context.theme === 'dark')
  }, [context])

  const chatId = context?.chatId ?? null
  const item = context?.item ?? null
  const picking = item === PICK_ITEM && chatId !== null

  // Each opening starts from what it was opened for.
  useEffect(() => {
    if (context === null) return
    let cancelled = false
    void (async () => {
      try {
        const all = await odyn.projects.list()
        const wanted = initiativeIdFromItem(item)
        const start = await startingProject(odyn, all, chatId, wanted)
        if (cancelled) return
        setProjects(all)
        setProjectId(start)
        setSelection(wanted === null ? null : { kind: 'initiative', id: wanted })
      } catch (caught) {
        console.error('[initiatives] could not load projects', caught)
        if (!cancelled) setError(errorText(caught))
      }
    })()
    return () => { cancelled = true }
  }, [context, chatId, item])

  const refresh = useCallback(async () => {
    if (projectId === null) return
    try {
      setData(await loadProject(odyn, projectId))
      setError(null)
    } catch (caught) {
      console.error('[initiatives] could not load the project', caught)
      setError(errorText(caught))
    }
  }, [projectId])

  useEffect(() => { setData(null); void refresh() }, [refresh])

  const openInitiativeId = selection?.kind === 'initiative' ? selection.id : selection?.kind === 'note' ? selection.initiativeId : null
  useEffect(() => {
    if (projectId === null || openInitiativeId === null) { setInitiative(null); return }
    let cancelled = false
    odyn.notes.initiative(projectId, openInitiativeId)
      .then((found) => { if (!cancelled) setInitiative(found) })
      .catch((caught: unknown) => {
        console.error('[initiatives] could not open the initiative', caught)
        if (!cancelled) setError(errorText(caught))
      })
    return () => { cancelled = true }
  }, [projectId, openInitiativeId, data])

  const initiatives = useMemo(
    () => (data?.list.initiatives ?? []).filter((entry) => matches(query, entry.title, entry.description)),
    [data, query],
  )
  const notes = useMemo(() => (data?.list.notes ?? []).filter((entry) => matches(query, entry.title, entry.description)), [data, query])

  async function create(title: string): Promise<void> {
    if (projectId === null) return
    const reply = creating === 'initiative'
      ? await odyn.notes.run('CreateInitiative', { projectId }, { title })
      : await odyn.notes.run('CreateNote', { projectId }, { title, markdown: `# ${title}\n` })
    if (reply.isError) { setError(reply.text); return }
    const id = createdId(reply.text)
    const kind = creating
    setCreating(null)
    await refresh()
    if (id !== null) setSelection(kind === 'initiative' ? { kind: 'initiative', id } : { kind: 'note', id, initiativeId: null })
  }

  if (projects === null || (projectId !== null && data === null && error === null)) return <PageSkeleton />
  if (projectId === null) {
    return <p className="p-6 text-sm text-muted-foreground">Add a project to Odyn first, then come back to group its chats into initiatives.</p>
  }

  const isEmpty = (data?.list.initiatives.length ?? 0) === 0 && (data?.list.notes.length ?? 0) === 0

  return (
    <div className="flex h-full text-foreground">
      <nav className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-e p-3" aria-label="Initiatives and notes">
        {projects.length > 1 && (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Project
            <select
              value={projectId}
              onChange={(event) => { setSelection(null); setProjectId(event.target.value) }}
              className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
            >
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
        )}
        <div className="relative">
          <label className="sr-only" htmlFor="search">Search initiatives and notes</label>
          <IconMagnifierOutline18 aria-hidden="true" className="pointer-events-none absolute start-2 top-2 size-4 text-muted-foreground" />
          <input
            id="search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search…"
            className="h-8 w-full rounded-md border bg-background ps-8 pe-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
        </div>
        {creating !== null
          ? <TitleForm label={creating === 'initiative' ? 'Initiative title' : 'Note title'} onSubmit={create} onCancel={() => setCreating(null)} />
          : (
            <div className="flex gap-2">
              <Button size="sm" className="flex-1" onClick={() => setCreating('initiative')}><IconPlusOutline18 />Initiative</Button>
              <Button size="sm" variant="outline" className="flex-1" onClick={() => setCreating('note')}><IconPlusOutline18 />Note</Button>
            </div>
          )}

        <div className="flex flex-col gap-0.5">
          <h2 className="px-2 text-xs font-medium text-muted-foreground">Initiatives</h2>
          {initiatives.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={openInitiativeId === entry.id ? 'true' : undefined}
              onClick={() => setSelection({ kind: 'initiative', id: entry.id })}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                openInitiativeId === entry.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                entry.status !== 'active' && 'text-muted-foreground',
              )}
            >
              <Dot initiativeId={entry.id} />
              <span className="min-w-0 flex-1 truncate" title={entry.title}>{entry.title}</span>
              {entry.status !== 'active' && <span className="text-xs whitespace-nowrap capitalize">{entry.status}</span>}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-0.5">
          <h2 className="px-2 text-xs font-medium text-muted-foreground">Notes</h2>
          {notes.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={selection?.kind === 'note' && selection.id === entry.id ? 'true' : undefined}
              onClick={() => setSelection({ kind: 'note', id: entry.id, initiativeId: null })}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                selection?.kind === 'note' && selection.id === entry.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
              )}
            >
              <IconFileContentOutline18 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={entry.title}>{entry.title}</span>
              {entry.visibility === 'team' && <span className="text-xs text-muted-foreground">Team</span>}
            </button>
          ))}
        </div>
        {data?.list.degraded != null && <p role="status" className="px-2 text-xs text-warning">{data.list.degraded}</p>}
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {error !== null && <p role="alert" className="px-6 pt-4 text-sm text-destructive">{error}</p>}
        {picking && selection === null && (
          <p className="px-6 pt-6 text-sm text-muted-foreground">Pick an initiative on the left, then choose “Link this chat”.</p>
        )}
        {selection === null && !picking && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="max-w-sm text-sm text-muted-foreground text-pretty">
              {isEmpty ? 'Group related chats and documents under one goal.' : 'Open an initiative or a note from the list.'}
            </p>
            {isEmpty && <Button onClick={() => setCreating('initiative')}><IconPlusOutline18 />Create initiative</Button>}
          </div>
        )}
        {selection?.kind === 'initiative' && initiative !== null && data !== null && (
          <InitiativeView
            initiative={initiative}
            data={data}
            chatId={chatId}
            picking={picking}
            projectId={projectId}
            onOpenNote={(noteId) => setSelection({ kind: 'note', id: noteId, initiativeId: initiative.id })}
            onChanged={refresh}
          />
        )}
        {selection?.kind === 'note' && (
          <NoteEditor
            key={selection.id}
            odyn={odyn}
            projectId={projectId}
            noteId={selection.id}
            backLabel={initiative?.title ?? null}
            onBack={selection.initiativeId === null ? null : () => setSelection({ kind: 'initiative', id: selection.initiativeId ?? '' })}
            onChanged={refresh}
            onDeleted={() => {
              setSelection(selection.initiativeId === null ? null : { kind: 'initiative', id: selection.initiativeId })
              void refresh()
            }}
          />
        )}
      </main>
    </div>
  )
}

const root = document.getElementById('root')
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

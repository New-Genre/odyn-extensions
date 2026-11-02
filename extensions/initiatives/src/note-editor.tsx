// One document or loose note, edited as markdown. It saves by itself a moment
// after you stop typing. Before each save it checks nobody else changed the
// document meanwhile; if they did, it stops and asks you to reload rather than
// overwrite their work.
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ExtensionNote, OdynSurfaceApi } from '@odyn-app/api'
import { Button, Skeleton } from '@odyn-app/api/ui'
import { IconChevronLeftOutline18, IconTrashOutline18 } from 'nucleo-ui-essential-outline-18'
import { saveDecision } from './save-rules'

const SAVE_DELAY_MS = 800

type SaveState = 'saved' | 'waiting' | 'saving' | 'conflict' | 'failed'

const SAVE_LABEL: Readonly<Record<SaveState, string>> = {
  saved: 'Saved',
  waiting: 'Editing…',
  saving: 'Saving…',
  conflict: 'Changed somewhere else',
  failed: 'Not saved',
}

export function NoteEditor({ odyn, projectId, noteId, backLabel, onBack, onChanged, onDeleted }: {
  readonly odyn: OdynSurfaceApi
  readonly projectId: string
  readonly noteId: string
  readonly backLabel: string | null
  readonly onBack: (() => void) | null
  readonly onChanged: () => Promise<void>
  readonly onDeleted: () => void
}): ReactElement {
  const [note, setNote] = useState<ExtensionNote | null>(null)
  const [missing, setMissing] = useState(false)
  const [markdown, setMarkdown] = useState('')
  const [title, setTitle] = useState('')
  const [state, setState] = useState<SaveState>('saved')
  const [message, setMessage] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  /** The copy the edits started from, to spot someone else's change. */
  const base = useRef<ExtensionNote | null>(null)
  /** Set once a clash is found, so no more saves start until the person reloads. */
  const clashed = useRef(false)
  /** The newest text waiting to be saved, and whether a save is running now. */
  const pending = useRef<string | null>(null)
  const running = useRef(false)
  /** What is in the box right now, for the save on the way out. */
  const latest = useRef('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const loaded = await odyn.notes.read(projectId, noteId)
      if (loaded === null) { setMissing(true); return }
      base.current = loaded
      clashed.current = false
      setNote(loaded)
      setMarkdown(loaded.markdown)
      setTitle(loaded.title)
      setState('saved')
      setMessage(null)
    } catch (error) {
      console.error('[initiatives] could not open the document', error)
      setMessage(error instanceof Error ? error.message : String(error))
      setState('failed')
    }
  }, [odyn, projectId, noteId])

  const saveOnce = useCallback(async (text: string): Promise<void> => {
    const started = base.current
    if (started === null) return
    setState('saving')
    try {
      const fresh = await odyn.notes.read(projectId, noteId)
      const decision = saveDecision(started, fresh, text)
      if (decision === 'conflict') {
        clashed.current = true
        setState('conflict')
        return
      }
      if (decision === 'skip') { setState('saved'); return }
      const reply = await odyn.notes.run('EditNote', { projectId }, { noteId, markdown: text })
      if (reply.isError) throw new Error(reply.text)
      base.current = (await odyn.notes.read(projectId, noteId)) ?? { ...started, markdown: text }
      setState('saved')
      setMessage(null)
    } catch (error) {
      console.error('[initiatives] could not save the document', error)
      setMessage(error instanceof Error ? error.message : String(error))
      setState('failed')
    }
  }, [odyn, projectId, noteId])

  /**
   * Saves run one at a time. Text typed while a save is running waits and goes
   * next, starting from the copy that save left behind, so two saves never
   * race and report a clash with each other.
   */
  const save = useCallback(async (text: string): Promise<void> => {
    pending.current = text
    if (running.current) return
    running.current = true
    try {
      while (pending.current !== null && !clashed.current) {
        const next = pending.current
        pending.current = null
        await saveOnce(next)
      }
    } finally {
      running.current = false
    }
  }, [saveOnce])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    latest.current = markdown
    if (base.current === null || markdown === base.current.markdown || clashed.current) return
    setState('waiting')
    const timer = setTimeout(() => void save(markdown), SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [markdown, save])

  // Leaving the document (another one opened, back, or the page closed) saves
  // whatever was still waiting instead of dropping it.
  useEffect(() => () => {
    const text = latest.current
    if (base.current === null || clashed.current || text === base.current.markdown) return
    void save(text)
  }, [save])

  async function rename(): Promise<void> {
    const next = title.trim()
    if (note === null || next === '' || next === note.title) { setTitle(note?.title ?? title); return }
    const reply = await odyn.notes.run('RenameNote', { projectId }, { noteId, title: next })
    if (reply.isError) { setMessage(reply.text); setTitle(note.title); return }
    setNote({ ...note, title: next })
    await onChanged()
  }

  async function remove(): Promise<void> {
    const reply = await odyn.notes.run('DeleteNote', { projectId }, { noteId })
    if (reply.isError) { setMessage(reply.text); setConfirmingDelete(false); return }
    onDeleted()
  }

  if (missing) return <p className="p-6 text-sm text-muted-foreground">This document no longer exists. Pick another from the list.</p>
  if (note === null && state === 'failed') {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 p-6 text-sm">
        <p className="text-destructive">{message ?? 'This document could not be opened.'}</p>
        <Button size="sm" variant="outline" onClick={() => void load()}>Try again</Button>
      </div>
    )
  }
  if (note === null) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-6" aria-busy="true" aria-label="Loading document">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-3 p-6">
      <div className="flex min-h-6 items-center justify-between gap-2">
        {onBack !== null
          ? (
            <Button variant="ghost" size="xs" onClick={onBack}>
              <IconChevronLeftOutline18 />
              <span className="max-w-60 truncate">{backLabel ?? 'Initiative'}</span>
            </Button>
          )
          : <span />}
        <div className="flex items-center gap-2">
          <span role="status" className="text-xs whitespace-nowrap text-muted-foreground">{SAVE_LABEL[state]}</span>
          {note.visibility === 'team' && <span className="text-xs text-muted-foreground">Shared with team</span>}
          {confirmingDelete
            ? (
              <>
                <Button variant="ghost" size="xs" onClick={() => setConfirmingDelete(false)}>Cancel</Button>
                <Button variant="destructive" size="xs" onClick={() => void remove()}>Delete document</Button>
              </>
            )
            : (
              <Button variant="ghost" size="icon-xs" aria-label="Delete document" onClick={() => setConfirmingDelete(true)}>
                <IconTrashOutline18 />
              </Button>
            )}
        </div>
      </div>
      <label className="sr-only" htmlFor="note-title">Title</label>
      <input
        id="note-title"
        type="text"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => void rename()}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
        className="rounded-md bg-transparent px-1 text-lg font-semibold focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      {note.offline !== null && <p role="status" className="text-xs text-warning">{note.offline}</p>}
      {state === 'conflict' && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border bg-warning/10 px-3 py-2 text-sm">
          <span>Someone else changed this document. Reload to see their version; your unsaved text is not kept.</span>
          <Button size="xs" variant="outline" onClick={() => void load()}>Reload document</Button>
        </div>
      )}
      {message !== null && state !== 'conflict' && <p role="alert" className="text-sm text-destructive">{message}</p>}
      <label className="sr-only" htmlFor="note-body">Document text, in markdown</label>
      <textarea
        id="note-body"
        value={markdown}
        readOnly={state === 'conflict'}
        onChange={(event) => setMarkdown(event.target.value)}
        className="min-h-80 flex-1 resize-none rounded-md border bg-background p-3 font-mono text-sm leading-relaxed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
    </div>
  )
}

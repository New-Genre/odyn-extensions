// The Scratchpad page. Odyn shows it in a sealed box above the message box;
// everything it does goes through the building kit's `connectSurface()`.
import '@fontsource-variable/inter'
import './panel.css'
import { StrictMode, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { connectSurface, type SurfaceContext } from '@odyn-app/api'
import { ScratchpadEditor, type ScratchpadDraftState, type ScratchpadEditorHandle } from './editor'

/** Where the drawing is kept in the extension's per-chat store. */
const DRAWING_KEY = 'drawing'
const ATTACHMENT_MIME_TYPE = 'image/png'

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

// The drawing library fetches its fonts from the internet unless told
// otherwise, and this page has no internet. Point it at the copies that ship
// next to this page.
window.EXCALIDRAW_ASSET_PATH = new URL('./', window.location.href).href

const odyn = connectSurface()

/** A drawing loaded for one chat. `null` chat means "not saved anywhere". */
interface LoadedDrawing {
  readonly chatId: string | null
  readonly initialState: ScratchpadDraftState | null
}

/** Very large drawings open without their pasted pictures, so the page doesn't run out of memory. */
const MAX_SCENE_CHARS = 2_000_000

/** Reads a saved drawing, or `null` if it can't be read. */
function parseDrawing(raw: string): ScratchpadDraftState | null {
  try {
    const drawing = JSON.parse(raw) as ScratchpadDraftState
    if (raw.length <= MAX_SCENE_CHARS) return drawing
    console.warn(`[scratchpad] The saved drawing is ${raw.length} characters; opening it without its pictures.`)
    return { ...drawing, files: {} }
  } catch (error) {
    console.error('[scratchpad] The saved drawing could not be read:', error)
    return null
  }
}

function bytesFromBlob(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer))
}

function ScratchpadPage(): ReactElement | null {
  const [context, setContext] = useState<SurfaceContext | null>(null)
  const [loaded, setLoaded] = useState<LoadedDrawing | null>(null)
  const editorRef = useRef<ScratchpadEditorHandle>(null)

  useEffect(() => odyn.onContext(setContext), [])

  // Follow Odyn's light or dark look.
  useEffect(() => {
    if (!context) return
    document.documentElement.classList.toggle('dark', context.theme === 'dark')
  }, [context])

  // Load the saved drawing whenever the chat changes.
  const chatId = context?.chatId ?? null
  const hasContext = context !== null
  useEffect(() => {
    if (!hasContext) return
    let cancelled = false
    if (chatId === null) {
      setLoaded({ chatId: null, initialState: null })
      return
    }
    setLoaded(null)
    odyn.chatStorage
      .get(chatId, DRAWING_KEY)
      .then((raw) => {
        if (cancelled) return
        const initialState = raw && raw !== '{}' ? parseDrawing(raw) : null
        setLoaded({ chatId, initialState })
      })
      .catch((error: unknown) => {
        console.error('[scratchpad] Failed to load the drawing:', error)
        if (!cancelled) setLoaded({ chatId, initialState: null })
      })
    return () => {
      cancelled = true
    }
  }, [chatId, hasContext])

  // A screenshot handed over by Odyn lands on the canvas.
  useEffect(
    () =>
      odyn.onImage((image) => {
        const file = new File([image.bytes.slice()], image.name, { type: image.mimeType })
        editorRef.current?.insertImage(file).catch((error: unknown) => {
          console.error('[scratchpad] Failed to add the screenshot:', error)
        })
      }),
    [],
  )

  const loadedChatId = loaded?.chatId ?? null

  const saveDrawing = useCallback((ownerChatId: string | null, state: ScratchpadDraftState | null): void => {
    if (ownerChatId === null) return
    odyn.chatStorage.set(ownerChatId, DRAWING_KEY, state ? JSON.stringify(state) : null).catch((error: unknown) => {
      console.error('[scratchpad] Failed to save the drawing:', error)
    })
  }, [])

  const attachDrawing = useCallback(
    async (blob: Blob): Promise<void> => {
      await odyn.composer.attachImage({
        name: `scratchpad-${Date.now()}.png`,
        mimeType: ATTACHMENT_MIME_TYPE,
        bytes: await bytesFromBlob(blob),
      })
      // Attached, so the drawing has done its job: clear it for next time.
      saveDrawing(loadedChatId, null)
      odyn.composer.close()
    },
    [loadedChatId, saveDrawing],
  )

  const close = useCallback(() => odyn.composer.close(), [])

  const saveLoadedDrawing = useCallback(
    (state: ScratchpadDraftState | null): void => saveDrawing(loadedChatId, state),
    [loadedChatId, saveDrawing],
  )

  if (!loaded) return null

  return (
    <ScratchpadEditor
      // A fresh editor for each chat, so one chat's drawing never lands in another.
      key={loaded.chatId ?? 'no-chat'}
      ref={editorRef}
      initialState={loaded.initialState}
      isDark={context?.theme === 'dark'}
      onStateChange={saveLoadedDrawing}
      onComplete={attachDrawing}
      onCancel={close}
    />
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ScratchpadPage />
    </StrictMode>,
  )
} else {
  console.error('[scratchpad] The page is missing its root element.')
}

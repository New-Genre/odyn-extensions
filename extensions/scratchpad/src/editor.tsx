// The drawing area of the Scratchpad: Excalidraw (an open-source whiteboard)
// with a small toolbar of our own. The drawing is saved as you go, and
// "Attach" turns it into a picture on your message.
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import '@excalidraw/excalidraw/index.css'
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import {
  IconAspectRatioSquare2Outline18,
  IconCheckOutline18,
  IconPen3Outline18,
  IconPointerOutline18,
  IconTextTool2Outline18,
  IconTrashOutline18,
  IconXmarkOutline18,
} from 'nucleo-ui-essential-outline-18'
import { Button, cn, Orb } from '@odyn-app/api/ui'

// Loaded separately so the page shows its placeholder straight away.
const Excalidraw = lazy(() => import('@excalidraw/excalidraw').then((library) => ({ default: library.Excalidraw })))

/** Wait this long after the last change before saving… */
const AUTOSAVE_DEBOUNCE_MS = 400
/** …but never hold a save back longer than this while changes keep coming. */
const AUTOSAVE_MAX_WAIT_MS = 1_000

// Literal colours: the canvas is always drawn in its light theme, so what you
// pick is exactly what shows and what gets attached.
const STROKE_PRESETS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: '#000000', label: 'Black' },
  { value: '#ffffff', label: 'White' },
  { value: '#e03131', label: 'Red' },
  { value: '#f08c00', label: 'Orange' },
  { value: '#f7d000', label: 'Yellow' },
  { value: '#2f9e44', label: 'Green' },
  { value: '#1971c2', label: 'Blue' },
  { value: '#7048e8', label: 'Violet' },
]

/** The background the attached picture is flattened onto, so strokes stay visible. */
const EXPORT_BG_DARK = '#1e1e1e'
const EXPORT_BG_LIGHT = '#ffffff'
const EXPORT_PADDING_PX = 12

/** Pasted pictures are scaled to fit inside this box. */
const IMAGE_MAX_WIDTH_PX = 360
const IMAGE_MAX_HEIGHT_PX = 200
const FALLBACK_IMAGE_SIZE = { width: 320, height: 240 } as const
const IMAGE_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])

/** The bits of the canvas view worth keeping between visits. */
const PERSISTENT_APPSTATE_KEYS: ReadonlyArray<keyof AppState> = [
  'viewBackgroundColor',
  'currentItemStrokeColor',
  'currentItemStrokeWidth',
  'zoom',
  'scrollX',
  'scrollY',
]

type ScratchTool = 'selection' | 'rectangle' | 'freedraw' | 'text'

const TOOLS: ReadonlyArray<{
  readonly type: ScratchTool
  readonly label: string
  readonly shortcut: string
  readonly Icon: React.ComponentType<{ className?: string }>
}> = [
  { type: 'selection', label: 'Select', shortcut: '1', Icon: IconPointerOutline18 },
  { type: 'rectangle', label: 'Square', shortcut: '2', Icon: IconAspectRatioSquare2Outline18 },
  { type: 'freedraw', label: 'Pen', shortcut: '3', Icon: IconPen3Outline18 },
  { type: 'text', label: 'Text', shortcut: '4', Icon: IconTextTool2Outline18 },
]

/** A saved drawing. The same shape Odyn has always stored, so old drawings still open. */
export interface ScratchpadDraftState {
  readonly elements: readonly ExcalidrawElement[]
  readonly appState: Partial<AppState>
  readonly files: BinaryFiles
}

export interface ScratchpadEditorHandle {
  readonly insertImage: (file: File) => Promise<void>
}

interface ScratchpadEditorProps {
  readonly ref?: Ref<ScratchpadEditorHandle>
  readonly initialState: ScratchpadDraftState | null
  readonly isDark: boolean
  /** Called with the drawing as it changes, or `null` once it has been emptied. */
  readonly onStateChange: (state: ScratchpadDraftState | null) => void
  readonly onComplete: (picture: Blob) => Promise<void>
  readonly onCancel: () => void
}

function defaultStroke(isDark: boolean): string {
  return isDark ? '#ffffff' : '#000000'
}

function liveElements(elements: readonly ExcalidrawElement[]): readonly ExcalidrawElement[] {
  return elements.filter((element) => !element.isDeleted)
}

function pickPersistentAppState(appState: AppState): Partial<AppState> {
  return Object.fromEntries(
    PERSISTENT_APPSTATE_KEYS.filter((key) => key in appState).map((key) => [key, appState[key]]),
  ) as Partial<AppState>
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the picture'))
    reader.readAsDataURL(file)
  })
}

function readImageSize(dataURL: string): Promise<{ readonly width: number; readonly height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('Could not read the picture size'))
    image.src = dataURL
  })
}

function fitInside(size: { readonly width: number; readonly height: number }): { width: number; height: number } {
  const scale = Math.min(1, IMAGE_MAX_WIDTH_PX / Math.max(size.width, 1), IMAGE_MAX_HEIGHT_PX / Math.max(size.height, 1))
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) }
}

function isTyping(element: Element | null): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  )
}

function LoadingScratchpad(): ReactElement {
  return (
    <div className="flex size-full items-center justify-center text-muted-foreground">
      <Orb label="Loading the scratchpad…" />
    </div>
  )
}

/** Shows a short message instead of a blank box if the drawing library breaks. */
class DrawingErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error('[scratchpad] The drawing area stopped working:', error)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="flex size-full items-center justify-center text-sm text-muted-foreground">
        The scratchpad couldn’t load. Close it and try again.
      </div>
    )
  }
}

export function ScratchpadEditor({
  ref,
  initialState,
  isDark,
  onStateChange,
  onComplete,
  onCancel,
}: ScratchpadEditorProps): ReactElement {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const colorPickerRef = useRef<HTMLDivElement>(null)

  // The latest drawing, kept outside React state so saving never re-renders.
  const latestRef = useRef({
    elements: initialState?.elements ?? [],
    appState: initialState?.appState ?? {},
    files: initialState?.files ?? {},
  })
  // An editor that never held anything must not save an empty drawing over a real one.
  const everHadContentRef = useRef(liveElements(initialState?.elements ?? []).length > 0)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstUnsavedChangeAtRef = useRef<number | null>(null)
  // Set once the drawing is attached, so it isn't saved again as the pad closes.
  const finishedRef = useRef(false)
  const onStateChangeRef = useRef(onStateChange)
  useEffect(() => {
    onStateChangeRef.current = onStateChange
  }, [onStateChange])

  const savedStroke = initialState?.appState.currentItemStrokeColor
  const userPickedColorRef = useRef(typeof savedStroke === 'string')
  const [strokeColor, setStrokeColor] = useState(typeof savedStroke === 'string' ? savedStroke : defaultStroke(isDark))
  const [activeTool, setActiveTool] = useState<ScratchTool>('selection')
  const [hasStrokes, setHasStrokes] = useState(everHadContentRef.current)
  const [colorPickerOpen, setColorPickerOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const saveNow = useCallback((): void => {
    if (autoSaveTimerRef.current !== null) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = null
    firstUnsavedChangeAtRef.current = null
    if (finishedRef.current) return
    const { elements, appState, files } = latestRef.current
    const live = liveElements(elements)
    if (live.length === 0) {
      if (everHadContentRef.current) onStateChangeRef.current(null)
      return
    }
    everHadContentRef.current = true
    onStateChangeRef.current({ elements: live, appState, files })
  }, [])

  const scheduleSave = useCallback((): void => {
    const now = Date.now()
    firstUnsavedChangeAtRef.current ??= now
    if (autoSaveTimerRef.current !== null) clearTimeout(autoSaveTimerRef.current)
    if (now - firstUnsavedChangeAtRef.current >= AUTOSAVE_MAX_WAIT_MS) {
      saveNow()
      return
    }
    autoSaveTimerRef.current = setTimeout(saveNow, AUTOSAVE_DEBOUNCE_MS)
  }, [saveNow])

  // Closing the pad or switching chat saves whatever is waiting.
  useEffect(() => saveNow, [saveNow])

  // Follow light/dark for the default pen colour, unless one was picked.
  useEffect(() => {
    if (userPickedColorRef.current) return
    const color = defaultStroke(isDark)
    setStrokeColor(color)
    apiRef.current?.updateScene({ appState: { currentItemStrokeColor: color } })
  }, [isDark])

  // Excalidraw reads its starting drawing once, so it is worked out once.
  const [initialData] = useState<ExcalidrawInitialDataState>(() => ({
    elements: [...(initialState?.elements ?? [])],
    appState: { ...initialState?.appState, viewBackgroundColor: 'transparent', currentItemStrokeColor: strokeColor },
    files: initialState?.files,
    scrollToContent: false,
  }))

  const handleSceneChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles): void => {
      latestRef.current = { elements, appState: pickPersistentAppState(appState), files }
      setHasStrokes(liveElements(elements).length > 0)
      const tool = appState.activeTool.type
      if (TOOLS.some((entry) => entry.type === tool)) setActiveTool(tool as ScratchTool)
      scheduleSave()
    },
    [scheduleSave],
  )

  const selectTool = useCallback((tool: ScratchTool): void => {
    setActiveTool(tool)
    apiRef.current?.setActiveTool({ type: tool })
  }, [])

  const selectColor = useCallback((color: string): void => {
    userPickedColorRef.current = true
    setStrokeColor(color)
    setColorPickerOpen(false)
    apiRef.current?.updateScene({ appState: { currentItemStrokeColor: color } })
  }, [])

  const clear = useCallback((): void => {
    apiRef.current?.updateScene({ elements: [] })
    selectTool('selection')
  }, [selectTool])

  const insertImage = useCallback(async (file: File): Promise<void> => {
    const api = apiRef.current
    if (!api || !IMAGE_MIMES.has(file.type)) return
    const dataURL = await readAsDataURL(file)
    const { width, height } = fitInside(await readImageSize(dataURL).catch(() => FALLBACK_IMAGE_SIZE))
    const { convertToExcalidrawElements } = await import('@excalidraw/excalidraw')
    const fileId = `scratch-img-${crypto.randomUUID()}` as BinaryFileData['id']
    api.addFiles([
      {
        id: fileId,
        mimeType: file.type as BinaryFileData['mimeType'],
        dataURL: dataURL as BinaryFileData['dataURL'],
        created: Date.now(),
      },
    ])
    const view = api.getAppState()
    const [picture] = convertToExcalidrawElements([
      {
        type: 'image',
        fileId,
        x: view.width / 2 - view.scrollX - width / 2,
        y: view.height / 2 - view.scrollY - height / 2,
        width,
        height,
      },
    ])
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), picture] })
    selectTool('selection')
  }, [selectTool])

  useImperativeHandle(ref, () => ({ insertImage }), [insertImage])

  const handleApiReady = useCallback((api: ExcalidrawImperativeAPI): void => {
    apiRef.current = api
  }, [])

  const attachDrawing = useCallback(async (): Promise<void> => {
    if (!hasStrokes || exporting) return
    const live = liveElements(latestRef.current.elements)
    if (live.length === 0) {
      onCancel()
      return
    }
    setExporting(true)
    try {
      const { exportToBlob } = await import('@excalidraw/excalidraw')
      const picture = await exportToBlob({
        elements: live,
        appState: {
          ...latestRef.current.appState,
          exportBackground: true,
          exportWithDarkMode: false,
          viewBackgroundColor: isDark ? EXPORT_BG_DARK : EXPORT_BG_LIGHT,
        },
        files: latestRef.current.files,
        mimeType: 'image/png',
        exportPadding: EXPORT_PADDING_PX,
      })
      // Stop saving first, so the attached drawing isn't kept as a draft too.
      finishedRef.current = true
      if (autoSaveTimerRef.current !== null) clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
      await onComplete(picture)
    } catch (error) {
      console.error('[scratchpad] Could not attach the drawing:', error)
      finishedRef.current = false
      setExporting(false)
    }
  }, [hasStrokes, exporting, isDark, onCancel, onComplete])

  // Keyboard: Escape closes (or shuts the colour list first), Cmd/Ctrl+Enter
  // attaches, and 1–4 pick a tool. Kept in refs so the listener is added once.
  const keyActionsRef = useRef({ attachDrawing, onCancel, selectTool, colorPickerOpen })
  useEffect(() => {
    keyActionsRef.current = { attachDrawing, onCancel, selectTool, colorPickerOpen }
  }, [attachDrawing, onCancel, selectTool, colorPickerOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const actions = keyActionsRef.current
      if (event.key === 'Escape') {
        event.preventDefault()
        if (actions.colorPickerOpen) {
          event.stopPropagation()
          setColorPickerOpen(false)
          return
        }
        actions.onCancel()
        return
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void actions.attachDrawing()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(document.activeElement)) return
      const tool = TOOLS.find((entry) => entry.shortcut === event.key)
      if (!tool) return
      event.preventDefault()
      event.stopPropagation()
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      actions.selectTool(tool.type)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // A click anywhere else closes the colour list.
  useEffect(() => {
    if (!colorPickerOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && colorPickerRef.current?.contains(event.target)) return
      setColorPickerOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [colorPickerOpen])

  const floatingBar = 'flex items-center gap-0.5 rounded-lg bg-background/80 p-0.5 ring-1 ring-black/5 backdrop-blur dark:ring-white/10'

  return (
    <div className="scratchpad-surface relative size-full">
      <DrawingErrorBoundary>
        <Suspense fallback={<LoadingScratchpad />}>
          <Excalidraw
            initialData={initialData}
            onChange={handleSceneChange}
            // Always the light canvas: colours show and attach exactly as picked.
            theme="light"
            excalidrawAPI={handleApiReady}
            zenModeEnabled
            UIOptions={{
              canvasActions: {
                changeViewBackgroundColor: false,
                clearCanvas: false,
                export: false,
                loadScene: false,
                saveToActiveFile: false,
                toggleTheme: false,
                saveAsImage: false,
              },
              tools: { image: true },
            }}
          />
        </Suspense>
      </DrawingErrorBoundary>

      <div className="pointer-events-none absolute bottom-2 left-2 z-10 flex items-center">
        <div className={cn('pointer-events-auto', floatingBar)} role="toolbar" aria-label="Drawing tools">
          {TOOLS.map(({ type, label, shortcut, Icon }) => (
            <Button
              key={type}
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              aria-pressed={activeTool === type}
              title={`${label} (${shortcut})`}
              onClick={() => selectTool(type)}
              className={cn('size-7', activeTool === type ? 'bg-accent text-foreground' : 'text-muted-foreground')}
            >
              <Icon className="size-4" />
            </Button>
          ))}
          <div ref={colorPickerRef} className="relative">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Stroke colour"
              aria-haspopup="menu"
              aria-expanded={colorPickerOpen}
              title="Stroke colour"
              onClick={() => setColorPickerOpen((open) => !open)}
              className="size-7"
            >
              <span
                className="size-4 rounded-full ring-1 ring-black/20 dark:ring-white/30"
                style={{ backgroundColor: strokeColor }}
              />
            </Button>
            {colorPickerOpen && (
              <div
                role="menu"
                aria-label="Stroke colours"
                className={cn('absolute bottom-full left-0 mb-2 grid grid-cols-4 gap-1 p-1.5', floatingBar)}
              >
                {STROKE_PRESETS.map(({ value, label }) => {
                  const isActive = strokeColor.toLowerCase() === value.toLowerCase()
                  return (
                    <button
                      key={value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      aria-label={label}
                      title={label}
                      onClick={() => selectColor(value)}
                      className={cn(
                        'size-6 rounded-full ring-1 ring-black/20 transition-[scale] duration-200 ease-out active:scale-95 dark:ring-white/30',
                        isActive && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
                      )}
                      style={{ backgroundColor: value }}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={cn('pointer-events-auto absolute right-2 top-2 z-10', floatingBar)}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear drawing"
          title="Clear drawing"
          disabled={!hasStrokes || exporting}
          onClick={clear}
          className="size-7 text-muted-foreground"
        >
          <IconTrashOutline18 className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close scratchpad"
          title="Close scratchpad (Esc)"
          onClick={onCancel}
          className="size-7 text-muted-foreground"
        >
          <IconXmarkOutline18 className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Attach drawing"
          title="Attach drawing (⌘↵)"
          disabled={!hasStrokes || exporting}
          onClick={() => void attachDrawing()}
          className="size-7 text-foreground"
        >
          <IconCheckOutline18 className="size-4" />
        </Button>
      </div>
    </div>
  )
}

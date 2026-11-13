import './styles.css'
import { connectSurface } from '@odyn-app/api'
import { Button, Skeleton, cn } from '@odyn-app/api/ui'
import { StrictMode, useEffect, useReducer, useRef, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MathUtils, type Object3D } from 'three'
import {
  COMPANION_EXTENSIONS,
  SHAPE_KINDS,
  SUPPORTED_EXTENSIONS,
  createEditor,
  isCompanionFile,
  isSupportedFile,
  type Editor,
  type ShapeKind,
  type TransformMode,
} from './editor'

const MODEL_TYPES = SUPPORTED_EXTENSIONS.map((extension) => `.${extension}`).join(', ')
// Companion files (.bin, textures) can be picked too, so a .gltf that points to them opens.
const ACCEPT = [...SUPPORTED_EXTENSIONS, ...COMPANION_EXTENSIONS].map((extension) => `.${extension}`).join(',')
const AXES = ['x', 'y', 'z'] as const
const NUMBER_STEP = 0.1
const EXPORT_FILE_NAME = 'scene.glb'

const MODES: readonly { mode: TransformMode; label: string; key: string }[] = [
  { mode: 'translate', label: 'Move', key: 'G' },
  { mode: 'rotate', label: 'Rotate', key: 'R' },
  { mode: 'scale', label: 'Scale', key: 'S' },
]

// Odyn tells the page whether it's in light or dark mode.
connectSurface().onContext(({ theme }) => {
  document.documentElement.classList.toggle('dark', theme === 'dark')
})

function App(): ReactElement {
  const viewportRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  // Bumped whenever the 3D scene changes, so the panels redraw.
  const [version, refresh] = useReducer((count: number) => count + 1, 0)
  // How many imports are still running. Counting (rather than on/off) stops the first one to finish
  // from clearing the spinner — and re-enabling export — while another is still loading.
  const [pendingImports, setPendingImports] = useState(0)
  const loading = pendingImports > 0
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!viewportRef.current) return
    const created = createEditor(viewportRef.current, refresh)
    setEditor(created)
    return () => created.dispose()
  }, [])

  // Blender-style keys: G/R/S, X or Delete, Shift+D, F to focus, Esc to deselect.
  useEffect(() => {
    if (!editor) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key.toLowerCase()
      const actions: Record<string, () => void> = {
        g: () => editor.setMode('translate'),
        r: () => editor.setMode('rotate'),
        s: () => editor.setMode('scale'),
        x: editor.deleteSelected,
        delete: editor.deleteSelected,
        backspace: editor.deleteSelected,
        f: editor.focusSelected,
        escape: () => editor.select(null),
      }
      const action = event.shiftKey && key === 'd' ? editor.duplicateSelected : actions[key]
      if (!action) return
      event.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editor])

  const openFiles = async (files: FileList | null): Promise<void> => {
    if (!editor || !files) return
    setError(null)
    const supported = [...files].filter(isSupportedFile)
    const companions = [...files].filter(isCompanionFile)
    if (supported.length === 0) {
      setError(`That file type isn't supported. Try ${MODEL_TYPES}.`)
      return
    }
    setPendingImports((count) => count + 1)
    try {
      for (const file of supported) await editor.loadFile(file, companions)
    } catch (loadError) {
      console.error('Could not open model', loadError)
      setError(
        `Couldn't open that model. ${loadError instanceof Error ? loadError.message : ''} ` +
          '(If a .gltf uses separate .bin or texture files, select them together with it, or save it as a single .glb.)',
      )
    } finally {
      setPendingImports((count) => count - 1)
    }
  }

  const exportScene = async (): Promise<void> => {
    if (!editor) return
    try {
      const url = URL.createObjectURL(await editor.exportGlb())
      const link = Object.assign(document.createElement('a'), { href: url, download: EXPORT_FILE_NAME })
      link.click()
      URL.revokeObjectURL(url)
    } catch (exportError) {
      console.error('Could not export scene', exportError)
      setError("Couldn't export the scene.")
    }
  }

  const selected = editor?.selected() ?? null
  const objects = editor?.objects() ?? []
  const isEmpty = editor !== null && objects.length === 0

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-4 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={!editor}>
            Import model
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(event) => {
              void openFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <label className="sr-only" htmlFor="add-shape">
            Add shape
          </label>
          <select
            id="add-shape"
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value=""
            disabled={!editor}
            onChange={(event) => editor?.addShape(event.target.value as ShapeKind)}
          >
            <option value="" disabled>
              Add shape…
            </option>
            {SHAPE_KINDS.map((kind) => (
              <option key={kind} value={kind} className="capitalize">
                {kind}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="Tool">
          {MODES.map(({ mode, label, key }) => (
            <Button
              key={mode}
              size="sm"
              variant={editor?.mode() === mode ? 'secondary' : 'ghost'}
              aria-pressed={editor?.mode() === mode}
              onClick={() => editor?.setMode(mode)}
              title={`${label} (${key})`}
            >
              {label}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={!selected} onClick={editor?.duplicateSelected} title="Duplicate (Shift+D)">
            Duplicate
          </Button>
          <Button size="sm" variant="ghost" disabled={!selected} onClick={editor?.deleteSelected} title="Delete (X)">
            Delete
          </Button>
          <Button size="sm" variant="ghost" disabled={!editor} onClick={editor?.focusSelected} title="Focus (F)">
            Focus
          </Button>
        </div>

        <Button size="sm" variant="outline" className="ms-auto" disabled={isEmpty || loading} onClick={() => void exportScene()}>
          Export .glb
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-e p-2" aria-label="Scene">
          <h2 className="px-1 pb-1 text-xs font-medium text-muted-foreground">Scene</h2>
          {objects.length === 0 && <p className="px-1 text-xs text-pretty text-muted-foreground">Nothing here yet.</p>}
          {objects.map((object) => (
            <OutlinerRow key={object.uuid} object={object} editor={editor} isSelected={object === selected} />
          ))}
        </aside>

        <main
          className={cn('relative min-w-0 flex-1', dragging && 'outline-2 -outline-offset-2 outline-primary')}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            void openFiles(event.dataTransfer.files)
          }}
        >
          <div ref={viewportRef} className="absolute inset-0" />
          {isEmpty && !loading && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="flex max-w-xs flex-col items-center gap-2 rounded-lg bg-background/80 p-4 text-center backdrop-blur">
                <p className="text-sm font-medium text-balance">Drop a 3D model here to start editing</p>
                <p className="text-xs text-pretty text-muted-foreground">
                  {MODEL_TYPES} — or add a shape from the
                  toolbar.
                </p>
              </div>
            </div>
          )}
          {(loading || !editor) && <Skeleton className="absolute inset-0 rounded-none" aria-label="Loading" />}
          {error && (
            <p role="alert" className="absolute inset-x-3 bottom-3 rounded-md bg-destructive px-3 py-2 text-sm text-white">
              {error}
            </p>
          )}
          <p className="pointer-events-none absolute start-3 top-3 text-xs text-muted-foreground">
            Drag to orbit · right-drag to pan · scroll to zoom · click to select
          </p>
        </main>

        <aside className="w-60 shrink-0 overflow-y-auto border-s p-3" aria-label="Properties">
          {selected && editor ? (
            <Properties key={selected.uuid} object={selected} editor={editor} version={version} />
          ) : (
            <p className="text-xs text-pretty text-muted-foreground">Select something to see its properties.</p>
          )}
        </aside>
      </div>
    </div>
  )
}

function OutlinerRow({
  object,
  editor,
  isSelected,
}: {
  object: Object3D
  editor: Editor | null
  isSelected: boolean
}): ReactElement {
  return (
    <div className={cn('flex items-center rounded-md', isSelected && 'bg-accent text-accent-foreground')}>
      <button
        type="button"
        className={cn('min-w-0 flex-1 truncate px-2 py-1.5 text-start text-sm', !object.visible && 'opacity-50')}
        title={object.name}
        onClick={() => editor?.select(object)}
      >
        {object.name || 'Untitled'}
      </button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={object.visible ? `Hide ${object.name}` : `Show ${object.name}`}
        aria-pressed={!object.visible}
        onClick={() => {
          object.visible = !object.visible
          editor?.notify()
        }}
      >
        {object.visible ? '◉' : '○'}
      </Button>
    </div>
  )
}

function Properties({ object, editor, version }: { object: Object3D; editor: Editor; version: number }): ReactElement {
  // Inputs are re-filled from the scene whenever it changes (e.g. after dragging the gizmo),
  // but typing in them writes straight to the object without re-filling, so focus isn't lost.
  const rows = [
    { label: 'Position', read: (axis: Axis) => object.position[axis], write: (axis: Axis, value: number) => (object.position[axis] = value) },
    {
      label: 'Rotation °',
      read: (axis: Axis) => MathUtils.radToDeg(object.rotation[axis]),
      write: (axis: Axis, value: number) => (object.rotation[axis] = MathUtils.degToRad(value)),
    },
    { label: 'Scale', read: (axis: Axis) => object.scale[axis], write: (axis: Axis, value: number) => (object.scale[axis] = value) },
  ]

  return (
    <div className="flex flex-col gap-4 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Name</span>
        <input
          type="text"
          className="h-8 rounded-md border bg-background px-2"
          defaultValue={object.name}
          onChange={(event) => {
            object.name = event.target.value
            editor.notify()
          }}
        />
      </label>

      {rows.map(({ label, read, write }) => (
        <fieldset key={label} className="flex flex-col gap-1">
          <legend className="pb-1 text-xs font-medium text-muted-foreground">{label}</legend>
          <div className="grid grid-cols-3 gap-1">
            {AXES.map((axis) => (
              <label key={`${axis}-${version}`} className="flex items-center gap-1 rounded-md border px-1.5">
                <span className="text-xs text-muted-foreground uppercase">{axis}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step={NUMBER_STEP}
                  className="h-7 w-full min-w-0 bg-transparent tabular-nums outline-none"
                  defaultValue={Number(read(axis).toFixed(3))}
                  onChange={(event) => {
                    if (Number.isFinite(event.target.valueAsNumber)) write(axis, event.target.valueAsNumber)
                  }}
                />
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Colour</span>
        <input
          key={version}
          type="color"
          className="h-8 w-14 rounded-md border bg-background"
          defaultValue={editor.getColor(object)}
          onChange={(event) => editor.setColor(object, event.target.value)}
        />
      </label>

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Show wireframe</span>
        <input
          type="checkbox"
          checked={editor.getWireframe(object)}
          onChange={(event) => editor.setWireframe(object, event.target.checked)}
        />
      </label>
    </div>
  )
}

type Axis = (typeof AXES)[number]

const rootElement = document.getElementById('root')
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

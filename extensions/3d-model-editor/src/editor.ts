// The 3D side of the editor: the scene, camera, mouse controls and file loading.
// The React page (main.tsx) only calls the functions returned here.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'

export type TransformMode = 'translate' | 'rotate' | 'scale'
export type ShapeKind = 'cube' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'plane'

export const SUPPORTED_EXTENSIONS = ['glb', 'gltf', 'obj', 'stl', 'fbx'] as const
/** Files a .gltf can point to (its data and textures). Picked alongside the .gltf, they're looked up by name. */
export const COMPANION_EXTENSIONS = ['bin', 'png', 'jpg', 'jpeg', 'webp', 'ktx2'] as const
/** Sharp screens draw up to 3 dots per pixel; past 2 the extra detail isn't worth the graphics work. */
const MAX_PIXEL_RATIO = 2
export const SHAPE_KINDS: readonly ShapeKind[] = ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'plane']

/** A mouse press that moves less than this counts as a click (select), not a drag (orbit). */
const CLICK_TOLERANCE_PX = 4
const DEFAULT_COLOR = 0xb4b4b4
const SELECTION_COLOR = 0xff9a1f
const GRID_SIZE = 20
const FOCUS_DISTANCE_FACTOR = 1.6
const DUPLICATE_OFFSET = 0.5

const SHAPE_GEOMETRY: Record<ShapeKind, () => THREE.BufferGeometry> = {
  cube: () => new THREE.BoxGeometry(1, 1, 1),
  sphere: () => new THREE.SphereGeometry(0.5, 32, 16),
  cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 32),
  cone: () => new THREE.ConeGeometry(0.5, 1, 32),
  torus: () => new THREE.TorusGeometry(0.5, 0.18, 16, 48),
  plane: () => new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
}

export interface Editor {
  readonly objects: () => readonly THREE.Object3D[]
  readonly selected: () => THREE.Object3D | null
  readonly select: (object: THREE.Object3D | null) => void
  readonly setMode: (mode: TransformMode) => void
  readonly mode: () => TransformMode
  readonly loadFile: (file: File, companions?: readonly File[]) => Promise<void>
  readonly addShape: (kind: ShapeKind) => void
  readonly deleteSelected: () => void
  readonly duplicateSelected: () => void
  readonly focusSelected: () => void
  readonly setColor: (object: THREE.Object3D, hex: string) => void
  readonly getColor: (object: THREE.Object3D) => string
  readonly setWireframe: (object: THREE.Object3D, on: boolean) => void
  readonly getWireframe: (object: THREE.Object3D) => boolean
  readonly notify: () => void
  readonly exportGlb: () => Promise<Blob>
  readonly dispose: () => void
}

const fileExtension = (name: string): string => name.split('.').pop()?.toLowerCase() ?? ''

export const isSupportedFile = (file: File): boolean =>
  (SUPPORTED_EXTENSIONS as readonly string[]).includes(fileExtension(file.name))

export const isCompanionFile = (file: File): boolean =>
  (COMPANION_EXTENSIONS as readonly string[]).includes(fileExtension(file.name))

/** The last part of a path or web address, decoded, e.g. "textures/wood%20grain.png" → "wood grain.png". */
const baseName = (url: string): string => {
  const lastPart = url.split(/[?#]/)[0].split('/').pop() ?? ''
  try {
    return decodeURIComponent(lastPart)
  } catch {
    return lastPart
  }
}

/** Frees the graphics memory an object uses, except for anything another object still needs. */
const disposeUnused = (removed: THREE.Object3D, remaining: THREE.Object3D): void => {
  const geometriesIn = (root: THREE.Object3D): Set<THREE.BufferGeometry> => {
    const geometries = new Set<THREE.BufferGeometry>()
    root.traverse((child) => {
      if (child instanceof THREE.Mesh) geometries.add(child.geometry)
    })
    return geometries
  }
  const texturesOf = (materials: readonly THREE.Material[]): Set<THREE.Texture> =>
    new Set(materials.flatMap((material) => Object.values(material).filter((value) => value instanceof THREE.Texture)))

  const keptGeometries = geometriesIn(remaining)
  const keptMaterials = new Set(materialsOf(remaining))
  const keptTextures = texturesOf([...keptMaterials])
  const removedMaterials = [...new Set(materialsOf(removed))]

  for (const geometry of geometriesIn(removed)) if (!keptGeometries.has(geometry)) geometry.dispose()
  for (const texture of texturesOf(removedMaterials)) if (!keptTextures.has(texture)) texture.dispose()
  for (const material of removedMaterials) if (!keptMaterials.has(material)) material.dispose()
}

/** Every material on an object and its children. */
const materialsOf = (object: THREE.Object3D): THREE.Material[] => {
  const materials: THREE.Material[] = []
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) materials.push(...[child.material].flat())
  })
  return materials
}

const hasColor = (material: THREE.Material): material is THREE.Material & { color: THREE.Color } =>
  'color' in material && material.color instanceof THREE.Color

const hasWireframe = (material: THREE.Material): material is THREE.Material & { wireframe: boolean } =>
  'wireframe' in material

const readModel = async (file: File, companions: readonly File[]): Promise<THREE.Object3D> => {
  const url = URL.createObjectURL(file)
  // A .gltf names its other files (e.g. "scene.bin"). Point those names at the matching picked files.
  const companionUrls = new Map(companions.map((companion) => [companion.name, URL.createObjectURL(companion)]))
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((requested) => companionUrls.get(baseName(requested)) ?? requested)
  try {
    switch (fileExtension(file.name)) {
      case 'glb':
      case 'gltf':
        return (await new GLTFLoader(manager).loadAsync(url)).scene
      case 'obj':
        return await new OBJLoader().loadAsync(url)
      case 'fbx':
        return await new FBXLoader().loadAsync(url)
      case 'stl': {
        const geometry = await new STLLoader().loadAsync(url)
        geometry.computeVertexNormals()
        return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: DEFAULT_COLOR }))
      }
      default:
        throw new Error(`Can't open .${fileExtension(file.name)} files.`)
    }
  } finally {
    URL.revokeObjectURL(url)
    companionUrls.forEach((companionUrl) => URL.revokeObjectURL(companionUrl))
  }
}

export function createEditor(host: HTMLElement, onChange: () => void): Editor {
  const scene = new THREE.Scene()
  const world = new THREE.Group()
  scene.add(world)

  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 2000)
  camera.position.set(4, 3, 6)

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO))
  renderer.domElement.style.display = 'block'
  host.appendChild(renderer.domElement)

  const sun = new THREE.DirectionalLight(0xffffff, 2)
  sun.position.set(5, 10, 7)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.5), sun)
  scene.add(new THREE.GridHelper(GRID_SIZE, GRID_SIZE, 0x888888, 0x555555))

  // Orbit: left-drag turns, right-drag pans, scroll zooms.
  const orbit = new OrbitControls(camera, renderer.domElement)
  orbit.enableDamping = true

  // The coloured arrows/rings for moving, rotating and scaling the selection.
  const gizmo = new TransformControls(camera, renderer.domElement)
  scene.add(gizmo.getHelper())
  gizmo.addEventListener('dragging-changed', (event) => {
    orbit.enabled = !event.value
  })
  gizmo.addEventListener('objectChange', onChange)

  const outline = new THREE.BoxHelper(new THREE.Object3D(), SELECTION_COLOR)
  outline.visible = false
  scene.add(outline)

  let selected: THREE.Object3D | null = null

  const select = (object: THREE.Object3D | null): void => {
    selected = object
    if (object) gizmo.attach(object)
    else gizmo.detach()
    outline.visible = object !== null
    onChange()
  }

  const focusOn = (object: THREE.Object3D): void => {
    const box = new THREE.Box3().setFromObject(object)
    if (box.isEmpty()) return
    const center = box.getCenter(new THREE.Vector3())
    const radius = box.getSize(new THREE.Vector3()).length() || 1
    const direction = camera.position.clone().sub(orbit.target).normalize()
    orbit.target.copy(center)
    camera.position.copy(center).addScaledVector(direction, radius * FOCUS_DISTANCE_FACTOR)
    camera.near = radius / 1000
    camera.far = radius * 1000
    camera.updateProjectionMatrix()
  }

  const addToScene = (object: THREE.Object3D): void => {
    world.add(object)
    select(object)
  }

  // Click (not drag) on the viewport picks the object under the mouse.
  const pointerStart = new THREE.Vector2()
  const raycaster = new THREE.Raycaster()
  // The gizmo clears its own "dragging" flag before this runs, so remember whether the press began on one of its handles.
  let pressedGizmo = false
  const onPointerDown = (event: PointerEvent): void => {
    pointerStart.set(event.clientX, event.clientY)
    pressedGizmo = gizmo.dragging || gizmo.axis !== null
  }
  const onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0 || gizmo.dragging || pressedGizmo) return
    if (pointerStart.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > CLICK_TOLERANCE_PX) return
    const rect = renderer.domElement.getBoundingClientRect()
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    )
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObjects(world.children, true).find((h) => h.object.visible)
    // Select the whole imported model, not one small piece of it.
    let picked = hit?.object ?? null
    while (picked && picked.parent !== world) picked = picked.parent
    select(picked)
  }
  renderer.domElement.addEventListener('pointerdown', onPointerDown)
  renderer.domElement.addEventListener('pointerup', onPointerUp)

  const resize = new ResizeObserver(() => {
    const { clientWidth, clientHeight } = host
    if (clientWidth === 0 || clientHeight === 0) return
    camera.aspect = clientWidth / clientHeight
    camera.updateProjectionMatrix()
    renderer.setSize(clientWidth, clientHeight)
  })
  resize.observe(host)

  renderer.setAnimationLoop(() => {
    orbit.update()
    if (selected) outline.setFromObject(selected)
    renderer.render(scene, camera)
  })

  let mode: TransformMode = 'translate'

  return {
    objects: () => world.children,
    selected: () => selected,
    select,
    mode: () => mode,
    setMode: (next) => {
      mode = next
      gizmo.setMode(next)
      onChange()
    },
    loadFile: async (file, companions = []) => {
      const model = await readModel(file, companions)
      model.name = file.name.replace(/\.[^.]+$/, '')
      addToScene(model)
      focusOn(model)
    },
    addShape: (kind) => {
      const mesh = new THREE.Mesh(SHAPE_GEOMETRY[kind](), new THREE.MeshStandardMaterial({ color: DEFAULT_COLOR }))
      mesh.name = kind[0].toUpperCase() + kind.slice(1)
      mesh.position.copy(orbit.target)
      addToScene(mesh)
    },
    deleteSelected: () => {
      if (!selected) return
      const removed = selected
      world.remove(removed)
      select(null)
      disposeUnused(removed, world)
    },
    duplicateSelected: () => {
      if (!selected) return
      const copy = selected.clone()
      // Give the copy its own materials so recolouring one doesn't recolour both.
      copy.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.material = Array.isArray(child.material)
            ? child.material.map((material) => material.clone())
            : child.material.clone()
        }
      })
      copy.name = `${selected.name} copy`
      copy.position.x += DUPLICATE_OFFSET
      addToScene(copy)
    },
    focusSelected: () => focusOn(selected ?? world),
    getColor: (object) => {
      const material = materialsOf(object).find(hasColor)
      return `#${(material?.color ?? new THREE.Color(DEFAULT_COLOR)).getHexString()}`
    },
    setColor: (object, hex) => {
      materialsOf(object).filter(hasColor).forEach((material) => material.color.set(hex))
    },
    getWireframe: (object) => materialsOf(object).filter(hasWireframe).some((material) => material.wireframe),
    setWireframe: (object, on) => {
      materialsOf(object).filter(hasWireframe).forEach((material) => {
        material.wireframe = on
      })
      onChange()
    },
    notify: onChange,
    exportGlb: async () => {
      const result = await new GLTFExporter().parseAsync(world, { binary: true, onlyVisible: false })
      if (!(result instanceof ArrayBuffer)) throw new Error('Export did not produce a .glb file.')
      return new Blob([result], { type: 'model/gltf-binary' })
    },
    dispose: () => {
      renderer.setAnimationLoop(null)
      resize.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      gizmo.dispose()
      orbit.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}

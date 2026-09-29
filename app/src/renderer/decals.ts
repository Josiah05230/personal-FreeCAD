/**
 * Face decals: an image at true mm size on a planar face of a part (product
 * labels on an enclosure lid). The sidecar (gwtcad/decals.py) owns the
 * records - persisted in the part's .gwtcad companion under "decals" - and
 * sends every mesh's decal frames with scene.get (RenderMesh.decals), own and
 * inherited through assembly links. viewport/decalLayer.ts draws them.
 */

/** One decal as drawn: its frame in the mesh's own coordinates. */
export interface DecalRender {
  id: string
  center: [number, number, number]
  /** outward face normal */
  normal: [number, number, number]
  /** in-plane image +X direction (rotation already applied) */
  u: [number, number, number]
  width: number
  height: number
  /** absolute image path */
  image: string
  imageMtime?: number | null
}

/** One stored decal record (decal.list / add / update). */
export interface DecalRecord {
  id: string
  object: string
  face: string
  /** absolute in the live session; relative to the companion on disk */
  image: string
  imageName?: string
  widthMm: number
  heightMm: number
  offsetMm: [number, number]
  rotationDeg: number
  faceNormal: [number, number, number]
  faceCentroid: [number, number, number]
  /** its face could not be found (not even by geometry) - not drawn */
  missing?: boolean
  resolvedFace?: string
}

export interface DecalPatch {
  image?: string
  widthMm?: number
  heightMm?: number
  offsetMm?: [number, number]
  rotationDeg?: number
  object?: string
  face?: string
  keepAspect?: boolean
}

type DecalsResult = { decals: DecalRecord[] }

// view-state edits like appearance: not traced as document RPCs, the caller
// marks the tab dirty and refreshes the scene
const call = <T,>(m: string, p: Record<string, unknown> = {}): Promise<T> => window.cad.rpc<T>(m, p)

export const decalApi = {
  list: () => call<DecalsResult>('decal.list'),
  add: (
    object: string,
    face: string,
    image: string,
    widthMm: number,
    heightMm?: number | null,
    offsetMm?: [number, number],
    rotationDeg?: number
  ) =>
    call<DecalsResult & { decal: DecalRecord }>('decal.add', {
      object,
      face,
      image,
      widthMm,
      heightMm: heightMm ?? null,
      offsetMm: offsetMm ?? null,
      rotationDeg: rotationDeg ?? 0
    }),
  update: (id: string, patch: DecalPatch) =>
    call<DecalsResult & { decal: DecalRecord }>('decal.update', { id, ...patch }),
  remove: (id: string) => call<DecalsResult & { removed: string }>('decal.remove', { id })
}

export const DECAL_IMAGE_FILTERS = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]

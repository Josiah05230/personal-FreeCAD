/** Mesh import / conversion preferences - persisted to localStorage, same
 *  pattern as ribbonPrefs.ts. A huge STL/OBJ (a raw 3D scan, a dense sculpt
 *  export) can be tens of millions of triangles; importing it at full density
 *  freezes the viewport and every mesh tool on it. These settings let that be
 *  capped up front instead of discovered the hard way. */

const KEY = 'gwtcad.mesh.prefs'

export interface MeshPrefs {
  /** Facet count above which an imported mesh is auto-decimated on the way in. */
  importFacetCap: number
  /** Whether the auto-decimate-on-import behaviour is on at all. */
  autoSimplifyOnImport: boolean
}

export const DEFAULT_MESH_PREFS: MeshPrefs = {
  importFacetCap: 200000,
  autoSimplifyOnImport: true
}

export function loadMeshPrefs(): MeshPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_MESH_PREFS }
    return { ...DEFAULT_MESH_PREFS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_MESH_PREFS }
  }
}

export function saveMeshPrefs(p: MeshPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* private mode / disabled storage - just won't persist */
  }
}

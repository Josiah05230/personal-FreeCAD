/**
 * The ONE list of file types GWT-CAD can do something with - shared by the
 * main process (Data Panel listing / folder-relevance walk / search) and the
 * renderer (Data Panel icons + double-click, the copy-into-company-repo
 * gate). Anything not listed here (dll, py, json, ...) is invisible to the
 * Data Panel, and a folder holding nothing listed here anywhere beneath it
 * is hidden too.
 *
 * Keep in sync with what the app can actually open/import: io.importModel's
 * _BREP_EXT/_MESH_EXT (methods.py), import_dispatch.py's KiCad/zip
 * handling, and the image dialogs (canvas + drawing image).
 */

export type FileKind =
  | 'design' // FreeCAD document - opens as a design
  | 'model' // BRep solid (STEP/IGES/BREP) - imports into a design
  | 'mesh' // STL/OBJ/3MF/PLY/OFF - imports as a mesh
  | 'ecad' // KiCad project/board/schematic
  | 'archive' // zip - New Part from File unpacks + classifies it
  | 'image' // raster image - canvas / drawing image / label artwork
  | 'vector' // DXF/SVG - 2D artwork (opened with the system viewer today)
  | 'document' // PDF - datasheets, prints (system viewer)

export const FILE_KINDS: Readonly<Record<string, FileKind>> = {
  fcstd: 'design',
  step: 'model',
  stp: 'model',
  iges: 'model',
  igs: 'model',
  brep: 'model',
  brp: 'model',
  stl: 'mesh',
  obj: 'mesh',
  '3mf': 'mesh',
  ply: 'mesh',
  off: 'mesh',
  kicad_pro: 'ecad',
  kicad_pcb: 'ecad',
  kicad_sch: 'ecad',
  zip: 'archive',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  bmp: 'image',
  gif: 'image',
  dxf: 'vector',
  svg: 'vector',
  pdf: 'document'
}

export const ALLOWED_EXTENSIONS: readonly string[] = Object.keys(FILE_KINDS)

/** lower-cased extension without the dot ('' for none) - "a.kicad_pcb" ->
 *  "kicad_pcb", "A.FCStd" -> "fcstd" */
export function extOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase()
}

/** Files GWT-CAD writes NEXT TO a part that are not themselves openable
 *  parts: FreeCAD backups, the per-design .gwtcad.json companion, a
 *  supplier model's metadata sidecar. Most already fall outside the
 *  allow-list by extension; this states it explicitly so a future
 *  allow-list addition (json, say) can't make them reappear. */
export function isCompanionFile(name: string): boolean {
  const n = name.toLowerCase()
  return (
    n.endsWith('.fcbak') ||
    /\.fcstd\d+$/.test(n) || // pre-1.0 FreeCAD backups: X.FCStd1, X.FCStd2
    n.endsWith('.fcstd.gwtcad.json') ||
    n.endsWith('_supplier_meta.json')
  )
}

/** the file's kind, or null when GWT-CAD has no use for it (hidden) */
export function fileKind(name: string): FileKind | null {
  if (isCompanionFile(name)) return null
  return FILE_KINDS[extOf(name)] ?? null
}

export function isAllowedFile(name: string): boolean {
  return fileKind(name) !== null
}

/** Folders never worth walking into (or showing): tool/vendor/cache trees
 *  that can hold millions of files and never a part. Dot-folders (.git,
 *  .venv, .pio, .cache, ...) are all skipped by the leading dot; the named
 *  ones are listed anyway so the intent survives if that rule ever changes. */
export const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '__pycache__',
  'venv',
  'site-packages',
  'bower_components',
  '.git',
  '.venv',
  '.pio',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  '.gwtcad-thumbs'
])

export function isSkippedDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIR_NAMES.has(name)
}

/** Kinds that are REAL geometry/ECAD sources: pulling one of these from
 *  outside the company repos into a company document must go through the
 *  New Part workflow (reserve a PN, copy it in). Everything else allowed
 *  (images, pdf, vector art) is only OFFERED a copy-in. */
export const COPY_IN_REQUIRED_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  'design',
  'model',
  'mesh',
  'ecad',
  'archive'
])

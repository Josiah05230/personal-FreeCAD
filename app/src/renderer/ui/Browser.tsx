import { useState } from 'react'
import type { BodyTree, CanvasDTO, ImportedNode, Selection } from '../rpc'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { AssemblyPanel } from './AssemblyPanel'

export interface SectionNode {
  id: string
  label: string
  visible: boolean
}

export interface DrawingNode {
  id: string
  label: string
}

export interface BrowserHandlers {
  onToggleVisibility: (id: string, visible: boolean) => void
  onToggleGroup: (group: 'bodies' | 'sketches' | 'origin', visible: boolean) => void
  onRename: (id: string) => void
  onDelete: (id: string) => void
  onEdit: (id: string) => void
  onEditDim: (id: string) => void
  onSelect: (sel: Selection, additive: boolean) => void
  onCalibrateCanvas: (id: string) => void
  onDeleteCanvas: (id: string) => void
  onToggleSection?: (id: string, visible: boolean) => void
  onEditSection?: (id: string) => void
  onDeleteSection?: (id: string) => void
  onOpenDrawing?: (id: string) => void
  onRenameDrawing?: (id: string) => void
  onDeleteDrawing?: (id: string) => void
}

const Eye = ({ on }: { on: boolean }): JSX.Element =>
  on ? (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M1 6.5 C3 3, 10 3, 12 6.5 C10 10, 3 10, 1 6.5 Z" />
      <circle cx="6.5" cy="6.5" r="1.8" />
    </svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M1 6.5 C3 3, 10 3, 12 6.5 C11 8, 9 9.3, 6.5 9.3" />
      <line x1="2" y1="11" x2="11" y2="2" />
    </svg>
  )

interface RowProps {
  depth: number
  label: string
  glyph: string
  id?: string
  visible?: boolean
  onToggle?: (v: boolean) => void
  onPick?: (additive: boolean) => void
  selected?: boolean
  menu?: MenuItem[]
  onEditDbl?: () => void
  defaultOpen?: boolean
  /** while a search query is active, force this node open regardless of
   *  defaultOpen/the user's own collapsed state - so a match nested under
   *  a normally-collapsed section (Origin, Construction, Drawings, ...)
   *  is actually visible instead of requiring the user to expand it
   *  manually first. undefined outside of search. */
  forceOpen?: boolean
  /** true when this row's OWN label is what matched the query (as
   *  opposed to just being an ancestor of a match) - gets a highlight. */
  matched?: boolean
  children?: React.ReactNode
}

function Row({
  depth,
  label,
  glyph,
  visible,
  onToggle,
  onPick,
  selected,
  menu,
  onEditDbl,
  defaultOpen = true,
  forceOpen,
  matched,
  children
}: RowProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null)
  const hasKids = Array.isArray(children) ? children.length > 0 : !!children
  const effectiveOpen = forceOpen ?? open

  return (
    <div className="br-node">
      <div
        className={
          (selected ? 'br-row selected' : 'br-row') + (matched ? ' br-match' : '')
        }
        style={{ paddingLeft: 6 + depth * 13 }}
        onContextMenu={
          menu
            ? (e) => {
                e.preventDefault()
                setCtx({ x: e.clientX, y: e.clientY })
              }
            : undefined
        }
      >
        <span
          className={hasKids ? (effectiveOpen ? 'br-tw open' : 'br-tw') : 'br-tw none'}
          onClick={() => hasKids && setOpen(!effectiveOpen)}
        />
        <span className="br-glyph">{glyph}</span>
        <span
          className="br-label"
          onClick={(e) => onPick?.(e.shiftKey || e.ctrlKey)}
          onDoubleClick={onEditDbl}
        >
          {label}
        </span>
        {typeof visible === 'boolean' && onToggle && (
          <span
            className={visible ? 'br-eye on' : 'br-eye'}
            title={visible ? 'Hide' : 'Show'}
            onClick={(e) => {
              e.stopPropagation()
              onToggle(!visible)
            }}
          >
            <Eye on={visible} />
          </span>
        )}
      </div>
      {effectiveOpen && children}
      {ctx && menu && (
        <ContextMenu x={ctx.x} y={ctx.y} items={menu} onClose={() => setCtx(null)} />
      )}
    </div>
  )
}

/** Floating browser panel over the top-left of the canvas. Not a docked sidebar. */
export function Browser({
  bodies,
  imported = [],
  canvases = [],
  sections = [],
  drawings = [],
  assembly,
  handlers,
  visibility,
  selection
}: {
  bodies: BodyTree[]
  imported?: ImportedNode[]
  canvases?: CanvasDTO[]
  sections?: SectionNode[]
  drawings?: DrawingNode[]
  /** Present only once an assembly exists in the document - renders an
   *  "Assembly" tree section (components/grounding/pins/joints list/explode)
   *  in place of what used to be a permanent floating viewport panel. */
  assembly?: Omit<Parameters<typeof AssemblyPanel>[0], 'tree'> & {
    tree: import('../rpc').AssemblyTree | null
  }
  handlers: BrowserHandlers
  visibility: Record<string, boolean>
  selection: Selection[]
}): JSX.Element {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const matches = (label: string): boolean => label.toLowerCase().includes(q)

  const vis = (id: string, fallback: boolean): boolean =>
    id in visibility ? visibility[id] : fallback
  const isSel = (pred: (s: Selection) => boolean): boolean => selection.some(pred)
  // a body row should read as selected for a face/edge/vertex pick ON that
  // body too, not only a bare {kind:'body'} selection - previously picking
  // a face in the viewport set real selection state but the tree gave no
  // feedback at all about which body it belonged to (user report,
  // 2026-09-20: "It also should highlight in the model tree when I select
  // a part of it in the viewer").
  const isBodySel = (bodyId: string): boolean =>
    isSel(
      (s) =>
        (s.kind === 'body' && s.bodyId === bodyId) ||
        ((s.kind === 'face' || s.kind === 'edge' || s.kind === 'vertex') && s.bodyId === bodyId)
    )

  const b0 = bodies[0]
  const origin = b0?.origin ?? []
  // an empty starter body exists so the Origin is always there (Fusion-style),
  // but don't surface it as a "Body" until it actually has a SOLID - a lone
  // sketch or datum living in the starter body must not read as "a body exists"
  const realBodies = bodies.filter((b) =>
    b.features.some((f) => f.kind !== 'sketch' && f.kind !== 'datum')
  )
  const sketches = bodies.flatMap((b) => b.features.filter((f) => f.kind === 'sketch'))
  const datums = bodies.flatMap((b) => b.features.filter((f) => f.kind === 'datum'))

  const anyOn = (ids: string[], fb: (id: string) => boolean): boolean =>
    ids.some((id) => vis(id, fb(id)))

  // search checks the section's OWN label first (the "highest level") -
  // a match there (e.g. typing "sketch") keeps every item in that
  // section, since the section itself is what the user was looking for.
  // Only when the section name doesn't match does it recurse into the
  // section's own items and keep just the ones whose own label matches
  // (per user request, 2026-09-22: "search the highest level first and
  // then continue searching recursively").
  function filterSection<T>(
    sectionLabel: string,
    items: T[],
    itemLabel: (item: T) => string
  ): { items: T[]; sectionMatched: boolean; show: boolean } {
    if (!searching) return { items, sectionMatched: false, show: true }
    const sectionMatched = matches(sectionLabel)
    if (sectionMatched) return { items, sectionMatched: true, show: true }
    const filtered = items.filter((it) => matches(itemLabel(it)))
    return { items: filtered, sectionMatched: false, show: filtered.length > 0 }
  }

  const featMenu = (id: string, kind?: 'sketch'): MenuItem[] => [
    kind === 'sketch'
      ? { label: 'Edit Sketch', onClick: () => handlers.onEdit(id) }
      : { label: 'Edit Feature…', onClick: () => handlers.onEdit(id) },
    ...(kind === 'sketch'
      ? []
      : [{ label: 'Edit Value…', onClick: () => handlers.onEditDim(id) }]),
    { label: 'Rename…', onClick: () => handlers.onRename(id) },
    { separator: true, label: '' },
    { label: 'Delete', danger: true, onClick: () => handlers.onDelete(id) }
  ]

  const originF = filterSection('Origin', origin, (o) => o.label)
  const bodiesF = filterSection('Bodies', realBodies, (b) => b.label)
  const importedF = filterSection('Imported', imported, (o) => o.label)
  const sketchesF = filterSection('Sketches', sketches, (f) => f.label)
  const datumsF = filterSection('Construction', datums, (f) => f.label)
  const canvasesF = filterSection('Canvases', canvases, (c) => c.id)
  const sectionsF = filterSection('Section Views', sections, (s) => s.label)
  const drawingsF = filterSection('Drawings', drawings, (dw) => dw.label)
  const assemblyShow = !searching || matches('Assembly')
  const rootMatched = searching && matches('Untitled')
  const anySectionShown =
    !searching ||
    rootMatched ||
    originF.show ||
    bodiesF.show ||
    importedF.show ||
    sketchesF.show ||
    datumsF.show ||
    canvasesF.show ||
    sectionsF.show ||
    (assembly && assemblyShow) ||
    drawingsF.show

  return (
    <div className="browser">
      <div className="br-search-wrap">
        <input
          className="br-search"
          type="text"
          placeholder="Search the tree…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="br-tree-scroll">
        {searching && !anySectionShown ? (
          <div className="br-no-results">No matches for “{query.trim()}”</div>
        ) : (
          <Row depth={0} label="Untitled" glyph="◈" forceOpen={searching ? true : undefined}>
            {(rootMatched || originF.show) && (
              <Row
                depth={1}
                label="Origin"
                glyph="✛"
                defaultOpen={false}
                forceOpen={searching ? true : undefined}
                matched={originF.sectionMatched}
                visible={anyOn(
                  origin.map((o) => o.id),
                  (id) => origin.find((o) => o.id === id)?.visible ?? false
                )}
                onToggle={(v) => handlers.onToggleGroup('origin', v)}
              >
                {(rootMatched ? origin : originF.items).map((o) => (
                  <Row
                    key={o.id}
                    depth={2}
                    label={o.label}
                    glyph={o.kind === 'plane' ? '▱' : o.kind === 'axis' ? '╱' : '•'}
                    matched={searching && !originF.sectionMatched}
                    visible={vis(o.id, o.visible)}
                    onToggle={(v) => handlers.onToggleVisibility(o.id, v)}
                    onPick={(add) =>
                      handlers.onSelect(
                        { kind: 'plane', planeId: o.id, role: o.role, label: o.label },
                        add
                      )
                    }
                    selected={isSel((s) => s.kind === 'plane' && s.planeId === o.id)}
                  />
                ))}
              </Row>
            )}

            {realBodies.length > 0 && (rootMatched || bodiesF.show) && (
              <Row
                depth={1}
                label="Bodies"
                glyph="▨"
                forceOpen={searching ? true : undefined}
                matched={bodiesF.sectionMatched}
                visible={anyOn(
                  realBodies.map((b) => b.id),
                  (id) => realBodies.find((b) => b.id === id)?.visible ?? true
                )}
                onToggle={(v) => handlers.onToggleGroup('bodies', v)}
              >
                {(rootMatched ? realBodies : bodiesF.items).map((b) => (
                  <Row
                    key={b.id}
                    depth={2}
                    label={b.label}
                    glyph="▬"
                    matched={searching && !bodiesF.sectionMatched}
                    visible={vis(b.id, b.visible)}
                    onToggle={(v) => handlers.onToggleVisibility(b.id, v)}
                    onPick={(add) => handlers.onSelect({ kind: 'body', bodyId: b.id }, add)}
                    selected={isBodySel(b.id)}
                    menu={featMenu(b.id)}
                    onEditDbl={() => handlers.onEdit(b.id)}
                  />
                ))}
              </Row>
            )}

            {imported.length > 0 && (rootMatched || importedF.show) && (
              <Row
                depth={1}
                label="Imported"
                glyph="⬡"
                forceOpen={searching ? true : undefined}
                matched={importedF.sectionMatched}
                visible={anyOn(
                  imported.map((o) => o.id),
                  (id) => imported.find((o) => o.id === id)?.visible ?? true
                )}
                onToggle={(v) => {
                  for (const o of imported) handlers.onToggleVisibility(o.id, v)
                }}
              >
                {(rootMatched ? imported : importedF.items).map((o) => (
                  <Row
                    key={o.id}
                    depth={2}
                    label={o.label}
                    glyph={o.kind === 'mesh' ? '◆' : o.kind === 'link' ? '⛓' : '⬡'}
                    matched={searching && !importedF.sectionMatched}
                    visible={vis(o.id, o.visible)}
                    onToggle={(v) => handlers.onToggleVisibility(o.id, v)}
                    onPick={(add) => handlers.onSelect({ kind: 'body', bodyId: o.id }, add)}
                    selected={isBodySel(o.id)}
                    menu={[
                      { label: 'Rename…', onClick: () => handlers.onRename(o.id) },
                      { separator: true, label: '' },
                      { label: 'Delete', danger: true, onClick: () => handlers.onDelete(o.id) }
                    ]}
                  />
                ))}
              </Row>
            )}

            {sketches.length > 0 && (rootMatched || sketchesF.show) && (
              <Row
                depth={1}
                label="Sketches"
                glyph="✎"
                forceOpen={searching ? true : undefined}
                matched={sketchesF.sectionMatched}
                visible={anyOn(
                  sketches.filter((s) => !s.afterTip).map((s) => s.id),
                  (id) => sketches.find((s) => s.id === id)?.visible ?? false
                )}
                onToggle={(v) => handlers.onToggleGroup('sketches', v)}
              >
                {(rootMatched ? sketches : sketchesF.items).map((f) =>
                  f.afterTip ? (
                    <div key={f.id} className="br-row rolled" style={{ paddingLeft: 32 }}>
                      <span className="br-glyph">✎</span>
                      <span className="br-label">{f.label}</span>
                    </div>
                  ) : (
                    <Row
                      key={f.id}
                      depth={2}
                      label={f.label}
                      glyph="✎"
                      matched={searching && !sketchesF.sectionMatched}
                      visible={vis(f.id, f.visible)}
                      onToggle={(v) => handlers.onToggleVisibility(f.id, v)}
                      menu={featMenu(f.id, 'sketch')}
                    />
                  )
                )}
              </Row>
            )}

            {datums.length > 0 && (rootMatched || datumsF.show) && (
              <Row
                depth={1}
                label="Construction"
                glyph="▱"
                defaultOpen={false}
                forceOpen={searching ? true : undefined}
                matched={datumsF.sectionMatched}
                visible={anyOn(
                  datums.map((f) => f.id),
                  (id) => datums.find((f) => f.id === id)?.visible ?? false
                )}
                onToggle={(v) => {
                  for (const f of datums) handlers.onToggleVisibility(f.id, v)
                }}
              >
                {(rootMatched ? datums : datumsF.items).map((f) =>
                  f.afterTip ? (
                    <div key={f.id} className="br-row rolled" style={{ paddingLeft: 32 }}>
                      <span className="br-glyph">▱</span>
                      <span className="br-label">{f.label}</span>
                    </div>
                  ) : (
                    <Row
                      key={f.id}
                      depth={2}
                      label={f.label}
                      glyph="▱"
                      matched={searching && !datumsF.sectionMatched}
                      visible={vis(f.id, f.visible)}
                      onToggle={(v) => handlers.onToggleVisibility(f.id, v)}
                      onPick={(add) =>
                        handlers.onSelect({ kind: 'plane', planeId: f.id, label: f.label }, add)
                      }
                      selected={isSel((s) => s.kind === 'plane' && s.planeId === f.id)}
                      menu={featMenu(f.id)}
                    />
                  )
                )}
              </Row>
            )}

            {canvases.length > 0 && (rootMatched || canvasesF.show) && (
              <Row
                depth={1}
                label="Canvases"
                glyph="▣"
                defaultOpen={false}
                forceOpen={searching ? true : undefined}
                matched={canvasesF.sectionMatched}
              >
                {(rootMatched ? canvases : canvasesF.items).map((c) => (
                  <Row
                    key={c.id}
                    depth={2}
                    label={c.id}
                    glyph="▣"
                    matched={searching && !canvasesF.sectionMatched}
                    menu={[
                      { label: 'Calibrate…', onClick: () => handlers.onCalibrateCanvas(c.id) },
                      { separator: true, label: '' },
                      {
                        label: 'Delete',
                        danger: true,
                        onClick: () => handlers.onDeleteCanvas(c.id)
                      }
                    ]}
                  />
                ))}
              </Row>
            )}

            {sections.length > 0 && (rootMatched || sectionsF.show) && (
              <Row
                depth={1}
                label="Section Views"
                glyph="⌗"
                defaultOpen
                forceOpen={searching ? true : undefined}
                matched={sectionsF.sectionMatched}
              >
                {(rootMatched ? sections : sectionsF.items).map((s) => (
                  <Row
                    key={s.id}
                    depth={2}
                    label={s.label}
                    glyph="⌗"
                    matched={searching && !sectionsF.sectionMatched}
                    visible={s.visible}
                    onToggle={(v) => handlers.onToggleSection?.(s.id, v)}
                    onEditDbl={() => handlers.onEditSection?.(s.id)}
                    menu={[
                      { label: 'Edit…', onClick: () => handlers.onEditSection?.(s.id) },
                      {
                        label: s.visible ? 'Hide' : 'Show',
                        onClick: () => handlers.onToggleSection?.(s.id, !s.visible)
                      },
                      { separator: true, label: '' },
                      {
                        label: 'Delete',
                        danger: true,
                        onClick: () => handlers.onDeleteSection?.(s.id)
                      }
                    ]}
                  />
                ))}
              </Row>
            )}

            {assembly && (rootMatched || assemblyShow) && (
              <Row
                depth={1}
                label="Assembly"
                glyph="⚙"
                forceOpen={searching ? true : undefined}
                matched={searching && matches('Assembly')}
              >
                <AssemblyPanel {...assembly} />
              </Row>
            )}

            {drawings.length > 0 && (rootMatched || drawingsF.show) && (
              <Row
                depth={1}
                label="Drawings"
                glyph="☷"
                defaultOpen={false}
                forceOpen={searching ? true : undefined}
                matched={drawingsF.sectionMatched}
              >
                {(rootMatched ? drawings : drawingsF.items).map((dw) => (
                  <Row
                    key={dw.id}
                    depth={2}
                    label={dw.label}
                    glyph="☷"
                    matched={searching && !drawingsF.sectionMatched}
                    onEditDbl={() => handlers.onOpenDrawing?.(dw.id)}
                    menu={[
                      { label: 'Open', onClick: () => handlers.onOpenDrawing?.(dw.id) },
                      { label: 'Rename…', onClick: () => handlers.onRenameDrawing?.(dw.id) },
                      { separator: true, label: '' },
                      {
                        label: 'Delete',
                        danger: true,
                        onClick: () => handlers.onDeleteDrawing?.(dw.id)
                      }
                    ]}
                  />
                ))}
              </Row>
            )}
          </Row>
        )}
      </div>
    </div>
  )
}

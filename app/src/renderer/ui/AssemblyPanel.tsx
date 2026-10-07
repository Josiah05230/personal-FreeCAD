import { useState } from 'react'
import { ContextMenu } from './ContextMenu'
import type { AssemblyTree, AssemblySubComponent } from '../rpc'

/**
 * Assembly panel content - components (with grounding + git pinning) and a
 * read-only joints list. Rendered INSIDE the left Browser tree as an
 * "Assembly" section (moved 2026-09-20: this used to be its own floating
 * panel permanently covering the ViewCube in the top-right of the viewport
 * whenever any assembly existed - user report: "It's covering/blocking the
 * view cube" and "It's so confusing, what am I looking at" - matching how
 * Fusion 360 keeps components/joints in its left browser tree instead of a
 * viewport overlay). Joint CREATION now happens through the ASSEMBLE ribbon
 * tab's guided pick flow (see App.tsx's jointFlow state), not from here -
 * this panel only lists existing joints.
 *
 * Component linking, placement and grounding are live; joint solving is
 * experimental headless (joints are recorded and round-trip, the MbD solve
 * needs a GUI session for now).
 *
 * Each component can also be git-pinned: locked to a specific commit (never
 * moves) or tracking a branch's tip (re-resolved on reopen / manual refresh).
 * Unpinned components stay "live" - always whatever is on disk right now,
 * today's original behaviour.
 */
export function AssemblyPanel({
  tree,
  onAddComponent,
  onGround,
  onOpenComponent,
  onOpenPath,
  pins,
  onSetPin,
  tool,
  onSetTool,
  exploded,
  explodeDistance,
  onExplodeToggle,
  onExplodeDistanceChange
}: {
  tree: AssemblyTree | null
  onAddComponent: () => void
  onGround: (id: string) => void
  /** open a component's own part file in another tab (right-click / double-click) */
  onOpenComponent?: (id: string) => void
  /** open a part that sits inside a sub-assembly, by its file */
  onOpenPath?: (path: string, label: string) => void
  pins: AsmPinFile
  onSetPin: (
    componentId: string,
    sourcePath: string,
    pin: { mode: PinMode; ref: string } | null
  ) => Promise<void>
  /** 'select' (default): a plain click picks a face/edge/component, same as
   *  anywhere else in the viewport. 'move': drag a whole component,
   *  live-solved against whatever joints touch it - a separate mode so
   *  dragging never fights a normal pick click. */
  tool: 'select' | 'move'
  onSetTool: (t: 'select' | 'move') => void
  /** Exploded view: on/off, and the spread distance multiplier (1 = the
   *  assembly's own bounding radius) that onExplodeDistanceChange feeds
   *  back into a fresh explodeAuto call each time the slider moves. */
  exploded: boolean
  explodeDistance: number
  onExplodeToggle: (on: boolean) => void
  onExplodeDistanceChange: (d: number) => void
}): JSX.Element {
  const [pinEditFor, setPinEditFor] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  // sub-assemblies fold open level by level: keys are the id path from the top
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [subMenu, setSubMenu] = useState<{ x: number; y: number; path: string; label: string } | null>(null)
  const toggle = (key: string): void =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  const fold = (key: string, has: boolean): JSX.Element => (
    <span
      className={has ? 'asm-fold' : 'asm-fold none'}
      onClick={(e) => {
        e.stopPropagation()
        if (has) toggle(key)
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {has ? (open.has(key) ? '▾' : '▸') : ''}
    </span>
  )
  // what a sub-assembly is made of (read from its own file): listed, and
  // openable, but grounded / pinned / joined in THAT assembly, not here
  const subRows = (items: AssemblySubComponent[], parentKey: string, depth: number): JSX.Element[] =>
    items.flatMap((s) => {
      const key = `${parentKey}/${s.id}`
      const kids = s.children ?? []
      const row = (
        <div
          key={key}
          className="asm-row asm-sub"
          style={{ paddingLeft: 10 + depth * 14 }}
          title={s.linkedPath ?? undefined}
          onDoubleClick={() => s.linkedPath && onOpenPath?.(s.linkedPath, s.label)}
          onContextMenu={(e) => {
            e.preventDefault()
            if (s.linkedPath) setSubMenu({ x: e.clientX, y: e.clientY, path: s.linkedPath, label: s.label })
          }}
        >
          <span className="asm-name">
            {fold(key, kids.length > 0)}
            {s.label}
          </span>
        </div>
      )
      return open.has(key) ? [row, ...subRows(kids, key, depth + 1)] : [row]
    })

  return (
    <div className="asmpanel-tree">
      <div className="asmpanel-head">
        <button className="asmpanel-add" onClick={onAddComponent}>
          + Component
        </button>
      </div>

      <div className="asm-toolbar">
        <button
          className={tool === 'select' ? 'asm-tool on' : 'asm-tool'}
          title="Select - plain click picks a face/edge/component"
          onClick={() => onSetTool('select')}
        >
          Select
        </button>
        <button
          className={tool === 'move' ? 'asm-tool on' : 'asm-tool'}
          title="Move - drag a component; joints constrain the motion live"
          onClick={() => onSetTool('move')}
        >
          Move
        </button>
      </div>

      <div className="asm-section">Components</div>
      {(!tree || tree.components.length === 0) && (
        <div className="asm-hint">Insert a saved design as a component.</div>
      )}
      {tree?.components.map((c) => {
        const pin = pins[c.id]
        const sourcePath = pin?.sourcePath ?? c.linkedPath ?? ''
        return (
          <div key={c.id} className="asm-comp">
            <div
              className="asm-row"
              title={onOpenComponent ? 'Right-click or double-click to open this part in another tab' : undefined}
              onDoubleClick={() => onOpenComponent?.(c.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, id: c.id })
              }}
            >
              <span className="asm-name">
                {fold(c.id, (c.children ?? []).length > 0)}
                {c.label}
              </span>
              <button
                className={c.grounded ? 'asm-ground on' : 'asm-ground'}
                title="Ground (fix in place)"
                onClick={() => onGround(c.id)}
              >
                ⏚
              </button>
            </div>
            {pin?.ref ? (
              <div className={pin.drift === undefined ? 'asm-pin' : pin.drift ? 'asm-pin drift' : 'asm-pin ok'}>
                <span className="asm-pin-badge">{pin.mode === 'branch' ? 'branch' : 'commit'}</span>
                <span className="asm-pin-ref" title={pin.resolvedCommit ?? ''}>
                  {pin.ref}
                </span>
                {pin.drift && <span className="asm-pin-drift-flag">source has moved since pin</span>}
                <button
                  className="asm-pin-edit"
                  onClick={() => setPinEditFor(pinEditFor === c.id ? null : c.id)}
                >
                  Change
                </button>
                <button
                  className="asm-pin-clear"
                  title="Unpin - go back to live (always current on-disk)"
                  onClick={() => void onSetPin(c.id, sourcePath, null)}
                >
                  Unpin
                </button>
              </div>
            ) : (
              <div className="asm-pin unset">
                <span className="asm-pin-live">live (tracks the file on disk)</span>
                <button
                  className="asm-pin-edit"
                  onClick={() => setPinEditFor(pinEditFor === c.id ? null : c.id)}
                >
                  Pin version…
                </button>
              </div>
            )}
            {open.has(c.id) && subRows(c.children ?? [], c.id, 1)}
            {pinEditFor === c.id && (
              <PinEditor
                sourcePath={sourcePath}
                initialMode={pin?.mode ?? 'commit'}
                initialRef={pin?.ref ?? ''}
                onCancel={() => setPinEditFor(null)}
                onSave={async (mode, ref) => {
                  await onSetPin(c.id, sourcePath, { mode, ref })
                  setPinEditFor(null)
                }}
              />
            )}
          </div>
        )
      })}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Open in new tab',
              disabled: !onOpenComponent,
              onClick: () => onOpenComponent?.(menu.id)
            },
            {
              label: tree?.components.find((c) => c.id === menu.id)?.grounded ? 'Unground' : 'Ground (fix in place)',
              onClick: () => onGround(menu.id)
            }
          ]}
        />
      )}

      {subMenu && (
        <ContextMenu
          x={subMenu.x}
          y={subMenu.y}
          onClose={() => setSubMenu(null)}
          items={[
            {
              label: 'Open in new tab',
              disabled: !onOpenPath,
              onClick: () => onOpenPath?.(subMenu.path, subMenu.label)
            }
          ]}
        />
      )}

      <div className="asm-section">Joints</div>
      {tree?.joints.map((j) => (
        <div key={j.id} className="asm-row">
          <span className="asm-name">
            {j.label} · {j.type}
          </span>
        </div>
      ))}
      {(!tree || tree.joints.length === 0) && (
        <div className="asm-hint">No joints yet - use Joint on the ASSEMBLE ribbon tab.</div>
      )}

      <div className="asm-section">Exploded View</div>
      <div className="asm-explode">
        <button
          className={exploded ? 'asm-tool on' : 'asm-tool'}
          disabled={!tree || tree.components.length < 2}
          onClick={() => onExplodeToggle(!exploded)}
        >
          {exploded ? 'Exploded' : 'Explode'}
        </button>
        <input
          type="range"
          min={0.3}
          max={4}
          step={0.1}
          value={explodeDistance}
          disabled={!exploded}
          onChange={(e) => onExplodeDistanceChange(Number(e.target.value))}
        />
      </div>
      <div className="asm-hint small">
        {tree && tree.components.length < 2
          ? 'Needs at least 2 components.'
          : 'Spreads components apart from the assembly centre - a drawing view can capture this pose alongside normal ones.'}
      </div>
    </div>
  )
}

function PinEditor({
  sourcePath,
  initialMode,
  initialRef,
  onSave,
  onCancel
}: {
  sourcePath: string
  initialMode: PinMode
  initialRef: string
  onSave: (mode: PinMode, ref: string) => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const [mode, setMode] = useState<PinMode>(initialMode)
  const [ref, setRef] = useState(initialRef)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    if (!ref.trim()) {
      setErr(mode === 'branch' ? 'enter a branch name' : 'enter a commit hash')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await onSave(mode, ref.trim())
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method[^:]*:\s*/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="asm-pin-editor">
      <div className="asm-pin-editor-row">
        <select value={mode} onChange={(e) => setMode(e.target.value as PinMode)}>
          <option value="commit">Lock to commit</option>
          <option value="branch">Track branch</option>
        </select>
        <input
          type="text"
          placeholder={mode === 'branch' ? 'branch name (e.g. main)' : 'commit hash'}
          value={ref}
          onChange={(e) => setRef(e.target.value)}
        />
      </div>
      {err && <div className="asm-pin-err">{err}</div>}
      <div className="asm-pin-editor-row">
        <button disabled={busy} onClick={() => void save()}>
          {busy ? 'Resolving…' : 'Save'}
        </button>
        <button disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="asm-hint small">
        {mode === 'commit'
          ? 'Locks this component to that exact version of ' + (sourcePath || 'the source file') + ' - never moves until you change it.'
          : 'Always uses the current tip of that branch, re-resolved on reopen or refresh.'}
      </div>
    </div>
  )
}

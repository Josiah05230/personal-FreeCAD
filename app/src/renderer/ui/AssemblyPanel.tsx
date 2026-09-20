import { useState } from 'react'
import type { AssemblyTree, Selection } from '../rpc'

const JOINT_TYPES = ['Fixed', 'Revolute', 'Cylindrical', 'Slider', 'Ball'] as const

/**
 * Assembly panel - components and joints. Component linking, placement and
 * grounding are live; joint solving is experimental headless (joints are
 * recorded and round-trip, the MbD solve needs a GUI session for now).
 *
 * Each component can also be git-pinned: locked to a specific commit (never
 * moves) or tracking a branch's tip (re-resolved on reopen / manual refresh).
 * Unpinned components stay "live" - always whatever is on disk right now,
 * today's original behaviour.
 */
export function AssemblyPanel({
  tree,
  selection,
  jointType,
  onSetJointType,
  onAddComponent,
  onGround,
  onAddJoint,
  pins,
  onSetPin,
  tool,
  onSetTool
}: {
  tree: AssemblyTree | null
  selection: Selection[]
  jointType: string
  onSetJointType: (t: string) => void
  onAddComponent: () => void
  onGround: (id: string) => void
  onAddJoint: () => void
  pins: AsmPinFile
  onSetPin: (
    componentId: string,
    sourcePath: string,
    pin: { mode: PinMode; ref: string } | null
  ) => Promise<void>
  /** 'select' (default): click faces to build joint references. 'move':
   *  drag a whole component, live-solved against whatever joints touch it -
   *  a separate mode so dragging never fights face-picking. */
  tool: 'select' | 'move'
  onSetTool: (t: 'select' | 'move') => void
}): JSX.Element {
  const faceSel = selection.filter((s) => s.kind === 'face')
  const canJoint = faceSel.length === 2 && faceSel[0].bodyId !== faceSel[1].bodyId
  const [pinEditFor, setPinEditFor] = useState<string | null>(null)

  return (
    <div className="asmpanel">
      <div className="asmpanel-head">
        <span className="asmpanel-title">ASSEMBLY</span>
        <button className="asmpanel-add" onClick={onAddComponent}>
          + Component
        </button>
      </div>

      <div className="asm-toolbar">
        <button
          className={tool === 'select' ? 'asm-tool on' : 'asm-tool'}
          title="Select - click faces to pick joint references"
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
            <div className="asm-row">
              <span className="asm-name">{c.label}</span>
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

      <div className="asm-section">Joints</div>
      {tree?.joints.map((j) => (
        <div key={j.id} className="asm-row">
          <span className="asm-name">
            {j.label} · {j.type}
          </span>
        </div>
      ))}
      {(!tree || tree.joints.length === 0) && <div className="asm-hint">No joints yet.</div>}

      <div className="asm-jointbar">
        <select value={jointType} onChange={(e) => onSetJointType(e.target.value)}>
          {JOINT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button disabled={!canJoint} onClick={onAddJoint}>
          Add joint
        </button>
      </div>
      <div className="asm-hint small">
        {canJoint
          ? 'Ready: 2 faces on 2 components selected'
          : 'Select one face on each of two components'}
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

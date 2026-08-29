import type { AssemblyTree, Selection } from '../rpc'

const JOINT_TYPES = ['Fixed', 'Revolute', 'Cylindrical', 'Slider', 'Ball'] as const

/**
 * Assembly panel - components and joints. Component linking, placement and
 * grounding are live; joint solving is experimental headless (joints are
 * recorded and round-trip, the MbD solve needs a GUI session for now).
 */
export function AssemblyPanel({
  tree,
  selection,
  jointType,
  onSetJointType,
  onAddComponent,
  onGround,
  onAddJoint
}: {
  tree: AssemblyTree | null
  selection: Selection[]
  jointType: string
  onSetJointType: (t: string) => void
  onAddComponent: () => void
  onGround: (id: string) => void
  onAddJoint: () => void
}): JSX.Element {
  const faceSel = selection.filter((s) => s.kind === 'face')
  const canJoint = faceSel.length === 2 && faceSel[0].bodyId !== faceSel[1].bodyId

  return (
    <div className="asmpanel">
      <div className="asmpanel-head">
        <span className="asmpanel-title">ASSEMBLY</span>
        <button className="asmpanel-add" onClick={onAddComponent}>
          + Component
        </button>
      </div>

      <div className="asm-section">Components</div>
      {(!tree || tree.components.length === 0) && (
        <div className="asm-hint">Insert a saved design as a component.</div>
      )}
      {tree?.components.map((c) => (
        <div key={c.id} className="asm-row">
          <span className="asm-name">{c.label}</span>
          <button
            className={c.grounded ? 'asm-ground on' : 'asm-ground'}
            title="Ground (fix in place)"
            onClick={() => onGround(c.id)}
          >
            ⏚
          </button>
        </div>
      ))}

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

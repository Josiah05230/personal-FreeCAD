import { useState } from 'react'

const TABS = ['SOLID', 'SURFACE', 'MESH', 'SHEET METAL', 'ASSEMBLE', 'INSPECT', 'TOOLS'] as const

interface Cmd {
  label: string
  onClick?: () => void
  disabled?: boolean
}
interface CmdGroup {
  name: string
  cmds: Cmd[]
}

/** Placeholder ribbon: real command wiring arrives with Milestone 1. */
export function Ribbon({ onDemoPad }: { onDemoPad: () => void }): JSX.Element {
  const [tab, setTab] = useState<(typeof TABS)[number]>('SOLID')

  const groups: Record<string, CmdGroup[]> = {
    SOLID: [
      { name: 'Create', cmds: [
        { label: 'Extrude', onClick: onDemoPad },
        { label: 'Revolve', disabled: true },
        { label: 'Sweep', disabled: true },
        { label: 'Loft', disabled: true },
        { label: 'Rib', disabled: true },
        { label: 'Box', disabled: true }
      ] },
      { name: 'Modify', cmds: [
        { label: 'Fillet', disabled: true },
        { label: 'Chamfer', disabled: true },
        { label: 'Shell', disabled: true },
        { label: 'Draft', disabled: true },
        { label: 'Combine', disabled: true },
        { label: 'Press Pull', disabled: true }
      ] },
      { name: 'Pattern', cmds: [
        { label: 'Rectangular', disabled: true },
        { label: 'Circular', disabled: true },
        { label: 'Mirror', disabled: true }
      ] },
      { name: 'Construct', cmds: [
        { label: 'Offset Plane', disabled: true },
        { label: 'Axis', disabled: true },
        { label: 'Point', disabled: true }
      ] }
    ]
  }

  const activeGroups = groups[tab] ?? [{ name: '', cmds: [{ label: 'Not wired yet', disabled: true }] }]

  return (
    <div className="ribbon">
      <div className="ribbon-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={t === tab ? 'ribbon-tab active' : 'ribbon-tab'}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="ribbon-body">
        {activeGroups.map((g) => (
          <div className="ribbon-group" key={g.name}>
            <div className="ribbon-group-cmds">
              {g.cmds.map((c) => (
                <button
                  key={c.label}
                  className="ribbon-cmd"
                  disabled={c.disabled}
                  onClick={c.onClick}
                >
                  <span className="ribbon-cmd-icon" aria-hidden />
                  <span className="ribbon-cmd-label">{c.label}</span>
                </button>
              ))}
            </div>
            <div className="ribbon-group-name">{g.name}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

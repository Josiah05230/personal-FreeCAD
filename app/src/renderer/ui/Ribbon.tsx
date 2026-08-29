import { useState } from 'react'
import { Icon, type IconName } from './icons'

const TABS = ['SOLID', 'SURFACE', 'MESH', 'SHEET METAL', 'ASSEMBLE', 'INSPECT', 'TOOLS'] as const
type Tab = (typeof TABS)[number]

interface Cmd {
  label: string
  icon: IconName
  onClick?: () => void
  disabled?: boolean
}
interface Group {
  name: string
  cmds: Cmd[]
}

export function Ribbon({ onExtrude }: { onExtrude: () => void }): JSX.Element {
  const [tab, setTab] = useState<Tab>('SOLID')

  const groups: Partial<Record<Tab, Group[]>> = {
    SOLID: [
      {
        name: 'Create',
        cmds: [
          { label: 'Extrude', icon: 'extrude', onClick: onExtrude },
          { label: 'Revolve', icon: 'revolve', disabled: true },
          { label: 'Sweep', icon: 'sweep', disabled: true },
          { label: 'Loft', icon: 'loft', disabled: true },
          { label: 'Rib', icon: 'rib', disabled: true }
        ]
      },
      {
        name: 'Modify',
        cmds: [
          { label: 'Fillet', icon: 'fillet', disabled: true },
          { label: 'Chamfer', icon: 'chamfer', disabled: true },
          { label: 'Shell', icon: 'shell', disabled: true },
          { label: 'Draft', icon: 'draft', disabled: true },
          { label: 'Combine', icon: 'combine', disabled: true }
        ]
      },
      {
        name: 'Hole',
        cmds: [{ label: 'Hole', icon: 'hole', disabled: true }]
      },
      {
        name: 'Pattern',
        cmds: [
          { label: 'Rectangular', icon: 'patternRect', disabled: true },
          { label: 'Circular', icon: 'patternCirc', disabled: true },
          { label: 'Mirror', icon: 'mirror', disabled: true }
        ]
      },
      {
        name: 'Construct',
        cmds: [
          { label: 'Plane', icon: 'plane', disabled: true },
          { label: 'Axis', icon: 'axis', disabled: true },
          { label: 'Point', icon: 'point', disabled: true }
        ]
      },
      {
        name: 'Sketch',
        cmds: [{ label: 'Create Sketch', icon: 'sketch', disabled: true }]
      }
    ]
  }

  const active = groups[tab] ?? [
    { name: '', cmds: [{ label: 'Not wired yet', icon: 'point', disabled: true }] }
  ]

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
        {active.map((g, gi) => (
          <div className="ribbon-group" key={g.name || gi}>
            <div className="ribbon-group-cmds">
              {g.cmds.map((c) => {
                const Glyph = Icon[c.icon]
                return (
                  <button
                    key={c.label}
                    className="ribbon-cmd"
                    disabled={c.disabled}
                    onClick={c.onClick}
                  >
                    <span className="ribbon-cmd-icon">
                      <Glyph />
                    </span>
                    <span className="ribbon-cmd-label">{c.label}</span>
                  </button>
                )
              })}
            </div>
            <div className="ribbon-group-name">{g.name}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

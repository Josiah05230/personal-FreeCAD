import { useState } from 'react'
import type { BodyTree } from '../rpc'

function Row({
  depth,
  label,
  icon,
  children
}: {
  depth: number
  label: string
  icon: string
  children?: React.ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(true)
  const hasKids = !!children
  return (
    <div className="br-node">
      <div className="br-row" style={{ paddingLeft: 8 + depth * 14 }}>
        <span
          className={hasKids ? (open ? 'br-twist open' : 'br-twist') : 'br-twist none'}
          onClick={() => hasKids && setOpen(!open)}
        />
        <span className="br-icon">{icon}</span>
        <span className="br-label">{label}</span>
      </div>
      {open && children}
    </div>
  )
}

/** Fusion-style browser. Tree shape is fixed for Milestone 0. */
export function Browser({ bodies }: { bodies: BodyTree[] }): JSX.Element {
  return (
    <div className="browser">
      <Row depth={0} label="GWT-CAD" icon="▦">
        <Row depth={1} label="Document Settings" icon="⚙" />
        <Row depth={1} label="Named Views" icon="◱" />
        <Row depth={1} label="Origin" icon="✛">
          <Row depth={2} label="XY Plane" icon="▱" />
          <Row depth={2} label="XZ Plane" icon="▱" />
          <Row depth={2} label="YZ Plane" icon="▱" />
        </Row>
        <Row depth={1} label="Bodies" icon="▤">
          {bodies.map((b) => (
            <Row key={b.id} depth={2} label={b.label} icon="▨" />
          ))}
        </Row>
        <Row depth={1} label="Sketches" icon="✎">
          {bodies.flatMap((b) =>
            b.features
              .filter((f) => f.kind === 'sketch')
              .map((f) => <Row key={f.id} depth={2} label={f.label} icon="✎" />)
          )}
        </Row>
      </Row>
    </div>
  )
}

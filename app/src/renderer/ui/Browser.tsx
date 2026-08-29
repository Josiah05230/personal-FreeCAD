import { useState } from 'react'
import type { BodyTree } from '../rpc'

interface NodeProps {
  depth: number
  label: string
  glyph: string
  defaultOpen?: boolean
  children?: React.ReactNode
}

function Node({ depth, label, glyph, defaultOpen = true, children }: NodeProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const hasKids = Array.isArray(children) ? children.length > 0 : !!children
  return (
    <div className="br-node">
      <div
        className="br-row"
        style={{ paddingLeft: 6 + depth * 13 }}
        onClick={() => hasKids && setOpen(!open)}
      >
        <span className={hasKids ? (open ? 'br-tw open' : 'br-tw') : 'br-tw none'} />
        <span className="br-glyph">{glyph}</span>
        <span className="br-label">{label}</span>
      </div>
      {open && children}
    </div>
  )
}

/**
 * Floating browser panel - overlays the top-left of the canvas, sizes to
 * content, translucent. Not a docked sidebar.
 */
export function Browser({ bodies }: { bodies: BodyTree[] }): JSX.Element {
  const sketches = bodies.flatMap((b) => b.features.filter((f) => f.kind === 'sketch'))
  return (
    <div className="browser">
      <Node depth={0} label="Untitled" glyph="◈">
        <Node depth={1} label="Named Views" glyph="◱" defaultOpen={false} />
        <Node depth={1} label="Origin" glyph="✛" defaultOpen={false}>
          <Node depth={2} label="Front" glyph="▱" />
          <Node depth={2} label="Top" glyph="▱" />
          <Node depth={2} label="Right" glyph="▱" />
        </Node>
        <Node depth={1} label="Bodies" glyph="▨">
          {bodies.map((b) => (
            <Node key={b.id} depth={2} label={b.label} glyph="▬" />
          ))}
        </Node>
        {sketches.length > 0 && (
          <Node depth={1} label="Sketches" glyph="✎">
            {sketches.map((f) => (
              <Node key={f.id} depth={2} label={f.label} glyph="✎" />
            ))}
          </Node>
        )}
      </Node>
    </div>
  )
}

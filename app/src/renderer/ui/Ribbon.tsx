import { useMemo, useState } from 'react'
import type { Command } from '../commands'
import { Icon } from './icons'

const TABS = ['SOLID', 'SURFACE', 'MESH', 'SHEET METAL', 'ASSEMBLE', 'INSPECT', 'TOOLS'] as const
type Tab = (typeof TABS)[number]

export function Ribbon({
  commands,
  rightSlot
}: {
  commands: Command[]
  rightSlot?: React.ReactNode
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('SOLID')
  const [menu, setMenu] = useState<{ group: string; x: number; y: number } | null>(null)

  const groups = useMemo(() => {
    const forTab = commands.filter((c) => c.tab === tab)
    const order: string[] = []
    const map = new Map<string, Command[]>()
    for (const c of forTab) {
      if (!map.has(c.group)) {
        map.set(c.group, [])
        order.push(c.group)
      }
      map.get(c.group)!.push(c)
    }
    return order.map((name) => ({ name, cmds: map.get(name)! }))
  }, [commands, tab])

  const menuCmds = menu ? (groups.find((g) => g.name === menu.group)?.cmds ?? []) : []

  return (
    <div className="ribbon">
      <div className="ribbon-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={t === tab ? 'ribbon-tab active' : 'ribbon-tab'}
            onClick={() => {
              setTab(t)
              setMenu(null)
            }}
          >
            {t}
          </button>
        ))}
        <span className="ribbon-tabs-spacer" />
        {rightSlot}
      </div>
      <div className="ribbon-body">
        {groups.length === 0 && <div className="ribbon-none">Nothing on this tab yet</div>}
        {groups.map((g) => (
          <div className="ribbon-group" key={g.name}>
            <div className="ribbon-group-cmds">
              {g.cmds.map((c) => {
                const Glyph = Icon[c.icon]
                return (
                  <button
                    key={c.id}
                    className="ribbon-cmd"
                    disabled={!c.run}
                    title={c.hotkey ? `${c.title}  (${c.hotkey})` : c.title}
                    onClick={() => c.run?.()}
                  >
                    <span className="ribbon-cmd-icon">
                      <Glyph />
                    </span>
                    <span className="ribbon-cmd-label">{c.title}</span>
                  </button>
                )
              })}
            </div>
            <button
              className="ribbon-group-name"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setMenu(
                  menu?.group === g.name ? null : { group: g.name, x: r.left, y: r.bottom + 2 }
                )
              }}
            >
              {g.name} <span className="ribbon-group-caret">▾</span>
            </button>
          </div>
        ))}
      </div>

      {menu && (
        <>
          <div className="ribbon-dd-scrim" onClick={() => setMenu(null)} />
          <div className="ribbon-dd" style={{ left: menu.x, top: menu.y }}>
            {menuCmds.map((c) => {
              const Glyph = Icon[c.icon]
              return (
                <div
                  key={c.id}
                  className={c.run ? 'ribbon-dd-item' : 'ribbon-dd-item soon'}
                  onClick={() => {
                    if (c.run) {
                      c.run()
                      setMenu(null)
                    }
                  }}
                >
                  <span className="ribbon-dd-ic">
                    <Glyph />
                  </span>
                  <span>{c.title}</span>
                  {c.hotkey && <span className="ribbon-dd-key">{c.hotkey}</span>}
                  {!c.run && <span className="ribbon-dd-soon">soon</span>}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

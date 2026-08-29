import { useMemo, useState } from 'react'
import type { Command } from '../commands'
import { Icon } from './icons'

const TABS = ['SOLID', 'SURFACE', 'MESH', 'SHEET METAL', 'ASSEMBLE', 'INSPECT', 'TOOLS'] as const
type Tab = (typeof TABS)[number]

export function Ribbon({ commands }: { commands: Command[] }): JSX.Element {
  const [tab, setTab] = useState<Tab>('SOLID')
  const [openGroup, setOpenGroup] = useState<string | null>(null)

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

  return (
    <div className="ribbon">
      <div className="ribbon-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={t === tab ? 'ribbon-tab active' : 'ribbon-tab'}
            onClick={() => {
              setTab(t)
              setOpenGroup(null)
            }}
          >
            {t}
          </button>
        ))}
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
              onClick={() => setOpenGroup((v) => (v === g.name ? null : g.name))}
            >
              {g.name} <span className="ribbon-group-caret">▾</span>
            </button>
            {openGroup === g.name && (
              <>
                <div className="ribbon-dd-scrim" onClick={() => setOpenGroup(null)} />
                <div className="ribbon-dd">
                  {g.cmds.map((c) => {
                    const Glyph = Icon[c.icon]
                    return (
                      <div
                        key={c.id}
                        className={c.run ? 'ribbon-dd-item' : 'ribbon-dd-item soon'}
                        onClick={() => {
                          if (c.run) {
                            c.run()
                            setOpenGroup(null)
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
        ))}
      </div>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import type { Command } from '../commands'
import { Icon } from './icons'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { promptText } from './PromptDialog'
import { isPinned, normaliseCombo, type PinMap, type HotkeyMap } from '../ribbonPrefs'

const TABS = ['SOLID', 'SURFACE', 'MESH', 'SHEET METAL', 'ASSEMBLE', 'INSERT', 'TOOLS'] as const
type Tab = (typeof TABS)[number] | 'SKETCH'

export function Ribbon({
  commands,
  rightSlot,
  sketchMode = false,
  sketchPanel,
  pins,
  hotkeys,
  onSetPin,
  onSetHotkey,
  showAssemble = true
}: {
  commands: Command[]
  rightSlot?: React.ReactNode
  sketchMode?: boolean
  sketchPanel?: React.ReactNode
  pins: PinMap
  hotkeys: HotkeyMap
  onSetPin: (id: string, pinned: boolean) => void
  onSetHotkey: (id: string, combo: string | null) => void
  /** hide the ASSEMBLE tab until there is more than one body to assemble */
  showAssemble?: boolean
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('SOLID')
  const [menu, setMenu] = useState<{ group: string; x: number; y: number } | null>(null)
  const [ctx, setCtx] = useState<{ x: number; y: number; cmd: Command } | null>(null)

  const [prevTab, setPrevTab] = useState<Tab>('SOLID')
  useEffect(() => {
    if (sketchMode) {
      setPrevTab((p) => (tab === 'SKETCH' ? p : tab))
      setTab('SKETCH')
      setMenu(null)
    } else {
      setTab((t) => (t === 'SKETCH' ? prevTab : t))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sketchMode])

  // if the ASSEMBLE tab disappears while it is active, fall back to SOLID
  useEffect(() => {
    if (!showAssemble && tab === 'ASSEMBLE') {
      setTab('SOLID')
      setMenu(null)
    }
  }, [showAssemble, tab])

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
  const hk = (c: Command): string | undefined => hotkeys[c.id] ?? c.hotkey
  const promptHotkey = async (c: Command): Promise<void> => {
    const next = await promptText(
      `Hotkey for "${c.title}" (e.g. shift+e, blank to clear)`,
      hk(c) ?? ''
    )
    if (next === null) return
    onSetHotkey(c.id, next.trim() ? normaliseCombo(next) : null)
  }
  const cmdMenu = (c: Command): MenuItem[] => [
    isPinned(c.id, pins)
      ? { label: 'Unpin from ribbon', onClick: () => onSetPin(c.id, false) }
      : { label: 'Pin to ribbon', onClick: () => onSetPin(c.id, true) },
    { label: 'Set hotkey…', onClick: () => promptHotkey(c) },
    ...(hk(c) ? [{ label: 'Clear hotkey', onClick: () => onSetHotkey(c.id, null) }] : [])
  ]

  const baseTabs = TABS.filter((t) => t !== 'ASSEMBLE' || showAssemble)
  const tabList: Tab[] = sketchMode ? [...baseTabs, 'SKETCH'] : [...baseTabs]

  return (
    <div className="ribbon">
      <div className="ribbon-tabs">
        {tabList.map((t) => (
          <button
            key={t}
            className={
              (t === tab ? 'ribbon-tab active' : 'ribbon-tab') +
              (t === 'SKETCH' ? ' contextual' : '')
            }
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
      {tab === 'SKETCH' ? (
        sketchPanel
      ) : (
        <div className="ribbon-body">
          {groups.length === 0 && <div className="ribbon-none">Nothing on this tab yet</div>}
          {groups.map((g) => {
            const pinned = g.cmds.filter((c) => isPinned(c.id, pins))
            return (
              <div className="ribbon-group" key={g.name}>
                <div className="ribbon-group-cmds">
                  {pinned.length === 0 && <div className="ribbon-group-empty">▾</div>}
                  {pinned.map((c) => {
                    if (c.component) return <div key={c.id}>{c.component}</div>
                    const Glyph = Icon[c.icon]
                    return (
                      <button
                        key={c.id}
                        className="ribbon-cmd"
                        disabled={!c.run}
                        title={hk(c) ? `${c.title}  (${hk(c)})` : c.title}
                        onClick={() => c.run?.()}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setCtx({ x: e.clientX, y: e.clientY, cmd: c })
                        }}
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
            )
          })}
        </div>
      )}

      {menu && tab !== 'SKETCH' && (
        <>
          <div className="ribbon-dd-scrim" onClick={() => setMenu(null)} />
          <div className="ribbon-dd" style={{ left: menu.x, top: menu.y }}>
            {menuCmds.map((c) => {
              const Glyph = Icon[c.icon]
              const p = isPinned(c.id, pins)
              return (
                <div
                  key={c.id}
                  className={c.run ? 'ribbon-dd-item' : 'ribbon-dd-item soon'}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setCtx({ x: e.clientX, y: e.clientY, cmd: c })
                  }}
                >
                  <span
                    className="ribbon-dd-body"
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
                    {hk(c) && <span className="ribbon-dd-key">{hk(c)}</span>}
                    {!c.run && <span className="ribbon-dd-soon">soon</span>}
                  </span>
                  <span
                    className={p ? 'ribbon-dd-pin on' : 'ribbon-dd-pin'}
                    title={p ? 'Pinned - click to unpin' : 'Pin to ribbon'}
                    onClick={() => onSetPin(c.id, !p)}
                  >
                    📌
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}

      {ctx && (
        <ContextMenu x={ctx.x} y={ctx.y} items={cmdMenu(ctx.cmd)} onClose={() => setCtx(null)} />
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { api, type Param } from '../rpc'

/**
 * Named user parameters. Any dimension input (feature dialogs today) accepts a
 * parameter name or an expression referencing one, e.g. `bore/2 + 1mm`.
 */
export function ParametersPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [params, setParams] = useState<Param[]>([])
  const [name, setName] = useState('')
  const [expr, setExpr] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const load = (): void => {
    void api
      .paramsList()
      .then((r) => setParams(r.params))
      .catch((e) => setErr((e as Error).message))
  }
  useEffect(load, [])

  const add = async (): Promise<void> => {
    if (!name.trim() || !expr.trim()) return
    try {
      const r = await api.paramsSet(name.trim(), expr.trim())
      setParams(r.params)
      setName('')
      setExpr('')
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const edit = async (n: string, e: string): Promise<void> => {
    try {
      setParams((await api.paramsSet(n, e)).params)
      setErr(null)
    } catch (ex) {
      setErr((ex as Error).message)
    }
  }

  const remove = async (n: string): Promise<void> => {
    setParams((await api.paramsDelete(n)).params)
  }

  return (
    <div className="params-panel">
      <div className="params-head">
        <span>PARAMETERS</span>
        <button onClick={onClose} title="Close">
          ×
        </button>
      </div>
      <div className="params-list">
        <div className="params-row params-hd">
          <span>Name</span>
          <span>Expression</span>
          <span>Value</span>
          <span />
        </div>
        {params.map((p) => (
          <div key={p.name} className="params-row">
            <span className="params-name">{p.name}</span>
            <input
              defaultValue={p.expr}
              onBlur={(e) => e.target.value !== p.expr && void edit(p.name, e.target.value)}
            />
            <span className="params-val">{p.value == null ? '—' : Number(p.value.toFixed(4))}</span>
            <button className="params-del" title="Delete" onClick={() => void remove(p.name)}>
              ×
            </button>
          </div>
        ))}
        {!params.length && <div className="params-empty">No parameters yet</div>}
      </div>
      <div className="params-add">
        <input
          placeholder="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          placeholder="expression (e.g. 4in + 2mm)"
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <button onClick={() => void add()}>Add</button>
      </div>
      {err && <div className="params-err">{err}</div>}
    </div>
  )
}

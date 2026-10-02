/**
 * Superseded revisions. Every revision of a part is its own file
 * (<seq><rev>.FCStd, e.g. PSJ0010 then PSJ0011) and the old ones stay on
 * disk, but only the newest is meant to be browsed or opened - older ones
 * are viewed read-only from the newest one's History panel.
 */

/** "PSJ0011.FCStd" / "PSJ0011.step" / "PSJ0011_supplier_meta.json" -> PSJ001 + 1 */
export function pnOfFilename(name: string): { seq: string; rev: number; pn: string } | null {
  const m = /^\.?([A-Za-z]+\d{3})(\d+)(?=[._]|$)/.exec(name)
  if (!m) return null
  return { seq: m[1].toUpperCase(), rev: Number(m[2]), pn: `${m[1]}${m[2]}`.toUpperCase() }
}

/** current revision per sequence, from pn.listAll rows (which are current rows only) */
export function currentRevs(rows: { pn_seq: string; rev: string; pn: string }[]): Map<string, { rev: number; pn: string }> {
  const m = new Map<string, { rev: number; pn: string }>()
  for (const r of rows) m.set(r.pn_seq.toUpperCase(), { rev: Number(r.rev), pn: r.pn })
  return m
}

/** the current PN when this file belongs to an older revision of a part, else null */
export function supersededBy(name: string, current: Map<string, { rev: number; pn: string }>): string | null {
  const f = pnOfFilename(name)
  if (!f) return null
  const cur = current.get(f.seq)
  return cur && f.rev < cur.rev ? cur.pn : null
}

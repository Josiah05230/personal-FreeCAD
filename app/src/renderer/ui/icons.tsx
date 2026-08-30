/**
 * Command glyphs. Simple 20x20 line icons in the Fusion spirit: a light stroke
 * with a single accent fill where it helps read the shape. Not the real Fusion
 * art (that is proprietary) - our own set, same visual weight.
 */
import type { SVGProps } from 'react'

const S = (props: SVGProps<SVGSVGElement>) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  />
)

const ACCENT = '#f0a91b'

export const Icon = {
  sketch: () => (
    <S>
      <path d="M3 15 L9 5 L13 12 L17 8" />
      <circle cx="3" cy="15" r="1.3" fill={ACCENT} stroke="none" />
      <circle cx="17" cy="8" r="1.3" fill={ACCENT} stroke="none" />
    </S>
  ),
  extrude: () => (
    <S>
      <rect x="3" y="9" width="8" height="8" />
      <path d="M3 9 L7 4 L15 4 L11 9" />
      <path d="M11 17 L15 12 L15 4" />
      <path d="M13 2.5 L13 6 M11.5 4 L13 2.2 L14.5 4" stroke={ACCENT} />
    </S>
  ),
  revolve: () => (
    <S>
      <line x1="4" y1="3" x2="4" y2="17" strokeDasharray="2 2" />
      <path d="M7 5 h6 v10 h-6" />
      <path d="M7 5 C 1 8, 1 12, 7 15" stroke={ACCENT} />
    </S>
  ),
  sweep: () => (
    <S>
      <path d="M3 16 C 6 6, 12 6, 17 4" stroke={ACCENT} />
      <rect x="1.5" y="13.5" width="5" height="5" transform="rotate(-12 4 16)" />
    </S>
  ),
  loft: () => (
    <S>
      <ellipse cx="6" cy="14" rx="4" ry="2" />
      <rect x="11" y="3" width="6" height="6" />
      <path d="M3 13 L11 6 M10 15 L17 9" stroke={ACCENT} />
    </S>
  ),
  hole: () => (
    <S>
      <rect x="3" y="3" width="14" height="14" rx="1" />
      <circle cx="10" cy="10" r="3.2" fill={ACCENT} stroke="none" />
      <circle cx="10" cy="10" r="3.2" />
    </S>
  ),
  fillet: () => (
    <S>
      <path d="M4 17 L4 9 C 4 6, 6 4, 11 4 L17 4" />
      <path d="M4 4 L4 17 L17 17" strokeDasharray="2 2" opacity="0.5" />
      <path d="M4 9 C 4 6, 6 4, 11 4" stroke={ACCENT} />
    </S>
  ),
  chamfer: () => (
    <S>
      <path d="M4 17 L4 8 L11 4 L17 4" />
      <path d="M4 8 L11 4" stroke={ACCENT} />
    </S>
  ),
  shell: () => (
    <S>
      <rect x="3" y="3" width="14" height="14" rx="1" />
      <rect x="6.5" y="6.5" width="7" height="7" rx="0.5" stroke={ACCENT} />
    </S>
  ),
  draft: () => (
    <S>
      <path d="M5 17 L8 4 L13 4 L16 17 Z" />
      <path d="M8 4 L5 17" stroke={ACCENT} />
    </S>
  ),
  rib: () => (
    <S>
      <path d="M3 5 L3 15 M17 5 L17 15" />
      <path d="M3 15 L10 8 L17 15" stroke={ACCENT} />
    </S>
  ),
  combine: () => (
    <S>
      <circle cx="8" cy="10" r="5" />
      <circle cx="12" cy="10" r="5" stroke={ACCENT} />
    </S>
  ),
  patternRect: () => (
    <S>
      {[4, 11].flatMap((x) =>
        [4, 11].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="5" height="5" />)
      )}
      <path d="M4 2.5 h12 M2.5 4 v12" stroke={ACCENT} />
    </S>
  ),
  patternCirc: () => (
    <S>
      <circle cx="10" cy="10" r="7" stroke={ACCENT} strokeDasharray="2 2" />
      {[0, 120, 240].map((a) => {
        const r = (a * Math.PI) / 180
        return (
          <rect
            key={a}
            x={10 + Math.cos(r) * 7 - 2}
            y={10 + Math.sin(r) * 7 - 2}
            width="4"
            height="4"
          />
        )
      })}
    </S>
  ),
  mirror: () => (
    <S>
      <line x1="10" y1="3" x2="10" y2="17" strokeDasharray="2 2" stroke={ACCENT} />
      <path d="M7 6 L3 10 L7 14 Z" />
      <path d="M13 6 L17 10 L13 14 Z" />
    </S>
  ),
  plane: () => (
    <S>
      <path d="M3 7 L13 5 L17 13 L7 15 Z" fill={ACCENT} fillOpacity="0.18" />
    </S>
  ),
  axis: () => (
    <S>
      <line x1="3" y1="17" x2="17" y2="3" stroke={ACCENT} />
      <circle cx="3" cy="17" r="1.3" fill="currentColor" stroke="none" />
    </S>
  ),
  point: () => (
    <S>
      <circle cx="10" cy="10" r="2" fill={ACCENT} stroke="none" />
      <path d="M10 3 v3 M10 14 v3 M3 10 h3 M14 10 h3" />
    </S>
  ),
  canvas: () => (
    <S>
      <rect x="3" y="5" width="14" height="11" rx="1.5" />
      <path d="M7 5 l1.4 -2 h3.2 L16 5" />
      <circle cx="10" cy="10.5" r="3" fill={ACCENT} fillOpacity="0.18" />
    </S>
  )
}

export type IconName = keyof typeof Icon

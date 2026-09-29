/**
 * How the Insert Decal panel sizes an image: by one dimension in mm (width,
 * height, the long edge or the short edge) or by its print resolution in
 * pixels per mm. The other dimension always follows from the image's pixel
 * aspect, so a decal is never stretched.
 */
export type DecalSizeMode = 'width' | 'height' | 'long' | 'short' | 'pxPerMm'

export const DECAL_SIZE_MODES: { id: DecalSizeMode; label: string; unit: string }[] = [
  { id: 'width', label: 'Width', unit: 'mm' },
  { id: 'height', label: 'Height', unit: 'mm' },
  { id: 'long', label: 'Long edge', unit: 'mm' },
  { id: 'short', label: 'Short edge', unit: 'mm' },
  { id: 'pxPerMm', label: 'Resolution', unit: 'px/mm' }
]

/** Width x height in mm, or null if the inputs can't give a real size. */
export function decalSize(
  mode: DecalSizeMode,
  value: number,
  pxW: number,
  pxH: number
): { widthMm: number; heightMm: number } | null {
  if (!(value > 0) || !(pxW > 0) || !(pxH > 0)) return null
  const aspect = pxH / pxW
  let w: number
  switch (mode) {
    case 'width':
      w = value
      break
    case 'height':
      w = value / aspect
      break
    case 'long':
      w = pxW >= pxH ? value : value / aspect
      break
    case 'short':
      w = pxW <= pxH ? value : value / aspect
      break
    case 'pxPerMm':
      w = pxW / value
      break
  }
  return { widthMm: w, heightMm: w * aspect }
}

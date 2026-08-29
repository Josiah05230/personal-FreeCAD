export interface ViewportApi {
  fit: () => void
  setView: (dir: [number, number, number]) => void
}

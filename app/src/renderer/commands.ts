/**
 * Central command registry. One definition per tool, consumed by the ribbon, the
 * command palette ('s'), and (later) the marking menu.
 */
import type { IconName } from './ui/icons'
import type { OpKind } from './ui/OperationDialog'

export interface Command {
  id: string
  title: string
  group: string
  tab: string
  icon: IconName
  hotkey?: string
  /** undefined => not yet implemented (shown disabled, still searchable). */
  run?: () => void | Promise<void>
}

export interface CommandContext {
  openOp: (kind: OpKind) => void
  sweep: () => Promise<void>
  createSketch: () => Promise<void>
  newDesign: () => void
  open: () => Promise<void>
  save: () => Promise<void>
  saveAs: () => Promise<void>
  exportModel: () => Promise<void>
  importStep: () => Promise<void>
  fitView: () => void
  toggleData: () => void
  toggleGit: () => void
  startDrawing: () => Promise<void>
  startMeasure: () => void
  toggleSection: () => void
}

export function buildCommands(ctx: CommandContext): Command[] {
  const op = (k: OpKind) => () => ctx.openOp(k)
  return [
    // --- create ---
    { id: 'sketch.create', title: 'Create Sketch', group: 'Create', tab: 'SOLID', icon: 'sketch', hotkey: 'c s', run: () => ctx.createSketch() },
    { id: 'solid.extrude', title: 'Extrude', group: 'Create', tab: 'SOLID', icon: 'extrude', hotkey: 'e', run: op('extrude') },
    { id: 'solid.revolve', title: 'Revolve', group: 'Create', tab: 'SOLID', icon: 'revolve', run: op('revolve') },
    { id: 'solid.loft', title: 'Loft', group: 'Create', tab: 'SOLID', icon: 'loft', run: op('loft') },
    { id: 'solid.sweep', title: 'Sweep', group: 'Create', tab: 'SOLID', icon: 'sweep', run: () => ctx.sweep() },
    { id: 'prim.box', title: 'Box', group: 'Create', tab: 'SOLID', icon: 'extrude', run: op('box') },
    { id: 'prim.cyl', title: 'Cylinder', group: 'Create', tab: 'SOLID', icon: 'revolve', run: op('cylinder') },
    // --- modify ---
    { id: 'mod.fillet', title: 'Fillet', group: 'Modify', tab: 'SOLID', icon: 'fillet', hotkey: 'f', run: op('fillet') },
    { id: 'mod.chamfer', title: 'Chamfer', group: 'Modify', tab: 'SOLID', icon: 'chamfer', run: op('chamfer') },
    { id: 'mod.shell', title: 'Shell', group: 'Modify', tab: 'SOLID', icon: 'shell', run: op('shell') },
    { id: 'mod.hole', title: 'Hole', group: 'Modify', tab: 'SOLID', icon: 'hole', run: op('hole') },
    { id: 'mod.draft', title: 'Draft', group: 'Modify', tab: 'SOLID', icon: 'draft', run: op('draft') },
    { id: 'mod.combine', title: 'Combine', group: 'Modify', tab: 'SOLID', icon: 'combine', run: op('combine') },
    // --- pattern ---
    { id: 'pat.rect', title: 'Rectangular Pattern', group: 'Pattern', tab: 'SOLID', icon: 'patternRect', run: op('patternLinear') },
    { id: 'pat.circ', title: 'Circular Pattern', group: 'Pattern', tab: 'SOLID', icon: 'patternCirc', run: op('patternCircular') },
    { id: 'pat.mirror', title: 'Mirror', group: 'Pattern', tab: 'SOLID', icon: 'mirror', run: op('mirror') },
    // --- construct ---
    { id: 'con.plane', title: 'Offset Plane', group: 'Construct', tab: 'SOLID', icon: 'plane', run: op('datumPlane') },
    { id: 'con.axis', title: 'Construction Axis', group: 'Construct', tab: 'SOLID', icon: 'axis' },
    { id: 'con.point', title: 'Construction Point', group: 'Construct', tab: 'SOLID', icon: 'point' },
    // --- assemble ---
    { id: 'asm.newComponent', title: 'New Component', group: 'Assemble', tab: 'ASSEMBLE', icon: 'combine' },
    { id: 'asm.joint', title: 'Joint', group: 'Assemble', tab: 'ASSEMBLE', icon: 'axis' },
    { id: 'asm.rigidGroup', title: 'Rigid Group', group: 'Assemble', tab: 'ASSEMBLE', icon: 'combine' },
    // --- inspect ---
    { id: 'insp.measure', title: 'Measure', group: 'Inspect', tab: 'INSPECT', icon: 'axis', hotkey: 'm', run: () => ctx.startMeasure() },
    { id: 'insp.section', title: 'Section Analysis', group: 'Inspect', tab: 'INSPECT', icon: 'plane', run: () => ctx.toggleSection() },
    // --- drawing ---
    { id: 'draw.fromDesign', title: 'Drawing from Design', group: 'Drawing', tab: 'TOOLS', icon: 'sketch', run: () => ctx.startDrawing() },
    // --- file / view ---
    { id: 'file.new', title: 'New Design', group: 'File', tab: 'TOOLS', icon: 'point', hotkey: 'ctrl n', run: () => ctx.newDesign() },
    { id: 'file.open', title: 'Open…', group: 'File', tab: 'TOOLS', icon: 'point', hotkey: 'ctrl o', run: () => ctx.open() },
    { id: 'file.save', title: 'Save', group: 'File', tab: 'TOOLS', icon: 'point', hotkey: 'ctrl s', run: () => ctx.save() },
    { id: 'file.saveAs', title: 'Save As…', group: 'File', tab: 'TOOLS', icon: 'point', run: () => ctx.saveAs() },
    { id: 'file.export', title: 'Export (STEP / STL)…', group: 'File', tab: 'TOOLS', icon: 'point', run: () => ctx.exportModel() },
    { id: 'file.import', title: 'Import STEP…', group: 'File', tab: 'TOOLS', icon: 'point', run: () => ctx.importStep() },
    { id: 'view.fit', title: 'Fit View', group: 'View', tab: 'TOOLS', icon: 'point', hotkey: 'f6', run: () => ctx.fitView() },
    { id: 'panel.data', title: 'Toggle Data Panel', group: 'View', tab: 'TOOLS', icon: 'point', run: () => ctx.toggleData() },
    { id: 'panel.git', title: 'Toggle History (Git)', group: 'View', tab: 'TOOLS', icon: 'point', run: () => ctx.toggleGit() }
  ]
}

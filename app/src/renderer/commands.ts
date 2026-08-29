/**
 * Central command registry. One definition per tool, consumed by the ribbon, the
 * command palette ('s'), and (later) the marking menu. Keeps naming and wiring in
 * one place so nothing drifts.
 */
import type { IconName } from './ui/icons'

export interface Command {
  id: string
  title: string
  group: string
  tab: string
  icon: IconName
  hotkey?: string
  /** undefined => not yet implemented (shows disabled, still searchable). */
  run?: () => void | Promise<void>
}

export interface CommandContext {
  extrude: () => Promise<void>
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
}

export function buildCommands(ctx: CommandContext): Command[] {
  return [
    // --- create ---
    { id: 'sketch.create', title: 'Create Sketch', group: 'Create', tab: 'SOLID', icon: 'sketch', hotkey: 'c s', run: () => ctx.createSketch() },
    { id: 'solid.extrude', title: 'Extrude', group: 'Create', tab: 'SOLID', icon: 'extrude', hotkey: 'e', run: () => ctx.extrude() },
    { id: 'solid.revolve', title: 'Revolve', group: 'Create', tab: 'SOLID', icon: 'revolve' },
    { id: 'solid.sweep', title: 'Sweep', group: 'Create', tab: 'SOLID', icon: 'sweep' },
    { id: 'solid.loft', title: 'Loft', group: 'Create', tab: 'SOLID', icon: 'loft' },
    { id: 'solid.rib', title: 'Rib', group: 'Create', tab: 'SOLID', icon: 'rib' },
    // --- modify ---
    { id: 'mod.fillet', title: 'Fillet', group: 'Modify', tab: 'SOLID', icon: 'fillet', hotkey: 'f' },
    { id: 'mod.chamfer', title: 'Chamfer', group: 'Modify', tab: 'SOLID', icon: 'chamfer' },
    { id: 'mod.shell', title: 'Shell', group: 'Modify', tab: 'SOLID', icon: 'shell' },
    { id: 'mod.draft', title: 'Draft', group: 'Modify', tab: 'SOLID', icon: 'draft' },
    { id: 'mod.combine', title: 'Combine', group: 'Modify', tab: 'SOLID', icon: 'combine' },
    { id: 'mod.hole', title: 'Hole', group: 'Modify', tab: 'SOLID', icon: 'hole' },
    // --- pattern ---
    { id: 'pat.rect', title: 'Rectangular Pattern', group: 'Pattern', tab: 'SOLID', icon: 'patternRect' },
    { id: 'pat.circ', title: 'Circular Pattern', group: 'Pattern', tab: 'SOLID', icon: 'patternCirc' },
    { id: 'pat.mirror', title: 'Mirror', group: 'Pattern', tab: 'SOLID', icon: 'mirror' },
    // --- construct ---
    { id: 'con.plane', title: 'Offset Plane', group: 'Construct', tab: 'SOLID', icon: 'plane' },
    { id: 'con.axis', title: 'Construction Axis', group: 'Construct', tab: 'SOLID', icon: 'axis' },
    { id: 'con.point', title: 'Construction Point', group: 'Construct', tab: 'SOLID', icon: 'point' },
    // --- assemble ---
    { id: 'asm.newComponent', title: 'New Component', group: 'Assemble', tab: 'ASSEMBLE', icon: 'combine' },
    { id: 'asm.joint', title: 'Joint', group: 'Assemble', tab: 'ASSEMBLE', icon: 'axis' },
    { id: 'asm.rigidGroup', title: 'Rigid Group', group: 'Assemble', tab: 'ASSEMBLE', icon: 'combine' },
    // --- inspect ---
    { id: 'insp.measure', title: 'Measure', group: 'Inspect', tab: 'INSPECT', icon: 'axis' },
    { id: 'insp.section', title: 'Section Analysis', group: 'Inspect', tab: 'INSPECT', icon: 'plane' },
    // --- file / view (searchable, some wired) ---
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

/**
 * Central command registry. One definition per tool, consumed by the ribbon, the
 * command palette ('s'), and (later) the marking menu.
 */
import type { ReactNode } from 'react'
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
  /** if set, the ribbon renders this instead of a button (e.g. the Select menu) */
  component?: ReactNode
  /** if set, the group's fold-out renders this instead of command rows */
  menuComponent?: ReactNode
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
  scale: () => Promise<void>
  interference: () => void
  centerOfMass: () => void
  insertCanvas: () => Promise<void>
  toggleParams: () => void
  importKicad: () => Promise<void>
  reimportKicad: () => Promise<void>
  surfaceRuled: () => Promise<void>
  surfaceFill: () => Promise<void>
  surfaceStitch: () => Promise<void>
  surfaceOffset: () => Promise<void>
  addComponent: () => Promise<void>
  addJoint: () => Promise<void>
  selectFilterNode: ReactNode
  selectFilterMenuNode: ReactNode
}

export function buildCommands(ctx: CommandContext): Command[] {
  const op = (k: OpKind) => () => ctx.openOp(k)
  return [
    // --- create ---
    { id: 'sketch.create', title: 'Create Sketch', group: 'Create', tab: 'SOLID', icon: 'sketch', hotkey: 'c s', run: () => ctx.createSketch() },
    { id: 'solid.extrude', title: 'Extrude', group: 'Create', tab: 'SOLID', icon: 'extrude', hotkey: 'e', run: op('extrude') },
    { id: 'solid.revolve', title: 'Revolve', group: 'Create', tab: 'SOLID', icon: 'revolve', run: op('revolve') },
    { id: 'solid.sweep', title: 'Sweep', group: 'Create', tab: 'SOLID', icon: 'sweep', run: () => ctx.sweep() },
    { id: 'solid.loft', title: 'Loft', group: 'Create', tab: 'SOLID', icon: 'loft', run: op('loft') },
    { id: 'solid.rib', title: 'Rib', group: 'Create', tab: 'SOLID', icon: 'extrude', run: op('rib') },
    { id: 'solid.hole', title: 'Hole', group: 'Create', tab: 'SOLID', icon: 'hole', run: op('hole') },
    { id: 'solid.box', title: 'Box', group: 'Create', tab: 'SOLID', icon: 'extrude', run: op('box') },
    { id: 'solid.cylinder', title: 'Cylinder', group: 'Create', tab: 'SOLID', icon: 'revolve', run: op('cylinder') },
    { id: 'solid.sphere', title: 'Sphere', group: 'Create', tab: 'SOLID', icon: 'revolve', run: op('sphere') },
    { id: 'solid.torus', title: 'Torus', group: 'Create', tab: 'SOLID', icon: 'revolve', run: op('torus') },
    { id: 'solid.coil', title: 'Coil', group: 'Create', tab: 'SOLID', icon: 'revolve', run: op('coil') },
    { id: 'solid.pipe', title: 'Pipe', group: 'Create', tab: 'SOLID', icon: 'sweep', run: op('pipe') },
    // --- surface ---
    { id: 'surf.ruled', title: 'Ruled Surface', group: 'Create', tab: 'SURFACE', icon: 'loft', run: () => ctx.surfaceRuled() },
    { id: 'surf.fill', title: 'Boundary Fill', group: 'Create', tab: 'SURFACE', icon: 'plane', run: () => ctx.surfaceFill() },
    { id: 'surf.stitch', title: 'Stitch', group: 'Modify', tab: 'SURFACE', icon: 'combine', run: () => ctx.surfaceStitch() },
    { id: 'surf.offset', title: 'Offset Surface', group: 'Modify', tab: 'SURFACE', icon: 'draft', run: () => ctx.surfaceOffset() },
    { id: 'surf.split', title: 'Trim / Split', group: 'Modify', tab: 'SURFACE', icon: 'plane', run: op('splitBody') },
    // Split Body is a solid op - it also lives on the SOLID tab
    { id: 'mod.splitBody', title: 'Split Body', group: 'Modify', tab: 'SOLID', icon: 'plane', run: op('splitBody') },
    // --- sheet metal ---
    { id: 'sm.base', title: 'Base Flange', group: 'Create', tab: 'SHEET METAL', icon: 'extrude', run: op('baseFlange') },
    // --- modify ---
    { id: 'mod.pressPull', title: 'Press Pull', group: 'Modify', tab: 'SOLID', icon: 'draft', hotkey: 'q', run: op('pressPull') },
    { id: 'mod.fillet', title: 'Fillet', group: 'Modify', tab: 'SOLID', icon: 'fillet', hotkey: 'f', run: op('fillet') },
    { id: 'mod.chamfer', title: 'Chamfer', group: 'Modify', tab: 'SOLID', icon: 'chamfer', run: op('chamfer') },
    { id: 'mod.shell', title: 'Shell', group: 'Modify', tab: 'SOLID', icon: 'shell', run: op('shell') },
    { id: 'mod.draft', title: 'Draft', group: 'Modify', tab: 'SOLID', icon: 'draft', run: op('draft') },
    { id: 'mod.scale', title: 'Scale', group: 'Modify', tab: 'SOLID', icon: 'patternRect', run: op('scale') },
    { id: 'mod.combine', title: 'Combine', group: 'Modify', tab: 'SOLID', icon: 'combine', run: op('combine') },
    { id: 'mod.offsetFace', title: 'Offset Face', group: 'Modify', tab: 'SOLID', icon: 'draft', run: op('offsetFace') },
    { id: 'mod.splitFace', title: 'Split Face', group: 'Modify', tab: 'SOLID', icon: 'plane', run: op('splitFace') },
    { id: 'mod.move', title: 'Move/Copy', group: 'Modify', tab: 'SOLID', icon: 'patternRect', run: op('move') },
    { id: 'mod.align', title: 'Align', group: 'Modify', tab: 'SOLID', icon: 'combine', run: op('align') },
    // --- pattern ---
    { id: 'pat.rect', title: 'Rectangular Pattern', group: 'Pattern', tab: 'SOLID', icon: 'patternRect', run: op('patternLinear') },
    { id: 'pat.circ', title: 'Circular Pattern', group: 'Pattern', tab: 'SOLID', icon: 'patternCirc', run: op('patternCircular') },
    { id: 'pat.mirror', title: 'Mirror', group: 'Pattern', tab: 'SOLID', icon: 'mirror', run: op('mirror') },
    // --- construct ---
    { id: 'con.plane', title: 'Plane', group: 'Construct', tab: 'SOLID', icon: 'plane', run: op('datumPlane') },
    { id: 'con.axis', title: 'Axis', group: 'Construct', tab: 'SOLID', icon: 'axis', run: op('datumAxis') },
    { id: 'con.point', title: 'Point', group: 'Construct', tab: 'SOLID', icon: 'point', run: op('datumPoint') },
    // --- select (F360-style group on the SOLID tab) ---
    { id: 'sel.filter', title: 'Select', group: 'Select', tab: 'SOLID', icon: 'point', component: ctx.selectFilterNode, menuComponent: ctx.selectFilterMenuNode },
    // --- insert (lives on the SOLID tab, Fusion-style) ---
    { id: 'ins.canvas', title: 'Canvas', group: 'Insert', tab: 'SOLID', icon: 'canvas', run: () => ctx.insertCanvas() },
    { id: 'ins.model', title: 'Insert 3D Model', group: 'Insert', tab: 'SOLID', icon: 'extrude', run: () => ctx.importStep() },
    { id: 'ins.kicad', title: 'Import KiCad PCB', group: 'Insert', tab: 'SOLID', icon: 'combine', run: () => ctx.importKicad() },
    { id: 'ins.kicadSync', title: 'Re-sync KiCad PCB', group: 'Insert', tab: 'SOLID', icon: 'combine', run: () => ctx.reimportKicad() },
    // --- assemble ---
    { id: 'asm.newComponent', title: 'Insert Component', group: 'Assemble', tab: 'ASSEMBLE', icon: 'combine', run: () => ctx.addComponent() },
    { id: 'asm.joint', title: 'Joint', group: 'Assemble', tab: 'ASSEMBLE', icon: 'axis', run: () => ctx.addJoint() },
    { id: 'asm.rigidGroup', title: 'Rigid Group', group: 'Assemble', tab: 'ASSEMBLE', icon: 'combine' },
    // --- inspect (a group on SOLID, F360-style) ---
    { id: 'insp.measure', title: 'Measure', group: 'Inspect', tab: 'SOLID', icon: 'axis', hotkey: 'm', run: () => ctx.startMeasure() },
    { id: 'insp.section', title: 'Section', group: 'Inspect', tab: 'SOLID', icon: 'plane', run: () => ctx.toggleSection() },
    { id: 'insp.interference', title: 'Interference', group: 'Inspect', tab: 'SOLID', icon: 'combine', run: () => ctx.interference() },
    { id: 'insp.com', title: 'Center of Mass', group: 'Inspect', tab: 'SOLID', icon: 'point', run: () => ctx.centerOfMass() },
    // --- MESH tab (Fusion mesh workspace) ---
    { id: 'mesh.fromBRep', title: 'BRep to Mesh', group: 'Create', tab: 'MESH', icon: 'extrude', run: op('meshFromBRep') },
    { id: 'mesh.insert', title: 'Insert Mesh', group: 'Create', tab: 'MESH', icon: 'point', run: () => ctx.importStep() },
    { id: 'mesh.reduce', title: 'Reduce', group: 'Modify', tab: 'MESH', icon: 'patternRect', run: op('meshReduce') },
    { id: 'mesh.smooth', title: 'Smooth', group: 'Modify', tab: 'MESH', icon: 'draft', run: op('meshSmooth') },
    { id: 'mesh.planeCut', title: 'Plane Cut', group: 'Modify', tab: 'MESH', icon: 'plane', run: op('meshPlaneCut') },
    { id: 'mesh.flipNormals', title: 'Reverse Normals', group: 'Modify', tab: 'MESH', icon: 'draft', run: op('meshFlipNormals') },
    { id: 'mesh.repair', title: 'Repair', group: 'Modify', tab: 'MESH', icon: 'combine', run: op('meshRepair') },
    { id: 'mesh.separate', title: 'Separate', group: 'Modify', tab: 'MESH', icon: 'combine', run: op('meshSeparate') },
    { id: 'mesh.toSolid', title: 'Convert Mesh', group: 'BRep', tab: 'MESH', icon: 'extrude', run: op('meshToSolid') },
    { id: 'mod.params', title: 'Parameters', group: 'Modify', tab: 'SOLID', icon: 'patternRect', run: () => ctx.toggleParams() },
    // --- drawing ---
    { id: 'draw.fromDesign', title: 'Drawing from Design', group: 'Drawing', tab: 'TOOLS', icon: 'sketch', run: () => ctx.startDrawing() },
    // --- file / view ---
    { id: 'file.new', title: 'New Design', group: 'File', tab: 'TOOLS', icon: 'point', hotkey: 'ctrl n', run: () => ctx.newDesign() },
    { id: 'file.open', title: 'Open…', group: 'File', tab: 'TOOLS', icon: 'point', hotkey: 'ctrl o', run: () => ctx.open() },
    { id: 'file.save', title: 'Save', group: 'File', tab: 'TOOLS', icon: 'point', hotkey: 'ctrl s', run: () => ctx.save() },
    { id: 'file.saveAs', title: 'Save As…', group: 'File', tab: 'TOOLS', icon: 'point', run: () => ctx.saveAs() },
    { id: 'file.export', title: 'Export…', group: 'File', tab: 'TOOLS', icon: 'point', run: () => ctx.exportModel() },
    { id: 'file.import', title: 'Import…', group: 'File', tab: 'TOOLS', icon: 'point', run: () => ctx.importStep() },
    { id: 'view.fit', title: 'Fit View', group: 'View', tab: 'TOOLS', icon: 'point', hotkey: 'f6', run: () => ctx.fitView() },
    { id: 'panel.data', title: 'Toggle Data Panel', group: 'View', tab: 'TOOLS', icon: 'point', run: () => ctx.toggleData() },
    { id: 'panel.git', title: 'Toggle History (Git)', group: 'View', tab: 'TOOLS', icon: 'point', run: () => ctx.toggleGit() }
  ]
}

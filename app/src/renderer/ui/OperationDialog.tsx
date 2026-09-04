import { useEffect, useRef, useState } from 'react'
import { api, type Selection } from '../rpc'
import { trace } from '../trace'

export type OpKind =
  | 'extrude'
  | 'revolve'
  | 'rib'
  | 'sweep'
  | 'loft'
  | 'draft'
  | 'combine'
  | 'fillet'
  | 'chamfer'
  | 'shell'
  | 'hole'
  | 'patternLinear'
  | 'patternCircular'
  | 'mirror'
  | 'datumPlane'
  | 'datumAxis'
  | 'datumPoint'
  | 'move'
  | 'scale'
  | 'align'
  | 'pressPull'
  | 'offsetFace'
  | 'splitFace'
  | 'splitBody'
  | 'baseFlange'
  | 'box'
  | 'cylinder'
  | 'sphere'
  | 'torus'
  | 'coil'
  | 'pipe'
  | 'meshFromBRep'
  | 'meshReduce'
  | 'meshSmooth'
  | 'meshPlaneCut'
  | 'meshFlipNormals'
  | 'meshRepair'
  | 'meshSeparate'
  | 'meshToSolid'

interface FieldSpec {
  key: string
  label: string
  type: 'number' | 'select' | 'checkbox'
  default: number | string | boolean
  min?: number
  step?: number
  options?: string[]
  /** render label on its own line, control full-width (for long selects) */
  wide?: boolean
  /** only show this field when the predicate passes for the current values */
  showIf?: (v: Record<string, number | string | boolean>) => boolean
  /** a negative value here means "the other direction": send its magnitude and
   *  toggle this boolean field instead (so -5 length == 5 length + Flip) */
  flipWith?: string
}

interface OpSpec {
  title: string
  needs: 'none' | 'edges' | 'faces' | 'sketch' | 'sketches2' | 'planeFace' | 'plane' | 'axis' | 'any'
  fields: FieldSpec[]
  hint?: string
}

// Mirror / Pattern "what do I act on": the whole body (default), only the
// feature chips selected in the timeline, or only the features owning the
// selected faces.
const SCOPE_FIELD: FieldSpec = {
  key: 'scope',
  label: 'Type',
  type: 'select',
  default: 'Body',
  options: ['Body', 'Features', 'Faces'],
  wide: true
}

// how the mirror / pattern result combines with the body (same set as extrude)
const OPERATION_FIELD: FieldSpec = {
  key: 'operation',
  label: 'Operation',
  type: 'select',
  default: 'Join',
  options: ['Join', 'Cut', 'Intersect', 'New body'],
  wide: true
}

// primitives default to a new body (Fusion behavior) but can combine instead
const PRIMITIVE_OP_FIELD: FieldSpec = {
  key: 'operation',
  label: 'Operation',
  type: 'select',
  default: 'New body',
  options: ['New body', 'Join', 'Cut', 'Intersect'],
  wide: true
}

const SPECS: Record<OpKind, OpSpec> = {
  extrude: {
    title: 'Extrude',
    needs: 'sketch',
    hint: 'Profile: a sketch, or any flat face of the model. For "To object", also select the face to stop at.',
    fields: [
      {
        key: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'Join',
        options: ['New body', 'Join', 'Cut', 'Intersect'],
        wide: true
      },
      {
        key: 'mode',
        label: 'Extent',
        type: 'select',
        default: 'Blind',
        options: ['Blind', 'Two Sides', 'To object'],
        wide: true
      },
      {
        key: 'length',
        label: 'Distance',
        type: 'number',
        default: 10,
        step: 1,
        flipWith: 'reversed',
        showIf: (v) => v.mode === 'Blind' || v.mode === 'Two Sides'
      },
      {
        key: 'length2',
        label: 'Distance (side 2)',
        type: 'number',
        default: 10,
        step: 1,
        showIf: (v) => v.mode === 'Two Sides'
      },
      {
        key: 'offset',
        label: 'Offset',
        type: 'number',
        default: 0,
        step: 1,
        showIf: (v) => v.mode === 'To object'
      },
      {
        key: 'midplane',
        label: 'Symmetric',
        type: 'checkbox',
        default: false,
        showIf: (v) => v.mode === 'Blind'
      },
      {
        key: 'throughAll',
        label: 'All (through everything)',
        type: 'checkbox',
        default: false,
        showIf: (v) => v.mode === 'Blind' && v.operation === 'Cut'
      },
      {
        key: 'taper',
        label: 'Taper angle',
        type: 'number',
        default: 0,
        step: 1,
        showIf: (v) => v.mode !== 'To object' && !v.throughAll
      },
      { key: 'reversed', label: 'Flip', type: 'checkbox', default: false }
    ]
  },
  revolve: {
    title: 'Revolve',
    needs: 'sketch',
    hint: 'Profile: a sketch, or a flat face of the model. Axis: pick from the list, or choose "Selected edge / datum" and click a straight edge or datum axis (required when the profile is a face).',
    fields: [
      {
        key: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'Join',
        options: ['New body', 'Join', 'Cut', 'Intersect'],
        wide: true
      },
      { key: 'full', label: 'Full (360)', type: 'checkbox', default: true },
      {
        key: 'angle',
        label: 'Angle',
        type: 'number',
        default: 360,
        step: 15,
        flipWith: 'reversed',
        showIf: (v) => !v.full
      },
      {
        key: 'axis',
        label: 'Axis',
        type: 'select',
        default: 'Sketch vertical',
        wide: true,
        options: [
          'Sketch vertical',
          'Sketch horizontal',
          'X',
          'Y',
          'Z',
          'Selected edge / datum'
        ]
      }
    ]
  },
  rib: {
    title: 'Rib',
    needs: 'sketch',
    hint: 'An open profile sketch that reaches the solid; thickened to both sides',
    fields: [
      { key: 'thickness', label: 'Thickness', type: 'number', default: 3, min: 0.01, step: 0.5 },
      { key: 'reversed', label: 'Flip side', type: 'checkbox', default: false }
    ]
  },
  sweep: {
    title: 'Sweep',
    needs: 'any',
    hint: 'Click a profile sketch, then click the path: another sketch, or a body edge.',
    fields: [
      {
        key: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'Join',
        options: ['New body', 'Join', 'Cut', 'Intersect'],
        wide: true
      },
      {
        key: 'orientation',
        label: 'Orientation',
        type: 'select',
        default: 'Path',
        options: ['Path', 'Parallel'],
        wide: true
      },
      {
        key: 'transition',
        label: 'Transition',
        type: 'select',
        default: 'Transformed',
        options: ['Transformed', 'Right corner', 'Round corner'],
        wide: true
      }
    ]
  },
  loft: {
    title: 'Loft',
    needs: 'sketches2',
    hint: 'Pick 2+ profile sketches, in order, to loft between.',
    fields: [
      {
        key: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'Join',
        options: ['New body', 'Join', 'Cut', 'Intersect'],
        wide: true
      },
      { key: 'ruled', label: 'Ruled (straight between sections)', type: 'checkbox', default: false },
      { key: 'closed', label: 'Closed loop', type: 'checkbox', default: false }
    ]
  },
  draft: {
    title: 'Draft',
    needs: 'faces',
    hint: 'Also select a plane or flat face as the neutral (pull) plane',
    fields: [{ key: 'angle', label: 'Angle', type: 'number', default: 3, step: 1 }]
  },
  combine: {
    title: 'Combine',
    needs: 'none',
    hint: 'Pick the Target body first, then the Tool body/bodies (in order) - a body is selected by clicking it in the Browser, or a face of it in the viewport.',
    fields: [
      {
        key: 'op',
        label: 'Operation',
        type: 'select',
        default: 'Fuse',
        options: ['Fuse', 'Cut', 'Common']
      },
      { key: 'keepTools', label: 'Keep tool bodies', type: 'checkbox', default: false }
    ]
  },
  patternCircular: {
    title: 'Circular Pattern',
    needs: 'axis',
    hint: 'Type = Body patterns the whole solid; Features / Faces only what you pick in the timeline / viewport. Operation combines the copies like an extrude. Also pick the axis.',
    fields: [
      SCOPE_FIELD,
      OPERATION_FIELD,
      { key: 'count', label: 'Quantity', type: 'number', default: 4, min: 2, step: 1 },
      { key: 'angle', label: 'Total angle', type: 'number', default: 360, step: 15 }
    ]
  },
  fillet: {
    title: 'Fillet',
    needs: 'edges',
    hint: 'Click edges to round. Click a face to round all of its edges. Ctrl-click to add more, plain click replaces.',
    fields: [{ key: 'radius', label: 'Radius', type: 'number', default: 2, min: 0.01, step: 0.5 }]
  },
  chamfer: {
    title: 'Chamfer',
    needs: 'edges',
    hint: 'Click edges to chamfer. Click a face to chamfer all of its edges. Ctrl-click to add more, plain click replaces.',
    fields: [
      {
        key: 'mode',
        label: 'Type',
        type: 'select',
        default: 'Equal',
        options: ['Equal', 'Two distances', 'Distance and angle'],
        wide: true
      },
      { key: 'size', label: 'Distance', type: 'number', default: 2, min: 0.01, step: 0.5 },
      {
        key: 'size2',
        label: 'Distance 2',
        type: 'number',
        default: 2,
        min: 0.01,
        step: 0.5,
        showIf: (v) => v.mode === 'Two distances'
      },
      {
        key: 'angle',
        label: 'Angle',
        type: 'number',
        default: 45,
        step: 5,
        showIf: (v) => v.mode === 'Distance and angle'
      }
    ]
  },
  shell: {
    title: 'Shell',
    needs: 'faces',
    hint: 'Select the face(s) to remove (open the shell); the rest is hollowed to the thickness.',
    fields: [
      { key: 'thickness', label: 'Thickness', type: 'number', default: 2, min: 0.01, step: 0.5 },
      {
        key: 'direction',
        label: 'Direction',
        type: 'select',
        default: 'Inside',
        options: ['Inside', 'Outside', 'Both'],
        wide: true
      }
    ]
  },
  hole: {
    title: 'Hole',
    needs: 'planeFace',
    hint: 'Click the face where the hole goes (click again to move the point), then set the size.',
    fields: [
      { key: 'diameter', label: 'Diameter', type: 'number', default: 6, min: 0.01, step: 0.5 },
      { key: 'depth', label: 'Depth', type: 'number', default: 10, min: 0.01, step: 1 },
      { key: 'throughAll', label: 'Through all', type: 'checkbox', default: false },
      {
        key: 'cutType',
        label: 'Head',
        type: 'select',
        default: 'None',
        options: ['None', 'Counterbore', 'Countersink']
      },
      { key: 'cutDiameter', label: 'Head dia', type: 'number', default: 0, min: 0, step: 0.5 },
      { key: 'cutDepth', label: 'C-bore depth', type: 'number', default: 0, min: 0, step: 0.5 }
    ]
  },
  move: {
    title: 'Move/Copy',
    needs: 'none',
    hint: 'Acts on the selected body (or the first body). Translate: X/Y/Z. Rotate: axis + angle. Tick Create Copy to leave the original in place.',
    fields: [
      {
        key: 'mode',
        label: 'Move type',
        type: 'select',
        default: 'Translate',
        options: ['Translate', 'Rotate', 'Point to Point'],
        wide: true
      },
      { key: 'dx', label: 'Distance X', type: 'number', default: 0, step: 1, showIf: (v) => v.mode === 'Translate' },
      { key: 'dy', label: 'Distance Y', type: 'number', default: 0, step: 1, showIf: (v) => v.mode === 'Translate' },
      { key: 'dz', label: 'Distance Z', type: 'number', default: 0, step: 1, showIf: (v) => v.mode === 'Translate' },
      {
        key: 'axis',
        label: 'Axis',
        type: 'select',
        default: 'Z',
        options: ['X', 'Y', 'Z', 'Selected edge'],
        wide: true,
        showIf: (v) => v.mode === 'Rotate'
      },
      { key: 'angle', label: 'Angle', type: 'number', default: 90, step: 15, showIf: (v) => v.mode === 'Rotate' },
      {
        key: 'usePicks',
        label: 'Use 2 picked points',
        type: 'checkbox',
        default: true,
        showIf: (v) => v.mode === 'Point to Point'
      },
      { key: 'createCopy', label: 'Create Copy', type: 'checkbox', default: false },
      { key: 'copies', label: 'Copies', type: 'number', default: 1, min: 1, step: 1, showIf: (v) => Boolean(v.createCopy) }
    ]
  },
  scale: {
    title: 'Scale',
    needs: 'none',
    hint: 'Acts on the selected body (or the first body). Uniform scales all axes by one factor; untick for per-axis.',
    fields: [
      { key: 'uniform', label: 'Uniform', type: 'checkbox', default: true },
      { key: 'factor', label: 'Scale factor', type: 'number', default: 2, min: 0.001, step: 0.1, showIf: (v) => Boolean(v.uniform) },
      { key: 'fx', label: 'X factor', type: 'number', default: 1, min: 0.001, step: 0.1, showIf: (v) => !v.uniform },
      { key: 'fy', label: 'Y factor', type: 'number', default: 1, min: 0.001, step: 0.1, showIf: (v) => !v.uniform },
      { key: 'fz', label: 'Z factor', type: 'number', default: 1, min: 0.001, step: 0.1, showIf: (v) => !v.uniform }
    ]
  },
  align: {
    title: 'Align',
    needs: 'faces',
    hint: 'Pick the face to move FROM first, then the face to align it TO. Mates them flush.',
    fields: []
  },
  pressPull: {
    title: 'Press Pull',
    needs: 'edges',
    hint: 'Pick an edge to fillet it, or a face to offset it. One tool, like Fusion Q.',
    fields: [{ key: 'distance', label: 'Distance / Radius', type: 'number', default: 2, step: 0.5 }]
  },
  offsetFace: {
    title: 'Offset Face',
    needs: 'faces',
    hint: 'Move the selected face(s) along their normal. Positive adds material, negative removes.',
    fields: [{ key: 'distance', label: 'Offset', type: 'number', default: 2, step: 0.5 }]
  },
  splitFace: {
    title: 'Split Face',
    needs: 'faces',
    hint: 'Split the selected face(s) with a plane / datum. Also pick the splitting plane.',
    fields: []
  },
  patternLinear: {
    title: 'Rectangular Pattern',
    needs: 'axis',
    hint: 'Type = Body patterns the whole solid; Features / Faces only what you pick. Operation combines the copies like an extrude. Direction: an edge, a sketch line, or a datum / origin axis.',
    fields: [
      SCOPE_FIELD,
      OPERATION_FIELD,
      { key: 'count', label: 'Quantity', type: 'number', default: 3, min: 2, step: 1 },
      { key: 'spacing', label: 'Spacing', type: 'number', default: 20, min: 0.01, step: 1 }
    ]
  },
  mirror: {
    title: 'Mirror',
    needs: 'plane',
    hint: 'Type = Body mirrors the whole solid; Features / Faces mirror only what you pick in the timeline / viewport. Operation combines the mirrored copy like an extrude. Also pick the mirror plane (a datum / origin plane or a flat face).',
    fields: [SCOPE_FIELD, OPERATION_FIELD]
  },
  datumPlane: {
    title: 'Plane',
    needs: 'none',
    hint: 'Click geometry to set the reference, Ctrl-click to add another. 1 face = on it (offset); 1 edge = on the edge (tilt by Angle); 2 edges = through both; 2 faces = mid-plane; 3 points = through them.',
    fields: [
      { key: 'offset', label: 'Offset', type: 'number', default: 0, step: 1, flipWith: 'flip' },
      {
        key: 'angle',
        label: 'Angle',
        type: 'number',
        default: 0,
        step: 5,
        showIf: () => true
      },
      { key: 'flip', label: 'Flip', type: 'checkbox', default: false }
    ]
  },
  datumAxis: {
    title: 'Axis',
    needs: 'none',
    hint: 'Click, Ctrl-click to add. 1 edge = along it; 1 face = its normal; 2 vertices = through both; 2 faces = their intersection.',
    fields: [
      { key: 'offset', label: 'Offset', type: 'number', default: 0, step: 1 },
      { key: 'flip', label: 'Flip', type: 'checkbox', default: false }
    ]
  },
  datumPoint: {
    title: 'Point',
    needs: 'none',
    hint: 'Click, Ctrl-click to add. 1 vertex = there; 1 edge = its midpoint; 1 face = its centre; 2 edges = where they meet.',
    fields: []
  },
  splitBody: {
    title: 'Split Body',
    needs: 'plane',
    fields: []
  },
  baseFlange: {
    title: 'Base Flange',
    needs: 'sketch',
    fields: [
      { key: 'thickness', label: 'Thickness', type: 'number', default: 1.5, min: 0.1, step: 0.5 }
    ]
  },

  // --- CREATE: primitives (optionally place on a picked plane / face) ---
  box: {
    title: 'Box',
    needs: 'none',
    hint: 'Optionally click a plane or flat face to place it on.',
    fields: [
      PRIMITIVE_OP_FIELD,
      { key: 'length', label: 'Length', type: 'number', default: 40, min: 0.01, step: 1 },
      { key: 'width', label: 'Width', type: 'number', default: 40, min: 0.01, step: 1 },
      { key: 'height', label: 'Height', type: 'number', default: 20, min: 0.01, step: 1 }
    ]
  },
  cylinder: {
    title: 'Cylinder',
    needs: 'none',
    hint: 'Optionally click a plane or flat face to place it on.',
    fields: [
      PRIMITIVE_OP_FIELD,
      { key: 'diameter', label: 'Diameter', type: 'number', default: 40, min: 0.01, step: 1 },
      { key: 'height', label: 'Height', type: 'number', default: 40, min: 0.01, step: 1 }
    ]
  },
  sphere: {
    title: 'Sphere',
    needs: 'none',
    hint: 'Optionally click a plane or flat face to place its centre on.',
    fields: [
      PRIMITIVE_OP_FIELD,
      { key: 'diameter', label: 'Diameter', type: 'number', default: 40, min: 0.01, step: 1 }
    ]
  },
  torus: {
    title: 'Torus',
    needs: 'none',
    fields: [
      PRIMITIVE_OP_FIELD,
      { key: 'meanDiameter', label: 'Mean diameter', type: 'number', default: 60, min: 0.01, step: 1 },
      { key: 'sectionDiameter', label: 'Section diameter', type: 'number', default: 15, min: 0.01, step: 1 }
    ]
  },
  coil: {
    title: 'Coil',
    needs: 'none',
    hint: 'A helical coil. Optionally click a plane to base it on.',
    fields: [
      PRIMITIVE_OP_FIELD,
      { key: 'diameter', label: 'Diameter', type: 'number', default: 30, min: 0.01, step: 1 },
      { key: 'pitch', label: 'Pitch', type: 'number', default: 8, min: 0.01, step: 1 },
      { key: 'turns', label: 'Revolutions', type: 'number', default: 5, min: 0.1, step: 1 },
      { key: 'sectionDiameter', label: 'Section diameter', type: 'number', default: 4, min: 0.01, step: 0.5 }
    ]
  },
  pipe: {
    title: 'Pipe',
    needs: 'edges',
    hint: 'Pick the path edges, then set the section. A wall thickness makes it hollow.',
    fields: [
      PRIMITIVE_OP_FIELD,
      { key: 'sectionDiameter', label: 'Section diameter', type: 'number', default: 10, min: 0.01, step: 1 },
      { key: 'wallThickness', label: 'Wall thickness', type: 'number', default: 0, min: 0, step: 0.5 }
    ]
  },

  // --- MESH tab ---
  meshFromBRep: {
    title: 'BRep to Mesh',
    needs: 'none',
    hint: 'Tessellate the selected solid body into a mesh body.',
    fields: [
      { key: 'deflection', label: 'Deviation', type: 'number', default: 0.1, min: 0.001, step: 0.05 },
      { key: 'angularDeflection', label: 'Angle', type: 'number', default: 0.5, min: 0.01, step: 0.1 }
    ]
  },
  meshReduce: {
    title: 'Reduce',
    needs: 'none',
    hint: 'Decimate the selected mesh.',
    fields: [
      { key: 'targetFactor', label: 'Keep fraction', type: 'number', default: 0.5, min: 0.01, step: 0.05 },
      { key: 'targetCount', label: 'Target triangles (0 = use fraction)', type: 'number', default: 0, min: 0, step: 100 }
    ]
  },
  meshSmooth: {
    title: 'Smooth',
    needs: 'none',
    fields: [{ key: 'iterations', label: 'Iterations', type: 'number', default: 2, min: 1, step: 1 }]
  },
  meshPlaneCut: {
    title: 'Plane Cut',
    needs: 'plane',
    hint: 'Pick the cutting plane (a datum / origin plane or a flat face).',
    fields: [
      {
        key: 'keep',
        label: 'Keep',
        type: 'select',
        default: 'both',
        options: ['both', 'positive', 'negative'],
        wide: true
      },
      { key: 'fill', label: 'Fill the cut', type: 'checkbox', default: false }
    ]
  },
  meshFlipNormals: { title: 'Reverse Normals', needs: 'none', fields: [] },
  meshRepair: {
    title: 'Repair',
    needs: 'none',
    hint: 'Fix normals, non-manifold edges, small holes and duplicates on the selected mesh.',
    fields: [
      { key: 'fixNormals', label: 'Fix normals', type: 'checkbox', default: true },
      { key: 'fillHoles', label: 'Fill holes', type: 'checkbox', default: true },
      { key: 'removeNonManifold', label: 'Remove non-manifold', type: 'checkbox', default: true },
      { key: 'removeDuplicates', label: 'Remove duplicates', type: 'checkbox', default: true }
    ]
  },
  meshSeparate: { title: 'Separate', needs: 'none', fields: [] },
  meshToSolid: {
    title: 'Convert Mesh',
    needs: 'none',
    hint: 'Rebuild a solid BRep from the selected mesh.',
    fields: [
      {
        key: 'mode',
        label: 'Result',
        type: 'select',
        default: 'faceted',
        options: ['faceted', 'prismatic', 'organic'],
        wide: true
      },
      { key: 'sewTolerance', label: 'Sew tolerance', type: 'number', default: 0.1, min: 0.001, step: 0.05 }
    ]
  }
}

export type OpValues = Record<string, number | string | boolean>

/** Fold a negative distance / angle into "the other direction": a field with
 *  `flipWith` set and a negative numeric value is sent as its magnitude with the
 *  named boolean toggled. Leaves expressions and non-flip fields untouched. */
function foldNegativeDirections(spec: OpSpec, vals: OpValues): OpValues {
  const out: OpValues = { ...vals }
  for (const f of spec.fields) {
    if (!f.flipWith) continue
    const n = Number(String(out[f.key] ?? ''))
    if (Number.isFinite(n) && n < 0) {
      out[f.key] = Math.abs(n)
      out[f.flipWith] = !out[f.flipWith]
    }
  }
  return out
}

/** ops whose result we can re-render live as the number changes */
const LIVE_PREVIEW: ReadonlySet<OpKind> = new Set<OpKind>([
  'extrude',
  'revolve',
  'fillet',
  'chamfer',
  'shell',
  'hole',
  'draft',
  'rib'
])

export function OperationDialog({
  kind,
  selection,
  onApply,
  onCancel,
  onPreview,
  onReady,
  onLivePreview,
  onLivePreviewEnd,
  handleDrag,
  initialValues,
  editingLabel
}: {
  kind: OpKind | null
  selection: Selection[]
  onApply: (kind: OpKind, values: OpValues, exprs: Record<string, string>) => void
  onCancel: () => void
  onPreview?: (info: { offset: number; angle: number; flip: boolean } | null) => void
  /** report whether OK is currently pressable (so E2E / callers can observe it) */
  onReady?: (ready: boolean) => void
  onLivePreview?: (kind: OpKind, values: OpValues) => void
  onLivePreviewEnd?: () => void
  handleDrag?: { delta: number; phase: 'move' | 'end'; seq: number } | null
  /** seed the fields from an existing feature (edit mode) instead of the defaults */
  initialValues?: OpValues | null
  /** feature label when editing - drives the title / button text */
  editingLabel?: string | null
}): JSX.Element | null {
  const spec = kind ? SPECS[kind] : null
  const [values, setValues] = useState<OpValues>({})
  const [preview, setPreview] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const onReadyPrev = useRef<boolean | null>(null)

  // put the caret in the first field so Enter / Esc work without a mouse move
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('input, select')?.focus()
  }, [kind])

  useEffect(() => {
    if (spec) {
      const init: OpValues = {}
      for (const f of spec.fields) {
        const seed = initialValues ? initialValues[f.key] : undefined
        init[f.key] = seed !== undefined ? seed : f.default
      }
      setValues(init)
      setPreview({})
    }
  }, [kind, initialValues]) // eslint-disable-line react-hooks/exhaustive-deps

  // push a live ghost of where the datum Plane will land (offset / angle / flip
  // + the current reference selection, which the app reads directly)
  useEffect(() => {
    if (!onPreview) return
    if (kind !== 'datumPlane') {
      onPreview(null)
      return
    }
    const off = Number(String(values.offset ?? 0))
    const ang = Number(String(values.angle ?? 0))
    if (isNaN(off) || isNaN(ang)) return
    const t = setTimeout(
      () => onPreview({ offset: off, angle: ang, flip: Boolean(values.flip) }),
      120
    )
    return () => clearTimeout(t)
  }, [kind, values.offset, values.angle, values.flip, selection, onPreview])

  // drop the ghost when the dialog unmounts
  useEffect(() => () => onPreview?.(null), []) // eslint-disable-line react-hooks/exhaustive-deps

  // live feature preview: debounce value / selection changes and ask the app to
  // build the feature in the engine so it renders as you tune the number
  const lastFired = useRef('')
  useEffect(() => {
    if (!kind || !LIVE_PREVIEW.has(kind) || !onLivePreview) return
    if (!selection.length) return
    // short debounce - the app coalesces overlapping calls and the in-place
    // fast path is a single recompute, so this can stay snappy while typing
    trace('dialog preview scheduled', { kind, values })
    const t = setTimeout(() => {
      // an unrelated re-render (or React StrictMode) re-runs this effect with an
      // identical kind / values / selection - skip the redundant engine round
      // trip, which is what makes the preview flicker while you drag a number
      const pv = foldNegativeDirections(SPECS[kind], values)
      const key = JSON.stringify({
        kind,
        values: pv,
        sel: selection.map((s) => JSON.stringify(s)).sort()
      })
      if (key === lastFired.current) return
      lastFired.current = key
      trace('dialog preview fire', { kind, values: pv })
      onLivePreview(kind, pv)
    }, 130)
    return () => clearTimeout(t)
  }, [kind, selection, values]) // eslint-disable-line react-hooks/exhaustive-deps

  // roll the live preview back when the dialog closes without applying
  useEffect(() => () => onLivePreviewEnd?.(), []) // eslint-disable-line react-hooks/exhaustive-deps

  // apply drags of the ghost's handle to the Offset field
  const dragBaseRef = useState<{ v: number | null }>(() => ({ v: null }))[0]
  useEffect(() => {
    if (!handleDrag || kind !== 'datumPlane') return
    if (dragBaseRef.v == null) dragBaseRef.v = Number(String(values.offset ?? 0)) || 0
    const next = Math.round((dragBaseRef.v + handleDrag.delta) * 100) / 100
    setValues((v) => ({ ...v, offset: String(next) }))
    if (handleDrag.phase === 'end') dragBaseRef.v = null
  }, [handleDrag]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!kind || !spec) return null

  const numberFields = spec.fields.filter((f) => f.type === 'number')
  const kindOf = (key: string): 'length' | 'angle' => (key === 'angle' ? 'angle' : 'length')

  const evalField = async (key: string): Promise<void> => {
    const raw = String(values[key] ?? '')
    if (!raw.trim() || !isNaN(Number(raw))) {
      setPreview((p) => ({ ...p, [key]: '' }))
      return
    }
    try {
      const r = await api.exprEval(raw, kindOf(key))
      setPreview((p) => ({ ...p, [key]: `= ${Number(r.value.toFixed(4))}` }))
    } catch (e) {
      setPreview((p) => ({ ...p, [key]: (e as Error).message }))
    }
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      const out: OpValues = { ...values }
      const exprs: Record<string, string> = {}
      for (const f of numberFields) {
        const raw = String(values[f.key] ?? f.default).trim()
        if (isNaN(Number(raw))) {
          out[f.key] = (await api.exprEval(raw, kindOf(f.key))).value
          exprs[f.key] = raw // remember the formula for this dimension
        } else {
          out[f.key] = Number(raw)
        }
      }
      onApply(kind, foldNegativeDirections(spec, out), exprs)
    } catch (e) {
      window.alert((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const edges = selection.filter((s) => s.kind === 'edge')
  const faces = selection.filter((s) => s.kind === 'face')
  const sketchesSel = selection.filter((s) => s.kind === 'sketch')
  const extrudeToObj = kind === 'extrude' && values.mode === 'To object'
  // extrude and revolve both accept a sketch OR a flat model face as the profile
  const profileKind = kind === 'extrude' || kind === 'revolve'
  const extrudeProfileOk = kind === 'extrude' && (sketchesSel.length === 1 || faces.length >= 1)
  const revolveProfileOk = kind === 'revolve' && (sketchesSel.length === 1 || faces.length === 1)
  const planeSel = selection.filter((s) => s.kind === 'plane' || s.kind === 'face')
  const isDatum = kind === 'datumPlane' || kind === 'datumAxis' || kind === 'datumPoint'
  const datumPlaneMsg = isDatum
    ? selection.length
      ? `${selection.length} reference${selection.length === 1 ? '' : 's'} - click to replace, Ctrl-click to add`
      : 'click geometry to set the reference'
    : null
  const axisSel = selection.filter((s) => s.kind === 'plane' || s.kind === 'edge' || s.kind === 'face')
  const needMsg =
    datumPlaneMsg ??
    (spec.needs === 'edges'
      ? faces.length
        ? `${faces.length} face${faces.length === 1 ? '' : 's'} (all their edges)` +
          (edges.length ? ` + ${edges.length} edge${edges.length === 1 ? '' : 's'}` : '')
        : `${edges.length} edge${edges.length === 1 ? '' : 's'} selected`
      : spec.needs === 'faces' || spec.needs === 'planeFace'
        ? `${faces.length} face${faces.length === 1 ? '' : 's'} selected`
        : spec.needs === 'sketch'
          ? profileKind && !sketchesSel.length && !faces.length
            ? 'select a sketch, or a flat face of the model'
            : !sketchesSel.length && !profileKind
              ? 'select a sketch (click its outline or filled face)'
              : extrudeToObj && faces.length <= (sketchesSel.length ? 0 : 1)
                ? 'now select the face to extrude up to'
                : sketchesSel.length
                  ? 'sketch selected'
                  : 'face selected'
          : spec.needs === 'sketches2'
            ? `${sketchesSel.length} sketches selected (need 2+)`
            : spec.needs === 'plane'
              ? planeSel.length
                ? 'plane selected'
                : 'click a plane (tree) or a flat face'
              : spec.needs === 'axis'
                ? axisSel.length
                  ? 'axis selected'
                  : 'click an axis / edge / plane / face'
                : spec.needs === 'any'
                  ? selection.length
                    ? `${selection.length} reference${selection.length === 1 ? '' : 's'} selected`
                    : 'select a profile sketch, then click a path (a sketch or edge)'
                  : null)

  const ready =
    // editing a committed feature: its refs are already seeded, Update is always allowed
    !!editingLabel ||
    (isDatum && selection.length >= 1) ||
    (spec.needs === 'none' && !isDatum) ||
    (spec.needs === 'edges' && edges.length + faces.length > 0) ||
    (spec.needs === 'faces' && faces.length > 0) ||
    (spec.needs === 'planeFace' && faces.length === 1) ||
    (spec.needs === 'sketch' &&
      !profileKind &&
      sketchesSel.length === 1) ||
    (kind === 'revolve' && revolveProfileOk) ||
    (kind === 'extrude' &&
      extrudeProfileOk &&
      (!extrudeToObj || faces.length >= (sketchesSel.length ? 1 : 2))) ||
    (spec.needs === 'sketches2' && sketchesSel.length >= 2) ||
    (spec.needs === 'plane' && planeSel.length >= 1) ||
    (spec.needs === 'axis' && axisSel.length >= 1) ||
    (spec.needs === 'any' && selection.length >= 1)

  // report OK-pressability to the parent. Done inline (not in an effect) so it
  // survives the early `return null` above for an unknown kind without breaking
  // the hook order. The parent handler only stashes it in a ref.
  if (onReadyPrev.current !== ready) {
    onReadyPrev.current = ready
    onReady?.(ready)
  }

  // Enter = OK (when the params are good), Esc = Cancel - from anywhere in the
  // dialog, no mouse needed
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
      return
    }
    if (e.key === 'Enter') {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return
      e.preventDefault()
      if (ready && !busy) void submit()
    }
  }

  return (
    <div className="opdlg" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="opdlg-title">
        {editingLabel ? `Edit ${editingLabel}` : spec.title}
      </div>
      {needMsg && (
        <div className={ready ? 'opdlg-need ok' : 'opdlg-need'}>{needMsg}</div>
      )}
      {spec.hint && <div className="opdlg-hint">{spec.hint}</div>}
      <div className="opdlg-body">
        {spec.fields
          .filter((f) => !f.showIf || f.showIf(values))
          .map((f) => (
          <label key={f.key} className={f.wide ? 'opdlg-field col' : 'opdlg-field'}>
            <span>{f.label}</span>
            {f.type === 'number' && (
              <input
                type="text"
                inputMode="text"
                value={String(values[f.key] ?? f.default)}
                title="number or expression, e.g. 15in + 2.4mm, width/2"
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                onBlur={() => void evalField(f.key)}
              />
            )}
            {f.type === 'number' && preview[f.key] && (
              <span className="opdlg-eval">{preview[f.key]}</span>
            )}
            {f.type === 'checkbox' && (
              <input
                type="checkbox"
                checked={Boolean(values[f.key] ?? f.default)}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))}
              />
            )}
            {f.type === 'select' && (
              <select
                value={String(values[f.key] ?? f.default)}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              >
                {f.options!.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            )}
          </label>
        ))}
      </div>
      <div className="opdlg-actions">
        <button className="opdlg-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button className="opdlg-ok" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? '…' : editingLabel ? 'Update' : 'OK'}
        </button>
      </div>
    </div>
  )
}

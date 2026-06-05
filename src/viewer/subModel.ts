/**
 * Builds a minimal, self-contained IFC STEP model for a single element by walking
 * the reference graph around it. This is what makes per-element preview cheap even
 * on huge files: instead of handing a 180 MB model to the geometry engine, we emit
 * a few dozen lines containing only the element's geometry/placement closure.
 *
 * Original `#id` numbers are preserved verbatim, so the engine's express ids map
 * 1:1 back to the source STEP ids (reliable pick-to-reveal, "render exactly #N").
 *
 * Pure Node (no `vscode`): unit-testable against `test-files/`.
 */
import {
  REL_AGGREGATES,
  REL_NESTS,
  REL_VOIDS,
  STYLED_ITEM,
  StepFileIndex,
  collectRefs,
} from "./stepIndex";

export interface SubModelOptions {
  /** Include decomposition/assembly descendants (IfcRelAggregates/IfcRelNests). */
  includeChildren?: boolean;
  /** Include openings (IfcRelVoidsElement) so the engine subtracts voids. */
  includeVoids?: boolean;
  /** Include IfcStyledItem closures so surfaces keep their authored colors. */
  includeStyles?: boolean;
  /** Safety cap on collected instances; extraction stops and flags truncation. */
  maxInstances?: number;
}

export interface SubModelResult {
  /** A self-contained STEP file as raw bytes (passed verbatim to the engine).
   *  An ArrayBuffer (not a Buffer/Uint8Array) so it survives `webview.postMessage`
   *  structured cloning as binary rather than being mangled into a plain object. */
  ifcBytes: ArrayBuffer;
  rootId: number;
  /** Product/element ids intended for rendering, excluding helper closure ids. */
  renderIds: number[];
  rootType: string | undefined;
  schema: string | undefined;
  includedIds: number[];
  /** Number of decomposition descendants pulled in (excludes the root). */
  childCount: number;
  /** True if the instance cap was hit (result may be incomplete). */
  truncated: boolean;
}

const DEFAULT_MAX_INSTANCES = 200_000;
const ARG_RELATING = 4; // RelatingObject / RelatingBuildingElement
const ARG_RELATED = 5; // RelatedObjects / RelatedOpeningElement

function firstRef(arg: string | undefined): number | undefined {
  if (!arg) {
    return undefined;
  }
  return collectRefs(arg)[0];
}

export function extractSubModel(
  index: StepFileIndex,
  rootId: number,
  options: SubModelOptions = {},
): SubModelResult {
  const includeChildren = options.includeChildren ?? true;
  const includeVoids = options.includeVoids ?? true;
  const includeStyles = options.includeStyles ?? true;
  const maxInstances = options.maxInstances ?? DEFAULT_MAX_INSTANCES;

  if (!index.hasId(rootId)) {
    throw new Error(`#${rootId} is not defined in this file.`);
  }

  const included = new Set<number>();
  let truncated = false;

  /** BFS the forward `#ref` closure of the given seeds into `included`. */
  const addClosure = (seeds: number[]): void => {
    const queue = [...seeds];
    while (queue.length > 0) {
      const id = queue.pop() as number;
      if (included.has(id) || !index.hasId(id)) {
        continue;
      }
      if (included.size >= maxInstances) {
        truncated = true;
        return;
      }
      included.add(id);
      for (const ref of index.refsOf(id)) {
        if (!included.has(ref)) {
          queue.push(ref);
        }
      }
    }
  };

  // 1. The element itself (placement chain, representation, profiles, points...).
  const renderIds = new Set<number>([rootId]);
  addClosure([rootId]);

  // 2. The singleton IfcProject closure: units, geometric contexts, true north.
  if (index.projectId !== undefined) {
    addClosure([index.projectId]);
  }

  // 3. Decomposition/assembly descendants. Walk aggregate/nest rels whose
  //    RelatingObject is something already in scope, pulling in their children.
  let childCount = 0;
  if (includeChildren && !truncated) {
    const objectScope = new Set<number>([rootId]);
    const aggregateRels = [
      ...index.relIdsOfType(REL_AGGREGATES),
      ...index.relIdsOfType(REL_NESTS),
    ];
    let grew = true;
    let guard = 0;
    while (grew && !truncated && guard++ < 64) {
      grew = false;
      for (const relId of aggregateRels) {
        const args = index.argsOf(relId);
        const relating = firstRef(args[ARG_RELATING]);
        if (relating === undefined || !objectScope.has(relating)) {
          continue;
        }
        for (const child of collectRefs(args[ARG_RELATED] ?? "")) {
          if (!objectScope.has(child) && index.hasId(child)) {
            objectScope.add(child);
            renderIds.add(child);
            childCount++;
            grew = true;
            addClosure([child]);
          }
        }
      }
    }
  }

  // 4. Openings: include the void relationship + opening geometry so solids show
  //    their cut-outs (web-ifc performs the boolean when both are present).
  if (includeVoids && !truncated) {
    for (const relId of index.relIdsOfType(REL_VOIDS)) {
      const args = index.argsOf(relId);
      const relating = firstRef(args[ARG_RELATING]);
      if (relating !== undefined && included.has(relating)) {
        const opening = firstRef(args[ARG_RELATED]);
        included.add(relId);
        if (opening !== undefined) {
          addClosure([opening]);
        }
      }
    }
  }

  // 5. Styles/colors: include styled items whose target representation item is in
  //    scope, plus their style closure (IfcSurfaceStyle -> colour).
  if (includeStyles && !truncated) {
    for (const relId of index.relIdsOfType(STYLED_ITEM)) {
      const args = index.argsOf(relId);
      const item = firstRef(args[0]); // IfcStyledItem.Item
      if (item !== undefined && included.has(item)) {
        addClosure([relId]);
      }
    }
  }

  const includedIds = [...included].sort((a, b) => a - b);
  const ifcBytes = assemble(index, includedIds);

  return {
    ifcBytes,
    rootId,
    renderIds: [...renderIds].sort((a, b) => a - b),
    rootType: index.getType(rootId),
    schema: index.schema,
    includedIds,
    childCount,
    truncated,
  };
}

/** Stitch the header + selected instance bytes into a valid STEP file, preserving
 *  the original bytes verbatim (no latin1/UTF-8 round-trip) so non-ASCII content
 *  survives intact on its way to the geometry engine. Returns an exact-sized
 *  ArrayBuffer (Buffer.concat may sit in a shared pool, so slice to our bytes). */
function assemble(index: StepFileIndex, ids: number[]): ArrayBuffer {
  const NL = Buffer.from("\n");
  const parts: Buffer[] = [index.headerBytes()];
  for (const id of ids) {
    const bytes = index.sliceInstanceBytes(id);
    if (bytes) {
      parts.push(NL, bytes);
    }
  }
  parts.push(Buffer.from("\nENDSEC;\nEND-ISO-10303-21;\n"));
  const out = Buffer.concat(parts);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

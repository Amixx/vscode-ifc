import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { StepFileIndex } from "./stepIndex";

const ADVANCED_PROJECT = path.resolve(
  process.cwd(),
  "fixtures",
  "models",
  "advanced-project.ifc",
);

test("model tree spatial hierarchy: advanced-project.ifc", (t: TestContext) => {
  if (!existsSync(ADVANCED_PROJECT)) {
    t.skip("advanced-project.ifc not present (gitignored; local-only)");
    return;
  }

  const buf = readFileSync(ADVANCED_PROJECT);
  const index = StepFileIndex.build(buf);

  assert.ok(index.projectId !== undefined, "file should have an IfcProject");
  const projectType = index.getType(index.projectId!);
  assert.equal(projectType, "IFCPROJECT");

  const projectName = index.nameOf(index.projectId!);

  const projectChildren = index.decompositionChildrenOf(index.projectId!);
  assert.ok(projectChildren.length > 0, "IfcProject should have children");

  const siteIds = projectChildren.filter(
    (id) => index.getType(id) === "IFCSITE",
  );
  assert.ok(siteIds.length >= 1, "IfcProject should aggregate at least one IfcSite");

  const siteChildren = index.decompositionChildrenOf(siteIds[0]);
  const buildingIds = siteChildren.filter(
    (id) => index.getType(id) === "IFCBUILDING",
  );
  assert.ok(buildingIds.length >= 1, "IfcSite should aggregate at least one IfcBuilding");

  const buildingChildren = index.decompositionChildrenOf(buildingIds[0]);
  const storeyIds = buildingChildren.filter(
    (id) => index.getType(id) === "IFCBUILDINGSTOREY",
  );
  assert.ok(storeyIds.length >= 1, "IfcBuilding should aggregate at least one IfcBuildingStorey");

  const storeyChildren = index.decompositionChildrenOf(storeyIds[0]);
  const elementCount = storeyChildren.filter((id) => !index.isSpatialContainer(id)).length;
  assert.ok(elementCount > 0, "IfcBuildingStorey should contain physical elements via IfcRelContainedInSpatialStructure");

  let totalReachable = 0;
  const stack = [index.projectId!];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    totalReachable++;
    for (const childId of index.decompositionChildrenOf(id)) {
      stack.push(childId);
    }
  }
  assert.ok(
    totalReachable < index.instanceCount,
    `spatial tree should be a subset of all instances (${totalReachable} < ${index.instanceCount})`,
  );

  const parentMap = new Map<number, number>();
  stack.push(index.projectId!);
  const seen2 = new Set<number>();
  while (stack.length > 0) {
    const parentId = stack.pop()!;
    if (seen2.has(parentId)) continue;
    seen2.add(parentId);
    for (const childId of index.decompositionChildrenOf(parentId)) {
      parentMap.set(childId, parentId);
      stack.push(childId);
    }
  }

  for (const storeyId of storeyIds) {
    let current: number | undefined = storeyId;
    const path: string[] = [];
    while (current !== undefined) {
      path.push(`#${current}=${index.getType(current)}`);
      current = parentMap.get(current);
    }
    assert.equal(path[path.length - 1], `#${index.projectId}=IFCPROJECT`, `storey #${storeyId} path should reach IfcProject`);
  }
});

test("model tree spatial hierarchy: representation-gate.ifc", () => {
  const buf = readFileSync(path.resolve(process.cwd(), "fixtures", "representation-gate.ifc"));
  const index = StepFileIndex.build(buf);

  assert.ok(index.projectId !== undefined, "file should have an IfcProject");
  assert.equal(index.getType(index.projectId!), "IFCPROJECT");

  const projectChildren = index.decompositionChildrenOf(index.projectId!);
  assert.ok(projectChildren.length > 0, "IfcProject should have children");

  const parentMap = new Map<number, number>();
  const stack = [index.projectId!];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const parentId = stack.pop()!;
    if (seen.has(parentId)) continue;
    seen.add(parentId);
    for (const childId of index.decompositionChildrenOf(parentId)) {
      parentMap.set(childId, parentId);
      stack.push(childId);
    }
  }

  for (const [childId, parentId] of parentMap) {
    const parentChildren = index.decompositionChildrenOf(parentId);
    assert.ok(parentChildren.includes(childId), `parent #${parentId} should list child #${childId}`);
  }
});

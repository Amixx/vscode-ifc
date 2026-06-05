import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { StepFileIndex } from "./stepIndex";

function fixture(name: string): StepFileIndex {
  return StepFileIndex.build(readFileSync(path.resolve(process.cwd(), "fixtures", name)));
}

const gate = fixture("representation-gate.ifc");

test("hasRenderableRepresentation: renders solid-bearing products (+ tolerates `= ` spacing)", () => {
  assert.equal(gate.hasRenderableRepresentation(100), true);
  assert.equal(gate.hasRenderableRepresentation(500), true);
});

test("hasRenderableRepresentation: renders when any one representation is renderable", () => {
  assert.equal(gate.hasRenderableRepresentation(300), true);
});

test("hasRenderableRepresentation: skips curve/annotation-only and representation-less products", () => {
  assert.equal(gate.hasRenderableRepresentation(200), false);
  assert.equal(gate.hasRenderableRepresentation(400), false);
});

test("hasRenderableRepresentation: rejects non-products that carry a #ref at arg index 6", () => {
  assert.equal(gate.hasRenderableRepresentation(10), false);
  assert.equal(gate.hasRenderableRepresentation(600), false);
});

test("hasRenderableRepresentation: real sample file — products yes, sub-contexts no", (t: TestContext) => {
  const file = path.resolve(process.cwd(), "test-files", "000.063019MB__Ifc4_SampleHouse_1_Roof.ifc");
  if (!existsSync(file)) {
    t.skip("sample model not present (gitignored; local-only)");
    return;
  }
  const buf = readFileSync(file);
  const index = StepFileIndex.build(buf);
  const text = buf.toString("latin1");
  const firstIdOfType = (type: string): number => {
    const m = new RegExp(`#(\\d+)=\\s*${type}\\(`, "i").exec(text);
    assert.ok(m, `expected a ${type} in the sample file`);
    return Number.parseInt(m![1], 10);
  };

  assert.equal(index.hasRenderableRepresentation(firstIdOfType("IFCROOF")), true);
  assert.equal(index.hasRenderableRepresentation(firstIdOfType("IFCSLAB")), true);
  assert.equal(
    index.hasRenderableRepresentation(firstIdOfType("IFCGEOMETRICREPRESENTATIONSUBCONTEXT")),
    false,
  );
});

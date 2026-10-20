import { expect, it } from "vitest";
import { GraphPhysics } from "./graphPhysics";

it("dragged nodes remain under the pointer while springs pull their neighbors", () => {
  const sim = new GraphPhysics(
    ["a", "b", "c"],
    [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ],
  );
  for (let i = 0; i < 250; i++) sim.step();
  const before = sim.positions();
  const a = before.get("a")!;
  sim.hold("a", a.x + 350, a.y);
  for (let i = 0; i < 80; i++) sim.step();
  const after = sim.positions();
  expect(after.get("a")).toEqual({ x: a.x + 350, y: a.y });
  expect(after.get("b")!.x - before.get("b")!.x).toBeGreaterThan(40);
  expect(after.get("c")!.x - before.get("c")!.x).toBeGreaterThan(15);
  sim.release("a");
  for (let i = 0; i < 250; i++) sim.step();
  expect(sim.positions().get("a")!.x).toBeLessThan(a.x + 350);
});

it("100 connected pages settle to finite positions and stop moving", () => {
  const ids = Array.from({ length: 100 }, (_, i) => String(i));
  const sim = new GraphPhysics(
    ids,
    ids.slice(1).map((id) => ({ source: "0", target: id })),
  );
  let moving = true;
  for (let i = 0; i < 1400; i++) moving = sim.step();
  expect(moving).toBe(false);
  expect(sim.positions().size).toBe(100);
  for (const position of sim.positions().values()) {
    expect(Number.isFinite(position.x) && Number.isFinite(position.y)).toBe(
      true,
    );
    expect(Math.abs(position.x)).toBeLessThan(10000);
    expect(Math.abs(position.y)).toBeLessThan(10000);
  }
});

it("empty graphs and missing link endpoints do not break physics", () => {
  const empty = new GraphPhysics([], []);
  expect(empty.step()).toBe(false);
  expect(empty.positions().size).toBe(0);
  const sim = new GraphPhysics(["a"], [{ source: "a", target: "missing" }]);
  sim.hold("a", 0, 0);
  sim.step();
  expect(sim.positions().get("a")).toEqual({ x: 0, y: 0 });
});

it("topology edits preserve existing positions and remove obsolete bodies", () => {
  const sim = new GraphPhysics(["a", "b"], [{ source: "a", target: "b" }]);
  sim.hold("a", 430, 210);
  sim.release("a");
  const before = sim.positions();
  sim.reconcile(["a", "b", "c"], [{ source: "b", target: "c" }]);
  expect(sim.positions().get("a")).toEqual({ x: 430, y: 210 });
  expect(sim.positions().get("b")).toEqual(before.get("b"));
  expect(Number.isFinite(sim.positions().get("c")!.x)).toBe(true);
  sim.reconcile(["a", "c"], [{ source: "a", target: "c" }]);
  expect(sim.positions().has("b")).toBe(false);
  expect(sim.positions().get("a")).toEqual({ x: 430, y: 210 });
});

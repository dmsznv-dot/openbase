import { it, expect } from "vitest";
import { SaveQueue } from "./saveQueue";
import type { Document } from "./model";
const doc: Document = {
  id: "a",
  path: "a.md",
  title: "A",
  tags: [],
  links: [],
  properties: {},
  revision: "r0",
  updated: 0,
  excerpt: "",
  favorite: false,
  parent_id: null,
  content: "",
  raw: "",
  yaml_error: null,
};
it("serializes writes using the newly committed revision", async () => {
  let disk = "r0";
  let text = "";
  const q = new SaveQueue(async (d, c) => {
    await new Promise((r) => setTimeout(r, 2));
    if (d.revision !== disk) throw Error("stale revision");
    disk = disk === "r0" ? "r1" : "r2";
    text = c;
    return { ...d, revision: disk, content: c };
  });
  await Promise.all([q.write(doc, "first"), q.write(doc, "second")]);
  expect(text).toBe("second");
  expect(disk).toBe("r2");
});
it("flush waits for the actual disk boundary", async () => {
  let persisted = false;
  const q = new SaveQueue(async (d, c) => {
    await new Promise((r) => setTimeout(r, 5));
    persisted = true;
    return { ...d, content: c };
  });
  q.write(doc, "draft");
  await q.flush();
  expect(persisted).toBe(true);
});

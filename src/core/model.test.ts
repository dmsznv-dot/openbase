import { describe, it, expect } from "vitest";
import {
  attachmentPath,
  selectNotes,
  buildGraph,
  searchNotes,
  type Note,
  type DataView,
} from "./model";
const note = (
  id: string,
  title: string,
  tags: string[],
  links: string[] = [],
  path = `${title}.md`,
): Note => ({
  id,
  title,
  tags,
  links,
  path,
  properties: {},
  revision: id,
  updated: 0,
  excerpt: "Материалы светильника prototype",
  favorite: false,
  parent_id: null,
});
const a = note("a", "Идея", ["project", "design"], ["Смета"]);
const b = note("b", "Смета", ["project"]);
const c = note("c", "Архив", ["design"]);
const view: DataView = {
  id: "v",
  name: "Проект",
  tags: ["project", "design"],
  match: "any",
  layout: "graph",
  sort: "title",
  groupBy: "status",
};
describe("project view membership", () => {
  it("OR includes either tag and AND requires both", () => {
    expect(
      selectNotes([a, b, c], view)
        .map((n) => n.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);
    expect(
      selectNotes([a, b, c], { ...view, match: "all" }).map((n) => n.id),
    ).toEqual(["a"]);
  });
  it("empty filter includes every page and normalizes tag names", () => {
    expect(selectNotes([a, b], { ...view, tags: [] }).length).toBe(2);
    expect(
      selectNotes([a, b, c], { ...view, tags: ["#PROJECT"] })
        .map((n) => n.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});
describe("project brain", () => {
  it("distinguishes explicit links and tag membership", () => {
    const g = buildGraph([a, b]);
    expect(
      g.edges.filter((e) => e.kind === "link").map((e) => [e.source, e.target]),
    ).toEqual([["a", "b"]]);
    expect(
      g.edges
        .filter((e) => e.kind === "tag" && e.target === "tag:project")
        .map((e) => e.source)
        .sort(),
    ).toEqual(["a", "b"]);
  });
  it("never links an ambiguous name or a page outside the view", () => {
    const duplicate = note("d", "Смета", [], [], "Другие/Смета.md");
    expect(
      buildGraph([a, b, duplicate]).edges.filter((e) => e.kind === "link"),
    ).toEqual([]);
    expect(buildGraph([a]).edges.filter((e) => e.kind === "link")).toEqual([]);
  });
  it("can hide tag hubs without losing isolated pages", () => {
    const g = buildGraph([a, b, c], false);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(g.edges.every((e) => e.kind === "link")).toBe(true);
  });
});
it("finds prefixes in Cyrillic and ranks title matches first", () => {
  expect(searchNotes([a, b, c], "свет").length).toBe(3);
  expect(searchNotes([b, a], "иде")[0].id).toBe("a");
  expect(searchNotes([a], "prot").length).toBe(1);
});

it("resolves explicit relative links before root namesakes", () => {
  const source = note("s", "Source", [], ["Target.md"], "Folder/Source.md");
  const local = note("l", "Target", [], [], "Folder/Target.md");
  const root = note("r", "Target", [], [], "Target.md");
  expect(
    buildGraph([source, local, root])
      .edges.filter((e) => e.kind === "link")
      .map((e) => e.target),
  ).toEqual(["l"]);
});
it("does not hide ambiguity elsewhere in the vault", () => {
  const outside = note("outside", "Смета", [], [], "Other/Смета.md");
  expect(buildGraph([a, b], false, [a, b, outside]).edges).toEqual([]);
});

it("decodes and resolves note-relative media without escaping root", () => {
  expect(
    attachmentPath(
      "Folder/Page.md",
      "../%D0%92%D0%BB%D0%BE%D0%B6%D0%B5%D0%BD%D0%B8%D1%8F/a.pdf",
    ),
  ).toBe("Вложения/a.pdf");
  expect(() => attachmentPath("Page.md", "../secret")).toThrow();
});

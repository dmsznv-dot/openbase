import { expect, it } from "vitest";
import { getPageView, pageViewPatch, pageChildren, type Note } from "./model";

const parent = {
  id: "project",
  title: "Проект",
  properties: {
    localnotes: { id: "project", favorite: true, parent_id: "root" },
  },
} as unknown as Note;

it("switching page layouts preserves identity, favorite and nesting metadata", () => {
  const view = {
    ...getPageView(parent),
    layout: "board" as const,
    tags: ["дизайн"],
  };
  const patch = pageViewPatch(parent, view);
  expect(patch).toEqual({
    localnotes: {
      id: "project",
      favorite: true,
      parent_id: "root",
      page_view: {
        layout: "board",
        tags: ["дизайн"],
        match: "any",
        sort: "title",
        groupBy: "status",
      },
    },
  });
  expect(getPageView({ ...parent, properties: patch })).toEqual(view);
});

it("invalid or absent saved layouts fall back to text without hiding a page", () => {
  expect(getPageView(parent).layout).toBe("text");
  expect(
    getPageView({
      ...parent,
      properties: {
        localnotes: {
          page_view: {
            layout: "removed-plugin",
            tags: [2, "проект"],
            sort: "bad",
            match: "bad",
          },
        },
      },
    }),
  ).toEqual({
    layout: "text",
    tags: ["проект"],
    sort: "title",
    match: "any",
    groupBy: "status",
  });
});

it("page representations show direct children without flattening other projects", () => {
  const notes = [
    { id: "child", parent_id: "project" },
    { id: "grandchild", parent_id: "child" },
    { id: "other", parent_id: null },
    { id: "project", parent_id: "project" },
  ] as Note[];
  expect(pageChildren(notes, "project").map((n) => n.id)).toEqual(["child"]);
});

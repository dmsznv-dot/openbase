import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
await mkdir(root + "/artifacts", { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    const file = resolve(
      root + "/dist",
      path === "/" ? "index.html" : "." + path,
    );
    if (!file.startsWith(root + "/dist/")) throw Error("path");
    const bytes = await readFile(file);
    res.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        }[extname(file)] ?? "application/octet-stream",
    });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1320, height: 860 } });
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const results = [];
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/?demo`);
  const materialsRow = page
    .locator(".page-tree .sidebar-page-row")
    .filter({ hasText: "Материалы" });
  await materialsRow.hover();
  await materialsRow
    .getByRole("button", { name: "Меню страницы Материалы", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Добавить в избранное", exact: true })
    .click();
  await page
    .locator(".favorites")
    .getByRole("button", { name: "Материалы", exact: true })
    .waitFor();
  await materialsRow
    .getByRole("button", { name: "Меню страницы Материалы", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Переименовать", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Новое название страницы", exact: true })
    .fill("Материалы переименованы");
  await page
    .getByRole("textbox", { name: "Новое название страницы", exact: true })
    .press("Enter");
  await page
    .locator(".page-tree")
    .getByRole("button", { name: "Материалы переименованы", exact: true })
    .waitFor();
  await page
    .locator(".page-tree")
    .getByRole("button", {
      name: "Меню страницы Материалы переименованы",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Переименовать", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Новое название страницы", exact: true })
    .fill("Материалы");
  await page
    .getByRole("textbox", { name: "Новое название страницы", exact: true })
    .press("Enter");
  results.push(
    "sidebar menu favorites and rename save without opening another page",
  );
  await page
    .locator(".page-tree")
    .getByRole("button", { name: "Проект светильника", exact: true })
    .click();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const parentSource = page.getByRole("textbox", {
    name: "Исходный Markdown",
    exact: true,
  });
  const parentContent =
    (await parentSource.inputValue()) +
    "\n\n[Бриф](Вложения/brief.pdf)\n\nСохранить при смене вида.";
  await parentSource.fill(parentContent);
  await page.getByRole("tab", { name: "Таблица", exact: true }).click();
  await page
    .locator(".page-workspace")
    .getByRole("button", { name: "Новая страница", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Название страницы", exact: true })
    .fill("Задача проекта");
  await page
    .locator(".page-tree")
    .getByRole("button", { name: "Проект светильника", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("tab", { name: "Таблица", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  assert.equal(await page.locator(".table-title").count(), 1);
  assert.match(
    await page.locator(".table-title").innerText(),
    /Задача проекта/,
  );
  await page.getByRole("tab", { name: "Карточки", exact: true }).click();
  assert.equal(await page.locator(".note-card").count(), 1);
  await page.getByRole("tab", { name: "Канбан", exact: true }).click();
  assert.equal(await page.locator(".board-card").count(), 1);
  await page.getByRole("tab", { name: "Текст", exact: true }).click();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Исходный Markdown", exact: true })
      .inputValue(),
    parentContent,
  );
  results.push(
    "page text/table/cards/board tabs preserve text, attachment links and child nesting",
  );
  await page.getByRole("button", { name: /^Светильник/ }).click();
  await page.locator(".brain-node").first().waitFor();
  assert.equal(await page.locator(".brain-node.page").count(), 4);
  assert.ok((await page.locator(".brain-node.tag").count()) >= 3);
  await page
    .getByRole("button", { name: "Приостановить физику", exact: true })
    .click();
  const graphNode = (name) =>
    page
      .locator(".react-flow__node")
      .filter({ has: page.getByRole("button", { name, exact: true }) });
  const worldPosition = (node) =>
    node.evaluate((el) => {
      const m = el.style.transform.match(
        /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/,
      );
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    });
  const movingNode = graphNode("Материалы");
  const neighborNode = graphNode("Конструкция");
  const beforeDrag = await worldPosition(movingNode);
  const beforeNeighbor = await worldPosition(neighborNode);
  await page
    .getByRole("button", { name: "Включить физику", exact: true })
    .click();
  const dragBox = await movingNode.boundingBox();
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + 18);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + dragBox.width / 2 + 170, dragBox.y + 88, {
    steps: 20,
  });
  await page.waitForTimeout(350);
  const duringDrag = await worldPosition(movingNode);
  const duringNeighbor = await worldPosition(neighborNode);
  assert.ok(
    Math.hypot(duringDrag.x - beforeDrag.x, duringDrag.y - beforeDrag.y) > 60,
  );
  assert.ok(
    Math.hypot(
      duringNeighbor.x - beforeNeighbor.x,
      duringNeighbor.y - beforeNeighbor.y,
    ) > 3,
  );
  await page.mouse.up();
  assert.equal(await page.locator(".brain-node.page").count(), 4);
  await page
    .getByRole("button", { name: "Приостановить физику", exact: true })
    .click();
  const pausedPosition = await worldPosition(movingNode);
  await page
    .getByRole("textbox", { name: "Найти узел", exact: true })
    .fill("Материалы");
  await page.waitForTimeout(3200);
  assert.deepEqual(await worldPosition(movingNode), pausedPosition);
  await page.getByRole("textbox", { name: "Найти узел", exact: true }).fill("");
  results.push(
    "graph drag moves linked neighbors, does not navigate and survives polling/search",
  );
  await page.screenshot({
    path: root + "/artifacts/graph-light.png",
    animations: "disabled",
  });
  const preservedPosition = await worldPosition(neighborNode);
  const preservedViewport = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  await page
    .locator(".page-tree")
    .getByRole("button", { name: "Меню страницы Референсы", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Удалить в корзину", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".brain-node.page").length === 3,
  );
  assert.deepEqual(await worldPosition(neighborNode), preservedPosition);
  assert.equal(
    await page.locator(".react-flow__viewport").getAttribute("style"),
    preservedViewport,
  );
  await page.getByRole("button", { name: "Корзина", exact: true }).click();
  await page
    .locator(".trash-item")
    .filter({ hasText: "Референсы" })
    .getByRole("button", { name: "Восстановить", exact: true })
    .click();
  await page
    .locator(".page-tree")
    .getByRole("button", { name: "Референсы", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /^Светильник/ }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".brain-node.page").length === 4,
  );
  results.push(
    "graph membership changes retain existing positions and viewport",
  );
  results.push("tag-scoped graph: 4 pages and tag hubs");
  await page.getByRole("tab", { name: "Таблица", exact: true }).click();
  assert.equal(await page.locator(".table-title").count(), 4);
  await page.getByRole("tab", { name: "Карточки", exact: true }).click();
  assert.equal(await page.locator(".note-card").count(), 4);
  await page.getByRole("tab", { name: "Канбан", exact: true }).click();
  assert.equal(await page.locator(".board-card").count(), 4);
  results.push("table, cards and board share graph membership");
  await page.getByRole("tab", { name: "Связи", exact: true }).click();
  await page
    .getByRole("button", { name: "Материалы", exact: true })
    .last()
    .click();
  await page
    .getByRole("textbox", { name: "Название страницы", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Название страницы", exact: true })
      .inputValue(),
    "Материалы",
  );
  results.push("graph node opens the actual page");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  let source = page.getByRole("textbox", {
    name: "Исходный Markdown",
    exact: true,
  });
  await source.fill("## Preserve source\n\nThis source edit stays.");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "Содержимое страницы",
    exact: true,
  });
  await page.locator('[contenteditable="true"]').click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Extra");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  assert.match(await source.inputValue(), /This source edit stays/);
  results.push("fast source ↔ visual round-trip preserves edits");
  await page
    .getByRole("textbox", { name: "Название страницы", exact: true })
    .fill("Новое название");
  await page
    .getByRole("textbox", { name: "Теги", exact: true })
    .fill("светильник, новый");
  await page.getByRole("textbox", { name: "Статус", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "Сохранено",
  );
  assert.equal(
    await page
      .getByRole("textbox", { name: "Название страницы", exact: true })
      .inputValue(),
    "Новое название",
  );
  results.push("title + tags save without reverting optimistic changes");
  await page.getByRole("button", { name: "Поиск", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Поиск по хранилищу", exact: true })
    .fill("Новое");
  await page
    .getByRole("dialog")
    .getByRole("button")
    .filter({ hasText: "Новое название" })
    .waitFor();
  await page.keyboard.press("Escape");
  results.push("local search finds saved page");
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "Тёмная", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.screenshot({
    path: root + "/artifacts/settings-dark-small.png",
    animations: "disabled",
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  results.push("dark settings at 1024×700: no horizontal overflow");
  await page.setViewportSize({ width: 1320, height: 860 });
  await page.getByRole("button", { name: /^Светильник/ }).click();
  await page.getByRole("tab", { name: "Связи", exact: true }).click();
  await page.locator(".brain-node").first().waitFor();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .getByRole("button", { name: "Включить физику", exact: true })
    .waitFor();
  const reducedPosition = await worldPosition(graphNode("Конструкция"));
  await page.waitForTimeout(200);
  assert.deepEqual(
    await worldPosition(graphNode("Конструкция")),
    reducedPosition,
  );
  await page.screenshot({
    path: root + "/artifacts/graph-dark-v0.2.png",
    animations: "disabled",
  });
  results.push("reduced-motion preference pauses automatic graph movement");
  await page
    .locator(".page-tree")
    .getByRole("button", { name: "Проект светильника", exact: true })
    .click();
  await page.getByRole("tab", { name: "Канбан", exact: true }).click();
  await page.locator(".board-card").waitFor();
  await page.screenshot({
    path: root + "/artifacts/page-board-dark-v0.2.png",
    animations: "disabled",
  });
  await page
    .locator(".page-tree")
    .getByRole("button", { name: "Меню страницы Задача проекта", exact: true })
    .click();
  await page.screenshot({
    path: root + "/artifacts/sidebar-menu-dark-v0.2.png",
    animations: "disabled",
  });
  await page
    .getByRole("menuitem", { name: "Удалить в корзину", exact: true })
    .click();
  await page.getByRole("button", { name: "Корзина", exact: true }).click();
  await page
    .locator(".trash-item")
    .filter({ hasText: "Задача проекта" })
    .waitFor();
  results.push("sidebar deletion moves the correct nested page to trash");
  assert.deepEqual(errors, []);
  await writeFile(
    root + "/artifacts/browser-results.json",
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(JSON.stringify({ results, errors }, null, 2));
} catch (e) {
  await page.screenshot({ path: root + "/artifacts/failure.png" });
  console.error(
    JSON.stringify({
      errors,
      body: (await page.locator("body").innerText()).slice(0, 3000),
      graphNodes: await page
        .locator(".react-flow__node")
        .evaluateAll((nodes) => nodes.slice(0, 2).map((n) => n.outerHTML)),
      viewport: await page
        .locator(".react-flow__viewport")
        .getAttribute("style")
        .catch(() => null),
    }),
  );
  throw e;
} finally {
  await browser.close();
  server.close();
}

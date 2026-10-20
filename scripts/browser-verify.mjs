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
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const results = [];
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/?demo`);
  await page.getByRole("button", { name: /^Светильник/ }).click();
  await page.locator(".brain-node").first().waitFor();
  assert.equal(await page.locator(".brain-node.page").count(), 4);
  assert.ok((await page.locator(".brain-node.tag").count()) >= 3);
  await page.screenshot({ path: root + "/artifacts/graph-light.png", animations: "disabled" });
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
  await page.screenshot({ path: root + "/artifacts/settings-dark-small.png", animations: "disabled" });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  results.push("dark settings at 1024×700: no horizontal overflow");
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
    }),
  );
  throw e;
} finally {
  await browser.close();
  server.close();
}

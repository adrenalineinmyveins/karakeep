import { expect, test } from "@playwright/test";

const EDITOR_PLACEHOLDER = "Paste a link, write a note or drop an image…";

test("create, search and delete a note bookmark", async ({ page }) => {
  test.setTimeout(120_000);
  const note = `smoke note ${Date.now()}`;
  const noteCard = page.locator("[data-bookmark-index]").filter({
    hasText: note,
  });

  // Create a note bookmark from the dashboard editor
  await page.goto("/dashboard/bookmarks");
  const editor = page.getByPlaceholder(EDITOR_PLACEHOLDER);
  await editor.fill(note);
  await editor.press("Control+Enter");
  await expect(noteCard).toHaveCount(1);

  // Full-text search finds it. The search index updates asynchronously, and
  // the search page only queries once per load, so poll with reloads. Wait
  // for a settled UI (results or empty state) before counting, otherwise the
  // count races the freshly reloaded page before it hydrates.
  await page.goto(`/dashboard/search?q=${encodeURIComponent(note)}`);
  await expect
    .poll(
      async () => {
        await page.reload();
        await page
          .getByRole("heading", { name: "No bookmarks yet" })
          .or(noteCard.first())
          .waitFor({ state: "visible" });
        return await noteCard.count();
      },
      { timeout: 90_000, intervals: [3_000] },
    )
    .toBe(1);

  // Delete it via the card options menu
  await page.goto("/dashboard/bookmarks");
  await noteCard.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(noteCard).toHaveCount(0);
});

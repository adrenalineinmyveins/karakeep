import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Regression matrix for the bookmarks grid: the four layouts
// (masonry/grid/list/compact) across desktop and mobile viewports plus RTL
// (ar locale). Guards the BookmarksGrid rendering branch (masonry vs
// single-column container) and the shared responsive column logic.

const EDITOR_PLACEHOLDER = "Paste a link, write a note or drop an image…";

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 375, height: 667 };

const LOCAL_SETTINGS_COOKIE = "saiye-user-local-settings";

const LAYOUTS = ["masonry", "grid", "list", "compact"] as const;

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function setLocalSettings(page: Page, settings: Record<string, unknown>) {
  await page.context().addCookies([
    {
      name: LOCAL_SETTINGS_COOKIE,
      value: JSON.stringify(settings),
      url: test.info().project.use.baseURL ?? "http://localhost:3210",
    },
  ]);
}

/** The masonry container that holds rendered cards (excludes the skeleton). */
function masonryGrid(page: Page) {
  return page
    .locator("div.-ml-4.flex")
    .filter({ has: page.locator("[data-bookmark-index]") });
}

/** The single-column container used by the list/compact layouts. */
function singleColumnGrid(page: Page) {
  return page
    .locator("div.grid.grid-cols-1")
    .filter({ has: page.locator("[data-bookmark-index]") });
}

async function ensureAtLeastTwoBookmarks(page: Page) {
  const cards = page.locator("[data-bookmark-index]");
  let count = await cards.count();
  let serial = 0;
  while (count < 2) {
    const editor = page.getByPlaceholder(EDITOR_PLACEHOLDER);
    await editor.fill(`grid matrix note ${Date.now()} ${serial++}`);
    await editor.press("Control+Enter");
    await expect(cards).toHaveCount(count + 1, { timeout: 15_000 });
    count++;
  }
}

test.describe("bookmarks grid matrix", () => {
  test.beforeEach(async ({ page }) => {
    // Seed cards in the default (en) locale; the per-test local settings
    // cookie is applied afterwards, before the first dashboard render.
    await page.setViewportSize(DESKTOP);
    await page.goto("/dashboard/bookmarks");
    await ensureAtLeastTwoBookmarks(page);
  });

  for (const layout of LAYOUTS) {
    const isListLayout = layout === "list" || layout === "compact";

    test(`desktop: ${layout} renders cards`, async ({ page }) => {
      const errors = trackPageErrors(page);
      await setLocalSettings(page, { bookmarkGridLayout: layout });
      await page.goto("/dashboard/bookmarks");

      if (isListLayout) {
        await expect(singleColumnGrid(page)).toBeVisible();
      } else {
        await expect(masonryGrid(page)).toBeVisible();
      }
      await expect(page.locator("[data-bookmark-index]").first()).toBeVisible();

      // On desktop the masonry family renders multiple columns, so the
      // second card must start further right than the first.
      if (!isListLayout) {
        const first = await page
          .locator("[data-bookmark-index]")
          .first()
          .boundingBox();
        const second = await page
          .locator("[data-bookmark-index]")
          .nth(1)
          .boundingBox();
        expect(second!.x).toBeGreaterThan(first!.x);
      }
      expect(errors).toEqual([]);
    });

    test(`mobile: ${layout} renders a single column`, async ({ page }) => {
      const errors = trackPageErrors(page);
      await setLocalSettings(page, { bookmarkGridLayout: layout });
      await page.setViewportSize(MOBILE);
      await page.goto("/dashboard/bookmarks");

      if (isListLayout) {
        await expect(singleColumnGrid(page)).toBeVisible();
      } else {
        await expect(masonryGrid(page)).toBeVisible();
      }
      await expect(page.locator("[data-bookmark-index]").first()).toBeVisible();

      // Below the sm breakpoint every layout collapses to one column.
      const first = await page
        .locator("[data-bookmark-index]")
        .first()
        .boundingBox();
      const second = await page
        .locator("[data-bookmark-index]")
        .nth(1)
        .boundingBox();
      expect(Math.abs(second!.x - first!.x)).toBeLessThan(1);
      expect(errors).toEqual([]);
    });
  }

  for (const layout of ["masonry", "list"] as const) {
    test(`desktop: ar locale renders ${layout} without errors (RTL)`, async ({
      page,
    }) => {
      const errors = trackPageErrors(page);
      await setLocalSettings(page, { bookmarkGridLayout: layout, lang: "ar" });
      await page.goto("/dashboard/bookmarks");

      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      if (layout === "list") {
        await expect(singleColumnGrid(page)).toBeVisible();
      } else {
        await expect(masonryGrid(page)).toBeVisible();
      }
      await expect(page.locator("[data-bookmark-index]").first()).toBeVisible();
      expect(errors).toEqual([]);

      await page.screenshot({
        path: `test-results/ui/bookmarks-grid/rtl-${layout}.png`,
      });
    });
  }
});

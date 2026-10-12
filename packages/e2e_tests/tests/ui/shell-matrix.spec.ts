import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Regression matrix for the app shell: three AppShell consumers
// (dashboard / settings / admin) across desktop and mobile viewports,
// light/dark themes, RTL (ar) and the collapsible desktop sidebar.

const LAYOUTS = [
  { name: "dashboard", path: "/dashboard/bookmarks" },
  { name: "settings", path: "/settings" },
  { name: "admin", path: "/admin" },
] as const;

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 375, height: 667 };

const LOCAL_SETTINGS_COOKIE = "saiye-user-local-settings";

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function setArabicLocale(page: Page) {
  await page.context().addCookies([
    {
      name: LOCAL_SETTINGS_COOKIE,
      value: JSON.stringify({ lang: "ar" }),
      url: test.info().project.use.baseURL ?? "http://localhost:3210",
    },
  ]);
}

/** Resolves once the element's right edge is flush with the viewport. */
async function expectFlushRight(
  page: Page,
  locator: ReturnType<Page["locator"]>,
) {
  const viewport = page.viewportSize();
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      return box ? box.x + box.width - viewport!.width : Number.NaN;
    })
    .toBeLessThan(2);
}

test.describe("app shell matrix", () => {
  for (const layout of LAYOUTS) {
    test(`desktop: ${layout.name} renders sidebar and header`, async ({
      page,
    }) => {
      const errors = trackPageErrors(page);
      await page.setViewportSize(DESKTOP);
      await page.goto(layout.path);

      await expect(
        page.locator('[data-sidebar="sidebar"]').first(),
      ).toBeVisible();
      await expect(page.locator("header")).toBeVisible();
      await expect(page.locator("main")).toBeVisible();
      expect(errors).toEqual([]);
    });

    test(`mobile: ${layout.name} opens drawer via trigger`, async ({
      page,
    }) => {
      const errors = trackPageErrors(page);
      await page.setViewportSize(MOBILE);
      await page.goto(layout.path);

      // The desktop panel is hidden on mobile.
      await expect(
        page.locator('[data-sidebar="sidebar"]').first(),
      ).toBeHidden();

      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      // The dialog content is the mobile sidebar.
      await expect(dialog).toHaveAttribute("data-sidebar", "sidebar");
      // The drawer exposes the navigation.
      await expect(dialog.getByRole("link").first()).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(errors).toEqual([]);
    });
  }

  test("desktop: dashboard sidebar contains the lists tree", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/dashboard/bookmarks");

    const sidebar = page.locator('[data-sidebar="sidebar"]').first();
    await expect(sidebar.getByText("All Lists")).toBeVisible();
    await expect(sidebar.getByText("Favourites")).toBeVisible();
  });

  test("desktop: Ctrl+B collapses and expands the sidebar", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/dashboard/bookmarks");

    const wrapper = page.locator("div.group.peer");
    await expect(wrapper).toHaveAttribute("data-collapsible", "");

    await page.keyboard.press("Control+b");
    await expect(wrapper).toHaveAttribute("data-collapsible", "icon");

    await page.keyboard.press("Control+b");
    await expect(wrapper).toHaveAttribute("data-collapsible", "");
  });

  test("mobile: drawer closes after navigation", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/dashboard/bookmarks");

    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByRole("link", { name: "Tags" }).click();
    await expect(page).toHaveURL(/\/dashboard\/tags/);
    await expect(dialog).toBeHidden();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`desktop: dashboard renders in ${theme} theme`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await page.addInitScript((value) => {
        window.localStorage.setItem("theme", value);
      }, theme);
      await page.goto("/dashboard/bookmarks");

      const html = page.locator("html");
      if (theme === "dark") {
        await expect(html).toHaveClass(/dark/);
      } else {
        await expect(html).not.toHaveClass(/dark/);
      }
      await expect(
        page.locator('[data-sidebar="sidebar"]').first(),
      ).toBeVisible();
      await page.screenshot({
        path: `test-results/ui/shell-matrix/theme-${theme}.png`,
      });
    });
  }

  test("desktop: ar locale mirrors the sidebar to the right (RTL)", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await setArabicLocale(page);
    await page.goto("/dashboard/bookmarks");

    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    // The fixed sidebar panel must be pinned to the right edge.
    const panel = page.locator('[data-sidebar="sidebar"]').first();
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThan(page.viewportSize()!.width / 2);
    await expectFlushRight(page, panel);

    await page.screenshot({
      path: "test-results/ui/shell-matrix/rtl-desktop.png",
    });
  });

  test("desktop: ar locale collapsed icon tooltips open to the left", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await setArabicLocale(page);
    await page.goto("/dashboard/bookmarks");

    // Press until the rail reacts: the keydown listener only exists after
    // hydration, which can lag behind `goto` (extra client chunks in ar).
    const wrapper = page.locator("div.group.peer");
    await expect
      .poll(
        async () => {
          await page.keyboard.press("Control+b");
          return await wrapper.getAttribute("data-collapsible");
        },
        { timeout: 10_000 },
      )
      .toBe("icon");

    // With the rail pinned right, the tooltip must open on the opposite
    // side (the left) and stay fully inside the viewport.
    const button = page.locator('[data-sidebar="menu-button"]').first();
    await button.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();

    const tipBox = await tooltip.boundingBox();
    const btnBox = await button.boundingBox();
    expect(tipBox).not.toBeNull();
    expect(btnBox).not.toBeNull();
    expect(tipBox!.x).toBeGreaterThanOrEqual(0);
    expect(tipBox!.x + tipBox!.width).toBeLessThanOrEqual(btnBox!.x + 1);
  });

  test("mobile: ar locale opens the drawer from the right (RTL)", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    await setArabicLocale(page);
    await page.goto("/dashboard/bookmarks");

    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expectFlushRight(page, dialog);

    await page.screenshot({
      path: "test-results/ui/shell-matrix/rtl-mobile.png",
    });
  });
});

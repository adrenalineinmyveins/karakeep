import { expect, test } from "@playwright/test";

test("lists page renders and allows creating a list", async ({ page }) => {
  await page.goto("/dashboard/lists");
  await expect(page.getByRole("heading", { name: "All Lists" })).toBeVisible();

  const listName = `smoke list ${Date.now()}`;
  await page.getByRole("button", { name: "New List" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("List Name").fill(listName);
  await dialog.getByPlaceholder("List Name").press("Enter");

  // Creating a list navigates to the new list page
  await page.waitForURL(/\/dashboard\/lists\/[^/]+$/);
});

test("tags page renders", async ({ page }) => {
  await page.goto("/dashboard/tags");
  await expect(page.getByText("All Tags", { exact: true })).toBeVisible();
});

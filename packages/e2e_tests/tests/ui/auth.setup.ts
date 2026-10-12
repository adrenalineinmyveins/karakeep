import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test as setup } from "@playwright/test";

const EDITOR_PLACEHOLDER = "Paste a link, write a note or drop an image…";

// Sign in through the real UI and persist the session for the smoke tests.
// This doubles as the login smoke test itself.
setup("sign in with credentials", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("test1234");
  await page.getByRole("button", { name: "Sign In" }).click();

  await page.waitForURL(/\/dashboard\//);
  await expect(page.getByPlaceholder(EDITOR_PLACEHOLDER)).toBeVisible();

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const statePath = path.join(__dirname, ".auth", "user.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  await page.context().storageState({ path: statePath });
});

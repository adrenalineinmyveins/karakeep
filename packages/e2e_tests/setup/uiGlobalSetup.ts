import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitUntil } from "../utils/general";
import { getTrpcClient } from "../utils/trpc";

// Fixed port so that playwright.config.ts can reference it statically.
const SAIYE_UI_PORT = 3210;

export default async function globalSetup() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.join(__dirname, "..");
  const buildArg = process.env.E2E_TEST_NO_BUILD ? "" : "--build";

  console.log(
    `Starting docker compose for UI tests on port ${SAIYE_UI_PORT}...`,
  );
  execSync(`docker compose up ${buildArg} -d`, {
    cwd: packageRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      SAIYE_PORT: SAIYE_UI_PORT.toString(),
    },
  });

  console.log("Waiting for services to become healthy...");
  await waitUntil(
    async () => {
      const response = await fetch(
        `http://localhost:${SAIYE_UI_PORT}/api/health`,
      );
      return response.status === 200;
    },
    "Saiye is healthy",
    120_000,
  );

  // Seed the test user (reused from the API e2e suite). Tolerate the user
  // already existing when the docker stack was reused from a previous run.
  process.env.SAIYE_PORT = SAIYE_UI_PORT.toString();
  const trpc = getTrpcClient();
  try {
    await trpc.users.create.mutate({
      name: "Test User",
      email: "admin@example.com",
      password: "test1234",
      confirmPassword: "test1234",
    });
  } catch {
    console.log("Test user already exists, skipping creation");
  }

  return async () => {
    console.log("Stopping docker compose...");
    execSync("docker compose down", {
      cwd: packageRoot,
      stdio: "inherit",
    });
  };
}

import { Hono } from "hono";

import serverConfig from "@saiye/shared/config";
import { Context } from "@saiye/trpc";

const version = new Hono<{
  Variables: {
    ctx: Context;
  };
}>().get("/", (c) => {
  return c.json({
    version: serverConfig.serverVersion ?? "unknown",
  });
});

export default version;

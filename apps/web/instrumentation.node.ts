import {
  initEventLogger,
  initTracing,
  loadAllPlugins,
} from "@saiye/shared-server";

await loadAllPlugins();
initTracing("web");
initEventLogger("web");

// Auto-register the PG queue provider when this package is imported.
// D0-b：DATABASE_URL 存在（服务器版 PG）时接管队列，多实例安全；
// PGlite 嵌入式单机场景不注册，仍走 liteque（sqlite）。
import { PluginManager, PluginType } from "@saiye/shared/plugins";

import { PgQueueProvider } from "./src";

if (PgQueueProvider.isConfigured()) {
  PluginManager.register({
    type: PluginType.Queue,
    name: "PgQueue",
    provider: new PgQueueProvider(),
  });
}

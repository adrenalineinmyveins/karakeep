// Auto-register the MeiliSearch provider when this package is imported
import { PluginManager, PluginType } from "@saiye/shared/plugins";

import { MeiliSearchProvider } from "./src";

if (MeiliSearchProvider.isConfigured()) {
  PluginManager.register({
    type: PluginType.Search,
    name: "MeiliSearch",
    provider: new MeiliSearchProvider(),
  });
}

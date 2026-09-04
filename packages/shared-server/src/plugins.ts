import { PluginManager } from "@saiye/shared/plugins";

const pluginLoaderStateKey = "__saiye_plugins_loader_state__";

const globalPluginLoaderState = globalThis as typeof globalThis & {
  [pluginLoaderStateKey]?: {
    loaded: boolean;
    loading?: Promise<void>;
  };
};

const pluginLoaderState = (globalPluginLoaderState[pluginLoaderStateKey] ??= {
  loaded: false,
});

export async function loadAllPlugins() {
  if (pluginLoaderState.loaded) {
    return;
  }
  if (pluginLoaderState.loading) {
    await pluginLoaderState.loading;
    return;
  }
  pluginLoaderState.loading = (async () => {
    // Load plugins here. Order of plugin loading matter.
    // Queue provider(s)
    await import("@saiye/plugins/queue-liteque");
    await import("@saiye/plugins/queue-restate");
    await import("@saiye/plugins/search-meilisearch");
    await import("@saiye/plugins/vectorstore-meilisearch");
    // Rate limiters (order matters - last one wins)
    await import("@saiye/plugins/ratelimit-memory");
    await import("@saiye/plugins/ratelimit-redis");
    PluginManager.logAllPlugins();
    pluginLoaderState.loaded = true;
  })();

  try {
    await pluginLoaderState.loading;
  } finally {
    pluginLoaderState.loading = undefined;
  }
}

/// <reference types="vitest" />

import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// https://vitejs.dev/config/
export default defineConfig({
  // 跳过 .claude（agent 配置）与 .docker-ctx（docker 构建上下文的仓库快照，
  // 其中 tsconfig 的相对路径在快照内无法解析，会刷一串无害但扰人的警告）
  plugins: [
    tsconfigPaths({
      skip: (dir) => dir === ".claude" || dir === ".docker-ctx",
    }),
  ],
  test: {
    alias: {
      "@/*": "./*",
    },
  },
});

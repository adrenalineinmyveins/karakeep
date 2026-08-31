import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // 这两个包必须运行时从 node_modules 加载（不打进 bundle）：
  // mermaid-to-drawnix 的依赖链（mermaid/dompurify）在模块求值期绑定 window，
  // 一旦被 Turbopack 提前打进 server chunk，会在服务启动（无 window）时求值，
  // 导致 dompurify 导出空实例（"addHook is not a function"）。
  // 外部化后，tools.ts 里"先 ensureBrowserLikeEnv() 再动态 import"的顺序才能生效。
  serverExternalPackages: ["@plait-board/mermaid-to-drawnix", "jsdom"],
  turbopack: {
    rules: {
      "*.svg": {
        loaders: ["@svgr/webpack"],
        as: "*.js",
      },
    },
  },
  webpack: (config) => {
    config.module.rules.push({
      test: /\.svg$/,
      use: ["@svgr/webpack"],
    });
    return config;
  },
  async headers() {
    return [
      {
        // Routes this applies to
        source: "/api/(.*)",
        // Headers
        headers: [
          // Allow for specific domains to have access or * for all
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
          // Allows for specific methods accepted
          {
            key: "Access-Control-Allow-Methods",
            value: "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          },
          // Allows for specific headers accepted (These are a few standard ones)
          {
            key: "Access-Control-Allow-Headers",
            value: "Content-Type, Authorization",
          },
          {
            key: "Access-Control-Allow-Credentials",
            value: "true",
          },
        ],
      },
    ];
  },

  // transpilePackages: ["@karakeep/shared", "@karakeep/db", "@karakeep/trpc"],

  /** We already do linting and typechecking as separate tasks in CI */
  typescript: { ignoreBuildErrors: true },

  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS?.split(","),
};

export default withBundleAnalyzer(nextConfig);

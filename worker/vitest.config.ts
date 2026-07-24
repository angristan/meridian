import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          SETUP_TOKEN: "integration-test-setup-token-32-bytes-long",
        },
      },
      wrangler: { configPath: "../wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
})

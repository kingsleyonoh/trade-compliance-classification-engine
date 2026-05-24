import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:18080",
  },
  webServer: {
    command: "cargo run --bin trade-compliance-classification-engine",
    url: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:18080",
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://localhost/trade_compliance",
      APP_BASE_URL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:18080",
      APP_BIND_ADDR: process.env.PLAYWRIGHT_BIND_ADDR ?? "127.0.0.1:18080",
      JWT_SECRET: process.env.JWT_SECRET ?? "your-jwt-secret",
      API_KEY_PEPPER: process.env.API_KEY_PEPPER ?? "your-api-key-pepper",
      CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? "/tmp/tcce-target",
    },
  },
});

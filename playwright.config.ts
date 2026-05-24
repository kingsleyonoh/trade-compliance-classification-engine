import { defineConfig } from "@playwright/test";

function pickDefaultPlaywrightPort(): string {
  const basePort = 30_000;
  const portSpan = 10_000;
  const cwdHash = [...process.cwd()].reduce(
    (hash, character) => (hash * 31 + character.charCodeAt(0)) % portSpan,
    0,
  );

  return String(basePort + cwdHash);
}

function portFromBaseUrl(baseUrl: string, fallbackPort: string): string {
  const parsed = new URL(baseUrl);
  return parsed.port || fallbackPort;
}

const playwrightPort = process.env.PLAYWRIGHT_PORT ?? pickDefaultPlaywrightPort();
const playwrightBaseUrl =
  process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${playwrightPort}`;
const playwrightBindPort = portFromBaseUrl(playwrightBaseUrl, playwrightPort);
const playwrightBindAddr =
  process.env.PLAYWRIGHT_BIND_ADDR ?? `127.0.0.1:${playwrightBindPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: playwrightBaseUrl,
  },
  webServer: {
    command: "cargo run --bin trade-compliance-classification-engine",
    url: playwrightBaseUrl,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://localhost/trade_compliance",
      APP_BASE_URL: playwrightBaseUrl,
      APP_BIND_ADDR: playwrightBindAddr,
      JWT_SECRET: process.env.JWT_SECRET ?? "your-jwt-secret",
      API_KEY_PEPPER: process.env.API_KEY_PEPPER ?? "your-api-key-pepper",
      CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? "/tmp/tcce-target",
    },
  },
});

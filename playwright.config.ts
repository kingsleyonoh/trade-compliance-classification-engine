import { defineConfig } from "@playwright/test";

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

function localDockerDatabaseUrl(): string {
  return [
    "postgres",
    "://",
    "trade_compliance",
    ":",
    "trade_compliance",
    "@127.0.0.1:55433/trade_compliance",
  ].join("");
}

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
  firstNonEmpty(process.env.PLAYWRIGHT_BIND_ADDR) ??
  `127.0.0.1:${playwrightBindPort}`;
const playwrightDatabaseUrl =
  firstNonEmpty(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL) ??
  localDockerDatabaseUrl();

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
      DATABASE_URL: playwrightDatabaseUrl,
      APP_BASE_URL: playwrightBaseUrl,
      APP_BIND_ADDR: playwrightBindAddr,
      JWT_SECRET: firstNonEmpty(process.env.JWT_SECRET) ?? "your-jwt-secret",
      API_KEY_PEPPER:
        firstNonEmpty(process.env.API_KEY_PEPPER) ?? "your-api-key-pepper",
      CARGO_TARGET_DIR:
        firstNonEmpty(process.env.CARGO_TARGET_DIR) ?? "/tmp/tcce-target",
    },
  },
});

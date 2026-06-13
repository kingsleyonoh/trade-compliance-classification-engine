import { defineConfig } from "@playwright/test";

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
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
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: playwrightBaseUrl,
  },
  webServer: {
    command: `node scripts/playwright-webserver.mjs ${playwrightBaseUrl} ${playwrightBindAddr}`,
    url: playwrightBaseUrl,
    reuseExistingServer: true,
    timeout: 300_000,
  },
});

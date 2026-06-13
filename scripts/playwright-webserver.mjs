import { spawn } from "node:child_process";

function firstNonEmpty(...values) {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

function runtimeUsableDatabaseUrl(value) {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    return undefined;
  }

  const database = new URL(trimmed);
  if (
    ["postgres:", "postgresql:"].includes(database.protocol) &&
    (database.username === "" || database.password === "")
  ) {
    return undefined;
  }

  return trimmed;
}

function localDockerDatabaseUrl() {
  return [
    "postgres",
    "://",
    "trade_compliance",
    ":",
    "trade_compliance",
    "@127.0.0.1:55433/trade_compliance",
  ].join("");
}

const [, , baseUrlArg, bindAddrArg] = process.argv;

const env = {
  ...process.env,
  DATABASE_URL:
    runtimeUsableDatabaseUrl(firstNonEmpty(process.env.DATABASE_URL)) ??
    localDockerDatabaseUrl(),
  APP_BASE_URL:
    firstNonEmpty(baseUrlArg, process.env.APP_BASE_URL) ?? "http://127.0.0.1:8080",
  APP_BIND_ADDR:
    firstNonEmpty(bindAddrArg, process.env.APP_BIND_ADDR) ?? "127.0.0.1:8080",
  JWT_SECRET: firstNonEmpty(process.env.JWT_SECRET) ?? "your-jwt-secret",
  API_KEY_PEPPER:
    firstNonEmpty(process.env.API_KEY_PEPPER) ?? "your-api-key-pepper",
  CARGO_TARGET_DIR: firstNonEmpty(process.env.CARGO_TARGET_DIR) ?? "/tmp/tcce-target",
};

const database = new URL(env.DATABASE_URL);
console.error(
  `[playwright-webserver] db=${database.hostname}:${database.port}${database.pathname} base=${env.APP_BASE_URL} bind=${env.APP_BIND_ADDR}`,
);

const child = spawn(
  "cargo",
  ["run", "--bin", "trade-compliance-classification-engine"],
  {
    env,
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

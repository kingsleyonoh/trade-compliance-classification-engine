import { execFileSync } from "node:child_process";

import { expect, test } from "@playwright/test";

function runtimeUsableDatabaseUrl(value: string | undefined): string | undefined {
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

function runSql(sql: string): void {
  const database = new URL(
    runtimeUsableDatabaseUrl(process.env.DATABASE_URL) ?? localDockerDatabaseUrl(),
  );
  execFileSync(
    "psql",
    [
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "-h",
      database.hostname,
      "-p",
      database.port || "5432",
      "-U",
      decodeURIComponent(database.username),
      "-d",
      database.pathname.replace(/^\//, ""),
      "-c",
      sql,
    ],
    {
      env: {
        ...process.env,
        PGPASSWORD: decodeURIComponent(database.password),
      },
      stdio: "pipe",
    },
  );
}

type ApiRequest = {
  get: (
    url: string,
    options?: unknown,
  ) => Promise<{ status: () => number; json: () => Promise<Record<string, unknown>> }>;
};

async function expectClassifiedRun(
  request: ApiRequest,
  runId: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  let lastDetail: Record<string, unknown> | undefined;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await request.get(`/api/classifications/${runId}`, { headers });
    expect(response.status()).toBe(200);
    const detail = await response.json();
    lastDetail = detail;

    if (["classified", "needs_review"].includes(String(detail.status))) {
      expect(detail.selected_code).toBe("6205.20");
      expect(detail.risk_band).toBe("low");
      expect(String(detail.confidence)).toContain("0.91");
      expect(detail.input_snapshot).toMatchObject({
        description: "woven cotton shirt",
      });
      expect(detail.candidates).toMatchObject({
        matched_rules: [expect.objectContaining({ code: "6205.20", confidence: 0.91 })],
      });
      expect(detail.explanation).toMatchObject({ runtime: "deterministic_wasm_stub" });
      return detail;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `classification ${runId} did not complete before audit export: ${JSON.stringify(lastDetail)}`,
  );
}

function goldenRuleSource(code: string): string {
  return JSON.stringify({
    rules: [
      {
        id: "shirt",
        code,
        contains: "shirt",
        confidence: 0.91,
        risk_band: "low",
      },
    ],
    golden_cases: Array.from({ length: 10 }, (_, index) => ({
      product: {
        description: `woven cotton shirt case ${index}`,
        materials: ["cotton"],
      },
      expected_code: code,
    })),
    coverage: {
      outputs: [
        "hs_hts_recommendation",
        "duty_estimate",
        "risk_band",
        "audit_pack",
        "denied_goods_flag",
      ],
    },
  });
}

test("real HTTP server responds from the configured base URL", async ({
  request,
}) => {
  const response = await request.get("/__missing");
  expect(response.status()).toBe(404);
});

test("webServer tolerates empty DATABASE_URL assignment by using local fallback", async ({
  request,
}) => {
  const response = await request.get("/health/db");
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ status: "ok" });
});

test("real HTTP auth rejects inactive tenants and protects metrics", async ({
  request,
}) => {
  const unique = Date.now().toString();
  const email = `inactive-${unique}@example.test`;
  const registration = await request.post("/api/tenants/register", {
    data: {
      legal_name: `Inactive Probe ${unique}`,
      full_legal_name: `Inactive Probe ${unique} Limited`,
      display_name: `Inactive Probe ${unique}`,
      address: { line1: "1 Test Way" },
      registration: { number: `INACTIVE-${unique}` },
      contact: { email },
      wordmark: "Inactive Probe",
      regulator_ids: {},
      admin_email: email,
    },
  });
  expect(registration.status()).toBe(201);
  const { api_key, tenant_id } = await registration.json();

  const publicMetrics = await request.get("/metrics");
  expect(publicMetrics.status()).toBe(401);
  await expect(publicMetrics.json()).resolves.toMatchObject({
    error: { code: "missing_api_key" },
  });

  const authorizedMetrics = await request.get("/metrics", {
    headers: { "x-api-key": api_key },
  });
  expect(authorizedMetrics.status()).toBe(200);
  expect(await authorizedMetrics.text()).toContain("imports_started_total");

  runSql(`UPDATE tenants SET is_active = false WHERE id = '${tenant_id}'`);

  const inactiveMe = await request.get("/tenants/me", {
    headers: { "x-api-key": api_key },
  });
  expect(inactiveMe.status()).toBe(401);
  await expect(inactiveMe.json()).resolves.toMatchObject({
    error: { code: "invalid_api_key" },
  });
});

test("real HTTP product import enforces write scope and readiness facts", async ({
  request,
}) => {
  const unique = Date.now().toString();
  const email = `auditor-${unique}@example.test`;
  const registration = await request.post("/api/tenants/register", {
    data: {
      legal_name: `Auditor Probe ${unique}`,
      full_legal_name: `Auditor Probe ${unique} Limited`,
      display_name: `Auditor Probe ${unique}`,
      address: { line1: "1 Test Way" },
      registration: { number: `AUD-${unique}` },
      contact: { email },
      wordmark: "Auditor Probe",
      regulator_ids: {},
      admin_email: email,
    },
  });
  expect(registration.status()).toBe(201);
  const { api_key } = await registration.json();

  const incompleteImport = await request.post("/api/products/import", {
    headers: { "x-api-key": api_key },
    data: {
      rows: [
        {
          sku: `NOFACTS-${unique}`,
          name: "No facts",
          description: "Missing materials and intended use",
          country_of_origin: "NG",
          jurisdiction: "US",
          product_type: "apparel",
          materials: [],
          intended_use: "",
        },
      ],
    },
  });
  expect(incompleteImport.status()).toBe(200);
  await expect(incompleteImport.json()).resolves.toMatchObject({
    imported: 0,
    errors: [{ code: "missing_materials" }],
  });

  runSql(`UPDATE users SET scope = 'auditor' WHERE email = '${email}'`);

  const deniedImport = await request.post("/api/products/import", {
    headers: { "x-api-key": api_key },
    data: {
      rows: [
        {
          sku: `DENIED-${unique}`,
          name: "Denied",
          description: "Auditor must not write products",
          country_of_origin: "NG",
          jurisdiction: "US",
          product_type: "apparel",
          materials: ["cotton"],
          intended_use: "retail sale",
        },
      ],
    },
  });
  expect(deniedImport.status()).toBe(403);
  await expect(deniedImport.json()).resolves.toMatchObject({
    error: { code: "insufficient_scope" },
  });
});

test("real HTTP rule-pack lifecycle is admin-only and persists validation", async ({
  request,
}) => {
  const unique = Date.now().toString();
  const adminEmail = `rules-admin-${unique}@example.test`;
  const registration = await request.post("/api/tenants/register", {
    data: {
      legal_name: `Rules Admin ${unique}`,
      full_legal_name: `Rules Admin ${unique} Limited`,
      display_name: `Rules Admin ${unique}`,
      address: { line1: "1 Test Way" },
      registration: { number: `RULE-${unique}` },
      contact: { email: adminEmail },
      wordmark: "Rules Admin",
      regulator_ids: {},
      admin_email: adminEmail,
    },
  });
  expect(registration.status()).toBe(201);
  const { api_key } = await registration.json();

  const upload = await request.post("/api/rule-packs", {
    headers: { "x-api-key": api_key },
    data: {
      name: `mvp-hs-${unique}`,
      version: "2026.1",
      jurisdiction: "US",
      source: goldenRuleSource("6205.20"),
    },
  });
  expect(upload.status()).toBe(201);
  const pack = await upload.json();
  expect(pack.validation_report.valid).toBe(true);

  const activated = await request.post(`/api/rule-packs/${pack.id}/activate`, {
    headers: { "x-api-key": api_key },
    data: {},
  });
  expect(activated.status()).toBe(200);
  await expect(activated.json()).resolves.toMatchObject({ status: "active" });
});

test("import classify override export flow and denied role actions are covered", async ({
  request,
}) => {
  const unique = Date.now().toString();
  const email = `flow-admin-${unique}@example.test`;
  const registration = await request.post("/api/tenants/register", {
    data: {
      legal_name: `Flow Admin ${unique}`,
      full_legal_name: `Flow Admin ${unique} Limited`,
      display_name: `Flow Admin ${unique}`,
      address: { line1: "1 Test Way" },
      registration: { number: `FLOW-${unique}` },
      contact: { email },
      wordmark: "Flow Admin",
      regulator_ids: {},
      admin_email: email,
    },
  });
  expect(registration.status()).toBe(201);
  const { api_key } = await registration.json();
  const headers = { "x-api-key": api_key };

  const upload = await request.post("/api/rule-packs", {
    headers,
    data: {
      name: `flow-rules-${unique}`,
      version: "2026.1",
      jurisdiction: "US",
      source: goldenRuleSource("6205.20"),
    },
  });
  expect(upload.status()).toBe(201);
  const pack = await upload.json();
  expect((await request.post(`/api/rule-packs/${pack.id}/activate`, { headers, data: {} })).status()).toBe(200);

  expect((await request.post("/api/products/import", {
    headers,
    data: { rows: [{ sku: `FLOW-${unique}`, name: "Flow shirt", description: "woven cotton shirt", country_of_origin: "NG", jurisdiction: "US", product_type: "apparel", materials: ["cotton"], intended_use: "retail sale" }] },
  })).status()).toBe(200);
  const productList = await request.get(`/api/products?query=FLOW-${unique}`, { headers });
  expect(productList.status()).toBe(200);
  const productId = (await productList.json()).items[0].id;

  const run = await request.post("/api/classifications/run", { headers, data: { product_ids: [productId] } });
  expect(run.status()).toBe(201);
  const runId = (await run.json()).runs[0].id;
  await expectClassifiedRun(request, runId, headers);

  const override = await request.post(`/api/classifications/${runId}/override`, {
    headers,
    data: { override_code: "6205.20", reason_code: "supplier_evidence", note: "Playwright flow evidence", structured_correction: { source: "fixture" } },
  });
  expect(override.status()).toBe(201);

  const exportResponse = await request.post("/api/audit-exports", { headers, data: { classification_run_id: runId, format: "json" } });
  expect(exportResponse.status()).toBe(201);

  runSql(`UPDATE users SET scope = 'auditor' WHERE email = '${email}'`);
  const deniedOverride = await request.post(`/api/classifications/${runId}/override`, {
    headers,
    data: { override_code: "6205.20", reason_code: "other" },
  });
  expect(deniedOverride.status()).toBe(403);
});

test("MOBILE_VIEWPORT_PASS mobile viewport loads the real HTTP app", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");

  await expect(page.locator("body")).toContainText(
    "Trade Compliance Classification Engine",
  );
  expect(page.viewportSize()).toEqual({ width: 375, height: 667 });
});

import { execFileSync } from "node:child_process";

import { expect, test } from "@playwright/test";

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

  execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "trade_compliance",
      "-d",
      "trade_compliance",
      "-c",
      `UPDATE tenants SET is_active = false WHERE id = '${tenant_id}'`,
    ],
    { stdio: "pipe" },
  );

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

  execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "trade_compliance",
      "-d",
      "trade_compliance",
      "-c",
      `UPDATE users SET scope = 'auditor' WHERE email = '${email}'`,
    ],
    { stdio: "pipe" },
  );

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

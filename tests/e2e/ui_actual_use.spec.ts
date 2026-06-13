import { expect, test } from "@playwright/test";

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

test("browser API-key session unlocks UI and form actions use real endpoints and ids", async ({
  page,
  request,
}) => {
  const unique = Date.now().toString();
  const registration = await request.post("/api/tenants/register", {
    data: {
      legal_name: `UI Actual Use ${unique}`,
      full_legal_name: `UI Actual Use ${unique} Limited`,
      display_name: `UI Actual Use ${unique}`,
      address: { line1: "1 Browser Way" },
      registration: { number: `UI-${unique}` },
      contact: { email: `ui-${unique}@example.test` },
      wordmark: "UI Actual Use",
      regulator_ids: {},
      admin_email: `ui-${unique}@example.test`,
    },
  });
  expect(registration.status()).toBe(201);
  const { api_key } = await registration.json();

  await page.goto("/ui/dashboard");
  await expect(page).toHaveURL(/\/ui\/login/);
  await expect(page.getByRole("heading", { name: /API key sign in/i })).toBeVisible();

  await page.getByLabel(/tenant API key/i).fill(api_key);
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page).toHaveURL(/\/ui\/dashboard/);
  await expect(page.getByRole("heading", { name: /Compliance dashboard/i })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("missing_api_key");

  await page.getByRole("link", { name: /rule packs/i }).click();
  await page.getByLabel(/rule pack name/i).fill(`ui-rules-${unique}`);
  await page.getByLabel(/version/i).fill("2026.1");
  await page.getByLabel(/jurisdiction/i).selectOption("US");
  await page.getByLabel(/rule pack source/i).fill(goldenRuleSource("6205.20"));
  await page.getByRole("button", { name: /upload rule pack/i }).click();
  await expect(page.getByTestId("rule-pack-status")).toContainText(/uploaded|valid/i);
  await expect(page.locator("form[action*='{id}'], button[formaction*='{id}'], a[href*='{id}']")).toHaveCount(0);
  await page.getByRole("button", { name: /validate/i }).click();
  await expect(page.getByTestId("rule-pack-status")).toContainText(/valid/i);
  await page.getByRole("button", { name: /activate/i }).click();
  await expect(page.getByTestId("rule-pack-status")).toContainText(/active/i);

  await page.getByRole("link", { name: /import products/i }).click();
  await page.getByLabel(/sku/i).fill(`UI-${unique}`);
  await page.getByLabel(/name/i).fill("UI woven shirt");
  await page.getByLabel(/description/i).fill("woven cotton shirt for retail sale");
  await page.getByLabel(/country of origin/i).fill("NG");
  await page.getByLabel(/jurisdiction/i).selectOption("US");
  await page.getByLabel(/product type/i).fill("apparel");
  await page.getByLabel(/materials/i).fill("cotton");
  await page.getByLabel(/intended use/i).fill("retail sale");
  await page.getByRole("button", { name: /import product/i }).click();
  await expect(page.getByTestId("import-status")).toContainText(/imported 1/i);
  await expect(page.locator("body")).not.toContainText("unsupported media type");
  await expect(page.getByTestId("readiness-feedback")).not.toContainText(/materials and intended use are required before classification/i);

  await page.getByRole("link", { name: /^products$/i }).click();
  await expect(page.getByText(`UI-${unique}`)).toBeVisible();
  await page.getByLabel(`Select product UI-${unique}`).check();
  await page.getByRole("button", { name: /run selected/i }).click();
  await expect(page.getByTestId("run-status")).toContainText(/queued|completed|classification/i);

  await page.getByRole("link", { name: /classifications/i }).click();
  await expect(page.getByText(`UI-${unique}`)).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("6205.20")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await page.getByRole("link", { name: new RegExp(`View classification.*UI-${unique}`) }).click();
  await expect(page.getByTestId("classification-trace")).toContainText(/6205\.20/i);
  const classificationUrl = page.url();
  const classificationRunId = classificationUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  expect(classificationRunId).toBeTruthy();

  await page.getByRole("button", { name: /create audit export/i }).click();
  await expect(page.getByTestId("export-status")).toContainText(/created|completed|download/i);
  await expect(page.locator("form[action*='{id}'], button[formaction*='{id}'], a[href*='{id}']")).toHaveCount(0);

  await page.getByRole("link", { name: /audit exports/i }).click();
  await expect(page.getByTestId("audit-exports")).toContainText(`UI-${unique}`);
  await expect(page.getByTestId("audit-exports")).toContainText(classificationRunId!);
  const downloadLink = page.getByRole("link", { name: /download json audit export/i });
  await expect(downloadLink).toBeVisible();
  const downloadHref = await downloadLink.getAttribute("href");
  expect(downloadHref).toMatch(new RegExp(`/ui/audit-exports/[0-9a-f-]{36}/download$`, "i"));
  expect(downloadHref).not.toContain("{id}");
  await expect(downloadLink).toHaveAttribute("download", /audit-export-[0-9a-f-]{36}\.json/i);
  const exportResponse = await page.request.get(downloadHref!);
  expect(exportResponse.status()).toBe(200);
  expect(exportResponse.headers()["content-disposition"]).toMatch(
    /^attachment; filename="audit-export-[0-9a-f-]{36}\.json"$/i,
  );

  await page.getByRole("link", { name: /^reviews$/i }).click();
  await expect(page.getByTestId("review-queue")).toContainText(`UI-${unique}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("input, textarea, select, button, a").first()).toBeVisible();
  const undersizedTouchTargets = await page
    .locator("input, textarea, select, button, a, label:has(input[type='checkbox'])")
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.height < 44;
        })
        .map((element) => `${element.tagName.toLowerCase()}[${element.textContent?.trim() || element.getAttribute("aria-label") || element.getAttribute("name") || element.getAttribute("href") || "unnamed"}]=${element.getBoundingClientRect().height}`),
    );
  expect(undersizedTouchTargets).toEqual([]);
  await expect(page.getByTestId("review-queue")).toContainText(classificationRunId!);
  const overrideForm = page.locator(`form[data-run-id="${classificationRunId}"]`);
  await expect(overrideForm.getByRole("button", { name: /record override/i })).toBeEnabled();
  await expect(overrideForm).toHaveAttribute("action", `/ui/reviews/${classificationRunId}/override`);
  await overrideForm.getByLabel(/override code/i).fill("6205.30");
  await overrideForm.getByLabel(/reason code/i).selectOption("supplier_evidence");
  await overrideForm.getByLabel(/review note/i).fill("Supplier fiber evidence corrected the classification.");
  await overrideForm.getByLabel(/structured correction/i).fill('{"material":"cotton blend","source":"supplier-letter"}');
  await overrideForm.getByRole("button", { name: /record override/i }).click();
  await expect(page.getByTestId("review-status")).toContainText(/override recorded/i);
  await expect(page.getByTestId("review-queue")).toContainText("6205.30");
  await expect(page.getByTestId("review-queue")).toContainText("supplier_evidence");
  await expect(page.getByTestId("review-queue")).toContainText("supplier-letter");

  await page.getByRole("link", { name: /integrations/i }).click();
  await expect(page.getByTestId("integration-controls")).toContainText(/optional|non-blocking|disabled/i);
});

import { expect, test } from "@playwright/test";

test("real HTTP server responds from the configured base URL", async ({
  request,
}) => {
  const response = await request.get("/__missing");
  expect(response.status()).toBe(404);
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

import { expect, test } from "@playwright/test";

test("onboarding, language switching, and status views fully load", async ({ page }) => {
  await page.goto("/");
  const brandMark = page.locator(".brand-mark");
  await expect(brandMark).toBeVisible();
  await expect.poll(() => brandMark.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "欢迎使用 DeepSeek Harness Desktop" })).toBeVisible();
  await page.getByLabel("切换语言").selectOption("en-US");
  await expect(page.getByRole("heading", { name: "Welcome to DeepSeek Harness Desktop" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Choose a workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();

  await page.getByRole("button", { name: /Runtime/ }).click();
  await expect(page.getByRole("heading", { name: "Ready to start" })).toBeVisible();
  await page.getByRole("button", { name: /Diagnostics/ }).click();
  await expect(page.getByRole("heading", { name: "Runtime diagnostics" })).toBeVisible();
  await page.getByRole("button", { name: /Updates/ }).click();
  await expect(page.getByRole("heading", { name: "Application updates" })).toBeVisible();
  await page.getByRole("button", { name: /About/ }).click();
  await expect(page.getByRole("heading", { name: "About DeepSeek Harness Desktop" })).toBeVisible();
  await expect(page.getByText("0.1.0-community.5")).toBeVisible();
  await expect(page.getByText("Community", { exact: true })).toBeVisible();
  await expect(page.getByText("Unsigned community build")).toBeVisible();
});

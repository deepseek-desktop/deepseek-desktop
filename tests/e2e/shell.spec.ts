import { expect, test } from "@playwright/test";

test("onboarding, language switching, and status views fully load", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "欢迎使用 DSH Desktop" })).toBeVisible();
  await page.getByLabel("切换语言").selectOption("en-US");
  await expect(page.getByRole("heading", { name: "Welcome to DSH Desktop" })).toBeVisible();

  await page.getByRole("button", { name: /Runtime/ }).click();
  await expect(page.getByRole("heading", { name: "Ready to start" })).toBeVisible();
  await page.getByRole("button", { name: /Diagnostics/ }).click();
  await expect(page.getByRole("heading", { name: "Runtime diagnostics" })).toBeVisible();
  await page.getByRole("button", { name: /Updates/ }).click();
  await expect(page.getByRole("heading", { name: "Application updates" })).toBeVisible();
  await page.getByRole("button", { name: /About/ }).click();
  await expect(page.getByRole("heading", { name: "About DSH Desktop" })).toBeVisible();
  await expect(page.getByText("0.1.0-community.1")).toBeVisible();
  await expect(page.getByText("Community", { exact: true })).toBeVisible();
  await expect(page.getByText("Unsigned community build")).toBeVisible();
});

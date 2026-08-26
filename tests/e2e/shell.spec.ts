import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appConfig = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../target/generated/app-config.json"), "utf8")
) as {
  productName: string;
  version: string;
  release: {
    channel: "local" | "community" | "stable";
    signed: boolean;
  };
};

const releaseChannelLabel = {
  local: "Local build",
  community: "Community",
  stable: "Stable"
} as const;

test("onboarding, language switching, and status views fully load", async ({ page }) => {
  await page.goto("/");
  const brandMark = page.locator(".brand-mark");
  await expect(brandMark).toBeVisible();
  await expect.poll(() => brandMark.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: `欢迎使用 ${appConfig.productName}` })).toBeVisible();
  await page.getByLabel("切换语言").selectOption("en-US");
  await expect(page.getByRole("heading", { name: `Welcome to ${appConfig.productName}` })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: `About ${appConfig.productName}` })).toBeVisible();
  await expect(page.getByText(appConfig.version)).toBeVisible();
  await expect(page.getByText(releaseChannelLabel[appConfig.release.channel], { exact: true })).toBeVisible();
  await expect(page.getByText(appConfig.release.signed ? "Signed release build" : "Unsigned build")).toBeVisible();
});

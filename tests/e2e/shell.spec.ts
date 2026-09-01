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

test("automatic Runtime startup, language switching, and status views fully load", async ({ page }) => {
  await page.goto("/");
  const brandMark = page.locator(".brand-mark");
  await expect(brandMark).toBeVisible();
  await expect.poll(() => brandMark.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "Runtime 已就绪" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始使用" })).toHaveCount(0);
  await page.getByLabel("切换语言").selectOption("en-US");
  await expect(page.getByRole("heading", { name: "Runtime ready" })).toBeVisible();
  await expect(page.getByText("Choose a workspace")).toHaveCount(0);

  await page.getByRole("button", { name: /Diagnostics/ }).click();
  await expect(page.getByRole("heading", { name: "Runtime diagnostics" })).toBeVisible();
  await page.getByRole("button", { name: /Updates/ }).click();
  await expect(page.getByRole("heading", { name: "Updates", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Desktop application" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Independent Runtime update" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Update behavior" })).toHaveValue("notify");
  await expect(page.getByRole("combobox", { name: "Runtime channel" })).toHaveValue("stable");
  await expect(page.getByRole("button", { name: "Restore bundled Runtime" })).toBeVisible();
  await page.getByRole("button", { name: /About/ }).click();
  await expect(page.getByRole("heading", { name: `About ${appConfig.productName}` })).toBeVisible();
  await expect(page.getByText(appConfig.version)).toBeVisible();
  await expect(page.getByText(releaseChannelLabel[appConfig.release.channel], { exact: true })).toBeVisible();
  await expect(page.getByText(appConfig.release.signed ? "Signed release build" : "Unsigned build")).toBeVisible();
});

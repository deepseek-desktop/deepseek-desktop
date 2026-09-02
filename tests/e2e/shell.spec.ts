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
  harness: {
    repository: string;
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
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  const desktopMenu = page.getByRole("menubar", { name: "应用菜单" });
  await expect(desktopMenu).toBeVisible();
  await expect(desktopMenu.getByRole("menuitem")).toHaveText(["文件", "编辑", "视图", "窗口", "帮助"]);
  await expect(page.getByRole("button", { name: "开始使用" })).toHaveCount(0);
  await page.getByLabel("切换语言").selectOption("en-US");
  await expect(page.getByRole("heading", { name: "Runtime ready" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close settings and return to the workbench" })).toBeVisible();
  await expect(page.getByText("Choose a workspace")).toHaveCount(0);
  await expect(page.getByRole("menubar", { name: "Application menu" }).getByRole("menuitem")).toHaveText(["File", "Edit", "View", "Window", "Help"]);

  await page.getByRole("button", { name: /Diagnostics/ }).click();
  await expect(page.getByRole("heading", { name: "Runtime diagnostics" })).toBeVisible();
  await page.getByRole("button", { name: /Updates/ }).click();
  await expect(page.getByRole("heading", { name: "Updates", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Desktop update" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Independent Runtime update" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Manifest URL" })).toHaveCount(0);
  const runtimeRepository = page.getByRole("textbox", { name: "Runtime repository" });
  await expect(runtimeRepository).toBeVisible();
  await expect(runtimeRepository).toHaveValue(appConfig.harness.repository);
  await expect(page.getByRole("textbox", { name: "Publisher" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Ed25519 public key" })).toHaveCount(0);
  const saveUpdateSource = page.getByRole("button", { name: "Save repository" });
  await expect(saveUpdateSource).toBeDisabled();
  await runtimeRepository.fill("https://github.com/example/runtime.git");
  await expect(saveUpdateSource).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "Update behavior" })).toHaveValue("notify");
  await expect(page.getByRole("combobox", { name: "Runtime channel" })).toHaveValue("stable");
  await expect(page.getByRole("button", { name: "Restore bundled Runtime" })).toBeVisible();
  const settingsContent = page.locator(".content");
  await settingsContent.evaluate(element => element.scrollTo({ top: element.scrollHeight }));
  await expect(page.getByRole("button", { name: "Restore bundled Runtime" })).toBeVisible();
  await page.getByRole("button", { name: /About/ }).click();
  await expect(page.getByRole("heading", { name: `About ${appConfig.productName}` })).toBeVisible();
  await expect(page.getByText(appConfig.version)).toBeVisible();
  await expect(page.getByText(releaseChannelLabel[appConfig.release.channel], { exact: true })).toBeVisible();
  await expect(page.getByText(appConfig.release.signed ? "Signed release build" : "Unsigned build")).toBeVisible();
});

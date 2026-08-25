import process from "node:process";

const channel = process.argv[2] || "community";
if (channel === "community") {
  console.log("community release gate passed: artifacts must remain explicitly marked as not publisher-signed");
  process.exit(0);
}
if (channel !== "stable") throw new Error(`unsupported release channel ${channel}`);

const required = [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "DEEPSEEK_DESKTOP_UPDATER_PUBKEY",
  "DEEPSEEK_DESKTOP_UPDATER_ENDPOINT",
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "WINDOWS_CERTIFICATE",
  "WINDOWS_CERTIFICATE_PASSWORD"
];
const missing = required.filter(name => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(`stable release is blocked; missing signing configuration: ${missing.join(", ")}`);
}
console.log("stable release signing gate passed");

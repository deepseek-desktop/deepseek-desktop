import process from "node:process";

process.env.RELEASE_CHANNEL = "community";
process.env.RELEASE_SIGNED = "false";
await import("./desktop-package.mjs");

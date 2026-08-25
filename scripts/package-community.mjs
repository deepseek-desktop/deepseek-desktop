import process from "node:process";

process.env.RELEASE_CHANNEL = "community";
await import("./desktop-package.mjs");

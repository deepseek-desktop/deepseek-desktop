import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const output = resolve(process.argv[2] || "target/generated/runtime-update-signing-key.pem");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
const publicDer = publicKey.export({ format: "der", type: "spki" });
console.log(`Private signing key created at ${output}`);
console.log(`RUNTIME_UPDATE_PUBLIC_KEY=${Buffer.from(publicDer).subarray(-32).toString("base64")}`);

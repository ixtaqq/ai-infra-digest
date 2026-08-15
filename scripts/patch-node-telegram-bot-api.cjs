"use strict";

const fs = require("node:fs");
const path = require("node:path");

const packagePath = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "node-telegram-bot-api",
  "package.json"
);

if (!fs.existsSync(packagePath)) {
  console.log("node-telegram-bot-api is not installed; skipping exports patch");
  process.exit(0);
}

const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
if (!Object.prototype.hasOwnProperty.call(packageJson, "exports")) {
  console.log("node-telegram-bot-api exports patch already applied");
  process.exit(0);
}

delete packageJson.exports;
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log("patched node-telegram-bot-api: removed exports field");

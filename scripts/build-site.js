"use strict";
// Publish only the two public HTML pages, never extension code or server config.
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const output = path.join(root, "site");
fs.mkdirSync(output, { recursive: true });
for (const file of ["index.html", "privacy.html"]) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}
console.log("Built site/index.html and site/privacy.html");

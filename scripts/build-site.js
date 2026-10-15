"use strict";
// Publish only public pages, their stylesheet, and approved product screenshots.
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const output = path.join(root, "site");
fs.mkdirSync(output, { recursive: true });
for (const file of [
  "index.html",
  "privacy.html",
  "website.css",
  "docs/images/googlecleaner-review.png",
]) {
  fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true });
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}
console.log("Built public website pages, stylesheet, and product screenshots");

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const origin = process.argv[2];
let url;
try { url = new URL(origin); } catch (_) { throw new Error("Usage: node scripts/configure-auth.js https://YOUR-AUTH-HOST"); }
if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error("Use only the HTTPS origin, with no path or trailing slash.");
const configPath = path.join(root, "extension/auth-config.js");
const source = fs.readFileSync(configPath, "utf8");
const old = JSON.parse(source.match(/globalThis.GC_AUTH_CONFIG\s*=\s*(\{[^;]+\});/)[1]);
const manifestPath = path.join(root, "extension/manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [...new Set(manifest.host_permissions.filter(value => !old.authOrigin || value !== old.authOrigin + "/*").concat(origin + "/*"))];
fs.writeFileSync(configPath, '"use strict";\n// Public auth service origin; never put client secrets here.\nglobalThis.GC_AUTH_CONFIG = ' + JSON.stringify({ authOrigin: origin }) + ';\n');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("Configured auth origin and its exact host permission. Reload the unpacked extension.");

"use strict";
const { config, prepare, exchange, AuthError } = require("../lib/oauth");
module.exports = async function handler(req, res) {
  let settings;
  try { settings = config(); } catch (_) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "Authentication service is not configured." });
  }
  if (!prepare(req, res, "POST", settings)) return;
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) return res.status(415).json({ error: "JSON body required." });
  if (JSON.stringify(req.body || {}).length > 12000) return res.status(413).json({ error: "Request too large." });
  try { res.status(200).json(await exchange(req.body, settings)); }
  catch (error) {
    const message = error.name === "TimeoutError" ? "Google did not respond. Try again."
      : error instanceof AuthError ? error.message : "Authentication request failed. Try again.";
    res.status(400).json({ error: message });
  }
};

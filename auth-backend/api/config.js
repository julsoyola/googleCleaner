"use strict";
const { config, prepare, DRIVE_SCOPE } = require("../lib/oauth");
module.exports = function handler(req, res) {
  try {
    const settings = config();
    if (!prepare(req, res, "GET", settings)) return;
    res.status(200).json({ clientId: settings.clientId, redirectUri: settings.redirectUri, scope: DRIVE_SCOPE });
  } catch (_) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: "Authentication service is not configured." });
  }
};

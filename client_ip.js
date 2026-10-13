"use strict";

const net = require("node:net");

function getClientIp(req) {
    const forwardedClientIp = req?.headers?.["cf-connecting-ip"];
    if (typeof forwardedClientIp === "string") {
        const candidate = forwardedClientIp.trim();
        if (net.isIP(candidate) !== 0) return candidate;
    }

    // Do not trust X-Forwarded-For here: it can include a caller-supplied
    // value before Render appends its proxy addresses.
    return req?.socket?.remoteAddress || "unknown";
}

module.exports = { getClientIp };

"use strict";

function isSameOriginRequest(req) {
    const origin = req && req.headers && req.headers.origin;
    const host = req && req.headers && req.headers.host;
    if (typeof origin !== "string" || typeof host !== "string" || !host) return false;

    const forwardedProto = req.headers["x-forwarded-proto"];
    const scheme = forwardedProto || (req.socket && req.socket.encrypted ? "https" : "http");
    if (scheme !== "http" && scheme !== "https") return false;

    try {
        return new URL(origin).origin === new URL(`${scheme}://${host}`).origin;
    } catch {
        return false;
    }
}

module.exports = { isSameOriginRequest };

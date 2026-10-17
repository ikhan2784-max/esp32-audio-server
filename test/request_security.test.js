"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isSameOriginRequest } = require("../request_security");

test("accepts the public HTTPS origin behind Render's proxy", () => {
    assert.equal(isSameOriginRequest({
        headers: {
            origin: "https://esp32-audio-server-phase5-staging.onrender.com",
            host: "esp32-audio-server-phase5-staging.onrender.com",
            "x-forwarded-proto": "https",
        },
        socket: { encrypted: false },
    }), true);
});

test("rejects a different same-site Render origin", () => {
    assert.equal(isSameOriginRequest({
        headers: {
            origin: "https://attacker.onrender.com",
            host: "esp32-audio-server-phase5-staging.onrender.com",
            "x-forwarded-proto": "https",
        },
        socket: { encrypted: false },
    }), false);
});

test("rejects missing, opaque, malformed, or insecure origins", () => {
    const base = {
        headers: { host: "listener.example.test", "x-forwarded-proto": "https" },
        socket: { encrypted: false },
    };
    assert.equal(isSameOriginRequest(base), false);
    assert.equal(isSameOriginRequest({ ...base, headers: { ...base.headers, origin: "null" } }), false);
    assert.equal(isSameOriginRequest({ ...base, headers: { ...base.headers, origin: "not a URL" } }), false);
    assert.equal(isSameOriginRequest({
        ...base,
        headers: { ...base.headers, origin: "http://listener.example.test" },
    }), false);
});

test("accepts same-origin local HTTP requests with matching ports", () => {
    assert.equal(isSameOriginRequest({
        headers: { origin: "http://localhost:3000", host: "localhost:3000" },
        socket: { encrypted: false },
    }), true);
});

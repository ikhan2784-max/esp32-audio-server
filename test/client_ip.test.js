"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getClientIp } = require("../client_ip");

test("uses Render's validated client IP header for auth rate limiting", () => {
    assert.equal(getClientIp({
        headers: { "cf-connecting-ip": "203.0.113.7" },
        socket: { remoteAddress: "10.0.0.2" }
    }), "203.0.113.7");
});

test("supports IPv6 client addresses", () => {
    assert.equal(getClientIp({
        headers: { "cf-connecting-ip": "2001:db8::7" },
        socket: { remoteAddress: "10.0.0.2" }
    }), "2001:db8::7");
});

test("ignores spoofable X-Forwarded-For values", () => {
    assert.equal(getClientIp({
        headers: { "x-forwarded-for": "198.51.100.99, 203.0.113.7" },
        socket: { remoteAddress: "10.0.0.2" }
    }), "10.0.0.2");
});

test("rejects malformed forwarded client values and uses the socket address", () => {
    assert.equal(getClientIp({
        headers: { "cf-connecting-ip": "198.51.100.1, 203.0.113.7" },
        socket: { remoteAddress: "10.0.0.2" }
    }), "10.0.0.2");
    assert.equal(getClientIp({ headers: {}, socket: {} }), "unknown");
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { hasValidListenerSession } = require("../listener_auth");

test("accepts an authenticated listener with a live session", () => {
    assert.equal(hasValidListenerSession({
        role: "listener", authenticated: true, sessionValid: () => true,
    }), true);
});

test("rejects expired or missing listener sessions", () => {
    assert.equal(hasValidListenerSession({
        role: "listener", authenticated: true, sessionValid: () => false,
    }), false);
    assert.equal(hasValidListenerSession({ role: "listener", authenticated: true }), false);
});

test("does not treat other socket roles as listeners", () => {
    assert.equal(hasValidListenerSession({
        role: "source", authenticated: true, sessionValid: () => true,
    }), false);
});

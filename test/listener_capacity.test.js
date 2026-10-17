"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { addListenerWithinLimit } = require("../listener_capacity");

test("admits listeners up to the configured bound and rejects overflow", () => {
    const listeners = new Set();
    const first = {};
    const second = {};
    const overflow = {};
    assert.equal(addListenerWithinLimit(listeners, first, 2), true);
    assert.equal(addListenerWithinLimit(listeners, second, 2), true);
    assert.equal(addListenerWithinLimit(listeners, overflow, 2), false);
    assert.equal(listeners.size, 2);
    assert.equal(listeners.has(overflow), false);
});

test("admitting an existing listener is idempotent at capacity", () => {
    const listeners = new Set();
    const existing = {};
    assert.equal(addListenerWithinLimit(listeners, existing, 1), true);
    assert.equal(addListenerWithinLimit(listeners, existing, 1), true);
    assert.equal(listeners.size, 1);
});

test("rejects invalid capacity arguments", () => {
    assert.throws(() => addListenerWithinLimit(new Set(), {}, 0), TypeError);
});

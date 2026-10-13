const test = require("node:test");
const assert = require("node:assert/strict");
const { createAuthState, constantTimeStringEqual } = require("../auth_state");

function createState(overrides = {}) {
    let time = 1000;
    let id = 0;
    const state = createAuthState({
        sessionDurationMs: 100,
        authWindowMs: 50,
        authMaxAttempts: 3,
        maxSessions: 2,
        maxTrackedIps: 2,
        now: () => time,
        createId: () => `session-${++id}`,
        ...overrides,
    });
    return { state, setTime: (next) => { time = next; } };
}

test("sessions expire at their absolute deadline", () => {
    const { state, setTime } = createState();
    const id = state.createSession();
    assert.ok(state.getSession(id));
    setTime(1100);
    assert.equal(state.getSession(id), null);
});

test("session storage stays bounded and evicts the oldest live session", () => {
    const { state } = createState();
    const first = state.createSession();
    const second = state.createSession();
    const third = state.createSession();
    assert.equal(state.getSession(first), null);
    assert.ok(state.getSession(second));
    assert.ok(state.getSession(third));
});

test("failed PIN attempts are limited, reset after the window, and clear on success", () => {
    const { state, setTime } = createState();
    for (let attempt = 0; attempt < 3; attempt++) state.recordAuthAttempt("client-a");
    assert.equal(state.isAuthRateLimited("client-a"), true);
    state.clearAuthAttempts("client-a");
    assert.equal(state.isAuthRateLimited("client-a"), false);
    state.recordAuthAttempt("client-a");
    state.recordAuthAttempt("client-a");
    state.recordAuthAttempt("client-a");
    setTime(1050);
    assert.equal(state.isAuthRateLimited("client-a"), false);
});

test("rate-limit storage stays bounded for unique client addresses", () => {
    const { state } = createState();
    state.recordAuthAttempt("client-a");
    state.recordAuthAttempt("client-b");
    state.recordAuthAttempt("client-b");
    state.recordAuthAttempt("client-b");
    state.recordAuthAttempt("client-c");
    assert.equal(state.isAuthRateLimited("client-a"), false);
    assert.equal(state.isAuthRateLimited("client-b"), true);
    assert.equal(state.isAuthRateLimited("client-c"), false);
});

test("PIN comparison accepts exact matches and rejects mismatches", () => {
    assert.equal(constantTimeStringEqual("listen-123", "listen-123"), true);
    assert.equal(constantTimeStringEqual("listen-123", "listen-12"), false);
    assert.equal(constantTimeStringEqual("listen-123", "listen-124"), false);
    assert.equal(constantTimeStringEqual("listen-123", undefined), false);
});

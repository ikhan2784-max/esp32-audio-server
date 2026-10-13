const crypto = require("crypto");

function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`);
    }
    return value;
}

function constantTimeStringEqual(expected, supplied) {
    if (typeof expected !== "string" || typeof supplied !== "string") return false;
    const key = Buffer.from(expected, "utf8");
    const expectedDigest = crypto.createHmac("sha256", key).update(expected, "utf8").digest();
    const suppliedDigest = crypto.createHmac("sha256", key).update(supplied, "utf8").digest();
    return crypto.timingSafeEqual(expectedDigest, suppliedDigest);
}

function createAuthState({
    sessionDurationMs,
    sessionIdleDurationMs,
    authWindowMs,
    authMaxAttempts,
    maxSessions,
    maxTrackedIps,
    now = Date.now,
    createId = () => crypto.randomBytes(32).toString("hex"),
}) {
    positiveInteger(sessionDurationMs, "sessionDurationMs");
    positiveInteger(sessionIdleDurationMs, "sessionIdleDurationMs");
    positiveInteger(authWindowMs, "authWindowMs");
    positiveInteger(authMaxAttempts, "authMaxAttempts");
    positiveInteger(maxSessions, "maxSessions");
    positiveInteger(maxTrackedIps, "maxTrackedIps");
    if (typeof now !== "function" || typeof createId !== "function") {
        throw new TypeError("now and createId must be functions");
    }

    const sessions = new Map();
    const authAttempts = new Map();

    function removeExpiredSessions(at) {
        for (const [id, session] of sessions) {
            if (at >= session.expiresAt) sessions.delete(id);
        }
    }

    function removeExpiredAttempts(at) {
        for (const [ip, entry] of authAttempts) {
            if (at - entry.windowStart >= authWindowMs) authAttempts.delete(ip);
        }
    }

    function createSession() {
        const createdAt = now();
        removeExpiredSessions(createdAt);
        while (sessions.size >= maxSessions) {
            sessions.delete(sessions.keys().next().value);
        }

        let id;
        do {
            id = createId();
        } while (sessions.has(id));

        const absoluteExpiresAt = createdAt + sessionDurationMs;
        sessions.set(id, {
            createdAt,
            lastActivityAt: createdAt,
            absoluteExpiresAt,
            expiresAt: Math.min(absoluteExpiresAt, createdAt + sessionIdleDurationMs),
        });
        return id;
    }

    function getSession(id) {
        if (typeof id !== "string") return null;
        const session = sessions.get(id);
        if (!session) return null;
        if (now() >= session.expiresAt) {
            sessions.delete(id);
            return null;
        }
        return session;
    }

    function touchSession(id) {
        const session = getSession(id);
        if (!session) return false;
        const at = now();
        session.lastActivityAt = at;
        session.expiresAt = Math.min(session.absoluteExpiresAt, at + sessionIdleDurationMs);
        return true;
    }

    function isAuthRateLimited(ip) {
        if (typeof ip !== "string") return false;
        const at = now();
        const entry = authAttempts.get(ip);
        if (!entry) return false;
        if (at - entry.windowStart >= authWindowMs) {
            authAttempts.delete(ip);
            return false;
        }
        return entry.attempts >= authMaxAttempts;
    }

    function recordAuthAttempt(ip) {
        if (typeof ip !== "string") return;
        const at = now();
        const entry = authAttempts.get(ip);
        if (entry && at - entry.windowStart < authWindowMs) {
            entry.attempts++;
            return;
        }

        removeExpiredAttempts(at);
        while (!authAttempts.has(ip) && authAttempts.size >= maxTrackedIps) {
            authAttempts.delete(authAttempts.keys().next().value);
        }
        authAttempts.set(ip, { windowStart: at, attempts: 1 });
    }

    function clearAuthAttempts(ip) {
        authAttempts.delete(ip);
    }

    function deleteSession(id) {
        sessions.delete(id);
    }

    function cleanup() {
        const at = now();
        removeExpiredSessions(at);
        removeExpiredAttempts(at);
    }

    return {
        createSession,
        getSession,
        touchSession,
        deleteSession,
        isAuthRateLimited,
        recordAuthAttempt,
        clearAuthAttempts,
        cleanup,
    };
}

module.exports = { createAuthState, constantTimeStringEqual };

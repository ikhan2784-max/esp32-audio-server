"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const path = require("node:path");

async function reservePort() {
    const socket = net.createServer();
    await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(0, "127.0.0.1", resolve);
    });
    const { port } = socket.address();
    await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
    return port;
}

async function waitForServer(url, child) {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
        try {
            const response = await fetch(`${url}/health`);
            if (response.ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Server did not become ready");
}

test("WebRTC status is authenticated, uncached, and reports the single-device signaling state", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, PORT: String(port), SOURCE_TOKEN: "test-only-source", LISTENER_PIN: "test-only-pin" },
        stdio: "ignore",
    });

    try {
        await waitForServer(baseUrl, child);
        const statusUrl = `${baseUrl}/api/webrtc-status`;
        const secureHeaders = { "x-forwarded-proto": "https" };
        const unauthorized = await fetch(statusUrl, { headers: secureHeaders });
        assert.equal(unauthorized.status, 401);
        assert.equal(unauthorized.headers.get("cache-control"), "no-store");

        const originHeaders = {
            ...secureHeaders,
            origin: `https://127.0.0.1:${port}`,
            "content-type": "application/json",
        };
        const login = await fetch(`${baseUrl}/api/auth`, {
            method: "POST",
            headers: originHeaders,
            body: JSON.stringify({ pin: "test-only-pin" }),
        });
        assert.equal(login.status, 200);
        const cookie = login.headers.get("set-cookie").split(";", 1)[0];

        const loginPage = await fetch(baseUrl, { headers: secureHeaders });
        assert.equal(loginPage.status, 200);
        const loginHtml = await loginPage.text();
        assert.match(loginHtml, /<title>Listening Device \| Secure Access<\/title>/);
        assert.doesNotMatch(loginHtml, /ESP32 INMP441|Secure Live Audio Listener/);
        assert.match(loginHtml, /window\.location\.href="\/phase5-listener"/);

        const authenticatedRoot = await fetch(baseUrl, {
            headers: { ...secureHeaders, cookie },
            redirect: "manual",
        });
        assert.equal(authenticatedRoot.status, 302);
        assert.equal(authenticatedRoot.headers.get("location"), "/phase5-listener");

        const legacyListener = await fetch(`${baseUrl}/listener`, {
            headers: { ...secureHeaders, cookie },
            redirect: "manual",
        });
        assert.equal(legacyListener.status, 302);
        assert.equal(legacyListener.headers.get("location"), "/phase5-listener");

        const listenerPage = await fetch(`${baseUrl}/phase5-listener`, {
            headers: { ...secureHeaders, cookie },
        });
        assert.equal(listenerPage.status, 200);
        assert.match(listenerPage.headers.get("cache-control"), /no-store/);
        assert.match(await listenerPage.text(), /<title>Listening Device<\/title>/);

        const response = await fetch(statusUrl, {
            headers: { ...secureHeaders, cookie },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), {
            ok: true,
            transport: "webrtc",
            device_connected: false,
            listener_connected: false,
            session_active: false,
        });
    } finally {
        child.kill();
        if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const path = require("node:path");
const WebSocket = require("ws");

function waitForWsMessage(socket, predicate, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off("message", onMessage);
            reject(new Error("Timed out waiting for the expected WebSocket message"));
        }, timeoutMs);
        function onMessage(raw) {
            let message;
            try { message = JSON.parse(raw.toString()); }
            catch { return; }
            if (!predicate(message)) return;
            clearTimeout(timeout);
            socket.off("message", onMessage);
            resolve(message);
        }
        socket.on("message", onMessage);
    });
}

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
    let deviceSocket;

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
        const status = await response.json();
        assert.deepEqual(status, {
            ok: true,
            transport: "webrtc",
            device_connected: false,
            listener_connected: false,
            listener_count: 0,
            session_active: false,
            connected_at: null,
            last_seen: null,
            webrtc_sessions_started: 0,
            webrtc_sessions_ended: 0,
            last_session_started_at: null,
            last_session_duration_ms: null,
        });

        deviceSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        await once(deviceSocket, "open");
        const readyPromise = waitForWsMessage(deviceSocket, (message) => message.type === "webrtc_device_ready");
        deviceSocket.send(JSON.stringify({
            type: "webrtc_device_hello",
            device_id: "ESP32-S3-INMP441",
            source_token: "test-only-source",
        }));
        await readyPromise;

        const healthRequestPromise = waitForWsMessage(deviceSocket, (message) => message.type === "webrtc_health_request");
        const healthResponsePromise = fetch(`${baseUrl}/api/devices/ESP32-S3-INMP441/health-check`, {
            method: "POST",
            headers: { ...originHeaders, cookie },
        });
        const healthRequest = await healthRequestPromise;
        assert.match(healthRequest.id, /^[A-Za-z0-9_-]{1,64}$/);
        deviceSocket.send(JSON.stringify({
            type: "webrtc_health_response",
            id: healthRequest.id,
            data: { wifi_connected: true, uptime_ms: 123456, free_internal_heap: 32768 },
        }));
        const healthResponse = await healthResponsePromise;
        assert.equal(healthResponse.status, 200);
        const healthBody = await healthResponse.json();
        assert.equal(healthBody.ok, true);
        assert.equal(healthBody.device_id, "ESP32-S3-INMP441");
        assert.equal(healthBody.request_id, healthRequest.id);
        assert.match(healthBody.checked_at, /^\d{4}-\d\d-\d\dT/);
        assert.deepEqual(healthBody.data, {
            wifi_connected: true,
            uptime_ms: 123456,
            free_internal_heap: 32768,
        });

        const powerSettingRequestPromise = waitForWsMessage(
            deviceSocket, (message) => message.type === "webrtc_power_settings_request");
        const powerSettingResponsePromise = fetch(
            `${baseUrl}/api/devices/ESP32-S3-INMP441/power-settings`, {
                method: "POST",
                headers: { ...originHeaders, cookie },
                body: JSON.stringify({ auto_power_saving_enabled: false }),
            }
        );
        const powerSettingRequest = await powerSettingRequestPromise;
        assert.match(powerSettingRequest.id, /^[A-Za-z0-9_-]{1,64}$/);
        assert.equal(powerSettingRequest.auto_power_saving_enabled, false);
        deviceSocket.send(JSON.stringify({
            type: "webrtc_power_settings_response",
            id: powerSettingRequest.id,
            auto_power_saving_enabled: false,
            ok: true,
        }));
        const powerSettingResponse = await powerSettingResponsePromise;
        assert.equal(powerSettingResponse.status, 200);
        const powerSettingBody = await powerSettingResponse.json();
        assert.equal(powerSettingBody.ok, true);
        assert.equal(powerSettingBody.device_id, "ESP32-S3-INMP441");
        assert.equal(powerSettingBody.auto_power_saving_enabled, false);
    } finally {
        if (deviceSocket && deviceSocket.readyState !== WebSocket.CLOSED) deviceSocket.close();
        child.kill();
        if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
});

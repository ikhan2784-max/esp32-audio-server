"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWebRtcSignaling, MAX_SDP_CHARS } = require("../webrtc_signaling");
const WebSocket = { OPEN: 1, CLOSED: 3 };

class MockSocket {
    constructor(sessionValid = false) {
        this.readyState = WebSocket.OPEN;
        this.role = "unknown";
        this.authenticated = false;
        this.sessionValid = sessionValid;
        this.messages = [];
        this.closeCode = null;
    }

    send(text) { this.messages.push(JSON.parse(text)); }
    close(code) { this.closeCode = code; this.readyState = WebSocket.CLOSED; }
    last(type) { return this.messages.findLast((message) => message.type === type); }
}

function makeHarness() {
    const signaling = createWebRtcSignaling({
        WebSocket,
        sourceToken: "test-only-token",
        isListenerSessionValid: (ws) => ws.sessionValid
    });
    return { signaling, device: new MockSocket(), listener: new MockSocket(true) };
}

function joinBoth(harness) {
    const { signaling, device, listener } = harness;
    assert.equal(signaling.handleMessage(device, {
        type: "webrtc_device_hello",
        device: "ESP32-S3-INMP441",
        source_token: "test-only-token"
    }), true);
    assert.equal(signaling.handleMessage(listener, { type: "webrtc_listener_hello" }), true);
    return device.last("webrtc_session_ready").session_id;
}

test("requires device token and authenticated listener session", () => {
    const { signaling, device } = makeHarness();
    const listener = new MockSocket(false);
    signaling.handleMessage(device, {
        type: "webrtc_device_hello",
        device: "ESP32-S3-INMP441",
        source_token: "wrong-token"
    });
    signaling.handleMessage(listener, { type: "webrtc_listener_hello" });
    assert.equal(device.closeCode, 1008);
    assert.equal(listener.closeCode, 1008);
    assert.deepEqual(signaling.getStatus(), {
        device_connected: false,
        listener_connected: false,
        session_active: false
    });
});

test("pairs authorized peers and relays only the expected offer, answer and ICE", () => {
    const harness = makeHarness();
    const { signaling, device, listener } = harness;
    const sessionId = joinBoth(harness);
    assert.ok(sessionId);
    assert.equal(device.last("webrtc_session_ready").role, "offerer");
    assert.equal(listener.last("webrtc_session_ready").role, "answerer");

    const offer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
    signaling.handleMessage(device, {
        type: "webrtc_signal", session_id: sessionId, kind: "offer", sdp: offer
    });
    assert.equal(listener.last("webrtc_signal").sdp, offer);

    const answer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
    signaling.handleMessage(listener, {
        type: "webrtc_signal", session_id: sessionId, kind: "answer", sdp: answer
    });
    assert.equal(device.last("webrtc_signal").sdp, answer);

    const candidate = "candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host";
    signaling.handleMessage(listener, {
        type: "webrtc_signal", session_id: sessionId, kind: "candidate", candidate
    });
    assert.equal(device.last("webrtc_signal").candidate, candidate);
    signaling.handleMessage(listener, {
        type: "webrtc_signal", session_id: sessionId, kind: "end-of-candidates"
    });
    assert.equal(device.last("webrtc_signal").kind, "end-of-candidates");
    assert.equal(signaling.getStatus().session_active, true);
});

test("rejects wrong-direction and oversized SDP", () => {
    const harness = makeHarness();
    const { signaling, listener } = harness;
    const sessionId = joinBoth(harness);
    signaling.handleMessage(listener, {
        type: "webrtc_signal", session_id: sessionId, kind: "offer", sdp: "v=0\r\n"
    });
    assert.equal(listener.closeCode, 1008);

    const second = makeHarness();
    const secondSession = joinBoth(second);
    second.signaling.handleMessage(second.device, {
        type: "webrtc_signal", session_id: secondSession, kind: "offer",
        sdp: "x".repeat(MAX_SDP_CHARS + 1)
    });
    assert.equal(second.device.closeCode, 1008);
});

test("rejects binary audio from WebRTC peers and ends paired session on disconnect", () => {
    const harness = makeHarness();
    const { signaling, device, listener } = harness;
    joinBoth(harness);
    assert.equal(signaling.handleBinary(device), true);
    assert.equal(device.closeCode, 1008);
    signaling.handleClose(device);
    assert.equal(listener.last("webrtc_session_end").reason, "device_disconnected");
    assert.equal(signaling.getStatus().session_active, false);
});

test("expires a listener session and disconnects a signaling peer that is over buffer limit", () => {
    const expired = makeHarness();
    const expiredSession = joinBoth(expired);
    expired.listener.sessionValid = false;
    expired.signaling.handleMessage(expired.listener, {
        type: "webrtc_signal", session_id: expiredSession, kind: "end-of-candidates"
    });
    assert.equal(expired.listener.closeCode, 1008);

    const overloaded = makeHarness();
    const overloadedSession = joinBoth(overloaded);
    overloaded.listener.bufferedAmount = 65 * 1024;
    overloaded.signaling.handleMessage(overloaded.device, {
        type: "webrtc_signal", session_id: overloadedSession, kind: "offer",
        sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
    });
    assert.equal(overloaded.listener.closeCode, 1013);
    assert.equal(overloaded.signaling.getStatus().session_active, false);
});

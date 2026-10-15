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

function makeHarness(onHealthCheckResponse = () => {}) {
    const signaling = createWebRtcSignaling({
        WebSocket,
        sourceToken: "test-only-token",
        isListenerSessionValid: (ws) => ws.sessionValid,
        onHealthCheckResponse,
    });
    return { signaling, device: new MockSocket(), listener: new MockSocket(true) };
}

test("routes a bounded authenticated device health snapshot to its request callback", () => {
    const responses = [];
    const { signaling, device } = makeHarness((...args) => responses.push(args));
    signaling.handleMessage(device, {
        type: "webrtc_device_hello",
        device: "ESP32-S3-INMP441",
        source_token: "test-only-token",
    });
    const deviceId = device.last("webrtc_device_ready").device_id;
    const requestId = "health_1234567890abcdef";

    assert.equal(signaling.requestDeviceHealth(deviceId, requestId), true);
    assert.deepEqual(device.last("webrtc_health_request"), {
        type: "webrtc_health_request",
        id: requestId,
    });
    assert.equal(signaling.requestDeviceHealth(deviceId, "bad id"), false);

    assert.equal(signaling.handleMessage(device, {
        type: "webrtc_health_response",
        id: requestId,
        data: {
            wifi_connected: true,
            i2s_sample_rate_hz: 16000,
            i2s_slot_bits: 32,
            i2s_valid_bits: 24,
            pcm_bits: 16,
            pcm_channels: 1,
            pcm_signed: true,
            audio_profile: "16kHz PCM16",
            reset_reason_name: "POWERON",
            app_partition_free_bytes: 123456,
            firmware_version: "2.5.0",
            build_id: "a".repeat(64),
            dsp_input_peak: 1234,
            dsp_ns_level: "off",
            dsp_vad_level: "medium",
            dsp_limiter_level: "low",
            source_token: "must-not-pass-through",
        },
    }), true);
    assert.deepEqual(responses, [[deviceId, requestId, {
        wifi_connected: true,
        i2s_sample_rate_hz: 16000,
        i2s_slot_bits: 32,
        i2s_valid_bits: 24,
        pcm_bits: 16,
        pcm_channels: 1,
        pcm_signed: true,
        audio_profile: "16kHz PCM16",
        reset_reason_name: "POWERON",
        app_partition_free_bytes: 123456,
        firmware_version: "2.5.0",
        build_id: "a".repeat(64),
        dsp_input_peak: 1234,
        dsp_ns_level: "off",
        dsp_vad_level: "medium",
        dsp_limiter_level: "low",
    }]]);
});

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

test("rejects an empty device token when server credentials are unset", () => {
    const signaling = createWebRtcSignaling({
        WebSocket,
        sourceToken: "",
        isListenerSessionValid: () => true,
    });
    const device = new MockSocket();
    signaling.handleMessage(device, {
        type: "webrtc_device_hello",
        device: "ESP32-S3-INMP441",
        source_token: "",
    });
    assert.equal(device.closeCode, 1008);
    assert.deepEqual(signaling.getStatus(), {
        device_connected: false,
        listener_connected: false,
        session_active: false,
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

test("rejects a second WebRTC listener without displacing the active listener", () => {
    const harness = makeHarness();
    const { signaling, listener } = harness;
    const sessionId = joinBoth(harness);
    const secondListener = new MockSocket(true);

    signaling.handleMessage(secondListener, { type: "webrtc_listener_hello" });

    assert.equal(secondListener.last("webrtc_error").reason, "listener_busy");
    assert.equal(secondListener.closeCode, 1008);
    assert.equal(listener.readyState, WebSocket.OPEN);
    assert.equal(listener.last("webrtc_session_ready").session_id, sessionId);
    assert.equal(signaling.getStatus().listener_connected, true);
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

test("relays bounded session-only microphone gain controls and device acknowledgements", () => {
    const harness = makeHarness();
    const { signaling, device, listener } = harness;
    const sessionId = joinBoth(harness);

    signaling.handleMessage(listener, {
        type: "webrtc_audio_control", session_id: sessionId,
        command: "mic_gain", gain_percent: 125
    });
    assert.deepEqual(device.last("webrtc_audio_control"), {
        type: "webrtc_audio_control", session_id: sessionId,
        command: "mic_gain", gain_percent: 125
    });

    signaling.handleMessage(device, {
        type: "webrtc_audio_control_ack", session_id: sessionId,
        command: "mic_gain", gain_percent: 125, ok: true
    });
    assert.deepEqual(listener.last("webrtc_audio_control_ack"), {
        type: "webrtc_audio_control_ack", session_id: sessionId,
        command: "mic_gain", gain_percent: 125, ok: true
    });

    for (const gainPercent of [25, 200]) {
        signaling.handleMessage(listener, {
            type: "webrtc_audio_control", session_id: sessionId,
            command: "mic_gain", gain_percent: gainPercent
        });
        assert.equal(device.last("webrtc_audio_control").gain_percent, gainPercent);
    }
});

test("relays only the supported audio profiles and forwards the reboot acknowledgement", () => {
    const harness = makeHarness();
    const { signaling, device, listener } = harness;
    const sessionId = joinBoth(harness);

    signaling.handleMessage(listener, {
        type: "webrtc_audio_control", session_id: sessionId,
        command: "audio_profile", sample_rate_hz: 16000,
    });
    assert.deepEqual(device.last("webrtc_audio_control"), {
        type: "webrtc_audio_control", session_id: sessionId,
        command: "audio_profile", sample_rate_hz: 16000,
    });

    signaling.handleMessage(device, {
        type: "webrtc_audio_control_ack", session_id: sessionId,
        command: "audio_profile", sample_rate_hz: 16000, ok: true, restarting: true,
    });
    assert.deepEqual(listener.last("webrtc_audio_control_ack"), {
        type: "webrtc_audio_control_ack", session_id: sessionId,
        command: "audio_profile", sample_rate_hz: 16000, ok: true, restarting: true,
    });

    for (const sampleRateHz of [16000, 48000]) {
        signaling.handleMessage(listener, {
            type: "webrtc_audio_control", session_id: sessionId,
            command: "audio_profile", sample_rate_hz: sampleRateHz,
        });
        assert.equal(device.last("webrtc_audio_control").sample_rate_hz, sampleRateHz);
    }
});

test("rejects unsupported audio profile rates from listeners and devices", () => {
    const invalidRequest = makeHarness();
    const invalidRequestSession = joinBoth(invalidRequest);
    invalidRequest.signaling.handleMessage(invalidRequest.listener, {
        type: "webrtc_audio_control", session_id: invalidRequestSession,
        command: "audio_profile", sample_rate_hz: 44100,
    });
    assert.equal(invalidRequest.listener.last("webrtc_error").reason, "invalid_audio_control");

    const invalidAck = makeHarness();
    const invalidAckSession = joinBoth(invalidAck);
    invalidAck.signaling.handleMessage(invalidAck.device, {
        type: "webrtc_audio_control_ack", session_id: invalidAckSession,
        command: "audio_profile", sample_rate_hz: 44100, ok: true, restarting: false,
    });
    assert.equal(invalidAck.device.last("webrtc_error").reason, "invalid_audio_control_ack");
});

test("relays all four ESP32 DSP levels and validates each level on request and ack", () => {
    for (const noise_suppression_level of ["off", "low", "medium", "high"]) {
        for (const vad_level of ["off", "low", "medium", "high"]) {
            for (const limiter_level of ["off", "low", "medium", "high"]) {
                const harness = makeHarness();
                const { signaling, device, listener } = harness;
                const sessionId = joinBoth(harness);
                const settings = {
                    type: "webrtc_audio_settings",
                    session_id: sessionId,
                    mic_mode: "mic1",
                    auto_gain_enabled: true,
                    hpf_preset: "voice_clarity",
                    noise_suppression_level,
                    vad_level,
                    limiter_level,
                };

                assert.equal(signaling.handleMessage(listener, settings), true);
                assert.deepEqual(device.last("webrtc_audio_settings"), settings);
                assert.equal(signaling.handleMessage(device, {
                    type: "webrtc_audio_settings_ack",
                    session_id: sessionId,
                    mic_mode: "mic1",
                    auto_gain_enabled: true,
                    hpf_preset: "voice_clarity",
                    noise_suppression_level,
                    vad_level,
                    limiter_level,
                    ok: true,
                }), true);
                assert.equal(listener.last("webrtc_audio_settings_ack").noise_suppression_level,
                    noise_suppression_level);
                assert.equal(listener.last("webrtc_audio_settings_ack").vad_level, vad_level);
                assert.equal(listener.last("webrtc_audio_settings_ack").limiter_level, limiter_level);
            }
        }
    }
});

test("rejects invalid ESP32 DSP level names", () => {
    for (const [field, value] of [
        ["noise_suppression_level", "maximum"],
        ["vad_level", "maximum"],
        ["limiter_level", "maximum"],
    ]) {
        const harness = makeHarness();
        const sessionId = joinBoth(harness);
        harness.signaling.handleMessage(harness.listener, {
            type: "webrtc_audio_settings",
            session_id: sessionId,
            mic_mode: "mic1",
            auto_gain_enabled: true,
            hpf_preset: "voice_clarity",
            noise_suppression_level: "off",
            vad_level: "medium",
            limiter_level: "low",
            [field]: value,
        });
        assert.equal(harness.listener.last("webrtc_error").reason, "invalid_audio_settings");
        assert.equal(harness.device.last("webrtc_audio_settings"), undefined);
    }
});

test("rejects stale, out-of-range, and wrong-direction microphone gain controls", () => {
    const stale = makeHarness();
    const staleSession = joinBoth(stale);
    stale.signaling.handleMessage(stale.listener, {
        type: "webrtc_audio_control", session_id: `${staleSession}x`,
        command: "mic_gain", gain_percent: 100
    });
    assert.equal(stale.listener.closeCode, 1008);

    const invalid = makeHarness();
    const invalidSession = joinBoth(invalid);
    invalid.signaling.handleMessage(invalid.listener, {
        type: "webrtc_audio_control", session_id: invalidSession,
        command: "mic_gain", gain_percent: 201
    });
    assert.equal(invalid.listener.closeCode, 1008);

    const wrongDirection = makeHarness();
    const directionSession = joinBoth(wrongDirection);
    wrongDirection.signaling.handleMessage(wrongDirection.listener, {
        type: "webrtc_audio_control_ack", session_id: directionSession,
        command: "mic_gain", gain_percent: 100, ok: true
    });
    assert.equal(wrongDirection.listener.closeCode, 1008);
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

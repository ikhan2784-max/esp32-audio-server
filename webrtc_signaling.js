"use strict";

const crypto = require("crypto");
const { constantTimeStringEqual } = require("./auth_state");

const MAX_SDP_CHARS = 12 * 1024;
const MAX_CANDIDATE_CHARS = 2048;
const SIGNAL_WINDOW_MS = 60 * 1000;
const MAX_SIGNALS_PER_WINDOW = 120;
const MAX_CONTROL_MESSAGES_PER_WINDOW = 60;
const MIC_GAIN_MIN_PERCENT = 50;
const MIC_GAIN_MAX_PERCENT = 150;
const MAX_SIGNAL_BUFFERED_BYTES = 64 * 1024;
const DEVICE_NAME = "ESP32-S3-INMP441";

function safeEqual(expected, actual) {
    if (typeof expected !== "string" || typeof actual !== "string" || !expected || !actual) {
        return false;
    }
    return constantTimeStringEqual(expected, actual);
}

function createWebRtcSignaling({ WebSocket, sourceToken, isListenerSessionValid }) {
    let device = null;
    let listener = null;
    let sessionId = null;
    let telemetry = null;
    let telemetryUpdatedAt = 0;

    function send(ws, value) {
        if (!ws || ws.readyState !== WebSocket.OPEN ||
            Number(ws.bufferedAmount || 0) > MAX_SIGNAL_BUFFERED_BYTES) return false;
        try {
            ws.send(JSON.stringify(value));
            return true;
        } catch {
            return false;
        }
    }

    function endSession(reason, except) {
        if (sessionId !== null) {
            if (device && device !== except) send(device, { type: "webrtc_session_end", session_id: sessionId, reason });
            if (listener && listener !== except) send(listener, { type: "webrtc_session_end", session_id: sessionId, reason });
        }
        sessionId = null;
    }

    function closeClient(ws, code, reason) {
        try { ws.close(code, reason); } catch {}
    }

    function pairIfReady() {
        if (sessionId !== null || !device || !listener ||
            device.readyState !== WebSocket.OPEN || listener.readyState !== WebSocket.OPEN) {
            return;
        }
        sessionId = crypto.randomUUID();
        const message = { type: "webrtc_session_ready", session_id: sessionId };
        send(device, { ...message, role: "offerer" });
        send(listener, { ...message, role: "answerer" });
    }

    function fail(ws, reason) {
        send(ws, { type: "webrtc_error", reason });
        closeClient(ws, 1008, "WebRTC signaling rejected");
    }

    function handleJoin(ws, message) {
        if (ws.role !== "unknown") return false;
        if (message.type === "webrtc_device_hello") {
            if (message.device !== DEVICE_NAME || !safeEqual(sourceToken, message.source_token)) {
                fail(ws, "device_authentication_failed");
                return true;
            }
            if (device && device !== ws) {
                endSession("device_replaced", device);
                closeClient(device, 1012, "Device session replaced");
            }
            device = ws;
            ws.role = "webrtc_device";
            ws.authenticated = true;
            send(ws, { type: "webrtc_device_ready", device: DEVICE_NAME });
            pairIfReady();
            return true;
        }
        if (message.type === "webrtc_listener_hello") {
            if (typeof isListenerSessionValid !== "function" || !isListenerSessionValid(ws)) {
                fail(ws, "listener_session_required");
                return true;
            }
            if (listener && listener !== ws) {
                fail(ws, "listener_busy");
                return true;
            }
            listener = ws;
            ws.role = "webrtc_listener";
            ws.authenticated = true;
            send(ws, { type: "webrtc_listener_ready" });
            if (!device || device.readyState !== WebSocket.OPEN) {
                send(ws, { type: "webrtc_waiting_for_device" });
            }
            pairIfReady();
            return true;
        }
        return false;
    }

    function handleSignal(ws, message) {
        if (message.type !== "webrtc_signal") return false;
        const senderIsDevice = ws === device && ws.role === "webrtc_device" && ws.authenticated;
        const senderIsListener = ws === listener && ws.role === "webrtc_listener" && ws.authenticated;
        if ((!senderIsDevice && !senderIsListener) || sessionId === null ||
            message.session_id !== sessionId) {
            fail(ws, "invalid_signaling_session");
            return true;
        }
        if (senderIsListener &&
            (typeof isListenerSessionValid !== "function" || !isListenerSessionValid(ws))) {
            fail(ws, "listener_session_expired");
            return true;
        }
        const now = Date.now();
        if (!ws.signalWindowStart || now - ws.signalWindowStart >= SIGNAL_WINDOW_MS) {
            ws.signalWindowStart = now;
            ws.signalCount = 0;
        }
        ws.signalCount = (ws.signalCount || 0) + 1;
        if (ws.signalCount > MAX_SIGNALS_PER_WINDOW) {
            fail(ws, "signaling_rate_limited");
            return true;
        }

        const kind = message.kind;
        let signal;
        if (kind === "offer" || kind === "answer") {
            const validDirection = (senderIsDevice && kind === "offer") ||
                                   (senderIsListener && kind === "answer");
            if (!validDirection || typeof message.sdp !== "string" ||
                message.sdp.length === 0 || message.sdp.length > MAX_SDP_CHARS ||
                !message.sdp.startsWith("v=0") || !message.sdp.includes("m=audio ")) {
                fail(ws, "invalid_sdp_signal");
                return true;
            }
            signal = { type: "webrtc_signal", session_id: sessionId, kind, sdp: message.sdp };
        } else if (kind === "candidate") {
            if (typeof message.candidate !== "string" ||
                message.candidate.length > MAX_CANDIDATE_CHARS ||
                !message.candidate.startsWith("candidate:")) {
                fail(ws, "invalid_ice_candidate");
                return true;
            }
            signal = { type: "webrtc_signal", session_id: sessionId, kind, candidate: message.candidate };
        } else if (kind === "end-of-candidates") {
            signal = { type: "webrtc_signal", session_id: sessionId, kind };
        } else {
            fail(ws, "unsupported_signal");
            return true;
        }

        const peer = senderIsDevice ? listener : device;
        if (!send(peer, signal)) {
            endSession("peer_unavailable");
            if (peer && peer.readyState === WebSocket.OPEN) {
                closeClient(peer, 1013, "Signaling peer overloaded");
            }
        }
        return true;
    }

    function controlRateAllowed(ws) {
        const now = Date.now();
        if (!ws.controlWindowStart || now - ws.controlWindowStart >= SIGNAL_WINDOW_MS) {
            ws.controlWindowStart = now;
            ws.controlCount = 0;
        }
        ws.controlCount = (ws.controlCount || 0) + 1;
        return ws.controlCount <= MAX_CONTROL_MESSAGES_PER_WINDOW;
    }

    function handleAudioControl(ws, message) {
        if (message.type !== "webrtc_audio_control") return false;
        const senderIsListener = ws === listener && ws.role === "webrtc_listener" && ws.authenticated;
        if (!senderIsListener || sessionId === null || message.session_id !== sessionId) {
            fail(ws, "invalid_signaling_session");
            return true;
        }
        if (typeof isListenerSessionValid !== "function" || !isListenerSessionValid(ws)) {
            fail(ws, "listener_session_expired");
            return true;
        }
        if (!controlRateAllowed(ws)) {
            fail(ws, "control_rate_limited");
            return true;
        }
        if (message.command !== "mic_gain" || !Number.isInteger(message.gain_percent) ||
            message.gain_percent < MIC_GAIN_MIN_PERCENT ||
            message.gain_percent > MIC_GAIN_MAX_PERCENT) {
            fail(ws, "invalid_audio_control");
            return true;
        }

        const forwarded = {
            type: "webrtc_audio_control",
            session_id: sessionId,
            command: "mic_gain",
            gain_percent: message.gain_percent
        };
        if (!send(device, forwarded)) {
            endSession("peer_unavailable");
            if (device && device.readyState === WebSocket.OPEN) {
                closeClient(device, 1013, "Audio control peer overloaded");
            }
        }
        return true;
    }

    function handleAudioControlAck(ws, message) {
        if (message.type !== "webrtc_audio_control_ack") return false;
        const senderIsDevice = ws === device && ws.role === "webrtc_device" && ws.authenticated;
        if (!senderIsDevice || sessionId === null || message.session_id !== sessionId) {
            fail(ws, "invalid_signaling_session");
            return true;
        }
        if (!controlRateAllowed(ws)) {
            fail(ws, "control_rate_limited");
            return true;
        }
        if (message.command !== "mic_gain" || typeof message.ok !== "boolean" ||
            !Number.isInteger(message.gain_percent) ||
            message.gain_percent < MIC_GAIN_MIN_PERCENT ||
            message.gain_percent > MIC_GAIN_MAX_PERCENT) {
            fail(ws, "invalid_audio_control_ack");
            return true;
        }
        if (!send(listener, {
            type: "webrtc_audio_control_ack",
            session_id: sessionId,
            command: "mic_gain",
            gain_percent: message.gain_percent,
            ok: message.ok
        })) {
            endSession("peer_unavailable");
        }
        return true;
    }


    function handleDeviceTelemetry(ws, message) {
        if (message.type !== "webrtc_device_telemetry") return false;
        if (ws !== device || ws.role !== "webrtc_device" || !ws.authenticated) {
            fail(ws, "device_authentication_required");
            return true;
        }
        if (!message.data || typeof message.data !== "object" || Array.isArray(message.data)) return true;
        const input = message.data;
        const output = {};
        const booleans = ["wifi_connected", "peer_connected", "health_ok", "health_fault_latched", "dsp_vad_voice"];
        const numbers = ["wifi_rssi", "wifi_retry_count", "wifi_disconnect_count", "uptime_ms",
            "free_heap", "min_free_heap", "free_psram", "total_psram", "audio_capture_errors",
            "audio_buffer_overflows", "dsp_errors", "dsp_limiter_clipped", "audio_frames_sent",
            "audio_frames_dropped", "signaling_errors", "reset_reason"];
        for (const key of booleans) if (typeof input[key] === "boolean") output[key] = input[key];
        for (const key of numbers) {
            if (Number.isFinite(input[key]) && input[key] >= 0 && input[key] <= Number.MAX_SAFE_INTEGER) {
                output[key] = Math.floor(input[key]);
            }
        }
        if (Number.isFinite(input.dsp_vad_rms_db) && input.dsp_vad_rms_db >= -150 && input.dsp_vad_rms_db <= 20) output.dsp_vad_rms_db = input.dsp_vad_rms_db;
        for (const key of ["wifi_ssid", "ip", "firmware"]) {
            if (typeof input[key] === "string") output[key] = input[key].replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64);
        }
        telemetry = output;
        telemetryUpdatedAt = Date.now();
        return true;
    }

    function handleDeviceControl(ws, message) {
        if (message.type !== "webrtc_device_control") return false;
        const senderIsListener = ws === listener && ws.role === "webrtc_listener" && ws.authenticated;
        if (!senderIsListener || sessionId === null || message.session_id !== sessionId) {
            fail(ws, "invalid_signaling_session");
            return true;
        }
        if (typeof isListenerSessionValid !== "function" || !isListenerSessionValid(ws)) {
            fail(ws, "listener_session_expired");
            return true;
        }
        if (!controlRateAllowed(ws) || message.command !== "restart") {
            send(ws, { type: "webrtc_device_control_ack", command: "restart", ok: false });
            return true;
        }
        const ok = send(device, { type: "webrtc_device_control", session_id: sessionId, command: "restart" });
        send(ws, { type: "webrtc_device_control_ack", command: "restart", ok });
        return true;
    }

    function handleMessage(ws, message) {
        if (!message || typeof message !== "object" || Array.isArray(message)) return false;
        return handleJoin(ws, message) || handleSignal(ws, message) ||
            handleAudioControl(ws, message) || handleAudioControlAck(ws, message) ||
            handleDeviceTelemetry(ws, message) || handleDeviceControl(ws, message);
    }

    function handleBinary(ws) {
        if (ws.role !== "webrtc_device" && ws.role !== "webrtc_listener") return false;
        fail(ws, "binary_audio_not_supported_use_webrtc_media");
        return true;
    }

    function handleClose(ws) {
        if (ws === device) {
            endSession("device_disconnected", ws);
            device = null;
            telemetry = null;
            telemetryUpdatedAt = 0;
        }
        if (ws === listener) {
            endSession("listener_disconnected", ws);
            listener = null;
        }
    }

    function getStatus() {
        return {
            device_connected: !!device && device.readyState === WebSocket.OPEN,
            listener_connected: !!listener && listener.readyState === WebSocket.OPEN,
            session_active: sessionId !== null,
            device_telemetry: telemetry && Date.now() - telemetryUpdatedAt <= 15000 ? telemetry : null,
            telemetry_updated_at: telemetry && Date.now() - telemetryUpdatedAt <= 15000 ? telemetryUpdatedAt : null,
        };
    }

    return { handleMessage, handleBinary, handleClose, getStatus };
}

module.exports = { createWebRtcSignaling, MAX_SDP_CHARS, MAX_CANDIDATE_CHARS };

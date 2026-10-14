"use strict";

const crypto = require("crypto");
const { DEFAULT_DEVICE_ID, createDeviceCredentialRegistry, isValidDeviceId } = require("./device_registry");

const MAX_SDP_CHARS = 12 * 1024;
const MAX_CANDIDATE_CHARS = 2048;
const SIGNAL_WINDOW_MS = 60 * 1000;
const MAX_SIGNALS_PER_WINDOW = 120;
const MAX_CONTROL_MESSAGES_PER_WINDOW = 60;
const MIC_GAIN_MIN_PERCENT = 25;
const MIC_GAIN_MAX_PERCENT = 200;
const AUDIO_MIC_MODES = new Set(["mic1", "mic2", "both_mono"]);
const MAX_SIGNAL_BUFFERED_BYTES = 64 * 1024;
const TELEMETRY_MAX_AGE_MS = 15000;
const TELEMETRY_NUMBER_RANGES = Object.freeze({
    wifi_rssi: [-120, 0],
    wifi_retry_count: [0, Number.MAX_SAFE_INTEGER],
    wifi_disconnect_count: [0, Number.MAX_SAFE_INTEGER],
    hotspot_clients: [0, 256],
    cpu_frequency_mhz: [1, 400],
    temperature_c: [-20, 120],
    uptime_ms: [0, Number.MAX_SAFE_INTEGER],
    free_heap: [0, Number.MAX_SAFE_INTEGER],
    min_free_heap: [0, Number.MAX_SAFE_INTEGER],
    free_psram: [0, Number.MAX_SAFE_INTEGER],
    total_psram: [0, Number.MAX_SAFE_INTEGER],
    audio_capture_errors: [0, Number.MAX_SAFE_INTEGER],
    audio_buffer_overflows: [0, Number.MAX_SAFE_INTEGER],
    dsp_errors: [0, Number.MAX_SAFE_INTEGER],
    dsp_limiter_clipped: [0, Number.MAX_SAFE_INTEGER],
    dsp_vad_rms_db: [-120, 0],
    audio_frames_sent: [0, Number.MAX_SAFE_INTEGER],
    audio_frames_dropped: [0, Number.MAX_SAFE_INTEGER],
    signaling_errors: [0, Number.MAX_SAFE_INTEGER],
    reset_reason: [0, 255],
});
const TELEMETRY_BOOLEAN_FIELDS = new Set([
    "wifi_connected", "hotspot_running", "health_ok", "health_fault_latched",
    "dsp_vad_voice", "peer_connected",
]);
const TELEMETRY_STRING_LIMITS = Object.freeze({ wifi_ssid: 32, ip: 15, firmware: 64 });

function createWebRtcSignaling({
    WebSocket,
    sourceToken,
    deviceRegistry,
    isListenerSessionValid,
    isListenerAuthorizedForDevice = () => true,
}) {
    const credentials = deviceRegistry || createDeviceCredentialRegistry({ sourceToken });
    const states = new Map(credentials.list().map((deviceId) => [deviceId, {
        deviceId,
        device: null,
        listener: null,
        sessionId: null,
        telemetry: null,
        telemetryAt: 0,
    }]));

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

    function stateFor(ws) {
        return ws && typeof ws.deviceId === "string" ? states.get(ws.deviceId) || null : null;
    }

    function listenerAuthorized(ws, state) {
        return typeof isListenerAuthorizedForDevice === "function" &&
            isListenerAuthorizedForDevice(ws, state.deviceId);
    }

    function endSession(state, reason, except) {
        if (state.sessionId !== null) {
            const message = { type: "webrtc_session_end", device_id: state.deviceId, session_id: state.sessionId, reason };
            if (state.device && state.device !== except) send(state.device, message);
            if (state.listener && state.listener !== except) send(state.listener, message);
        }
        state.sessionId = null;
    }

    function closeClient(ws, code, reason) {
        try { ws.close(code, reason); } catch {}
    }

    function pairIfReady(state) {
        if (state.sessionId !== null || !state.device || !state.listener ||
            state.device.readyState !== WebSocket.OPEN || state.listener.readyState !== WebSocket.OPEN) {
            return;
        }
        state.sessionId = crypto.randomUUID();
        const message = {
            type: "webrtc_session_ready",
            device_id: state.deviceId,
            session_id: state.sessionId,
        };
        send(state.device, { ...message, role: "offerer" });
        send(state.listener, { ...message, role: "answerer" });
    }

    function fail(ws, reason) {
        send(ws, { type: "webrtc_error", reason });
        closeClient(ws, 1008, "WebRTC signaling rejected");
    }

    function handleDeviceJoin(ws, message) {
        const claimedId = Object.prototype.hasOwnProperty.call(message, "device_id")
            ? message.device_id
            : undefined;
        const deviceId = credentials.authenticate(claimedId, message.source_token);
        if (!deviceId || (message.device !== undefined &&
            (typeof message.device !== "string" || message.device.length > 64))) {
            fail(ws, "device_authentication_failed");
            return true;
        }
        const state = states.get(deviceId);
        if (!state) {
            fail(ws, "device_not_configured");
            return true;
        }
        if (state.device && state.device !== ws) {
            endSession(state, "device_replaced", state.device);
            closeClient(state.device, 1012, "Device session replaced");
        }
        state.device = ws;
        ws.deviceId = deviceId;
        ws.role = "webrtc_device";
        ws.authenticated = true;
        send(ws, { type: "webrtc_device_ready", device_id: deviceId });
        pairIfReady(state);
        return true;
    }

    function handleListenerJoin(ws, message) {
        const deviceId = message.device_id === undefined ? DEFAULT_DEVICE_ID : message.device_id;
        if (!isValidDeviceId(deviceId) || !states.has(deviceId)) {
            fail(ws, "device_not_configured");
            return true;
        }
        if (typeof isListenerSessionValid !== "function" || !isListenerSessionValid(ws)) {
            fail(ws, "listener_session_required");
            return true;
        }
        if (typeof isListenerAuthorizedForDevice !== "function" ||
            !isListenerAuthorizedForDevice(ws, deviceId)) {
            fail(ws, "device_access_denied");
            return true;
        }
        const state = states.get(deviceId);
        if (state.listener && state.listener !== ws) {
            fail(ws, "listener_busy");
            return true;
        }
        state.listener = ws;
        ws.deviceId = deviceId;
        ws.role = "webrtc_listener";
        ws.authenticated = true;
        send(ws, { type: "webrtc_listener_ready", device_id: deviceId });
        if (!state.device || state.device.readyState !== WebSocket.OPEN) {
            send(ws, { type: "webrtc_waiting_for_device", device_id: deviceId });
        }
        pairIfReady(state);
        return true;
    }

    function handleJoin(ws, message) {
        if (ws.role !== "unknown") return false;
        if (message.type === "webrtc_device_hello") return handleDeviceJoin(ws, message);
        if (message.type === "webrtc_listener_hello") return handleListenerJoin(ws, message);
        return false;
    }

    function handleSignal(ws, message) {
        if (message.type !== "webrtc_signal") return false;
        const state = stateFor(ws);
        const senderIsDevice = !!state && ws === state.device &&
            ws.role === "webrtc_device" && ws.authenticated;
        const senderIsListener = !!state && ws === state.listener &&
            ws.role === "webrtc_listener" && ws.authenticated;
        if ((!senderIsDevice && !senderIsListener) || state.sessionId === null ||
            message.session_id !== state.sessionId) {
            fail(ws, "invalid_signaling_session");
            return true;
        }
        if (senderIsListener &&
            (typeof isListenerSessionValid !== "function" || !isListenerSessionValid(ws))) {
            fail(ws, "listener_session_expired");
            return true;
        }
        if (senderIsListener && !listenerAuthorized(ws, state)) {
            fail(ws, "device_access_denied");
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
            signal = { type: "webrtc_signal", device_id: state.deviceId, session_id: state.sessionId, kind, sdp: message.sdp };
        } else if (kind === "candidate") {
            if (typeof message.candidate !== "string" ||
                message.candidate.length > MAX_CANDIDATE_CHARS ||
                !message.candidate.startsWith("candidate:")) {
                fail(ws, "invalid_ice_candidate");
                return true;
            }
            signal = { type: "webrtc_signal", device_id: state.deviceId, session_id: state.sessionId, kind, candidate: message.candidate };
        } else if (kind === "end-of-candidates") {
            signal = { type: "webrtc_signal", device_id: state.deviceId, session_id: state.sessionId, kind };
        } else {
            fail(ws, "unsupported_signal");
            return true;
        }

        const peer = senderIsDevice ? state.listener : state.device;
        if (!send(peer, signal)) {
            endSession(state, "peer_unavailable");
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
        const state = stateFor(ws);
        const senderIsListener = !!state && ws === state.listener &&
            ws.role === "webrtc_listener" && ws.authenticated;
        if (!senderIsListener || state.sessionId === null || message.session_id !== state.sessionId) {
            fail(ws, "invalid_signaling_session");
            return true;
        }
        if (typeof isListenerSessionValid !== "function" || !isListenerSessionValid(ws)) {
            fail(ws, "listener_session_expired");
            return true;
        }
        if (!listenerAuthorized(ws, state)) {
            fail(ws, "device_access_denied");
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
            session_id: state.sessionId,
            command: "mic_gain",
            gain_percent: message.gain_percent,
        };
        if (!send(state.device, forwarded)) {
            endSession(state, "peer_unavailable");
            if (state.device && state.device.readyState === WebSocket.OPEN) {
                closeClient(state.device, 1013, "Audio control peer overloaded");
            }
        }
        return true;
    }

    function handleAudioControlAck(ws, message) {
        if (message.type !== "webrtc_audio_control_ack") return false;
        const state = stateFor(ws);
        const senderIsDevice = !!state && ws === state.device &&
            ws.role === "webrtc_device" && ws.authenticated;
        if (!senderIsDevice || state.sessionId === null || message.session_id !== state.sessionId) {
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
        if (!send(state.listener, {
            type: "webrtc_audio_control_ack",
            session_id: state.sessionId,
            command: "mic_gain",
            gain_percent: message.gain_percent,
            ok: message.ok,
        })) {
            endSession(state, "peer_unavailable");
        }
        return true;
    }

    function handleAudioSettings(ws, message) {
        if (message.type !== "webrtc_audio_settings") return false;
        const state = stateFor(ws);
        const senderIsListener = !!state && ws === state.listener &&
            ws.role === "webrtc_listener" && ws.authenticated;
        if (!senderIsListener || state.sessionId === null || message.session_id !== state.sessionId) {
            fail(ws, "invalid_signaling_session");
            return true;
        }
        if (typeof isListenerSessionValid !== "function" || !isListenerSessionValid(ws)) {
            fail(ws, "listener_session_expired");
            return true;
        }
        if (!listenerAuthorized(ws, state)) {
            fail(ws, "device_access_denied");
            return true;
        }
        if (!controlRateAllowed(ws)) {
            fail(ws, "control_rate_limited");
            return true;
        }
        if (!AUDIO_MIC_MODES.has(message.mic_mode) ||
            typeof message.noise_suppression_enabled !== "boolean" ||
            typeof message.vad_enabled !== "boolean" ||
            typeof message.limiter_enabled !== "boolean") {
            fail(ws, "invalid_audio_settings");
            return true;
        }
        if (!send(state.device, {
            type: "webrtc_audio_settings",
            session_id: state.sessionId,
            mic_mode: message.mic_mode,
            noise_suppression_enabled: message.noise_suppression_enabled,
            vad_enabled: message.vad_enabled,
            limiter_enabled: message.limiter_enabled,
        })) {
            endSession(state, "peer_unavailable");
        }
        return true;
    }

    function handleAudioSettingsAck(ws, message) {
        if (message.type !== "webrtc_audio_settings_ack") return false;
        const state = stateFor(ws);
        const senderIsDevice = !!state && ws === state.device &&
            ws.role === "webrtc_device" && ws.authenticated;
        if (!senderIsDevice || state.sessionId === null || message.session_id !== state.sessionId) {
            fail(ws, "invalid_signaling_session");
            return true;
        }
        if (!controlRateAllowed(ws)) {
            fail(ws, "control_rate_limited");
            return true;
        }
        if (typeof message.ok !== "boolean" || !AUDIO_MIC_MODES.has(message.mic_mode) ||
            typeof message.noise_suppression_enabled !== "boolean" ||
            typeof message.vad_enabled !== "boolean" ||
            typeof message.limiter_enabled !== "boolean") {
            fail(ws, "invalid_audio_settings_ack");
            return true;
        }
        if (!send(state.listener, {
            type: "webrtc_audio_settings_ack",
            session_id: state.sessionId,
            mic_mode: message.mic_mode,
            noise_suppression_enabled: message.noise_suppression_enabled,
            vad_enabled: message.vad_enabled,
            limiter_enabled: message.limiter_enabled,
            ok: message.ok,
        })) {
            endSession(state, "peer_unavailable");
        }
        return true;
    }

    function normalizeDeviceTelemetry(data) {
        if (!data || typeof data !== "object" || Array.isArray(data)) return null;
        const telemetry = {};
        for (const [field, [minimum, maximum]] of Object.entries(TELEMETRY_NUMBER_RANGES)) {
            const value = data[field];
            if (typeof value === "number" && Number.isFinite(value) &&
                value >= minimum && value <= maximum) {
                telemetry[field] = value;
            }
        }
        for (const field of TELEMETRY_BOOLEAN_FIELDS) {
            if (typeof data[field] === "boolean") telemetry[field] = data[field];
        }
        for (const [field, maxLength] of Object.entries(TELEMETRY_STRING_LIMITS)) {
            const value = data[field];
            if (typeof value === "string" && value.length <= maxLength &&
                !/[\u0000-\u001f\u007f]/.test(value)) {
                telemetry[field] = value;
            }
        }
        return Object.keys(telemetry).length ? telemetry : null;
    }

    function handleDeviceTelemetry(ws, message) {
        if (message.type !== "webrtc_device_telemetry") return false;
        const state = stateFor(ws);
        if (!state || ws !== state.device || ws.role !== "webrtc_device" ||
            ws.authenticated !== true) {
            fail(ws, "invalid_device_telemetry_sender");
            return true;
        }
        const now = Date.now();
        if (now - state.telemetryAt < 1000) return true;
        const telemetry = normalizeDeviceTelemetry(message.data);
        if (!telemetry) {
            fail(ws, "invalid_device_telemetry");
            return true;
        }
        telemetry.received_at = new Date(now).toISOString();
        state.telemetry = telemetry;
        state.telemetryAt = now;
        if (state.listener && state.sessionId !== null) {
            send(state.listener, {
                type: "webrtc_device_telemetry",
                device_id: state.deviceId,
                session_id: state.sessionId,
                data: telemetry,
            });
        }
        return true;
    }

    function handleDeviceControl(ws, message) {
        if (message.type !== "webrtc_device_control") return false;
        const state = stateFor(ws);
        const senderIsListener = !!state && ws === state.listener &&
            ws.role === "webrtc_listener" && ws.authenticated;
        if (!senderIsListener || state.sessionId === null || message.session_id !== state.sessionId) {
            fail(ws, "invalid_signaling_session");
            return true;
        }
        if (typeof isListenerSessionValid !== "function" || !isListenerSessionValid(ws)) {
            fail(ws, "listener_session_expired");
            return true;
        }
        if (!listenerAuthorized(ws, state)) {
            fail(ws, "device_access_denied");
            return true;
        }
        if (!controlRateAllowed(ws)) {
            fail(ws, "control_rate_limited");
            return true;
        }
        if (message.command !== "restart") {
            fail(ws, "invalid_device_control");
            return true;
        }
        if (!send(state.device, {
            type: "webrtc_device_control",
            session_id: state.sessionId,
            command: "restart",
        })) {
            endSession(state, "peer_unavailable");
        }
        return true;
    }

    function handleMessage(ws, message) {
        if (!message || typeof message !== "object" || Array.isArray(message)) return false;
        return handleJoin(ws, message) || handleSignal(ws, message) ||
            handleAudioControl(ws, message) || handleAudioControlAck(ws, message) ||
            handleAudioSettings(ws, message) || handleAudioSettingsAck(ws, message) ||
            handleDeviceTelemetry(ws, message) ||
            handleDeviceControl(ws, message);
    }

    function handleBinary(ws) {
        if (ws.role !== "webrtc_device" && ws.role !== "webrtc_listener") return false;
        fail(ws, "binary_audio_not_supported_use_webrtc_media");
        return true;
    }

    function handleClose(ws) {
        const state = stateFor(ws);
        if (!state) return;
        if (ws === state.device) {
            endSession(state, "device_disconnected", ws);
            state.device = null;
        }
        if (ws === state.listener) {
            endSession(state, "listener_disconnected", ws);
            state.listener = null;
        }
        delete ws.deviceId;
    }

    function getStatus(deviceId = DEFAULT_DEVICE_ID) {
        const state = states.get(deviceId);
        if (!state) {
            if (arguments.length > 0) return null;
            return {
                device_connected: false,
                listener_connected: false,
                session_active: false,
            };
        }
        const result = {
            device_connected: !!state.device && state.device.readyState === WebSocket.OPEN,
            listener_connected: !!state.listener && state.listener.readyState === WebSocket.OPEN,
            session_active: state.sessionId !== null,
        };
        if (state.telemetry && Date.now() - state.telemetryAt <= TELEMETRY_MAX_AGE_MS) {
            result.telemetry = state.telemetry;
        }
        return result;
    }

    function getStatuses() {
        return Array.from(states.keys(), (deviceId) => ({
            device_id: deviceId,
            ...getStatus(deviceId),
        }));
    }

    return { handleMessage, handleBinary, handleClose, getStatus, getStatuses };
}

module.exports = { createWebRtcSignaling, MAX_SDP_CHARS, MAX_CANDIDATE_CHARS };

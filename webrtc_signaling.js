"use strict";

const crypto = require("crypto");
const { DEFAULT_DEVICE_ID, createDeviceCredentialRegistry, isValidDeviceId } = require("./device_registry");

const MAX_SDP_CHARS = 12 * 1024;
const MAX_CANDIDATE_CHARS = 2048;
const SIGNAL_WINDOW_MS = 60 * 1000;
const MAX_SIGNALS_PER_WINDOW = 120;
const MAX_CONTROL_MESSAGES_PER_WINDOW = 60;
const MIC_GAIN_MIN_PERCENT = 50;
const MIC_GAIN_MAX_PERCENT = 150;
const MAX_SIGNAL_BUFFERED_BYTES = 64 * 1024;

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
            device_id: state.deviceId,
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
            device_id: state.deviceId,
            session_id: state.sessionId,
            command: "mic_gain",
            gain_percent: message.gain_percent,
            ok: message.ok,
        })) {
            endSession(state, "peer_unavailable");
        }
        return true;
    }

    function handleMessage(ws, message) {
        if (!message || typeof message !== "object" || Array.isArray(message)) return false;
        return handleJoin(ws, message) || handleSignal(ws, message) ||
            handleAudioControl(ws, message) || handleAudioControlAck(ws, message);
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
        if (!state) return null;
        return {
            device_connected: !!state.device && state.device.readyState === WebSocket.OPEN,
            listener_connected: !!state.listener && state.listener.readyState === WebSocket.OPEN,
            session_active: state.sessionId !== null,
        };
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

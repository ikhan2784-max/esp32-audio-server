const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

const SOURCE_TOKEN = process.env.SOURCE_TOKEN || "";
const LISTENER_PIN = process.env.LISTENER_PIN || "";

const SESSION_COOKIE_NAME = "esp32_listener_session";
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

/* ============================================================
 * HEARTBEAT / KEEPALIVE TIMING
 * ============================================================ */
const DEVICE_HEARTBEAT_INTERVAL_MS = 5000;
const DEVICE_HEARTBEAT_TIMEOUT_MS = 20000;
const SOURCE_KEEPALIVE_MS = 5000;

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: "4kb" }));

if (!SOURCE_TOKEN) console.error("ERROR: SOURCE_TOKEN not set.");
if (!LISTENER_PIN) console.error("ERROR: LISTENER_PIN not set.");

/* ============================================================
 * SESSIONS
 * ============================================================ */
const sessions = new Map();

const authAttempts = new Map();
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function isAuthRateLimited(ip) {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now - entry.windowStart >= AUTH_WINDOW_MS) {
    authAttempts.set(ip, { windowStart: now, attempts: 0 });
    return false;
  }
  return entry.attempts >= AUTH_MAX_ATTEMPTS;
}

function recordAuthAttempt(ip) {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now - entry.windowStart >= AUTH_WINDOW_MS) {
    authAttempts.set(ip, { windowStart: now, attempts: 1 });
    return;
  }
  entry.attempts++;
}

function clearAuthAttempts(ip) { authAttempts.delete(ip); }

function createSession() {
  const sessionId = crypto.randomBytes(32).toString("hex");
  sessions.set(sessionId, {
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_DURATION_MS
  });
  return sessionId;
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const index = cookie.indexOf("=");
    if (index === -1) continue;
    const key = cookie.slice(0, index).trim();
    const value = cookie.slice(index + 1).trim();
    if (key === name) {
      try { return decodeURIComponent(value); } catch { return null; }
    }
  }
  return null;
}

function getSession(req) {
  const sessionId = getCookie(req, SESSION_COOKIE_NAME);
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function isAuthenticatedRequest(req) { return !!getSession(req); }

/* ============================================================
 * WEBSOCKET SERVER
 * ============================================================ */
const wss = new WebSocket.Server({
  server,
  path: "/ws",
  maxPayload: 16384,
  perMessageDeflate: false,
  clientTracking: true
});

const listeners = new Set();
const sources = new Set();
let audioMessagesReceived = 0;

let activeSource = null;
let deviceOnline = false;
let deviceLastSeen = null;
let deviceConnectedAt = null;
let deviceLastRebooted = null;
let deviceRebootPending = false;

function buildDeviceStatus() {
  return {
    type: "device_status",
    online: deviceOnline,
    listeners: listeners.size,
    streaming: deviceOnline && listeners.size > 0,
    audio: deviceOnline && listeners.size > 0 ? "OK" : "IDLE",
    last_seen: deviceLastSeen,
    connected_at: deviceConnectedAt,
    last_rebooted: deviceLastRebooted,
    uptime_seconds: deviceOnline && deviceConnectedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(deviceConnectedAt).getTime()) / 1000))
      : null
  };
}

function sendJson(ws, object) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(object)); } catch {}
}

function sendDeviceStatus(ws) { sendJson(ws, buildDeviceStatus()); }

function broadcastDeviceStatus() {
  const message = buildDeviceStatus();
  for (const listener of listeners) {
    if (listener.readyState === WebSocket.OPEN &&
        listener.role === "listener" && listener.authenticated) {
      sendJson(listener, message);
    }
  }
}

function broadcastToSources(message) {
  for (const source of sources) {
    if (source.readyState === WebSocket.OPEN &&
        source.role === "source" && source.authenticated) {
      sendJson(source, message);
    }
  }
}

function startESP32Audio() { broadcastToSources({ type: "stream_start" }); }
function stopESP32Audio() { broadcastToSources({ type: "stream_stop" }); }

/* ============================================================
 * HTTPS
 * ============================================================ */
function isHttpsRequest(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (forwardedProto) return forwardedProto === "https";
  return req.socket.encrypted === true;
}

function requireHttps(req, res, next) {
  if (isHttpsRequest(req)) return next();
  const host = req.headers.host;
  if (!host) return res.status(400).send("Invalid Host");
  return res.redirect(`https://${host}${req.originalUrl}`);
}

/* ============================================================
 * ROUTES
 * ============================================================ */
app.get("/", requireHttps, (req, res) => {
  if (isAuthenticatedRequest(req)) return res.redirect("/listener");
  res.sendFile(__dirname + "/index.html");
});

app.get("/health", (req, res) => res.status(200).send("OK"));

app.post("/api/auth", requireHttps, (req, res) => {
  const clientIp = getClientIp(req);
  if (isAuthRateLimited(clientIp)) {
    return res.status(429).json({ ok: false, error: "Too many attempts." });
  }
  const { pin } = req.body || {};
  if (!LISTENER_PIN || typeof pin !== "string" || pin !== LISTENER_PIN) {
    recordAuthAttempt(clientIp);
    return res.status(401).json({ ok: false, error: "Invalid PIN" });
  }
  clearAuthAttempts(clientIp);
  const sessionId = createSession();
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}`);
  return res.json({ ok: true });
});

app.post("/api/logout", requireHttps, (req, res) => {
  const sessionId = getCookie(req, SESSION_COOKIE_NAME);
  if (sessionId) sessions.delete(sessionId);
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
});

app.get("/listener", requireHttps, (req, res) => {
  if (!isAuthenticatedRequest(req)) return res.redirect("/");
  res.sendFile(__dirname + "/listener.html");
});

app.get("/api/device-status", requireHttps, (req, res) => {
  if (!isAuthenticatedRequest(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  res.json(buildDeviceStatus());
});

app.post("/api/esp32/reboot", requireHttps, (req, res) => {
  if (!isAuthenticatedRequest(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  console.log("Dashboard requested ESP32 reboot.");
  deviceRebootPending = true;
  deviceLastRebooted = new Date().toISOString();
  let forwarded = false;
  for (const source of sources) {
    if (source.readyState === WebSocket.OPEN &&
        source.role === "source" && source.authenticated) {
      sendJson(source, { type: "esp32_reboot" });
      forwarded = true;
    }
  }
  broadcastDeviceStatus();
  return res.json({ ok: true, source_connected: forwarded });
});

app.post("/api/esp32/forget-wifi", requireHttps, (req, res) => {
  if (!isAuthenticatedRequest(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  console.log("Dashboard requested ESP32 Wi-Fi reset.");
  let forwarded = false;
  for (const source of sources) {
    if (source.readyState === WebSocket.OPEN &&
        source.role === "source" && source.authenticated) {
      sendJson(source, { type: "forget_wifi" });
      forwarded = true;
    }
  }
  return res.json({ ok: true, source_connected: forwarded });
});

/* ============================================================
 * WEBSOCKET CONNECTION
 * ============================================================ */
wss.on("connection", (ws, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";

  ws.role = "unknown";
  ws.authenticated = false;
  ws.sessionAuthenticated = !!getSession(req);
  ws.isAlive = true;
  ws.connectedAt = Date.now();

  console.log(`WS connected: ${ip}`);

  ws.on("pong", () => { ws.isAlive = true; });

  sendJson(ws, { type: "welcome", message: "ESP32 INMP441 Relay connected" });

  ws.on("message", (data, isBinary) => {
    /* ============================================================
     * BINARY AUDIO (from ESP32)
     * ============================================================ */
    if (isBinary) {
      if (ws.role !== "source" || !ws.authenticated) return;

      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (frame.length < 16 ||
          frame.readUInt32LE(0) !== 0x41334631 ||
          frame.readUInt8(4) !== 1 ||
          frame.readUInt8(5) !== 16) {
        console.warn("Rejected invalid ESP32 audio frame header.");
        return;
      }
      const frameSamples = frame.readUInt16LE(6);
      if (frameSamples === 0 || frameSamples > 2048 ||
          frame.length !== 16 + frameSamples * 3) {
        console.warn(`Rejected invalid ESP32 frame length: ${frame.length}`);
        return;
      }

      deviceLastSeen = new Date().toISOString();
      audioMessagesReceived++;
      if (audioMessagesReceived % 100 === 0) {
        console.log(`ESP32 audio packets received: ${audioMessagesReceived}`);
      }

      for (const listener of listeners) {
        if (listener.readyState === WebSocket.OPEN &&
            listener.role === "listener" && listener.authenticated) {
          const buffered = Number(listener.bufferedAmount || 0);
          if (buffered > 512 * 1024) {
            console.warn(`Terminating slow listener: ${buffered} bytes`);
            try { listener.terminate(); } catch {}
            continue;
          }
          try { listener.send(data, { binary: true }); }
          catch (err) {
            console.warn(`Audio forward error: ${err.message}`);
            try { listener.terminate(); } catch {}
          }
        }
      }
      return;
    }

    /* ============================================================
     * JSON MESSAGES
     * ============================================================ */
    let message;
    try { message = JSON.parse(data.toString()); }
    catch { console.log("Rejected invalid JSON WS message."); return; }

    /* --------------------------------------------------------
     * ESP32 HELLO
     * -------------------------------------------------------- */
    if (message.type === "hello") {
      if (message.device !== "ESP32-S3-INMP441" ||
          !SOURCE_TOKEN || message.source_token !== SOURCE_TOKEN) {
        console.log("Rejected unauthorized ESP32 source.");
        sendJson(ws, { type: "auth_failed" });
        try { ws.close(1008); } catch {}
        return;
      }

      if (activeSource && activeSource !== ws) {
        try { activeSource.terminate(); } catch {}
        sources.delete(activeSource);
      }

      ws.role = "source";
      ws.authenticated = true;
      activeSource = ws;
      sources.add(ws);

      deviceOnline = true;
      deviceLastSeen = new Date().toISOString();
      deviceConnectedAt = new Date().toISOString();
      deviceRebootPending = false;

      console.log(`ESP32 authenticated. Active sources: ${sources.size}`);

      sendJson(ws, { type: "source_ready", sample_rate: 44100, format: "PCM24 mono" });

      if (listeners.size > 0) {
        sendJson(ws, { type: "stream_start" });
      }

      broadcastDeviceStatus();
      return;
    }

    /* --------------------------------------------------------
     * ESP32 APP HEARTBEAT
     * -------------------------------------------------------- */
    if (message.type === "heartbeat" &&
        ws.role === "source" && ws.authenticated) {
      deviceOnline = true;
      deviceLastSeen = new Date().toISOString();
      return;
    }

    /* --------------------------------------------------------
     * LISTENER AUTH
     * -------------------------------------------------------- */
    if (message.type === "listener") {
      if (!ws.sessionAuthenticated) {
        console.log("Rejected listener without session.");
        sendJson(ws, { type: "auth_failed", reason: "session_required" });
        try { ws.close(1008); } catch {}
        return;
      }

      ws.role = "listener";
      ws.authenticated = true;
      listeners.add(ws);

      console.log(`Listener authenticated. Active listeners: ${listeners.size}`);

      sendJson(ws, {
        type: "listener_ready",
        sample_rate: 44100,
        format: "PCM24 mono"
      });

      sendDeviceStatus(ws);

      if (listeners.size === 1 && activeSource) {
        startESP32Audio();
        console.log("First listener connected - stream_start requested.");
      }

      broadcastDeviceStatus();
      return;
    }

    /* --------------------------------------------------------
     * LISTENER STOP
     * -------------------------------------------------------- */
    if (message.type === "listener_stop") {
      if (ws.role === "listener" && ws.authenticated) {
        listeners.delete(ws);
        console.log(`Listener stopped. Active listeners: ${listeners.size}`);
        if (listeners.size === 0) stopESP32Audio();
        broadcastDeviceStatus();
      }
      return;
    }

    /* --------------------------------------------------------
     * LISTENER: REBOOT
     * -------------------------------------------------------- */
    if (message.type === "esp32_reboot") {
      if (ws.role !== "listener" || !ws.authenticated) return;
      console.log("Listener requested ESP32 reboot.");
      deviceRebootPending = true;
      deviceLastRebooted = new Date().toISOString();
      let forwarded = false;
      for (const source of sources) {
        if (source.readyState === WebSocket.OPEN &&
            source.role === "source" && source.authenticated) {
          sendJson(source, { type: "esp32_reboot" });
          forwarded = true;
        }
      }
      sendJson(ws, { type: "reboot_requested", source_connected: forwarded });
      broadcastDeviceStatus();
      return;
    }

    /* --------------------------------------------------------
     * LISTENER: FORGET WIFI
     * -------------------------------------------------------- */
    if (message.type === "forget_wifi") {
      if (ws.role !== "listener" || !ws.authenticated) return;
      console.log("Listener requested ESP32 Wi-Fi reset.");
      let forwarded = false;
      for (const source of sources) {
        if (source.readyState === WebSocket.OPEN &&
            source.role === "source" && source.authenticated) {
          sendJson(source, { type: "forget_wifi" });
          forwarded = true;
        }
      }
      sendJson(ws, { type: "forget_wifi_requested", source_connected: forwarded });
      return;
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`WS closed from ${ip}: code=${code}, reason=${reason.toString() || "(none)"}`);

    const wasListener = ws.role === "listener" && ws.authenticated;
    const wasSource = ws.role === "source" && ws.authenticated;

    listeners.delete(ws);
    sources.delete(ws);

    if (wasListener) {
      console.log(`Listener disconnected. Active listeners: ${listeners.size}`);
      if (listeners.size === 0) stopESP32Audio();
      broadcastDeviceStatus();
    }

    if (wasSource && ws === activeSource) {
      activeSource = null;
      deviceOnline = false;
      console.log("ESP32 source disconnected.");
      broadcastDeviceStatus();
    }
  });

  ws.on("error", (err) => {
    console.error(`WS error from ${ip}:`, err.message);
  });
});

/* ============================================================
 * HEARTBEAT LOOP
 * ============================================================ */
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("Terminating dead WebSocket connection.");
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });

  if (deviceOnline && activeSource) {
    const lastSeenMs = deviceLastSeen ? new Date(deviceLastSeen).getTime() : 0;
    const elapsed = Date.now() - lastSeenMs;
    if (elapsed > DEVICE_HEARTBEAT_TIMEOUT_MS) {
      console.log(`ESP32 heartbeat timeout: ${Math.floor(elapsed / 1000)}s.`);
      deviceOnline = false;
      stopESP32Audio();
      broadcastDeviceStatus();
      try { activeSource.terminate(); } catch {}
      activeSource = null;
    }
  }
}, DEVICE_HEARTBEAT_INTERVAL_MS);

/* ============================================================
 * SERVER → ESP32 KEEPALIVE (every 5 s)
 * ============================================================ */
const sourceKeepalive = setInterval(() => {
  for (const source of sources) {
    if (source.readyState === WebSocket.OPEN &&
        source.role === "source" && source.authenticated) {
      sendJson(source, { type: "keepalive", t: Date.now() });
    }
  }
}, SOURCE_KEEPALIVE_MS);

/* ============================================================
 * SESSION CLEANUP
 * ============================================================ */
const sessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(sessionId);
  }
  for (const [ip, entry] of authAttempts) {
    if (now - entry.windowStart >= AUTH_WINDOW_MS) authAttempts.delete(ip);
  }
}, 15 * 60 * 1000);

server.on("close", () => {
  clearInterval(heartbeat);
  clearInterval(sessionCleanup);
  clearInterval(sourceKeepalive);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP/WS server on port ${PORT}`);
  console.log(`SOURCE_TOKEN: ${SOURCE_TOKEN ? "YES" : "NO"}`);
  console.log(`LISTENER_PIN: ${LISTENER_PIN ? "YES" : "NO"}`);
  console.log(`Device heartbeat check: every ${DEVICE_HEARTBEAT_INTERVAL_MS / 1000}s, timeout ${DEVICE_HEARTBEAT_TIMEOUT_MS / 1000}s`);
  console.log(`Server->ESP32 keepalive: every ${SOURCE_KEEPALIVE_MS / 1000}s`);
});


const PORT = process.env.PORT || 10000;

// ============================================================
// PRODUCTION SECURITY SETTINGS
// ============================================================

const SOURCE_TOKEN = process.env.SOURCE_TOKEN || "";
const LISTENER_PIN = process.env.LISTENER_PIN || "";

if (!SOURCE_TOKEN) {
  console.error("ERROR: SOURCE_TOKEN environment variable is not set.");
}

if (!LISTENER_PIN) {
  console.error("ERROR: LISTENER_PIN environment variable is not set.");
}

// ============================================================
// EXPRESS / HTTP SERVER
// ============================================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

// ============================================================
// WEBSOCKET SERVER
// ============================================================

const wss = new WebSocket.Server({
  server,
  path: "/ws",
  maxPayload: 8192
});

// Authenticated clients only
const listeners = new Set();
const sources = new Set();

app.get("/", (req, res) => {
// ============================================================
// HTTPS DETECTION
// ============================================================

function isHttpsRequest(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];

  if (forwardedProto) {
    return forwardedProto === "https";
  }

  return req.socket.encrypted === true;
}

// ============================================================
// HTTPS REDIRECT
// ============================================================

function requireHttps(req, res, next) {
  if (isHttpsRequest(req)) {
    return next();
  }

  const host = req.headers.host;

  if (!host) {
    return res.status(400).send("Invalid Host");
  }

  return res.redirect(`https://${host}${req.originalUrl}`);
}

// ============================================================
// ROOT STATUS
// ============================================================

app.get("/", requireHttps, (req, res) => {
res.json({
    service: "ESP32 Audio WebSocket Relay",
    service: "ESP32 INMP441 Audio WebSocket Relay",
status: "ok",
websocket: "/ws",
listener: "/listener",
@@ -22,128 +87,482 @@ app.get("/", (req, res) => {
});
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", (req, res) => {
res.status(200).send("OK");
});

app.get("/listener", (req, res) => {
// ============================================================
// LISTENER PAGE
// ============================================================

app.get("/listener", requireHttps, (req, res) => {
res.sendFile(__dirname + "/listener.html");
});

// ============================================================
// SEND JSON HELPER
// ============================================================

function sendJson(ws, object) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify(object));
}

// ============================================================
// BROADCAST CONTROL MESSAGE TO ESP32 SOURCES
// ============================================================

function broadcastToSources(message) {
  for (const source of sources) {
    if (source.readyState === WebSocket.OPEN) {
      sendJson(source, message);
    }
  }
}

// ============================================================
// START STREAM WHEN FIRST LISTENER CONNECTS
// ============================================================

function updateStreamState() {
  if (listeners.size > 0) {
    console.log(
      `Active listeners: ${listeners.size} - requesting audio stream`
    );

    broadcastToSources({
      type: "stream_start"
    });
  } else {
    console.log("No active listeners - stopping audio stream");

    broadcastToSources({
      type: "stream_stop"
    });
  }
}

// ============================================================
// WEBSOCKET CONNECTION
// ============================================================

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  const ip =
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress ||
    "unknown";

ws.role = "unknown";
ws.isAlive = true;
  ws.authenticated = false;

console.log(`WebSocket connected: ${ip}`);

  // ----------------------------------------------------------
  // HEARTBEAT
  // ----------------------------------------------------------

ws.on("pong", () => {
ws.isAlive = true;
});

  ws.send(JSON.stringify({
  // ----------------------------------------------------------
  // WELCOME
  // ----------------------------------------------------------

  sendJson(ws, {
type: "welcome",
    message: "ESP32 Audio Relay connected"
  }));
    message: "ESP32 INMP441 Audio Relay connected"
  });

  // ----------------------------------------------------------
  // MESSAGE HANDLER
  // ----------------------------------------------------------

ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = data.toString();

      try {
        const message = JSON.parse(text);

        if (message.type === "listener") {
          ws.role = "listener";
          listeners.add(ws);

          console.log(
            `Listener registered: ${ip} (listeners=${listeners.size})`
          );

          ws.send(JSON.stringify({
            type: "listener_ready",
            sample_rate: 16000,
            format: "pcm16",
            channels: 1
          }));
          return;
        }

    // ========================================================
    // BINARY AUDIO
    // ========================================================

    if (isBinary) {

      // Only authenticated ESP32 source may send audio
      if (ws.role !== "source" || !ws.authenticated) {
        console.log(
          `Rejected binary packet from unauthenticated client: ${ip}`
        );

        return;
      }

      // ------------------------------------------------------
      // FORWARD AUDIO TO ALL AUTHENTICATED LISTENERS
      // ------------------------------------------------------

      for (const listener of listeners) {

if (
          message.type === "hello" &&
          message.device === "ESP32-S3-INMP441"
          listener.readyState === WebSocket.OPEN &&
          listener.role === "listener" &&
          listener.authenticated
) {
          ws.role = "source";
          sources.add(ws);

          console.log(
            `ESP32 audio source registered: ${ip} (sources=${sources.size})`
          );
          return;
          try {
            listener.send(data, {
              binary: true
            });
          } catch (err) {
            console.error(
              "Audio forwarding error:",
              err.message
            );
          }
}
      } catch {
        // Ignore non-JSON text.
}

      console.log("Text:", text);
      return;
    }

    // ========================================================
    // TEXT / JSON MESSAGE
    // ========================================================

    const text = data.toString();

    let message;

    try {
      message = JSON.parse(text);
    } catch {
      console.log("Ignored invalid JSON message");
      return;
    }

    // ========================================================
    // ESP32 SOURCE AUTHENTICATION
    // ========================================================

    if (
      message.type === "hello" &&
      message.device === "ESP32-S3-INMP441"
    ) {

      // Already authenticated
      if (ws.authenticated) {
        return;
      }

      // Validate source token
      if (
        !SOURCE_TOKEN ||
        typeof message.source_token !== "string" ||
        message.source_token !== SOURCE_TOKEN
      ) {

        console.log(
          `Rejected unauthorized ESP32 source: ${ip}`
        );

        sendJson(ws, {
          type: "auth_failed",
          reason: "source_authentication_failed"
        });

        ws.close(1008, "Unauthorized source");

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(text);
        return;
}

      // ------------------------------------------------------
      // AUTHENTICATED SOURCE
      // ------------------------------------------------------

      ws.role = "source";
      ws.authenticated = true;

      sources.add(ws);

      console.log(
        `ESP32 audio source authenticated: ${ip} ` +
        `(sources=${sources.size})`
      );

      sendJson(ws, {
        type: "source_ready",
        sample_rate: 16000,
        format: "pcm16",
        channels: 1
      });

      // If a listener is already connected,
      // immediately wake the microphone.
      if (listeners.size > 0) {

        sendJson(ws, {
          type: "stream_start"
        });

        console.log(
          "Existing listener detected - starting ESP32 audio"
        );
      }

return;
}

    if (ws.role !== "source") {
    // ========================================================
    // LISTENER AUTHENTICATION
    // ========================================================

    if (message.type === "listener") {

      // Prevent duplicate registration
      if (ws.authenticated) {
        return;
      }

      // Validate PIN
      if (
        !LISTENER_PIN ||
        typeof message.pin !== "string" ||
        message.pin !== LISTENER_PIN
      ) {

        console.log(
          `Rejected listener with invalid PIN: ${ip}`
        );

        sendJson(ws, {
          type: "auth_failed",
          reason: "invalid_pin"
        });

        ws.close(1008, "Invalid PIN");

        return;
      }

      // ------------------------------------------------------
      // AUTHENTICATED LISTENER
      // ------------------------------------------------------

      ws.role = "listener";
      ws.authenticated = true;

      listeners.add(ws);

console.log(
        `Binary packet from unregistered client: ${data.length} bytes`
        `Listener authenticated: ${ip} ` +
        `(listeners=${listeners.size})`
);

      sendJson(ws, {
        type: "listener_ready",
        sample_rate: 16000,
        format: "pcm16",
        channels: 1
      });

      // First listener wakes ESP32
      if (listeners.size === 1) {

        broadcastToSources({
          type: "stream_start"
        });

        console.log(
          "First listener connected - ESP32 audio START requested"
        );
      }

return;
}

    console.log(
      `Audio packet received: ${data.length} bytes; ` +
      `forwarding to ${listeners.size} listener(s)`
    );
    // ========================================================
    // LISTENER STOP
    // ========================================================

    for (const listener of listeners) {
      if (listener.readyState === WebSocket.OPEN) {
        listener.send(data, { binary: true });
    if (
      message.type === "listener_stop" &&
      ws.role === "listener"
    ) {

      console.log(
        `Listener requested stop: ${ip}`
      );

      listeners.delete(ws);

      ws.authenticated = false;
      ws.role = "unknown";

      // Stop ESP32 if nobody is listening
      if (listeners.size === 0) {

        broadcastToSources({
          type: "stream_stop"
        });

        console.log(
          "Last listener stopped - ESP32 audio STOP requested"
        );
}

      return;
}

    // ========================================================
    // ESP32 CONTROL / STATUS MESSAGE
    // ========================================================

    if (
      ws.role === "source" &&
      ws.authenticated
    ) {

      // Do not print secrets or sensitive payloads
      console.log(
        `ESP32 control message received: ${message.type || "unknown"}`
      );

      return;
    }

    // ========================================================
    // UNKNOWN MESSAGE
    // ========================================================

    console.log(
      `Ignored message type: ${message.type || "unknown"}`
    );
});

  // ==========================================================
  // DISCONNECT
  // ==========================================================

ws.on("close", () => {

    const wasListener =
      ws.role === "listener" &&
      ws.authenticated;

    const wasSource =
      ws.role === "source" &&
      ws.authenticated;

listeners.delete(ws);
sources.delete(ws);

console.log(
`WebSocket disconnected: ${ip} ` +
`(listeners=${listeners.size}, sources=${sources.size})`
);

    // --------------------------------------------------------
    // LAST LISTENER LEFT
    // --------------------------------------------------------

    if (wasListener && listeners.size === 0) {

      broadcastToSources({
        type: "stream_stop"
      });

      console.log(
        "Last listener disconnected - ESP32 audio STOP requested"
      );
    }

    // --------------------------------------------------------
    // SOURCE DISCONNECTED
    // --------------------------------------------------------

    if (wasSource) {

      console.log(
        "ESP32 audio source disconnected"
      );
    }
});

  // ==========================================================
  // WEBSOCKET ERROR
  // ==========================================================

ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    console.error(
      `WebSocket error from ${ip}:`,
      err.message
    );
});
});

// ============================================================
// WEBSOCKET HEARTBEAT
// ============================================================

const heartbeat = setInterval(() => {

wss.clients.forEach((ws) => {

if (ws.isAlive === false) {
      console.log("Terminating dead WebSocket connection");
return ws.terminate();
}

ws.isAlive = false;
    ws.ping();

    try {
      ws.ping();
    } catch (err) {
      console.error(
        "Heartbeat error:",
        err.message
      );
    }
});

}, 30000);

server.on("close", () => clearInterval(heartbeat));
// ============================================================
// SERVER SHUTDOWN
// ============================================================

server.on("close", () => {
  clearInterval(heartbeat);
});

// ============================================================
// START SERVER
// ============================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP/WebSocket server listening on port ${PORT}`);
  console.log("WebSocket endpoint: /ws");
  console.log("Listener page: /listener");

  console.log(
    `HTTP/WebSocket server listening on port ${PORT}`
  );

  console.log(
    "WebSocket endpoint: /ws"
  );

  console.log(
    "Listener page: /listener"
  );

  console.log(
    `SOURCE_TOKEN configured: ${SOURCE_TOKEN ? "YES" : "NO"}`
  );

  console.log(
    `LISTENER_PIN configured: ${LISTENER_PIN ? "YES" : "NO"}`
  );
});

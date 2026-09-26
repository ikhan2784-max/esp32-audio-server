const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;

// ============================================================
// EXPRESS / HTTP SERVER
// ============================================================

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: "4kb" }));

// ============================================================
// PRODUCTION SECURITY SETTINGS
// ============================================================

const SOURCE_TOKEN = process.env.SOURCE_TOKEN || "";
const LISTENER_PIN = process.env.LISTENER_PIN || "";

if (!SOURCE_TOKEN) {
  console.error(
    "ERROR: SOURCE_TOKEN environment variable is not set."
  );
}

if (!LISTENER_PIN) {
  console.error(
    "ERROR: LISTENER_PIN environment variable is not set."
  );
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

const sessions = new Map();

const SESSION_COOKIE_NAME =
  "esp32_listener_session";

const SESSION_DURATION_MS =
  24 * 60 * 60 * 1000;

function createSession() {

  const sessionId =
    crypto.randomBytes(32).toString("hex");

  sessions.set(
    sessionId,
    {
      createdAt: Date.now(),
      expiresAt:
        Date.now() +
        SESSION_DURATION_MS
    }
  );

  return sessionId;
}

function getCookie(req, name) {

  const cookieHeader =
    req.headers.cookie;

  if (!cookieHeader) {
    return null;
  }

  const cookies =
    cookieHeader.split(";");

  for (const cookie of cookies) {

    const index =
      cookie.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      cookie
        .slice(0, index)
        .trim();

    const value =
      cookie
        .slice(index + 1)
        .trim();

    if (key === name) {

      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function getSession(req) {

  const sessionId =
    getCookie(
      req,
      SESSION_COOKIE_NAME
    );

  if (!sessionId) {
    return null;
  }

  const session =
    sessions.get(sessionId);

  if (!session) {
    return null;
  }

  if (
    Date.now() >
    session.expiresAt
  ) {

    sessions.delete(sessionId);

    return null;
  }

  return session;
}

function isAuthenticatedRequest(req) {
  return !!getSession(req);
}

// ============================================================
// WEBSOCKET SERVER
// ============================================================

const wss =
  new WebSocket.Server({
    server,
    path: "/ws",
    maxPayload: 8192
  });

// Authenticated browser listeners
const listeners = new Set();

// Authenticated ESP32 sources
const sources = new Set();

// Current active ESP32 source
let activeSource = null;

// ============================================================
// ESP32 DEVICE STATUS
// ============================================================

let deviceOnline = false;

let deviceLastSeen = null;

let deviceConnectedAt = null;

let deviceLastRebooted = null;

let deviceRebootPending = false;

// ============================================================
// DEVICE STATUS OBJECT
// ============================================================

function buildDeviceStatus() {

  return {

    type:
      "device_status",

    online:
      deviceOnline,

    listeners:
      listeners.size,

    streaming:
      deviceOnline &&
      listeners.size > 0,

    audio:
      deviceOnline &&
      listeners.size > 0
        ? "OK"
        : "IDLE",

    last_seen:
      deviceLastSeen,

    connected_at:
      deviceConnectedAt,

    last_rebooted:
      deviceLastRebooted,

    uptime_seconds:
      deviceOnline &&
      deviceConnectedAt
        ? Math.max(
            0,
            Math.floor(
              (
                Date.now() -
                new Date(
                  deviceConnectedAt
                ).getTime()
              ) / 1000
            )
          )
        : null
  };
}

// ============================================================
// SEND JSON
// ============================================================

function sendJson(ws, object) {

  if (
    !ws ||
    ws.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  try {

    ws.send(
      JSON.stringify(object)
    );

  } catch {
    // Ignore individual WebSocket send errors
  }
}

// ============================================================
// SEND DEVICE STATUS
// ============================================================

function sendDeviceStatus(ws) {

  sendJson(
    ws,
    buildDeviceStatus()
  );
}

// ============================================================
// BROADCAST DEVICE STATUS
// ============================================================

function broadcastDeviceStatus() {

  const message =
    buildDeviceStatus();

  for (
    const listener of listeners
  ) {

    if (
      listener.readyState ===
        WebSocket.OPEN &&
      listener.role ===
        "listener" &&
      listener.authenticated
    ) {

      sendJson(
        listener,
        message
      );
    }
  }
}

// ============================================================
// HTTPS DETECTION
// ============================================================

function isHttpsRequest(req) {

  const forwardedProto =
    req.headers[
      "x-forwarded-proto"
    ];

  if (forwardedProto) {

    return (
      forwardedProto ===
      "https"
    );
  }

  return (
    req.socket.encrypted ===
    true
  );
}

// ============================================================
// HTTPS REDIRECT
// ============================================================

function requireHttps(
  req,
  res,
  next
) {

  if (
    isHttpsRequest(req)
  ) {
    return next();
  }

  const host =
    req.headers.host;

  if (!host) {

    return res
      .status(400)
      .send("Invalid Host");
  }

  return res.redirect(
    `https://${host}${req.originalUrl}`
  );
}

// ============================================================
// HOMEPAGE
// ============================================================

app.get(
  "/",
  requireHttps,
  (req, res) => {

    if (
      isAuthenticatedRequest(req)
    ) {

      return res.redirect(
        "/listener"
      );
    }

    res.sendFile(
      __dirname +
      "/index.html"
    );
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {

    res
      .status(200)
      .send("OK");
  }
);

// ============================================================
// LOGIN
// ============================================================

app.post(
  "/api/auth",
  requireHttps,
  (req, res) => {

    const { pin } =
      req.body || {};

    if (
      !LISTENER_PIN ||
      typeof pin !==
        "string" ||
      pin !==
        LISTENER_PIN
    ) {

      return res
        .status(401)
        .json({
          ok: false,
          error:
            "Invalid PIN"
        });
    }

    const sessionId =
      createSession();

    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(
        sessionId
      )}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(
        SESSION_DURATION_MS /
          1000
      )}`
    );

    return res.json({
      ok: true
    });
  }
);

// ============================================================
// LOGOUT
// ============================================================

app.post(
  "/api/logout",
  requireHttps,
  (req, res) => {

    const sessionId =
      getCookie(
        req,
        SESSION_COOKIE_NAME
      );

    if (sessionId) {

      sessions.delete(
        sessionId
      );
    }

    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
    );

    res.json({
      ok: true
    });
  }
);

// ============================================================
// LISTENER PAGE
// ============================================================

app.get(
  "/listener",
  requireHttps,
  (req, res) => {

    if (
      !isAuthenticatedRequest(req)
    ) {

      return res.redirect(
        "/"
      );
    }

    res.sendFile(
      __dirname +
      "/listener.html"
    );
  }
);

// ============================================================
// DEVICE STATUS API
// ============================================================

app.get(
  "/api/device-status",
  requireHttps,
  (req, res) => {

    if (
      !isAuthenticatedRequest(req)
    ) {

      return res
        .status(401)
        .json({
          ok: false,
          error:
            "Unauthorized"
        });
    }

    res.json(
      buildDeviceStatus()
    );
  }
);

// ============================================================
// BROADCAST MESSAGE TO ESP32
// ============================================================

function broadcastToSources(
  message
) {

  for (
    const source of sources
  ) {

    if (
      source.readyState ===
        WebSocket.OPEN &&
      source.role ===
        "source" &&
      source.authenticated
    ) {

      sendJson(
        source,
        message
      );
    }
  }
}

// ============================================================
// ESP32 REBOOT API
// ============================================================

app.post(
  "/api/esp32/reboot",
  requireHttps,
  (req, res) => {

    if (
      !isAuthenticatedRequest(req)
    ) {

      return res
        .status(401)
        .json({
          ok: false,
          error:
            "Unauthorized"
        });
    }

    console.log(
      "Authenticated dashboard requested ESP32 reboot."
    );

    deviceRebootPending =
      true;

    deviceLastRebooted =
      new Date().toISOString();

    let forwarded = false;

    for (
      const source of sources
    ) {

      if (
        source.readyState ===
          WebSocket.OPEN &&
        source.role ===
          "source" &&
        source.authenticated
      ) {

        sendJson(
          source,
          {
            type:
              "esp32_reboot"
          }
        );

        forwarded = true;
      }
    }

    broadcastDeviceStatus();

    return res.json({
      ok: true,
      source_connected:
        forwarded
    });
  }
);

// ============================================================
// FORGET WI-FI API
// ============================================================

app.post(
  "/api/esp32/forget-wifi",
  requireHttps,
  (req, res) => {

    if (
      !isAuthenticatedRequest(req)
    ) {

      return res
        .status(401)
        .json({
          ok: false,
          error:
            "Unauthorized"
        });
    }

    console.log(
      "Authenticated dashboard requested ESP32 Wi-Fi reset."
    );

    let forwarded = false;

    for (
      const source of sources
    ) {

      if (
        source.readyState ===
          WebSocket.OPEN &&
        source.role ===
          "source" &&
        source.authenticated
      ) {

        sendJson(
          source,
          {
            type:
              "forget_wifi"
          }
        );

        forwarded = true;
      }
    }

    return res.json({
      ok: true,
      source_connected:
        forwarded
    });
  }
);

// ============================================================
// STREAM CONTROL
// ============================================================

function updateStreamState() {

  if (
    listeners.size > 0
  ) {

    broadcastToSources({
      type:
        "stream_start"
    });

  } else {

    broadcastToSources({
      type:
        "stream_stop"
    });
  }

  broadcastDeviceStatus();
}

// ============================================================
// WEBSOCKET CONNECTION
// ============================================================

wss.on(
  "connection",
  (ws, req) => {

    const ip =
      req.headers[
        "x-forwarded-for"
      ] ||
      req.socket.remoteAddress ||
      "unknown";

    // --------------------------------------------------------
    // INITIAL STATE
    // --------------------------------------------------------

    ws.role =
      "unknown";

    ws.authenticated =
      false;

    ws.sessionAuthenticated =
      false;

    ws.isAlive =
      true;

    ws.connectedAt =
      Date.now();

    // --------------------------------------------------------
    // CHECK BROWSER SESSION
    // --------------------------------------------------------

    const session =
      getSession(req);

    if (session) {

      ws.sessionAuthenticated =
        true;
    }

    console.log(
      `WebSocket connected: ${ip}`
    );

    // --------------------------------------------------------
    // PONG
    // --------------------------------------------------------

    ws.on(
      "pong",
      () => {

        ws.isAlive =
          true;
      }
    );

    // --------------------------------------------------------
    // WELCOME
    // --------------------------------------------------------

    sendJson(
      ws,
      {
        type:
          "welcome",
        message:
          "ESP32 INMP441 Audio Relay connected"
      }
    );

    // ========================================================
    // MESSAGE
    // ========================================================

    ws.on(
      "message",
      (data, isBinary) => {

        // ====================================================
        // BINARY AUDIO
        // ====================================================

        if (isBinary) {

          if (
            ws.role !==
              "source" ||
            !ws.authenticated
          ) {

            return;
          }

          // Actual ESP32 traffic proves
          // the source is alive.
          deviceLastSeen =
            new Date().toISOString();

          // Forward PCM audio
          // to every authenticated listener.

          for (
            const listener of listeners
          ) {

            if (
              listener.readyState ===
                WebSocket.OPEN &&
              listener.role ===
                "listener" &&
              listener.authenticated
            ) {

              try {

                listener.send(
                  data,
                  {
                    binary: true
                  }
                );

              } catch {
                // Ignore failed listener
              }
            }
          }

          return;
        }

        // ====================================================
        // PARSE TEXT
        // ====================================================

        let message;

        try {

          message =
            JSON.parse(
              data.toString()
            );

        } catch {

          console.log(
            "Rejected invalid JSON WebSocket message."
          );

          return;
        }

        // ====================================================
        // ESP32 SOURCE AUTHENTICATION
        // ====================================================

        if (
          message.type ===
          "hello"
        ) {

          if (
            message.device !==
              "ESP32-S3-INMP441" ||
            !SOURCE_TOKEN ||
            message.source_token !==
              SOURCE_TOKEN
          ) {

            console.log(
              "Rejected unauthorized ESP32 source."
            );

            sendJson(
              ws,
              {
                type:
                  "auth_failed"
              }
            );

            try {
              ws.close(1008);
            } catch {}

            return;
          }

          // --------------------------------------------------
          // If an old ESP32 connection exists,
          // terminate it before accepting the new one.
          // --------------------------------------------------

          if (
            activeSource &&
            activeSource !== ws
          ) {

            try {
              activeSource.terminate();
            } catch {}

            sources.delete(
              activeSource
            );
          }

          ws.role =
            "source";

          ws.authenticated =
            true;

          activeSource =
            ws;

          sources.add(ws);

          deviceOnline =
            true;

          deviceLastSeen =
            new Date().toISOString();

          deviceConnectedAt =
            new Date().toISOString();

          deviceRebootPending =
            false;

          console.log(
            `ESP32 audio source authenticated. Active sources: ${sources.size}`
          );

          sendJson(
            ws,
            {
              type:
                "source_ready",

              sample_rate:
                16000,

              format:
                "PCM16 mono"
            }
          );

          // If listeners already exist,
          // immediately wake ESP32 audio.

          if (
            listeners.size > 0
          ) {

            sendJson(
              ws,
              {
                type:
                  "stream_start"
              }
            );
          }

          broadcastDeviceStatus();

          return;
        }

        // ====================================================
        // LISTENER AUTHENTICATION
        // ====================================================

        if (
          message.type ===
          "listener"
        ) {

          // PIN authentication has already
          // happened on /api/auth.
          //
          // The browser proves authentication
          // through its HttpOnly session cookie.

          if (
            !ws.sessionAuthenticated
          ) {

            console.log(
              "Rejected listener without authenticated session."
            );

            sendJson(
              ws,
              {
                type:
                  "auth_failed",

                reason:
                  "session_required"
              }
            );

            try {
              ws.close(1008);
            } catch {}

            return;
          }

          ws.role =
            "listener";

          ws.authenticated =
            true;

          listeners.add(ws);

          console.log(
            `Listener authenticated. Active listeners: ${listeners.size}`
          );

          sendJson(
            ws,
            {
              type:
                "listener_ready",

              sample_rate:
                16000,

              format:
                "PCM16 mono"
            }
          );

          sendDeviceStatus(ws);

          // First listener starts ESP32 audio.

          if (
            listeners.size ===
            1
          ) {

            broadcastToSources({
              type:
                "stream_start"
            });

            console.log(
              "First listener connected - ESP32 audio START requested."
            );
          }

          broadcastDeviceStatus();

          return;
        }

        // ====================================================
        // LISTENER STOP
        // ====================================================

        if (
          message.type ===
          "listener_stop"
        ) {

          if (
            ws.role ===
              "listener" &&
            ws.authenticated
          ) {

            listeners.delete(
              ws
            );

            console.log(
              `Listener stopped. Active listeners: ${listeners.size}`
            );

            if (
              listeners.size ===
              0
            ) {

              broadcastToSources({
                type:
                  "stream_stop"
              });
            }

            broadcastDeviceStatus();
          }

          return;
        }

        // ====================================================
        // ESP32 REBOOT
        // ====================================================

        if (
          message.type ===
          "esp32_reboot"
        ) {

          if (
            ws.role !==
              "listener" ||
            !ws.authenticated
          ) {

            return;
          }

          console.log(
            "Authenticated listener requested ESP32 reboot."
          );

          deviceRebootPending =
            true;

          deviceLastRebooted =
            new Date().toISOString();

          let forwarded =
            false;

          for (
            const source of sources
          ) {

            if (
              source.readyState ===
                WebSocket.OPEN &&
              source.role ===
                "source" &&
              source.authenticated
            ) {

              sendJson(
                source,
                {
                  type:
                    "esp32_reboot"
                }
              );

              forwarded =
                true;
            }
          }

          sendJson(
            ws,
            {
              type:
                "reboot_requested",

              source_connected:
                forwarded
            }
          );

          broadcastDeviceStatus();

          return;
        }

        // ====================================================
        // FORGET WI-FI
        // ====================================================

        if (
          message.type ===
          "forget_wifi"
        ) {

          if (
            ws.role !==
              "listener" ||
            !ws.authenticated
          ) {

            return;
          }

          console.log(
            "Authenticated listener requested ESP32 Wi-Fi reset."
          );

          let forwarded =
            false;

          for (
            const source of sources
          ) {

            if (
              source.readyState ===
                WebSocket.OPEN &&
              source.role ===
                "source" &&
              source.authenticated
            ) {

              sendJson(
                source,
                {
                  type:
                    "forget_wifi"
                }
              );

              forwarded =
                true;
            }
          }

          sendJson(
            ws,
            {
              type:
                "forget_wifi_requested",

              source_connected:
                forwarded
            }
          );

          return;
        }
      }
    );

    // ========================================================
    // CLOSE
    // ========================================================

    ws.on(
      "close",
      () => {

        const wasListener =
          ws.role ===
            "listener" &&
          ws.authenticated;

        const wasSource =
          ws.role ===
            "source" &&
          ws.authenticated;

        listeners.delete(ws);

        sources.delete(ws);

        // ----------------------------------------------------
        // LISTENER DISCONNECTED
        // ----------------------------------------------------

        if (
          wasListener
        ) {

          console.log(
            `Listener disconnected. Active listeners: ${listeners.size}`
          );

          if (
            listeners.size ===
            0
          ) {

            broadcastToSources({
              type:
                "stream_stop"
            });
          }

          broadcastDeviceStatus();
        }

        // ----------------------------------------------------
        // ESP32 SOURCE DISCONNECTED
        // ----------------------------------------------------

        if (
          wasSource
        ) {

          if (
            ws ===
            activeSource
          ) {

            activeSource =
              null;

            deviceOnline =
              false;

            deviceLastSeen =
              new Date().toISOString();

            console.log(
              "ESP32 active audio source disconnected."
            );

            broadcastDeviceStatus();
          }
        }
      }
    );

    // ========================================================
    // ERROR
    // ========================================================

    ws.on(
      "error",
      (err) => {

        console.error(
          `WebSocket error from ${ip}:`,
          err.message
        );
      }
    );
  }
);

// ============================================================
// FAST WEBSOCKET HEARTBEAT
// ============================================================
//
// 10-second heartbeat.
//
// A dead/unplugged ESP32 normally becomes detected after
// approximately 10-20 seconds instead of up to 60 seconds.
//
// IMPORTANT:
// We do NOT update deviceLastSeen merely because a heartbeat
// was sent. Only an actual ESP32 message / connection event
// updates the device's last-seen timestamp.
// ============================================================

const HEARTBEAT_INTERVAL_MS =
  10000;

const heartbeat =
  setInterval(
    () => {

      wss.clients.forEach(
        (ws) => {

          if (
            ws.isAlive ===
            false
          ) {

            console.log(
              "Terminating dead WebSocket connection."
            );

            try {
              ws.terminate();
            } catch {}

            return;
          }

          ws.isAlive =
            false;

          try {

            ws.ping();

          } catch {
            // Connection will be handled by close/error
          }
        }
      );

    },
    HEARTBEAT_INTERVAL_MS
  );

// ============================================================
// SESSION CLEANUP
// ============================================================

const sessionCleanup =
  setInterval(
    () => {

      const now =
        Date.now();

      for (
        const [
          sessionId,
          session
        ] of sessions
      ) {

        if (
          now >
          session.expiresAt
        ) {

          sessions.delete(
            sessionId
          );
        }
      }

    },
    15 * 60 * 1000
  );

// ============================================================
// SERVER SHUTDOWN
// ============================================================

server.on(
  "close",
  () => {

    clearInterval(
      heartbeat
    );

    clearInterval(
      sessionCleanup
    );
  }
);

// ============================================================
// START SERVER
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

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
      `SOURCE_TOKEN configured: ${
        SOURCE_TOKEN
          ? "YES"
          : "NO"
      }`
    );

    console.log(
      `LISTENER_PIN configured: ${
        LISTENER_PIN
          ? "YES"
          : "NO"
      }`
    );

    console.log(
      `ESP32 WebSocket heartbeat: ${
        HEARTBEAT_INTERVAL_MS / 1000
      } seconds`
    );
  }
);

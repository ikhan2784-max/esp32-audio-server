const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);

app.set("trust proxy", true);

app.use(express.json({ limit: "4kb" }));

// ============================================================
// ENVIRONMENT
// ============================================================

const PORT = process.env.PORT || 10000;

const SOURCE_TOKEN = process.env.SOURCE_TOKEN || "";
const LISTENER_PIN = process.env.LISTENER_PIN || "";

if (!SOURCE_TOKEN) {
  console.warn("WARNING: SOURCE_TOKEN is not configured.");
} else {
  console.log("SOURCE_TOKEN configured.");
}

if (!LISTENER_PIN) {
  console.warn("WARNING: LISTENER_PIN is not configured.");
} else {
  console.log("LISTENER_PIN configured.");
}

// ============================================================
// WEBSOCKETS
// ============================================================

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 8192
});

const sources = new Set();
const listeners = new Set();

let activeSource = null;

// ============================================================
// DEVICE STATUS
// ============================================================

let deviceOnline = false;
let deviceLastSeen = null;
let deviceConnectedAt = null;
let deviceLastRebooted = null;
let deviceRebootPending = false;

// ============================================================
// BROWSER SESSIONS
// ============================================================

const sessions = new Map();

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");

  sessions.set(token, {
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });

  return token;
}

function getSessionToken(req) {
  const cookie = req.headers.cookie || "";

  const match = cookie.match(
    /(?:^|;\s*)esp32_session=([^;]+)/
  );

  return match ? match[1] : null;
}

function hasValidSession(req) {
  const token = getSessionToken(req);

  if (!token) {
    return false;
  }

  const session = sessions.get(token);

  if (!session) {
    return false;
  }

  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return false;
  }

  return true;
}

function requireSession(req, res, next) {
  if (hasValidSession(req)) {
    next();
    return;
  }

  res.redirect("/");
}

function requireSessionApi(req, res, next) {
  if (hasValidSession(req)) {
    next();
    return;
  }

  res.status(401).json({
    ok: false,
    error: "Authentication required"
  });
}

// Cleanup expired sessions periodically.
setInterval(() => {
  const now = Date.now();

  for (const [token, session] of sessions.entries()) {
    if (now > session.expiresAt) {
      sessions.delete(token);
    }
  }
}, 10 * 60 * 1000);

// ============================================================
// HTTPS ENFORCEMENT
// ============================================================

function requireHttps(req, res, next) {
  const proto = req.headers["x-forwarded-proto"];

  if (proto === "https") {
    next();
    return;
  }

  if (req.path === "/health") {
    next();
    return;
  }

  const host = req.get("host");

  if (!host) {
    res.status(400).send("Bad Request");
    return;
  }

  res.redirect(
    "https://" +
      host +
      req.originalUrl
  );
}

// ============================================================
// DEVICE STATUS
// ============================================================

function buildDeviceStatus() {
  return {
    type: "device_status",

    online: deviceOnline,

    listeners: listeners.size,

    streaming:
      deviceOnline &&
      listeners.size > 0,

    audio:
      deviceOnline &&
      listeners.size > 0
        ? "OK"
        : "IDLE",

    last_seen: deviceLastSeen,

    connected_at: deviceConnectedAt,

    last_rebooted: deviceLastRebooted,

    uptime_seconds:
      deviceOnline &&
      deviceConnectedAt
        ? Math.max(
            0,
            Math.floor(
              (
                Date.now() -
                new Date(deviceConnectedAt).getTime()
              ) / 1000
            )
          )
        : null
  };
}

function sendDeviceStatus(ws) {
  if (
    ws &&
    ws.readyState === ws.OPEN
  ) {
    ws.send(
      JSON.stringify(
        buildDeviceStatus()
      )
    );
  }
}

function broadcastDeviceStatus() {
  const message = JSON.stringify(
    buildDeviceStatus()
  );

  for (const ws of listeners) {
    if (
      ws.readyState === ws.OPEN &&
      ws.authenticated
    ) {
      try {
        ws.send(message);
      } catch (err) {
        console.error(
          "Device status send error:",
          err.message
        );
      }
    }
  }
}

// ============================================================
// ROOT / HOMEPAGE
// ============================================================

app.get("/", requireHttps, (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32 INMP441</title>

<style>
*{box-sizing:border-box}

body{
  margin:0;
  min-height:100vh;
  background:#0b0f14;
  color:#f1f5f9;
  font-family:Arial,sans-serif;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:20px;
}

.card{
  width:100%;
  max-width:420px;
  background:#151b23;
  border:1px solid #293241;
  border-radius:16px;
  padding:28px;
  box-shadow:0 15px 40px rgba(0,0,0,.35);
}

h1{
  margin:0 0 8px;
  font-size:27px;
}

.sub{
  color:#9aa7b5;
  margin-bottom:28px;
}

label{
  display:block;
  margin-bottom:8px;
  color:#cbd5e1;
}

input{
  width:100%;
  padding:15px;
  border-radius:10px;
  border:1px solid #344052;
  background:#0d131a;
  color:white;
  font-size:20px;
  text-align:center;
  letter-spacing:4px;
  outline:none;
}

button{
  width:100%;
  margin-top:15px;
  padding:15px;
  border:0;
  border-radius:10px;
  background:#2f81f7;
  color:white;
  font-size:17px;
  font-weight:bold;
  cursor:pointer;
}

button:disabled{
  opacity:.6;
  cursor:not-allowed;
}

.error{
  color:#ff6b6b;
  margin-top:15px;
  text-align:center;
}

.status{
  color:#7f8c9d;
  text-align:center;
  margin-top:20px;
  font-size:13px;
}
</style>
</head>

<body>

<div class="card">

<h1>ESP32 INMP441</h1>

<div class="sub">
Secure Listener
</div>

<form id="login">

<label for="pin">
Listener PIN
</label>

<input
  id="pin"
  type="password"
  inputmode="numeric"
  autocomplete="current-password"
  placeholder="Enter PIN"
  required
>

<button id="button" type="submit">
Enter Listener
</button>

<div id="error" class="error"></div>

<div class="status">
Secure HTTPS / WSS connection
</div>

</form>

</div>

<script>

const form =
  document.getElementById("login");

const pin =
  document.getElementById("pin");

const button =
  document.getElementById("button");

const error =
  document.getElementById("error");

form.addEventListener(
  "submit",
  async (e) => {

    e.preventDefault();

    error.textContent = "";

    const value =
      pin.value.trim();

    if(!value){
      error.textContent =
        "Please enter the Listener PIN.";
      return;
    }

    button.disabled = true;
    button.textContent =
      "Checking PIN...";

    try{

      const response =
        await fetch(
          "/api/auth",
          {
            method:"POST",
            headers:{
              "Content-Type":
                "application/json"
            },
            credentials:"same-origin",
            cache:"no-store",
            body:JSON.stringify({
              pin:value
            })
          }
        );

      const data =
        await response.json();

      if(
        !response.ok ||
        !data.ok
      ){
        throw new Error(
          data.error ||
          "Invalid PIN"
        );
      }

      // Session cookie has now been
      // created by the server.
      window.location.href =
        "/listener";

    }catch(err){

      error.textContent =
        err.message ||
        "Authentication failed.";

      button.disabled = false;
      button.textContent =
        "Enter Listener";
    }

  }
);

pin.focus();

</script>

</body>
</html>
  `);
});

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {
    res.status(200).json({
      ok: true,
      service: "esp32-audio-server"
    });
  }
);

// ============================================================
// DEVICE STATUS API
// ============================================================

app.get(
  "/api/device-status",
  requireHttps,
  (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );

    res.setHeader(
      "Pragma",
      "no-cache"
    );

    res.setHeader(
      "Expires",
      "0"
    );

    res.json(
      buildDeviceStatus()
    );
  }
);

// ============================================================
// LISTENER PAGE
// ============================================================

app.get(
  "/listener",
  requireHttps,
  requireSession,
  (req, res) => {
    res.sendFile(
      __dirname + "/listener.html"
    );
  }
);

// ============================================================
// PIN AUTHENTICATION
// ============================================================

app.post(
  "/api/auth",
  requireHttps,
  (req, res) => {
    const pin =
      typeof req.body?.pin === "string"
        ? req.body.pin.trim()
        : "";

    if (!LISTENER_PIN) {
      res.status(500).json({
        ok: false,
        error: "Listener PIN is not configured"
      });

      return;
    }

    if (!pin) {
      res.status(400).json({
        ok: false,
        error: "PIN required"
      });

      return;
    }

    if (pin !== LISTENER_PIN) {
      console.warn(
        "Invalid listener PIN attempt from",
        req.ip
      );

      res.status(401).json({
        ok: false,
        error: "Invalid PIN"
      });

      return;
    }

    const token = createSession();

    res.setHeader(
      "Set-Cookie",
      [
        "esp32_session=" + token,
        "Path=/",
        "Max-Age=" +
          Math.floor(
            SESSION_TTL_MS / 1000
          ),
        "HttpOnly",
        "Secure",
        "SameSite=Strict"
      ].join("; ")
    );

    res.json({
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
    const token =
      getSessionToken(req);

    if (token) {
      sessions.delete(token);
    }

    res.setHeader(
      "Set-Cookie",
      [
        "esp32_session=",
        "Path=/",
        "Max-Age=0",
        "HttpOnly",
        "Secure",
        "SameSite=Strict"
      ].join("; ")
    );

    res.json({
      ok: true
    });
  }
);

// ============================================================
// ESP32 REBOOT API
// ============================================================

app.post(
  "/api/esp32/reboot",
  requireHttps,
  requireSessionApi,
  (req, res) => {
    console.log(
      "Authenticated dashboard requested ESP32 reboot."
    );

    deviceRebootPending = true;

    let forwarded = false;

    for (const ws of sources) {
      if (
        ws.readyState === ws.OPEN &&
        ws.authenticated
      ) {
        try {
          ws.send(
            JSON.stringify({
              type: "esp32_reboot"
            })
          );

          forwarded = true;

          console.log(
            "ESP32 reboot command forwarded to source."
          );
        } catch (err) {
          console.error(
            "Failed to forward reboot:",
            err.message
          );
        }
      }
    }

    if (!forwarded) {
      res.status(503).json({
        ok: false,
        error: "ESP32 source is not connected"
      });

      return;
    }

    res.json({
      ok: true,
      message:
        "ESP32 reboot command sent"
    });
  }
);

// ============================================================
// WEBSOCKET UPGRADE
// ============================================================

server.on(
  "upgrade",
  (req, socket, head) => {
    const host = req.headers.host || "";

    if (
      req.url !== "/ws"
    ) {
      socket.destroy();
      return;
    }

    const proto =
      req.headers["x-forwarded-proto"];

    /*
     * Render normally terminates TLS before
     * forwarding to Node.
     */
    if (
      proto &&
      proto !== "https"
    ) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(
      req,
      socket,
      head,
      (ws) => {
        wss.emit(
          "connection",
          ws,
          req
        );
      }
    );
  }
);

// ============================================================
// WEBSOCKET CONNECTION
// ============================================================

wss.on(
  "connection",
  (ws, req) => {
    const ip =
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "unknown";

    ws.authenticated = false;
    ws.role = null;

    console.log(
      "WebSocket connected from",
      ip
    );

    // --------------------------------------------------------
    // MESSAGE HANDLER
    // --------------------------------------------------------

    ws.on(
      "message",
      (data, isBinary) => {
        // ====================================================
        // BINARY AUDIO
        // ====================================================

        if (isBinary) {
          if (
            ws.role !== "source" ||
            !ws.authenticated
          ) {
            return;
          }

          for (const listener of listeners) {
            if (
              listener.readyState === listener.OPEN &&
              listener.authenticated
            ) {
              try {
                listener.send(
                  data,
                  {
                    binary: true
                  }
                );
              } catch (err) {
                console.error(
                  "Audio forwarding error:",
                  err.message
                );
              }
            }
          }

          return;
        }

        // ====================================================
        // TEXT MESSAGE
        // ====================================================

        let message;

        try {
          message = JSON.parse(
            data.toString()
          );
        } catch (err) {
          console.warn(
            "Invalid JSON from",
            ip
          );

          return;
        }

        // ====================================================
        // SOURCE AUTHENTICATION
        // ====================================================

        if (
          message.type === "hello"
        ) {
          const validDevice =
            message.device ===
            "ESP32-S3-INMP441";

          const validToken =
            typeof message.source_token ===
              "string" &&
            message.source_token ===
              SOURCE_TOKEN;

          if (
            !validDevice ||
            !validToken
          ) {
            console.warn(
              "Unauthorized ESP32 source from",
              ip
            );

            try {
              ws.send(
                JSON.stringify({
                  type: "auth_failed"
                })
              );
            } catch (_) {}

            ws.close(1008);

            return;
          }

          // -----------------------------------------------
          // Replace old active source
          // -----------------------------------------------

          if (
            activeSource &&
            activeSource !== ws
          ) {
            console.log(
              "Closing previous active ESP32 source."
            );

            try {
              activeSource.close(
                1000,
                "Replaced by new source connection"
              );
            } catch (_) {}
          }

          activeSource = ws;

          ws.role = "source";
          ws.authenticated = true;

          sources.add(ws);

          const connectedNow =
            new Date().toISOString();

          deviceOnline = true;
          deviceLastSeen =
            connectedNow;
          deviceConnectedAt =
            connectedNow;

          // -----------------------------------------------
          // Reboot confirmation
          // -----------------------------------------------

          if (
            deviceRebootPending
          ) {
            deviceLastRebooted =
              connectedNow;

            deviceRebootPending =
              false;

            console.log(
              "ESP32 reboot confirmed by new source connection."
            );
          }

          console.log(
            "ESP32 audio source authenticated.",
            "sources=" +
              sources.size
          );

          try {
            ws.send(
              JSON.stringify({
                type: "auth_ok"
              })
            );
          } catch (_) {}

          // -----------------------------------------------
          // If listeners already exist,
          // request audio immediately.
          // -----------------------------------------------

          if (
            listeners.size > 0
          ) {
            try {
              ws.send(
                JSON.stringify({
                  type: "stream_start"
                })
              );

              console.log(
                "Existing listener detected - starting ESP32 audio."
              );
            } catch (err) {
              console.error(
                "Failed to send stream_start:",
                err.message
              );
            }
          }

          broadcastDeviceStatus();

          return;
        }

        // ====================================================
        // LISTENER AUTHENTICATION
        // ====================================================

        if (
          message.type === "listener"
        ) {
          if (
            !hasValidSession(req)
          ) {
            console.warn(
              "Unauthorized listener WebSocket attempt from",
              ip
            );

            try {
              ws.send(
                JSON.stringify({
                  type: "auth_failed",
                  reason:
                    "session_required"
                })
              );
            } catch (_) {}

            ws.close(1008);

            return;
          }

          ws.role = "listener";
          ws.authenticated = true;

          listeners.add(ws);

          console.log(
            "Listener authenticated.",
            "listeners=" +
              listeners.size
          );

          // Send current device status.
          sendDeviceStatus(ws);

          // -----------------------------------------------
          // First listener starts ESP32 audio
          // -----------------------------------------------

          if (
            listeners.size === 1
          ) {
            console.log(
              "First listener connected - ESP32 audio START requested."
            );

            for (const source of sources) {
              if (
                source.readyState === source.OPEN &&
                source.authenticated
              ) {
                try {
                  source.send(
                    JSON.stringify({
                      type: "stream_start"
                    })
                  );
                } catch (err) {
                  console.error(
                    "Failed to request stream start:",
                    err.message
                  );
                }
              }
            }
          }

          broadcastDeviceStatus();

          return;
        }

        // ====================================================
        // ESP32 REBOOT FROM LISTENER PAGE
        // ====================================================

        if (
          message.type ===
          "esp32_reboot"
        ) {
          if (
            ws.role !== "listener" ||
            !ws.authenticated ||
            !hasValidSession(req)
          ) {
            console.warn(
              "Unauthorized reboot request from",
              ip
            );

            return;
          }

          console.log(
            "Authenticated listener requested ESP32 reboot."
          );

          deviceRebootPending = true;

          for (const source of sources) {
            if (
              source.readyState === source.OPEN &&
              source.authenticated
            ) {
              try {
                source.send(
                  JSON.stringify({
                    type: "esp32_reboot"
                  })
                );
              } catch (err) {
                console.error(
                  "Failed to forward ESP32 reboot:",
                  err.message
                );
              }
            }
          }

          try {
            ws.send(
              JSON.stringify({
                type: "reboot_requested"
              })
            );
          } catch (_) {}

          return;
        }

        // ====================================================
        // LISTENER COUNT
        // ====================================================

        if (
          message.type ===
          "listener_count"
        ) {
          broadcastDeviceStatus();
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
        const wasSource =
          ws.role === "source";

        const wasListener =
          ws.role === "listener";

        // ----------------------------------------------------
        // SOURCE DISCONNECT
        // ----------------------------------------------------

        if (wasSource) {
          sources.delete(ws);

          /*
           * IMPORTANT:
           * Only the CURRENT active source is allowed
           * to mark the device offline.
           *
           * This prevents the old ESP32 socket from
           * marking the device offline after a reboot
           * when the new socket has already connected.
           */

          if (
            ws === activeSource
          ) {
            activeSource = null;

            deviceOnline = false;

            deviceLastSeen =
              new Date().toISOString();

            deviceConnectedAt =
              null;

            console.log(
              "Active ESP32 source disconnected."
            );

            broadcastDeviceStatus();
          } else {
            console.log(
              "Old ESP32 source disconnected; active source remains online."
            );
          }
        }

        // ----------------------------------------------------
        // LISTENER DISCONNECT
        // ----------------------------------------------------

        if (wasListener) {
          listeners.delete(ws);

          console.log(
            "Listener disconnected.",
            "listeners=" +
              listeners.size
          );

          // --------------------------------------------------
          // Last listener stopped
          // --------------------------------------------------

          if (
            listeners.size === 0
          ) {
            console.log(
              "Last listener disconnected - ESP32 audio STOP requested."
            );

            for (const source of sources) {
              if (
                source.readyState === source.OPEN &&
                source.authenticated
              ) {
                try {
                  source.send(
                    JSON.stringify({
                      type: "stream_stop"
                    })
                  );
                } catch (err) {
                  console.error(
                    "Failed to request stream stop:",
                    err.message
                  );
                }
              }
            }
          }

          broadcastDeviceStatus();
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
// WEBSOCKET HEARTBEAT
// ============================================================

const HEARTBEAT_INTERVAL =
  30 * 1000;

setInterval(
  () => {
    const now =
      new Date().toISOString();

    for (const ws of wss.clients) {
      if (
        ws.isAlive === false
      ) {
        try {
          ws.terminate();
        } catch (_) {}

        continue;
      }

      ws.isAlive = false;

      try {
        ws.ping();
      } catch (_) {}
    }

    // --------------------------------------------------------
    // Update ESP32 last-seen
    // --------------------------------------------------------

    if (
      activeSource &&
      activeSource.readyState ===
        activeSource.OPEN &&
      activeSource.authenticated
    ) {
      deviceLastSeen = now;

      broadcastDeviceStatus();
    }
  },
  HEARTBEAT_INTERVAL
);

// ============================================================
// PING/PONG
// ============================================================

wss.on(
  "connection",
  (ws) => {
    ws.isAlive = true;

    ws.on(
      "pong",
      () => {
        ws.isAlive = true;
      }
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
      `ESP32 audio server listening on port ${PORT}`
    );

    console.log(
      "INMP441 production relay ready."
    );
  }
);

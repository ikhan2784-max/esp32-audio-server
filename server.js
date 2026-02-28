const http = require("http");
const WebSocket = require("ws");

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ESP32 Audio Server Running");
});

const wss = new WebSocket.Server({ server });

let espSocket = null;
let listeners = new Set();

wss.on("connection", (ws, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const type = url.searchParams.get("type");

  console.log("New connection:", type);

  if (type === "esp") {

    // Close old ESP if exists
    if (espSocket && espSocket.readyState === WebSocket.OPEN) {
      console.log("Closing old ESP connection");
      espSocket.close();
    }

    espSocket = ws;
    console.log("ESP connected");

    ws.on("message", (data) => {
      // Broadcast to ALL listeners
      listeners.forEach((listener) => {
        if (listener.readyState === WebSocket.OPEN) {
          listener.send(data, { binary: true });
        }
      });
    });

    ws.on("close", () => {
      console.log("ESP disconnected");
      espSocket = null;
    });
  }

  if (type === "listen") {

    listeners.add(ws);
    console.log("Listener connected");

    ws.on("close", () => {
      console.log("Listener disconnected");
      listeners.delete(ws);
    });
  }
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
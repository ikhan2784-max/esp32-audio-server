const http = require("http");
const WebSocket = require("ws");

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ESP32 Audio Server Running");
});

const wss = new WebSocket.Server({ server });

let espSocket = null;
let listenerSocket = null;

wss.on("connection", (ws, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const type = url.searchParams.get("type");

  console.log("New connection:", type);

  if (type === "esp") {
    espSocket = ws;
    console.log("ESP connected");

    ws.on("message", (data) => {
      if (listenerSocket && listenerSocket.readyState === WebSocket.OPEN) {
        listenerSocket.send(data, { binary: true });
      }
    });

    ws.on("close", () => {
      console.log("ESP disconnected");
      espSocket = null;
    });
  }

  if (type === "listen") {
    listenerSocket = ws;
    console.log("Listener connected");

    ws.on("close", () => {
      console.log("Listener disconnected");
      listenerSocket = null;
    });
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
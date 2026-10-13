# ESP32 Audio Render Relay

This is the clean WebSocket server for the new ESP32-S3 + ICS43434 project.

## Endpoint

WebSocket:
wss://YOUR-RENDER-DOMAIN.onrender.com/ws

For the user's current Render service, the endpoint will be:

wss://esp32-audio-server-1.onrender.com/ws

HTTP health:
https://esp32-audio-server-1.onrender.com/health

HTTP status:
https://esp32-audio-server-1.onrender.com/

## Render settings

Create/use a Render **Web Service**.

Build command:
npm install

Start command:
npm start

The server automatically uses Render's `PORT` environment variable and binds to 0.0.0.0.

## Current behavior

- Accepts WebSocket connections at `/ws`
- Sends a JSON welcome message
- Accepts binary messages
- Echoes binary messages back to the same ESP32
- Sends WebSocket ping frames every 30 seconds
- Provides `/health`

The binary echo is intentional for the first test. Once the ESP32 can connect reliably, we can change this into the actual audio relay/receiver architecture.

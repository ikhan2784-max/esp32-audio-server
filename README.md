# ESP32 Audio Render Relay

This is the clean WebSocket server for the new ESP32-S3 + ICS43434 project.

## WebRTC multi-device listener

The Phase 5 WebRTC listener can select among configured ESP32s. Keep `SOURCE_TOKEN` for the legacy `ESP32-S3-INMP441` identity. Add more device IDs and unique tokens in Render's `DEVICE_CREDENTIALS_JSON` environment variable:

```json
{"living-room":"replace-with-a-unique-random-token","garage":"replace-with-another-unique-random-token"}
```

Set each board's `CONFIG_APP_PHASE5_RENDER_SOURCE_TOKEN` in its ignored local `sdkconfig` to the matching unique token. Render maps each authenticated token to its configured ID, so the current firmware can keep its existing fixed device-name field. The tokens must be unique. `MAX_CONFIGURED_DEVICES` defaults to 16 total, including the `SOURCE_TOKEN` identity. Never commit tokens.

The authenticated `/api/devices` endpoint returns configured device IDs and connection state, never tokens. Listener PIN authentication currently grants access to every configured device. Signaling, listening, gain, and restart are scoped to the selected device. Device/session state is in memory, so keep the Render service at one instance; a restart clears active sessions and devices reconnect. The selector does not yet provide per-device firmware telemetry. Wi-Fi reset is disabled on the multi-device listener because the legacy action broadcasts to all sources.

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

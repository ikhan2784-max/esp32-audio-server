# Phase 5 WebRTC signaling path

This branch adds an authenticated, one-device/one-listener signaling session at the existing `/ws` WebSocket endpoint. The ESP32 proves its role with the `SOURCE_TOKEN` environment variable; the listener must have an authenticated web session. Render forwards bounded offer/answer SDP and trickled ICE candidates. It does not accept binary audio from these WebRTC roles.

The existing `/listener` route and PCM relay remain unchanged. The experimental WebRTC listener page is available at `/phase5-listener` after login. Browser recording stays local to the browser and has a bounded 128 MiB recording buffer.

WebRTC media is direct peer-to-peer in this implementation. Render provides signaling only; it does not relay Opus media. The device and page use STUN for direct ICE, and no TURN server is configured, so some NAT/firewall combinations will fail. This branch is not a production deployment or end-to-end acceptance result until the ESP32 firmware is integrated and tested with the listener.

Run the local signaling checks with:

```powershell
node --check server.js
node --check webrtc_signaling.js
node --test test\webrtc_signaling.test.js
```

# Phase 5 WebRTC signaling path

This branch adds authenticated, per-device WebRTC signaling sessions at the existing `/ws` WebSocket endpoint. Each ESP32 proves its role with a device token; the listener must have an authenticated web session and selects one configured device. Render forwards bounded offer/answer SDP and trickled ICE candidates. It does not accept binary audio from these WebRTC roles.

## Multi-device identity and controls

`SOURCE_TOKEN` remains the credential for the legacy identity `ESP32-S3-INMP441`. Configure additional boards in Render with `DEVICE_CREDENTIALS_JSON`, a JSON object that maps a stable selector name to a unique high-entropy token. For example:

```json
{"living-room":"replace-with-a-unique-random-token","garage":"replace-with-another-unique-random-token"}
```

Each board must use its own token in its ignored local `sdkconfig` (`CONFIG_APP_PHASE5_RENDER_SOURCE_TOKEN`). The current firmware hello message does not send a `device_id`; Render derives the selected identity from the unique token. Existing boards can keep their current token and default identity. Never commit or log these values. `MAX_CONFIGURED_DEVICES` defaults to 16 and includes the `SOURCE_TOKEN` identity; the configured tokens must be unique.

The authenticated `GET /api/devices` endpoint lists configured IDs and their signaling/listener state without returning credentials. `GET /api/devices/:deviceId/status` returns one configured device's state. The top-of-page selector stores the chosen ID in the URL and browser storage. Each WebRTC signaling session, microphone-gain command, and supported restart command is scoped to that selected device. The current listener PIN grants access to every configured device; per-user/device authorization is not implemented. One listener connection is allowed per device.

The existing Wi-Fi reset action is disabled on this page because its legacy endpoint broadcasts to all legacy sources. Firmware health/telemetry is not yet exposed per device, so detailed Diagnostics values are unavailable in this multi-device view.

The existing `/listener` route and PCM relay remain unchanged. After PIN login, the staging service opens the WebRTC listener at `/phase5-listener` by default. Browser recording stays local to the browser and has a bounded 128 MiB recording buffer. Recording defaults to the raw incoming WebRTC track for noise diagnosis; the listener output after GTCRN can also be selected. Filenames identify the selected source.

The listener status reports Web Audio input and output RMS levels in dBFS to distinguish a quiet remote track from a silent GTCRN output. If the GTCRN worklet raises a processor error, the page bypasses it, restores direct audio, and marks noise suppression off.

The listener's ESP32 microphone gain control is session-only and defaults to 100%. It accepts integer values from 25% to 200%, routes them through the authenticated WebRTC signaling session for the selected device, and applies a smooth gain ramp to processed PCM immediately before Opus encoding. Render validates the listener role, device-specific active session, range, and control rate before forwarding the command. The ESP32 acknowledges the applied value. It is separate from browser playback volume and is never saved to NVS; increasing gain can clip the PCM signal.

The Settings tab can select Mic 1/left, Mic 2/right, or both microphones mixed to mono, and can toggle firmware VAD and the limiter for the active session. Render validates the settings command against the selected device's authenticated session and forwards only the supported mode/boolean fields; firmware acknowledges the applied values. Both mics share BCLK GPIO4, WS GPIO5, and DATA GPIO6, with their L/R select pins set to opposite levels. Both stereo remains disabled because the firmware's processed audio queue and current Opus encoder are mono. The 44.1 kHz/24-bit option also remains disabled until capture, DSP, resampling, and WebRTC encoding support that profile end to end; the current Opus path is PCM16.

WebRTC media is direct peer-to-peer in this implementation. Render provides signaling only; it does not relay Opus media. The device and page use STUN for direct ICE, and no TURN server is configured, so some NAT/firewall combinations will fail. This branch is not a production deployment or end-to-end acceptance result until the ESP32 firmware is integrated and tested with the listener.

Run the local signaling checks with:

```powershell
node --check server.js
node --check webrtc_signaling.js
node --test test\webrtc_signaling.test.js
```

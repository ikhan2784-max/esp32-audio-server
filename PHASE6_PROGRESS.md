# Phase 6 — Render security and multi-device

**Status:** In progress. This file records the first backend-hardening slice; it is not a completion claim.

## Implemented in this slice

- Listener PIN verification compares fixed-size HMAC digests with Node's timing-safe comparison.
- In-memory listener sessions remain limited to 24 hours and are capped at 4,096 entries. Expired entries are removed during lookup/creation and periodic cleanup; when full, the oldest session is evicted.
- Failed-PIN rate-limit state remains 10 attempts per client per 15 minutes and is capped at 8,192 client entries. Old windows are pruned and the oldest tracked entry is evicted when full.
- Added automated tests for exact/incorrect PINs, session expiry and capacity, and rate-limit behavior/capacity.
- Authentication rate limiting now keys clients from Render's `CF-Connecting-IP` header after validating it as a single IP address. It ignores caller-controlled `X-Forwarded-For` and falls back to the socket address if the trusted header is absent or malformed.
- Added tests for IPv4/IPv6 forwarding, spoofed `X-Forwarded-For`, malformed proxy data, and fallback behavior.
- Listener sessions now expire after 30 minutes without activity and still have a 24-hour absolute lifetime. User interaction refreshes the idle expiry, and active legacy/WebRTC listening sends a bounded five-minute heartbeat. Expired listener WebSockets are closed by the server; browser pages return to sign-in after expiry.
- Added idle refresh and absolute lifetime tests; the activity endpoint only renews a currently valid same-origin session.
- Authenticated POST endpoints and cookie-authenticated WebSocket connections now require an exact same-origin match, including behind Render's HTTPS proxy. This blocks cross-origin requests to reboot/forget-Wi-Fi controls and signaling.
- WebSocket admission is capped at 64 total connections, legacy audio listeners at four, and WebRTC remains one listener per device; a second WebRTC listener is rejected without displacing the active one.
- Added tests for listener capacity and WebRTC single-listener isolation.

## Still open

- Sessions, rate limits, device state, and WebRTC pairing are process-local. They are not shared across instances and do not survive restarts.
- The current WebRTC signaling contract supports one device and one listener at a time. There is no persistent device registry or per-device authorization policy.
- Confirm Render's trusted client-IP header behavior with an authenticated edge request before treating IP-based rate limiting as fully verified.
- Verify browser login, logout, listener WebSocket, and control requests from the staging origin; foreign/missing origins are covered by helper tests.
- Verify idle session timeout and active WebRTC listener expiry against the deployed browser flow; automated state tests cover expiry and renewal.
- Add per-device identity/authentication and authenticated per-device health/status/control APIs. The current firmware sends a shared fixed device name and one source token, so it cannot safely claim multiple independent device identities yet.
- Validate signaling and media across separate networks; the current peer path is STUN-only and has no TURN relay.
- Run staging soak, restart/reconnect, logout/expiry, and concurrent-client tests before calling Phase 6 complete.

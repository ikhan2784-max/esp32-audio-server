# Phase 6 — Render security and multi-device

**Status:** In progress. This file records the first backend-hardening slice; it is not a completion claim.

## Implemented in this slice

- Listener PIN verification compares fixed-size HMAC digests with Node's timing-safe comparison.
- In-memory listener sessions remain limited to 24 hours and are capped at 4,096 entries. Expired entries are removed during lookup/creation and periodic cleanup; when full, the oldest session is evicted.
- Failed-PIN rate-limit state remains 10 attempts per client per 15 minutes and is capped at 8,192 client entries. Old windows are pruned and the oldest tracked entry is evicted when full.
- Added automated tests for exact/incorrect PINs, session expiry and capacity, and rate-limit behavior/capacity.
- Authentication rate limiting now keys clients from Render's `CF-Connecting-IP` header after validating it as a single IP address. It ignores caller-controlled `X-Forwarded-For` and falls back to the socket address if the trusted header is absent or malformed.
- Added tests for IPv4/IPv6 forwarding, spoofed `X-Forwarded-For`, malformed proxy data, and fallback behavior.

## Still open

- Sessions, rate limits, device state, and WebRTC pairing are process-local. They are not shared across instances and do not survive restarts.
- The current WebRTC signaling contract supports one device and one listener at a time. There is no persistent device registry or per-device authorization policy.
- Confirm Render's trusted client-IP header behavior with an authenticated edge request before treating IP-based rate limiting as fully verified.
- Implement and verify the approved idle session timeout behavior, including active WebRTC listener expiry.
- Add authenticated per-device health/status/control APIs, multi-device isolation, and bounded concurrent listener behavior.
- Validate signaling and media across separate networks; the current peer path is STUN-only and has no TURN relay.
- Run staging soak, restart/reconnect, logout/expiry, and concurrent-client tests before calling Phase 6 complete.

# KAC 2026 v4 — Delivery summary

- Corrected browser-visibility forced stopping: removed `stopHiddenJobs()` handling. Browser timers may still pause according to Android/browser policies.
- Added optional real server-side Durable Object Alarm job runner (`cloudflare/worker.js`) and Redis server-side job state. Requires explicit deployment and runtime secrets.
- Account/channel/job level independent stop; job drafts; future start/end; random/fixed delays with 3-second configured minimum; unlimited count with platform and manual controls.
- Added per-account accepted, rejected, uncertain, queued message metrics and most recent error. Local manual-send counts are per device; job counters sync with Redis when configured.
- Added Kick User OAuth Token introspection-based import, same Kick app ID required; incompatible old ID|SESSION tokens deliberately rejected.
- Added strong passphrase-encrypted all-data backup, account credential verification on restore; old plaintext local JSON backup remains secrets-free.
- Refined silent-duplicate avoidance, CSRF, Worker shared-secret and Redis job locking.
- All local unit/integration tests passed. Live Kick and Cloudflare credentials unavailable; deployment/live integration not tested.
- IMPORTANT: This is not complete implementation of all 350 spec entries. Consult FEATURE_AUDIT_370.md.

# Security baseline for Dublika

The published build is a client-side product prototype. Production processing must keep billing, authorization and media entitlements on trusted servers.

## Required production controls

- Store original video, stems, voice takes and exports in private object storage. Use short-lived, user-bound signed upload and download URLs. Never expose bucket URLs.
- Authorize every project, segment, job and export server-side by `user_id`; client-side role checks are only presentation.
- Create an immutable render entitlement after a confirmed payment webhook. Reserve a credit in one serializable transaction before enqueueing a render, then settle or release it idempotently.
- Verify YooKassa or CloudPayments webhooks with signatures, timestamps, replay protection and unique event IDs. Never trust success redirects from the browser.
- Put OAuth behind PKCE, strict redirect allowlists, `state`/`nonce`, encrypted session cookies (`HttpOnly`, `Secure`, `SameSite=Lax`) and account-linking confirmation. Do not merge identities by unverified email.
- Enforce one trial with layered abuse signals: verified provider identity, verified phone where lawful, payment-method fingerprint where available, device-bound risk token, IP/ASN velocity, disposable-email screening and manual-review thresholds. Do not use hardware fingerprinting as the sole decision.
- Scan uploads, verify MIME by file signature, cap size and duration before decoding, transcode in an isolated worker, reject polyglots and archive formats, and strip metadata.
- Process user media in short-lived isolated jobs without outbound network by default. Delete raw artifacts on schedule and keep deletion receipts.
- Protect APIs with per-user and per-IP rate limits, CSRF protection for cookie-authenticated writes, strict CORS, schema validation, parameterized queries and idempotency keys.
- Separate roles (`user`, `support`, `moderator`, `admin`) and require step-up MFA for staff. Log all staff media access in an append-only audit trail.
- Keep secrets in the deployment secret store, rotate them, use least-privilege service accounts, dependency scanning, SAST, secret scanning and incident alerts.

## Media pipeline

Use an isolated queue-based pipeline: ingest → validate/transcode → speech-to-text with word timestamps → source separation (dialogue/music/effects) → user recording cleanup → loudness normalization → time alignment → mix → MP4 render → private signed delivery.

This architecture preserves music instead of merely lowering the whole original soundtrack under the new voice.

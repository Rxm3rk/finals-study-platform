# Security Wall Design

## Goal

Restrict the website to the intended study group only, while making account sharing and content leakage difficult, traceable, and easy to stop. The system should fit the real usage pattern: most users are expected to use iPhone/iPad, not desktop browsers.

## Constraints and realities

- IP address alone is not reliable because mobile/iPad users can legitimately move across home Wi-Fi, campus Wi-Fi, cellular networks, and hotspots.
- Browser-only fingerprinting is not perfect and can change after browser updates, private browsing, or cleared storage.
- A website cannot make screenshots or external camera photos impossible, especially on iOS/iPadOS.
- The practical security goal is deterrence plus enforcement: limit access, make sharing inconvenient, log suspicious behavior, and watermark viewed content so leaked screenshots are attributable.

## Chosen approach

Use a server-side security wall with these rules:

1. Registration creates a pending account.
2. Admin must approve accounts before they can access PDFs.
3. At most 19 approved users can exist.
4. Each approved user can use at most 2 trusted devices.
5. First approved logins silently bind devices to the account until the 2-device limit is reached.
6. A login from a third device is blocked automatically.
7. Each fresh login continues to rotate the account session token, preserving the current anti-sharing behavior where concurrent shared sessions are inconvenient.
8. PDF viewer pages show a personalized watermark so screenshots are traceable.

## Account model

Each user record in `users.json` should gain security fields:

```json
{
  "username": "student1",
  "password": "...",
  "createdAt": "...",
  "lastOnline": 1710000000000,
  "ip": "...",
  "approved": false,
  "approvedAt": null,
  "approvedBy": null,
  "devices": [],
  "securityEvents": []
}
```

Existing users should be treated carefully during migration. The design should avoid locking the current admin/user base out unexpectedly. Existing users can be marked approved by default only if needed for compatibility, but new registrations should be pending by default.

## Device model

A trusted device entry should be stored on the server per user:

```json
{
  "id": "random-device-id",
  "label": "iPad Safari",
  "firstSeenAt": "2026-04-30T...Z",
  "lastSeenAt": "2026-04-30T...Z",
  "lastIp": "...",
  "userAgent": "..."
}
```

The browser should keep a local `device_id` in localStorage. On login, the client sends that device ID to the server. If none exists, the client creates a random one and saves it.

Server behavior:

- If user is not approved: reject login/access.
- If device ID already belongs to the user: allow and update last seen metadata.
- If the user has fewer than 2 devices: add the new device and allow.
- If the user already has 2 different devices: reject and log a security event.

This is not cryptographically perfect, but it is strong enough for the expected iOS/iPadOS study-group use and avoids the false positives of IP-only blocking.

## Admin controls

The existing admin API/page should be extended to support:

- Viewing users with approval status.
- Approving pending users.
- Seeing device count and recent device metadata.
- Resetting a user's devices if they change iPad/phone.
- Deleting users as already supported.
- Seeing security events such as blocked third-device attempts.

Admin approval should enforce the 19-user cap. If 19 users are already approved, approving another pending user should fail unless another approved user is removed or unapproved.

## Viewer watermark

No viewer watermark should be shown. Account-sharing protection should rely on admin approval, the two-device limit, session rotation, protected PDF routes, and admin reset controls.

## Copy and screenshot friction

Keep existing browser friction and add only safe, non-breaking measures:

- Keep `user-select: none` and image dragging disabled in the viewer.
- Hide print output with existing `@media print` behavior.
- Avoid relying on right-click prevention because most users are iOS/iPadOS and it adds little value.
- Do not claim screenshots are impossible. The security wall is focused on access control, not screenshot prevention.

## Data flow

1. User registers.
2. Server creates pending user with `approved: false`.
3. User cannot log in until admin approves them.
4. Admin approves pending user if approved-user count is below 19.
5. Approved user logs in from iPad/iPhone.
6. Client sends username, password/token, PDF choice, and local device ID.
7. Server validates credentials and approval.
8. Server validates or registers the device.
9. Server rotates session token and returns success.
10. Viewer opens with token.
11. `/api/document`, `/api/annotations`, `/api/heartbeat`, and related protected routes continue requiring a valid token and should also respect approval/security status.
12. Viewer opens without a watermark overlay.

## Error behavior

User-facing errors should stay generic enough not to teach bypasses:

- Pending account: `Account pending admin approval.`
- Too many devices: `Device limit reached. Contact admin.`
- Full group: registration can still create pending users, but admin approval should fail once the 19-user cap is reached.
- Invalid credentials/session: keep the existing generic expired-session behavior.

Security details should go into server logs/user security events, not detailed public messages.

## Testing plan

- Register a new account and verify it is pending.
- Confirm pending account cannot log in or open PDFs.
- Approve the account from admin.
- Log in from first device ID: allowed.
- Log in from second device ID: allowed.
- Log in from third device ID: blocked.
- Reset devices as admin, then verify the next device can bind again.
- Verify approved-user cap blocks the 20th approval.
- Verify document, annotation, heartbeat, and announcement endpoints reject unapproved users.
- Run server syntax checks and inline script checks.

## Out of scope

- Native iOS screenshot blocking, because normal websites cannot reliably do this.
- Strong cryptographic device attestation, because this is a plain browser app and would require a different architecture.
- Full role-based access control beyond admin approval and user access.

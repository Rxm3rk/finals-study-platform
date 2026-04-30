# Security Wall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-side security wall that limits access to admin-approved group members, caps approved users at 19, allows two trusted devices per user, and blocks third devices.

**Architecture:** Keep the current static HTML + Node `http` architecture. Add small security helper functions in `server.js`, enforce approval/device checks in existing auth-protected routes, pass a browser-generated device ID from `index.html` and `viewer.html`, and extend `admin.html` with approval/reset controls.

**Tech Stack:** Node.js built-in `http`, `fs`, `path`, `crypto`; static HTML/CSS/vanilla JavaScript; existing `users.json`, `database.json`, `blocked.json`, and localStorage session/device pattern.

---

## File Structure

- Modify `server.js`
  - Add constants: max approved users, max devices per user.
  - Add helpers for user security fields, approval, device binding, security events, and protected-session lookup.
  - Update registration to create pending users.
  - Update login/heartbeat and protected APIs to enforce approval and device rules.
  - Add admin endpoints for approving users and resetting devices.
- Modify `index.html`
  - Add client-side device ID helper.
  - Send `deviceId` and `deviceLabel` with login requests.
  - Keep registration UX simple: successful registration tells the user to wait for admin approval.
- Modify `viewer.html`
  - Do not render a viewer watermark overlay.
  - Add client-side device ID helper.
  - Send device fields during silent token refresh.
- Modify `admin.html`
  - Show approval status, approved user count, device count, and recent security events.
  - Add Approve and Reset Devices buttons.
- No new runtime data files. Security state lives inside each record in `users.json`.

## Task 1: Add Server Security Helpers

**Files:**
- Modify: `server.js:14-170`

- [ ] **Step 1: Add constants**

Insert after the existing `ACTIVE_ANNOUNCEMENT` constant:

```javascript
const MAX_APPROVED_USERS = 19;
const MAX_DEVICES_PER_USER = 2;
```

- [ ] **Step 2: Add helper functions**

Insert after `function getAdminPassword() { ... }`:

```javascript
function isUserApproved(user) {
    return user.approved === true;
}

function ensureSecurityFields(user) {
    if (typeof user.approved !== 'boolean') {
        user.approved = false;
    }
    if (!Array.isArray(user.devices)) {
        user.devices = [];
    }
    if (!Array.isArray(user.securityEvents)) {
        user.securityEvents = [];
    }
    return user;
}

function countApprovedUsers(users) {
    return users.filter(user => user.approved === true).length;
}

function recordSecurityEvent(user, type, details) {
    ensureSecurityFields(user);
    user.securityEvents.unshift({
        type,
        timestamp: new Date().toISOString(),
        ...details
    });
    user.securityEvents = user.securityEvents.slice(0, 20);
}

function getDeviceLabel(userAgent) {
    if (!userAgent) return 'Unknown device';
    if (/iPad/i.test(userAgent)) return 'iPad';
    if (/iPhone/i.test(userAgent)) return 'iPhone';
    if (/Macintosh/i.test(userAgent) && /Mobile/i.test(userAgent)) return 'iPad';
    return userAgent.slice(0, 80);
}

function normalizeDeviceId(deviceId) {
    if (typeof deviceId !== 'string') return '';
    return deviceId.trim().slice(0, 80);
}

function verifyUserAccess(user, clientIp, req, deviceId) {
    ensureSecurityFields(user);

    if (!isUserApproved(user)) {
        recordSecurityEvent(user, 'blocked_unapproved_access', { ip: clientIp });
        return { ok: false, status: 403, error: 'Account pending admin approval.' };
    }

    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (!normalizedDeviceId) {
        recordSecurityEvent(user, 'blocked_missing_device', { ip: clientIp });
        return { ok: false, status: 403, error: 'Device verification failed. Please try again.' };
    }

    const existingDevice = user.devices.find(device => device.id === normalizedDeviceId);
    if (existingDevice) {
        existingDevice.lastSeenAt = new Date().toISOString();
        existingDevice.lastIp = clientIp;
        existingDevice.userAgent = req.headers['user-agent'] || '';
        return { ok: true };
    }

    if (user.devices.length >= MAX_DEVICES_PER_USER) {
        recordSecurityEvent(user, 'blocked_device_limit', {
            ip: clientIp,
            attemptedDeviceId: normalizedDeviceId,
            userAgent: req.headers['user-agent'] || ''
        });
        return { ok: false, status: 403, error: 'Device limit reached. Contact admin.' };
    }

    user.devices.push({
        id: normalizedDeviceId,
        label: getDeviceLabel(req.headers['user-agent'] || ''),
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        lastIp: clientIp,
        userAgent: req.headers['user-agent'] || ''
    });

    recordSecurityEvent(user, 'device_registered', {
        ip: clientIp,
        deviceId: normalizedDeviceId
    });

    return { ok: true };
}

function findAuthorizedUserBySession(users, username, token) {
    const user = findUserBySession(users, username, token);
    if (!user) return null;
    ensureSecurityFields(user);
    return isUserApproved(user) ? user : null;
}
```

- [ ] **Step 3: Update existing session helper use**

Do not remove `findUserBySession`; keep it for announcement route compatibility until protected routes are updated in later tasks.

- [ ] **Step 4: Run syntax check**

Run:

```bash
node --check server.js
```

Expected: no output and exit code 0.

## Task 2: Make Registration Pending and Enforce Approval/Device Rules on Login

**Files:**
- Modify: `server.js:196-278`

- [ ] **Step 1: Update new user shape in registration**

Replace the `const newUser = { ... };` block in `/api/register` with:

```javascript
const newUser = {
    username: data.username,
    password: data.password,
    createdAt: new Date().toISOString(),
    lastOnline: Date.now(),
    ip: clientIp,
    approved: false,
    approvedAt: null,
    approvedBy: null,
    devices: [],
    securityEvents: []
};
```

- [ ] **Step 2: Keep activity update after registration**

Keep this existing line immediately after the new user object:

```javascript
updateUserActivity(newUser, clientIp);
```

- [ ] **Step 3: Add access enforcement in login/heartbeat**

In the `/api/login` and `/api/heartbeat` route, immediately after:

```javascript
if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Invalid credentials or expired session' }));
}
```

insert:

```javascript
const accessCheck = verifyUserAccess(user, clientIp, req, data.deviceId);
if (!accessCheck.ok) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    res.writeHead(accessCheck.status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: accessCheck.error }));
}
```

- [ ] **Step 4: Run syntax check**

Run:

```bash
node --check server.js
```

Expected: no output and exit code 0.

## Task 3: Enforce Approval on Protected Server Routes

**Files:**
- Modify: `server.js:280-654`

- [ ] **Step 1: Update announcement session lookup**

In `GET /api/announcement`, replace:

```javascript
const user = findUserBySession(users, username, token);
```

with:

```javascript
const user = findAuthorizedUserBySession(users, username, token);
```

- [ ] **Step 2: Update announcement dismiss session lookup**

In `POST /api/announcement/dismiss`, replace:

```javascript
const user = findUserBySession(users, data.username, data.token);
```

with:

```javascript
const user = findAuthorizedUserBySession(users, data.username, data.token);
```

- [ ] **Step 3: Update presence close session lookup**

In `POST /api/presence/close`, replace:

```javascript
const user = users.find(u => u.username === data.username && u.token === data.token);
```

with:

```javascript
const user = findAuthorizedUserBySession(users, data.username, data.token);
```

- [ ] **Step 4: Update annotations GET session lookup**

In `GET /api/annotations`, replace:

```javascript
if (!users.find(u => u.username === user && u.token === token)) {
    res.writeHead(401); return res.end('Unauthorized');
}
```

with:

```javascript
if (!findAuthorizedUserBySession(users, user, token)) {
    res.writeHead(401); return res.end('Unauthorized');
}
```

- [ ] **Step 5: Update annotations POST session lookup**

In `POST /api/annotations`, replace:

```javascript
if (!users.find(u => u.username === data.user && u.token === data.token)) {
    res.writeHead(401); return res.end('Unauthorized');
}
```

with:

```javascript
if (!findAuthorizedUserBySession(users, data.user, data.token)) {
    res.writeHead(401); return res.end('Unauthorized');
}
```

- [ ] **Step 6: Update document session lookup**

In `GET /api/document`, replace:

```javascript
const userData = users.find(u => u.username === user && u.token === token);
```

with:

```javascript
const userData = findAuthorizedUserBySession(users, user, token);
```

- [ ] **Step 7: Keep existing invalid session response**

Do not change this existing block after the document lookup:

```javascript
if (!userData) {
    res.writeHead(401);
    return res.end('Unauthorized: Session expired or invalid token');
}
```

- [ ] **Step 8: Run syntax check**

Run:

```bash
node --check server.js
```

Expected: no output and exit code 0.

## Task 4: Add Admin Approval and Device Reset Endpoints

**Files:**
- Modify: `server.js:404-598`

- [ ] **Step 1: Add admin security summary to `/api/admin` response**

In `GET /api/admin`, after:

```javascript
const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
```

insert:

```javascript
users.forEach(ensureSecurityFields);
fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
```

Then replace the response object:

```javascript
res.end(JSON.stringify({
    database: JSON.parse(dbData),
    blocked: JSON.parse(blockedData),
    users,
    annotations: listAnnotationSummaries(users)
}));
```

with:

```javascript
res.end(JSON.stringify({
    database: JSON.parse(dbData),
    blocked: JSON.parse(blockedData),
    users,
    approvedUserCount: countApprovedUsers(users),
    maxApprovedUsers: MAX_APPROVED_USERS,
    maxDevicesPerUser: MAX_DEVICES_PER_USER,
    annotations: listAnnotationSummaries(users)
}));
```

- [ ] **Step 2: Add approve user endpoint**

Insert before `if (req.method === 'GET' && pathname === '/api/admin/annotations') {`:

```javascript
    if (req.method === 'POST' && pathname === '/api/admin/user/approve') {
        const pwd = parsedUrl.searchParams.get('pwd');
        const adminPassword = getAdminPassword();
        if (pwd !== adminPassword) {
            res.writeHead(401);
            return res.end('Unauthorized');
        }

        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
                users.forEach(ensureSecurityFields);
                const user = users.find(u => u.username === data.username);

                if (!user) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'User not found' }));
                }

                if (!user.approved && countApprovedUsers(users) >= MAX_APPROVED_USERS) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Approved user limit reached' }));
                }

                user.approved = true;
                user.approvedAt = new Date().toISOString();
                user.approvedBy = 'admin';
                recordSecurityEvent(user, 'admin_approved_user', { ip: clientIp });

                fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
            }
        });
        return;
    }
```

- [ ] **Step 3: Add reset devices endpoint**

Insert after the approve endpoint from Step 2:

```javascript
    if (req.method === 'POST' && pathname === '/api/admin/user/reset-devices') {
        const pwd = parsedUrl.searchParams.get('pwd');
        const adminPassword = getAdminPassword();
        if (pwd !== adminPassword) {
            res.writeHead(401);
            return res.end('Unauthorized');
        }

        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
                users.forEach(ensureSecurityFields);
                const user = users.find(u => u.username === data.username);

                if (!user) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'User not found' }));
                }

                user.devices = [];
                recordSecurityEvent(user, 'admin_reset_devices', { ip: clientIp });

                fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
            }
        });
        return;
    }
```

- [ ] **Step 4: Run syntax check**

Run:

```bash
node --check server.js
```

Expected: no output and exit code 0.

## Task 5: Send Device Identity from Homepage Login

**Files:**
- Modify: `index.html:720-905`

- [ ] **Step 1: Add device helper**

Insert after `function safeStorageSet(key, value) { ... }`:

```javascript
        function getOrCreateDeviceId() {
            const existing = safeStorageGet('device_id');
            if (existing) return existing;

            const randomPart = window.crypto && window.crypto.getRandomValues
                ? Array.from(window.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
                : Math.random().toString(36).slice(2) + Date.now().toString(36);
            const deviceId = `device_${randomPart}`;
            safeStorageSet('device_id', deviceId);
            return deviceId;
        }

        function getDeviceLabel() {
            const ua = navigator.userAgent || '';
            if (/iPad/i.test(ua)) return 'iPad';
            if (/iPhone/i.test(ua)) return 'iPhone';
            if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return 'iPad';
            return 'Browser';
        }
```

- [ ] **Step 2: Create device fields before login fetch**

Inside `handleFormSubmit`, immediately before:

```javascript
const res = await fetch('/api/login', {
```

insert:

```javascript
const deviceId = getOrCreateDeviceId();
const deviceLabel = getDeviceLabel();
```

- [ ] **Step 3: Include device fields in login body**

Replace the login fetch body:

```javascript
body: JSON.stringify({ username, password, pdfVersion })
```

with:

```javascript
body: JSON.stringify({ username, password, pdfVersion, deviceId, deviceLabel })
```

- [ ] **Step 4: Improve registration success message**

After successful registration, before continuing to login, insert:

```javascript
alert('Registration submitted. Please wait for admin approval before accessing the question bank.');
btn.innerText = originalText;
btn.disabled = false;
return;
```

This means a newly registered pending user is not immediately sent into a login that will fail.

- [ ] **Step 5: Run inline script syntax check for homepage**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
for (const script of scripts) new Function(script);
console.log('index.html: inline scripts ok');
NODE
```

Expected:

```text
index.html: inline scripts ok
```

## Task 6: Add Viewer Device Refresh and Watermark

**Files:**
- Modify: `viewer.html:9-272`
- Modify: `viewer.html:560-665`

- [ ] **Step 1: Add watermark CSS**

Insert before `</style>`:

```css
        .rxm-watermark {
            position: fixed;
            inset: 60px 0 0;
            z-index: 6;
            pointer-events: none;
            overflow: hidden;
            opacity: 0.16;
        }

        .rxm-watermark::before {
            content: "@RXM3RK  @RXM3RK  @RXM3RK  @RXM3RK";
            position: absolute;
            top: -10%;
            left: -25%;
            width: 150%;
            height: 150%;
            color: #111827;
            font-size: clamp(2rem, 8vw, 5rem);
            font-weight: 800;
            letter-spacing: 0.4rem;
            line-height: 2.8;
            white-space: pre-wrap;
            transform: rotate(-24deg);
            text-align: center;
        }
```

- [ ] **Step 2: Add watermark markup**

Insert after:

```html
<div id="loader">Loading secure document...</div>
```

this line:

```html
    <div class="rxm-watermark" aria-hidden="true"></div>
```

- [ ] **Step 3: Add device helpers**

Insert after `function safeStorageSet(key, value) { ... }`:

```javascript
        function getOrCreateDeviceId() {
            const existing = safeStorageGet('device_id');
            if (existing) return existing;

            const randomPart = window.crypto && window.crypto.getRandomValues
                ? Array.from(window.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
                : Math.random().toString(36).slice(2) + Date.now().toString(36);
            const deviceId = `device_${randomPart}`;
            safeStorageSet('device_id', deviceId);
            return deviceId;
        }

        function getDeviceLabel() {
            const ua = navigator.userAgent || '';
            if (/iPad/i.test(ua)) return 'iPad';
            if (/iPhone/i.test(ua)) return 'iPhone';
            if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return 'iPad';
            return 'Browser';
        }
```

- [ ] **Step 4: Include device fields in silent token refresh**

In `refreshSessionToken`, replace the fetch body:

```javascript
body: JSON.stringify({ username: user, password: savedPassword, pdfVersion: fileName, silentRefresh: true })
```

with:

```javascript
body: JSON.stringify({
    username: user,
    password: savedPassword,
    pdfVersion: fileName,
    silentRefresh: true,
    deviceId: getOrCreateDeviceId(),
    deviceLabel: getDeviceLabel()
})
```

- [ ] **Step 5: Run inline script syntax check for viewer**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const html = fs.readFileSync('viewer.html', 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
for (const script of scripts) new Function(script);
console.log('viewer.html: inline scripts ok');
NODE
```

Expected:

```text
viewer.html: inline scripts ok
```

## Task 7: Add Admin Dashboard Controls

**Files:**
- Modify: `admin.html:91-180`
- Modify: `admin.html:269-590`

- [ ] **Step 1: Add status badge styles**

Insert after the `.blocked-badge { ... }` style block:

```css
        .approval-badge {
            padding: 4px 8px;
            border-radius: 99px;
            font-size: 0.75rem;
            font-weight: 600;
            display: inline-block;
            margin-left: 5px;
        }

        .approval-badge.approved {
            background: #e8f5e9;
            color: #1b5e20;
        }

        .approval-badge.pending {
            background: #fff3cd;
            color: #8a5a00;
        }

        .device-summary {
            font-size: 0.76rem;
            color: #666;
            margin-top: 0.25rem;
        }

        .security-events {
            margin-top: 0.35rem;
            font-size: 0.72rem;
            color: #777;
        }
```

- [ ] **Step 2: Show approved count**

Insert under `<h3>Registered Users</h3>`:

```html
                <div id="approval-count" style="font-size:0.8rem; color:#666; margin-top:-0.25rem;">Loading approval status...</div>
```

- [ ] **Step 3: Render richer user cards**

Inside `renderUsersAndPresence`, after:

```javascript
const usersList = document.getElementById('users-list');
```

insert:

```javascript
            const approvalCount = document.getElementById('approval-count');
            if (approvalCount) {
                approvalCount.textContent = `${data.approvedUserCount || 0}/${data.maxApprovedUsers || 19} approved users`;
            }
```

Then replace the whole `usersList.innerHTML = data.users.map(u => { ... }).join('');` block with:

```javascript
                usersList.innerHTML = data.users.map(u => {
                    const seenText = formatLastSeen(u.lastOnline);
                    const isBlocked = data.blocked && (data.blocked.includes(u.ip) || data.blocked.includes(u.username));
                    const isApproved = u.approved === true;
                    const devices = Array.isArray(u.devices) ? u.devices : [];
                    const securityEvents = Array.isArray(u.securityEvents) ? u.securityEvents.slice(0, 2) : [];
                    const btn = isBlocked ?
                        `<button onclick='unban(${JSON.stringify(u.username)})' style="padding:4px 8px; font-size:0.75rem; background:#6c757d; border-radius:4px;">Unban</button>` :
                        `<button onclick='banUser(${JSON.stringify(u.username)})' style="padding:4px 8px; font-size:0.75rem; background:#dc3545; border-radius:4px;">Ban IP</button>`;
                    const approveBtn = isApproved ? '' : `<button onclick='approveUser(${JSON.stringify(u.username)})' style="padding:4px 8px; font-size:0.75rem; background:#198754; border-radius:4px; margin-left:4px;">Approve</button>`;
                    const resetBtn = `<button onclick='resetDevices(${JSON.stringify(u.username)})' style="padding:4px 8px; font-size:0.75rem; background:#0d6efd; border-radius:4px; margin-left:4px;">Reset Devices</button>`;
                    const deviceText = `${devices.length}/${data.maxDevicesPerUser || 2} devices`;
                    const eventText = securityEvents.map(event => `${escapeHtml(event.type)} · ${new Date(event.timestamp).toLocaleString()}`).join('<br>');

                    return `<div style="margin-bottom: 10px; display:flex; justify-content:space-between; align-items:flex-start; gap:8px; background:#fbfbfb; padding:8px; border-radius:6px; border:1px solid #eee;">
                        <div>
                            <strong style="color:#222;">${escapeHtml(u.username)}</strong>
                            <span class="approval-badge ${isApproved ? 'approved' : 'pending'}">${isApproved ? 'APPROVED' : 'PENDING'}</span>
                            <span style="font-size:0.75rem; color:#888;">(${escapeHtml(u.ip || 'No IP')})</span>
                            <br><span style="font-size:0.8rem; color:#555;">last seen: ${seenText}</span>
                            <div class="device-summary">${deviceText}${devices[0] ? ` · latest: ${escapeHtml(devices[0].label || 'device')}` : ''}</div>
                            ${eventText ? `<div class="security-events">${eventText}</div>` : ''}
                            ${isBlocked ? '<span class="blocked-badge" style="margin-left: 5px;">BANNED</span>' : ''}
                        </div>
                        <div style="display:flex; flex-wrap:wrap; justify-content:flex-end; gap:4px;">
                            ${approveBtn}
                            ${resetBtn}
                            ${btn}
                            <button onclick='deleteUser(${JSON.stringify(u.username)})' style="padding:4px 8px; font-size:0.75rem; background:#333; border-radius:4px; margin-left:4px;">Delete User</button>
                        </div>
                    </div>`;
                }).join('');
```

- [ ] **Step 4: Add approve function**

Insert before `async function deleteUser(username) {`:

```javascript
        async function approveUser(username) {
            const pwd = document.getElementById('pwd').value;
            try {
                const res = await fetch(`/api/admin/user/approve?pwd=${encodeURIComponent(pwd)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username })
                });
                const data = await res.json();
                if (res.ok && data.success) {
                    loadData();
                } else {
                    alert(data.error || 'Failed to approve user.');
                }
            } catch(e) {
                alert('Error approving user.');
            }
        }

        async function resetDevices(username) {
            if (!confirm(`Reset trusted devices for ${username}? They will need to log in again from their current iPad/iPhone.`)) return;
            const pwd = document.getElementById('pwd').value;
            try {
                const res = await fetch(`/api/admin/user/reset-devices?pwd=${encodeURIComponent(pwd)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username })
                });
                const data = await res.json();
                if (res.ok && data.success) {
                    loadData();
                } else {
                    alert(data.error || 'Failed to reset devices.');
                }
            } catch(e) {
                alert('Error resetting devices.');
            }
        }
```

- [ ] **Step 5: Run inline script syntax check for admin**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const html = fs.readFileSync('admin.html', 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
for (const script of scripts) new Function(script);
console.log('admin.html: inline scripts ok');
NODE
```

Expected:

```text
admin.html: inline scripts ok
```

## Task 8: End-to-End Verification

**Files:**
- Verify: `server.js`, `index.html`, `viewer.html`, `admin.html`

- [ ] **Step 1: Run syntax checks**

Run:

```bash
node --check server.js
node - <<'NODE'
const fs = require('fs');
for (const file of ['index.html', 'viewer.html', 'admin.html']) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  for (const script of scripts) new Function(script);
  console.log(`${file}: inline scripts ok`);
}
NODE
```

Expected:

```text
index.html: inline scripts ok
viewer.html: inline scripts ok
admin.html: inline scripts ok
```

- [ ] **Step 2: Run whitespace check**

Run:

```bash
git diff --check -- server.js index.html viewer.html admin.html docs/superpowers/specs/2026-04-30-security-wall-design.md docs/superpowers/plans/2026-04-30-security-wall.md
```

Expected: no whitespace errors.

- [ ] **Step 3: Start local server**

Run:

```bash
npm start
```

Expected includes:

```text
Server running on port 3000
```

- [ ] **Step 4: Smoke test static pages and health**

In another shell, run:

```bash
curl -I http://localhost:3000/
curl -I http://localhost:3000/admin
curl http://localhost:3000/health
```

Expected: homepage/admin return HTTP 200, health returns `OK`.

- [ ] **Step 5: API test pending registration**

Run with a unique username:

```bash
curl -s -X POST http://localhost:3000/api/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"security_test_pending","password":"pass123"}'
```

Expected:

```json
{"success":true}
```

- [ ] **Step 6: API test pending login is blocked**

Run:

```bash
curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"security_test_pending","password":"pass123","pdfVersion":"Stage5_2023_2025 (soon to add other years too).pdf","deviceId":"device_test_1"}'
```

Expected includes:

```json
{"success":false,"error":"Account pending admin approval."}
```

- [ ] **Step 7: API test admin approval**

Run:

```bash
curl -s -X POST 'http://localhost:3000/api/admin/user/approve?pwd=rxm3rk_admin' \
  -H 'Content-Type: application/json' \
  -d '{"username":"security_test_pending"}'
```

Expected:

```json
{"success":true}
```

- [ ] **Step 8: API test first two devices allowed**

Run:

```bash
curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"security_test_pending","password":"pass123","pdfVersion":"Stage5_2023_2025 (soon to add other years too).pdf","deviceId":"device_test_1"}'

curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"security_test_pending","password":"pass123","pdfVersion":"Stage5_2023_2025 (soon to add other years too).pdf","deviceId":"device_test_2"}'
```

Expected for both: JSON includes `"success":true` and a `token`.

- [ ] **Step 9: API test third device blocked**

Run:

```bash
curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"security_test_pending","password":"pass123","pdfVersion":"Stage5_2023_2025 (soon to add other years too).pdf","deviceId":"device_test_3"}'
```

Expected includes:

```json
{"success":false,"error":"Device limit reached. Contact admin."}
```

- [ ] **Step 10: API test reset devices**

Run:

```bash
curl -s -X POST 'http://localhost:3000/api/admin/user/reset-devices?pwd=rxm3rk_admin' \
  -H 'Content-Type: application/json' \
  -d '{"username":"security_test_pending"}'
```

Expected:

```json
{"success":true}
```

Then rerun login with `device_test_3`; expected success.

- [ ] **Step 11: Manual browser check**

Open `http://localhost:3000/`, register or use an approved account, approve it from `/admin`, open a PDF, and verify:

```text
@RXM3RK
```

appears subtly in the viewer and does not block PDF scrolling, zooming, or drawing.

- [ ] **Step 12: Commit and push**

Run:

```bash
git status --short
git add -- server.js index.html viewer.html admin.html docs/superpowers/specs/2026-04-30-security-wall-design.md docs/superpowers/plans/2026-04-30-security-wall.md
git commit -m "$(cat <<'EOF'
feat: add security wall for approved devices

Restrict question bank access to approved users, enforce a two-device limit, and add a subtle viewer watermark.

Co-Authored-By: Claude GPT-5.5 <noreply@openclaude.dev>
EOF
)"
git push origin master
```

Expected: commit succeeds and push updates `origin/master`.

## Self-Review

- Spec coverage: pending registration, admin approval, 19 approved-user cap, two devices per approved user, third-device blocking, protected-route enforcement, admin reset controls, and iOS/iPad-focused flow are covered.
- Placeholder scan: no TBD/TODO/later placeholders are present.
- Type consistency: user fields use `approved`, `approvedAt`, `approvedBy`, `devices`, and `securityEvents` consistently; client/server device field is `deviceId`; admin endpoints are `/api/admin/user/approve` and `/api/admin/user/reset-devices`.

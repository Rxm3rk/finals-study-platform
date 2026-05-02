const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Global crash handlers to prevent silent Railway deaths
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});


const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// Dedicated Volume Persistent Storage Mapping
const VOL_PATH = '/app/data';
const IS_PROD_VOL = fs.existsSync(VOL_PATH);
const WORK_DIR = IS_PROD_VOL ? VOL_PATH : __dirname;

const DB_FILE = path.join(WORK_DIR, 'database.json');
const BLOCKED_FILE = path.join(WORK_DIR, 'blocked.json');

// Initialize Local/Volume DB & Copy existing tracked data if present
if (!fs.existsSync(DB_FILE)) {
    const localDbPath = path.join(__dirname, 'database.json');
    if (fs.existsSync(localDbPath) && IS_PROD_VOL) {
        fs.copyFileSync(localDbPath, DB_FILE); // Carry over the GitHub commit data into the new Volume
    } else {
        fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
    }
}

if (!fs.existsSync(BLOCKED_FILE)) {
    const localBlockedPath = path.join(__dirname, 'blocked.json');
    if (fs.existsSync(localBlockedPath) && IS_PROD_VOL) {
        fs.copyFileSync(localBlockedPath, BLOCKED_FILE);
    } else {
        fs.writeFileSync(BLOCKED_FILE, JSON.stringify([], null, 2));
    }
}

const USERS_FILE = path.join(WORK_DIR, 'users.json');
const ANNOTATIONS_DIR = path.join(WORK_DIR, 'annotations');
const ACTIVE_ANNOUNCEMENT = {
    id: 'question-bank-new-content-2026-04-25',
    message: 'New contents have been added to the question bank, check it out!',
    durationMs: 15000
};
const MAX_DEVICES_PER_USER = 2;
const ACTIVE_SESSION_HEARTBEAT_MS = 8000;
const ACTIVE_SESSION_REPLACED_ERROR = 'SESSION_REPLACED';

if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
}
if (!fs.existsSync(ANNOTATIONS_DIR)) {
    fs.mkdirSync(ANNOTATIONS_DIR, { recursive: true });
}

console.log(`[INFO] Startup: Node ${process.version}`);
console.log(`[INFO] Working Directory: ${__dirname}`);
console.log(`[INFO] Persistence set to: ${DB_FILE}`);

try {
    const testWrite = path.join(WORK_DIR, '.write_test');
    fs.writeFileSync(testWrite, 'ok');
    fs.unlinkSync(testWrite);
    console.log('[INFO] Volume write test: SUCCESS');
} catch(e) {
    console.error('[ERROR] Volume write test: FAILED. Persistence will crash.', e);
}

function updateUserActivity(user, ipAddress) {
    user.lastOnline = Date.now();
    user.ip = ipAddress;
}

function findUserBySession(users, username, token) {
    return users.find(user => user.username === username && user.token === token);
}

function userHasDismissedAnnouncement(user, announcementId) {
    return Array.isArray(user.dismissedAnnouncements) && user.dismissedAnnouncements.includes(announcementId);
}

function dismissAnnouncementForUser(user, announcementId) {
    if (!Array.isArray(user.dismissedAnnouncements)) {
        user.dismissedAnnouncements = [];
    }

    if (!user.dismissedAnnouncements.includes(announcementId)) {
        user.dismissedAnnouncements.push(announcementId);
    }
}

function appendAccessLog(entry) {
    const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const logEntry = {
        timestamp: new Date().toISOString(),
        ...entry
    };
    dbData.push(logEntry);
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
    sendTelegramAccessLogNotification(logEntry);
}

function getAnnotationStorageFile(user, file) {
    return path.basename(user) + '_' + path.basename(file) + '.json';
}

function getAnnotationPath(user, file) {
    return path.join(ANNOTATIONS_DIR, getAnnotationStorageFile(user, file));
}

function readAnnotationMapFromPath(annotationPath) {
    if (!fs.existsSync(annotationPath)) {
        return {};
    }

    return JSON.parse(fs.readFileSync(annotationPath, 'utf8'));
}

function getAdminPassword() {
    return process.env.ADMIN_PASSWORD || 'rxm3rk_admin';
}

function sendTelegramApiRequest(method, payload, warningLabel = 'Telegram request') {
    if (!TELEGRAM_BOT_TOKEN) return;

    try {
        const body = JSON.stringify(payload);
        const request = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, response => {
            response.resume();
            if (response.statusCode < 200 || response.statusCode >= 300) {
                console.warn(`[WARN] ${warningLabel} failed with status ${response.statusCode}`);
            }
        });

        request.setTimeout(3000, () => {
            request.destroy(new Error('Telegram request timed out'));
        });
        request.on('error', error => {
            console.warn(`[WARN] ${warningLabel} failed:`, error.message);
        });
        request.end(body);
    } catch (error) {
        console.warn(`[WARN] ${warningLabel} failed:`, error.message);
    }
}

function sendTelegramRegistrationNotification(user) {
    if (!TELEGRAM_CHAT_ID) return;

    const summary = user.registrationClientSummary || {};
    const lines = [
        'New user registered',
        `Username: ${user.username}`,
        `Time: ${user.createdAt}`,
        `IP: ${user.ip || 'Unknown'}`
    ];

    if (summary.deviceLabel || summary.platform || summary.timezone || summary.screen || summary.viewport) {
        lines.push(
            `Device: ${summary.deviceLabel || 'Unknown'}`,
            `Platform: ${summary.platform || 'Unknown'}`,
            `Timezone: ${summary.timezone || 'Unknown'}`,
            `Screen: ${summary.screen || 'Unknown'}`,
            `Viewport: ${summary.viewport || 'Unknown'}`
        );
    }

    sendTelegramApiRequest('sendMessage', {
        chat_id: TELEGRAM_CHAT_ID,
        text: lines.join('\n')
    }, 'Telegram registration notification');
}

function sendTelegramAccessLogNotification(logEntry) {
    if (!TELEGRAM_CHAT_ID) return;

    const summary = logEntry.clientSummary || {};
    const lines = [
        'Access history update',
        `Action: ${logEntry.action || 'access'}`,
        `Username: ${logEntry.username || 'Unknown'}`,
        `PDF: ${logEntry.pdfVersion || 'Unknown'}`,
        `Time: ${logEntry.timestamp}`,
        `IP: ${logEntry.ip || 'Unknown'}`
    ];

    if (logEntry.deviceId) {
        lines.push(`Device ID: ${logEntry.deviceId}`);
    }

    if (summary.deviceLabel || summary.platform || summary.timezone || summary.screen || summary.viewport) {
        lines.push(
            `Device: ${summary.deviceLabel || 'Unknown'}`,
            `Platform: ${summary.platform || 'Unknown'}`,
            `Timezone: ${summary.timezone || 'Unknown'}`,
            `Screen: ${summary.screen || 'Unknown'}`,
            `Viewport: ${summary.viewport || 'Unknown'}`
        );
    }

    sendTelegramApiRequest('sendMessage', {
        chat_id: TELEGRAM_CHAT_ID,
        text: lines.join('\n')
    }, 'Telegram access log notification');
}

function limitString(value, maxLength = 160) {
    if (typeof value !== 'string') return '';
    return value.slice(0, maxLength);
}

function sanitizeClientDetails(details) {
    if (!details || typeof details !== 'object') return null;

    const sanitized = {
        deviceLabel: limitString(details.deviceLabel, 40),
        userAgent: limitString(details.userAgent, 260),
        platform: limitString(details.platform, 80),
        vendor: limitString(details.vendor, 80),
        language: limitString(details.language, 40),
        timezone: limitString(details.timezone, 80),
        cookieEnabled: Boolean(details.cookieEnabled),
        standalone: Boolean(details.standalone),
        maxTouchPoints: Number.isFinite(Number(details.maxTouchPoints)) ? Number(details.maxTouchPoints) : 0,
        screen: details.screen && typeof details.screen === 'object' ? {
            width: Number(details.screen.width) || 0,
            height: Number(details.screen.height) || 0,
            availWidth: Number(details.screen.availWidth) || 0,
            availHeight: Number(details.screen.availHeight) || 0,
            colorDepth: Number(details.screen.colorDepth) || 0
        } : null,
        viewport: details.viewport && typeof details.viewport === 'object' ? {
            width: Number(details.viewport.width) || 0,
            height: Number(details.viewport.height) || 0,
            devicePixelRatio: Number(details.viewport.devicePixelRatio) || 0,
            orientation: limitString(details.viewport.orientation, 40)
        } : null
    };

    if (Array.isArray(details.languages)) {
        sanitized.languages = details.languages.slice(0, 6).map(language => limitString(language, 40)).filter(Boolean);
    } else {
        sanitized.languages = [];
    }

    return sanitized;
}

function summarizeClientDetails(details) {
    const sanitized = sanitizeClientDetails(details);
    if (!sanitized) return null;

    return {
        deviceLabel: sanitized.deviceLabel,
        platform: sanitized.platform,
        timezone: sanitized.timezone,
        language: sanitized.language,
        maxTouchPoints: sanitized.maxTouchPoints,
        screen: sanitized.screen ? `${sanitized.screen.width}x${sanitized.screen.height}` : '',
        viewport: sanitized.viewport ? `${sanitized.viewport.width}x${sanitized.viewport.height}@${sanitized.viewport.devicePixelRatio}` : '',
        orientation: sanitized.viewport ? sanitized.viewport.orientation : '',
        standalone: sanitized.standalone
    };
}

function buildDeviceRecord(deviceId, clientIp, req, data, existingDevice) {
    const clientDetails = sanitizeClientDetails(data.clientDetails);
    const clientSummary = summarizeClientDetails(data.clientDetails);
    const now = new Date().toISOString();

    return {
        ...(existingDevice || {}),
        id: deviceId,
        label: limitString(data.deviceLabel, 40) || (clientSummary && clientSummary.deviceLabel) || getDeviceLabel(req.headers['user-agent'] || ''),
        firstSeenAt: existingDevice?.firstSeenAt || now,
        lastSeenAt: now,
        lastIp: clientIp,
        userAgent: req.headers['user-agent'] || '',
        clientDetails,
        clientSummary
    };
}

function ensureSecurityFields(user) {
    if (!Array.isArray(user.devices)) {
        user.devices = [];
    }
    if (!Array.isArray(user.securityEvents)) {
        user.securityEvents = [];
    }
    if (!Object.prototype.hasOwnProperty.call(user, 'activeSession')) {
        user.activeSession = null;
    }
    if (!Array.isArray(user.pendingDevices)) {
        user.pendingDevices = [];
    }
    if (!Object.prototype.hasOwnProperty.call(user, 'registrationClientDetails')) {
        user.registrationClientDetails = null;
    }
    return user;
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

function approvePendingDevice(users, username, deviceId, actor, clientIp) {
    const user = users.find(u => u.username === username);
    if (!user) return { success: false, status: 404, error: 'User not found' };

    ensureSecurityFields(user);
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const pendingIndex = user.pendingDevices.findIndex(device => device.id === normalizedDeviceId);
    if (pendingIndex === -1) return { success: false, status: 404, error: 'Pending device not found' };
    if (user.devices.length >= MAX_DEVICES_PER_USER) return { success: false, status: 400, error: 'Device limit reached' };

    const [pendingDevice] = user.pendingDevices.splice(pendingIndex, 1);
    pendingDevice.approvedAt = new Date().toISOString();
    pendingDevice.approvedBy = actor;
    delete pendingDevice.status;
    delete pendingDevice.telegramNotificationPending;
    delete pendingDevice.telegramApprovalNotifiedAt;
    user.devices.push(pendingDevice);
    recordSecurityEvent(user, 'admin_approved_device', {
        ip: clientIp,
        deviceId: normalizedDeviceId,
        clientSummary: pendingDevice.clientSummary || null
    });

    return { success: true, user, device: pendingDevice };
}

function rejectPendingDevice(users, username, deviceId, actor, clientIp) {
    const user = users.find(u => u.username === username);
    if (!user) return { success: false, status: 404, error: 'User not found' };

    ensureSecurityFields(user);
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const pendingIndex = user.pendingDevices.findIndex(device => device.id === normalizedDeviceId);
    if (pendingIndex === -1) return { success: false, status: 404, error: 'Pending device not found' };

    const [pendingDevice] = user.pendingDevices.splice(pendingIndex, 1);
    recordSecurityEvent(user, 'admin_rejected_device', {
        ip: clientIp,
        deviceId: normalizedDeviceId,
        actor,
        clientSummary: pendingDevice.clientSummary || null
    });

    return { success: true, user, device: pendingDevice };
}

function verifyUserAccess(user, clientIp, req, deviceId, data = {}) {
    ensureSecurityFields(user);

    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (!normalizedDeviceId) {
        recordSecurityEvent(user, 'blocked_missing_device', {
            ip: clientIp,
            clientSummary: summarizeClientDetails(data.clientDetails)
        });
        return { ok: false, status: 403, error: 'Device verification failed. Please try again.' };
    }

    const existingDevice = user.devices.find(device => device.id === normalizedDeviceId);
    if (existingDevice) {
        Object.assign(existingDevice, buildDeviceRecord(normalizedDeviceId, clientIp, req, data, existingDevice));
        return { ok: true };
    }

    if (user.devices.length >= MAX_DEVICES_PER_USER) {
        recordSecurityEvent(user, 'blocked_device_limit', {
            ip: clientIp,
            attemptedDeviceId: normalizedDeviceId,
            userAgent: req.headers['user-agent'] || '',
            clientSummary: summarizeClientDetails(data.clientDetails)
        });
        return { ok: false, status: 403, error: 'Device limit reached. Contact admin.' };
    }

    const approvedDevice = buildDeviceRecord(normalizedDeviceId, clientIp, req, data);
    approvedDevice.approvedAt = new Date().toISOString();
    approvedDevice.approvedBy = 'automatic';
    user.devices.push(approvedDevice);
    user.pendingDevices = user.pendingDevices.filter(device => device.id !== normalizedDeviceId);

    recordSecurityEvent(user, 'device_auto_approved', {
        ip: clientIp,
        deviceId: normalizedDeviceId,
        pdfVersion: data.pdfVersion || null,
        clientSummary: approvedDevice.clientSummary
    });

    return { ok: true };
}

function findAuthorizedUserBySession(users, username, token) {
    const user = findUserBySession(users, username, token);
    if (!user) return null;
    ensureSecurityFields(user);
    return user;
}

function createActiveSession(user, data, clientIp, req) {
    ensureSecurityFields(user);

    const previousSession = user.activeSession;
    const sessionId = crypto.randomBytes(16).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    const deviceId = normalizeDeviceId(data.deviceId);

    if (previousSession && (previousSession.token !== token || previousSession.deviceId !== deviceId)) {
        recordSecurityEvent(user, 'active_session_replaced', {
            ip: clientIp,
            previousDeviceId: previousSession.deviceId || null,
            nextDeviceId: deviceId,
            pdfVersion: data.pdfVersion || null
        });
        appendAccessLog({
            username: user.username,
            pdfVersion: data.pdfVersion || previousSession.pdfVersion || null,
            ip: clientIp,
            action: 'session_replaced'
        });
    }

    user.token = token;
    user.activeSession = {
        id: sessionId,
        token,
        deviceId,
        pdfVersion: data.pdfVersion || null,
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        ip: clientIp,
        userAgent: req.headers['user-agent'] || '',
        clientDetails: sanitizeClientDetails(data.clientDetails),
        clientSummary: summarizeClientDetails(data.clientDetails)
    };

    return user.activeSession;
}

function isCurrentActiveSession(user, token, sessionId, deviceId) {
    ensureSecurityFields(user);
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    return Boolean(
        user.activeSession &&
        user.activeSession.id === sessionId &&
        user.activeSession.token === token &&
        user.activeSession.deviceId === normalizedDeviceId
    );
}

function verifyActiveProtectedSession(users, username, token, sessionId, deviceId, clientIp, req) {
    let sessionCheck = verifyProtectedSession(users, username, token, deviceId, clientIp, req);
    if (!sessionCheck.ok && sessionCheck.status === 401) {
        const staleUser = users.find(user => user.username === username);
        if (staleUser) {
            ensureSecurityFields(staleUser);
            const normalizedDeviceId = normalizeDeviceId(deviceId);
            const staleDevice = staleUser.devices.find(device => device.id === normalizedDeviceId);
            if (staleDevice) {
                sessionCheck = { ok: true, user: staleUser };
            }
        }
    }
    if (!sessionCheck.ok) return sessionCheck;

    const user = sessionCheck.user;
    if (!sessionId || !isCurrentActiveSession(user, token, sessionId, deviceId)) {
        recordSecurityEvent(user, 'blocked_stale_session', {
            ip: clientIp,
            attemptedSessionId: sessionId || null,
            attemptedDeviceId: normalizeDeviceId(deviceId),
            activeDeviceId: user.activeSession ? user.activeSession.deviceId : null
        });
        return { ok: false, status: 409, error: ACTIVE_SESSION_REPLACED_ERROR };
    }

    user.activeSession.lastHeartbeatAt = new Date().toISOString();
    user.activeSession.ip = clientIp;
    user.activeSession.userAgent = req.headers['user-agent'] || '';
    return { ok: true, user };
}

function clearActiveSessionIfCurrent(user, token, sessionId, deviceId) {
    if (!isCurrentActiveSession(user, token, sessionId, deviceId)) {
        return false;
    }

    user.activeSession = null;
    return true;
}

function verifyProtectedSession(users, username, token, deviceId, clientIp, req) {
    const user = findUserBySession(users, username, token);
    if (!user) {
        return { ok: false, status: 401, error: 'Invalid session' };
    }

    ensureSecurityFields(user);

    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (!normalizedDeviceId) {
        recordSecurityEvent(user, 'blocked_missing_device', { ip: clientIp });
        return { ok: false, status: 403, error: 'Device verification failed. Please try again.' };
    }

    const existingDevice = user.devices.find(device => device.id === normalizedDeviceId);
    if (!existingDevice) {
        recordSecurityEvent(user, 'blocked_unregistered_device', {
            ip: clientIp,
            attemptedDeviceId: normalizedDeviceId,
            userAgent: req.headers['user-agent'] || ''
        });
        return { ok: false, status: 403, error: 'Device limit reached. Contact admin.' };
    }

    existingDevice.lastSeenAt = new Date().toISOString();
    existingDevice.lastIp = clientIp;
    existingDevice.userAgent = req.headers['user-agent'] || '';

    return { ok: true, user, device: existingDevice };
}

function parseStoredAnnotationName(storageFile, users) {
    const baseName = storageFile.replace(/\.json$/i, '');
    const sortedUsers = [...users].sort((a, b) => b.username.length - a.username.length);

    for (const user of sortedUsers) {
        const prefix = `${user.username}_`;
        if (baseName.startsWith(prefix)) {
            return {
                user: user.username,
                file: baseName.slice(prefix.length),
                storageFile
            };
        }
    }

    return {
        user: 'Unknown',
        file: baseName,
        storageFile
    };
}

function listAnnotationSummaries(users) {
    if (!fs.existsSync(ANNOTATIONS_DIR)) {
        return [];
    }

    return fs.readdirSync(ANNOTATIONS_DIR)
        .filter(name => name.toLowerCase().endsWith('.json'))
        .map(storageFile => {
            const annotationPath = path.join(ANNOTATIONS_DIR, storageFile);
            const annotationMap = readAnnotationMapFromPath(annotationPath);
            const pages = Object.keys(annotationMap)
                .map(page => Number(page))
                .filter(page => Number.isFinite(page))
                .sort((a, b) => a - b);
            const annotationInfo = parseStoredAnnotationName(storageFile, users);
            const stats = fs.statSync(annotationPath);

            return {
                ...annotationInfo,
                pageCount: pages.length,
                pages,
                updatedAt: stats.mtime.toISOString()
            };
        })
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

const server = http.createServer((req, res) => {
    try {
        // CORS headers just in case
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        const host = req.headers.host || 'localhost';
        const parsedUrl = new URL(req.url, `http://${host}`);
        let pathname = parsedUrl.pathname;

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
        try {
            const blockedList = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'));
            if (clientIp && blockedList.includes(clientIp)) {
                res.writeHead(403);
                return res.end("You're banned from getting access to the Question Bank.");
            }
        } catch(e) {}


    if (pathname === '/health') {
        res.writeHead(200);
        return res.end('OK');
    }

    if (req.method === 'POST' && pathname === '/api/register') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const blockedList = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'));
                if (blockedList.includes(data.username)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Banned' }));
                }
                const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
                if (users.find(u => u.username === data.username)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Username already exists' }));
                }
                const registrationClientDetails = sanitizeClientDetails(data.clientDetails);
                const registrationClientSummary = summarizeClientDetails(data.clientDetails);
                const newUser = {
                    username: data.username,
                    password: data.password,
                    createdAt: new Date().toISOString(),
                    lastOnline: Date.now(),
                    ip: clientIp,
                    devices: [],
                    pendingDevices: [],
                    registrationClientDetails,
                    registrationClientSummary,
                    securityEvents: []
                };
                recordSecurityEvent(newUser, 'registration_submitted', {
                    ip: clientIp,
                    deviceId: normalizeDeviceId(data.deviceId),
                    clientSummary: registrationClientSummary
                });
                updateUserActivity(newUser, clientIp);
                users.push(newUser);
                fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                sendTelegramRegistrationNotification(newUser);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                res.writeHead(400); res.end('Invalid request');
            }
        });
        return;
    }

    if (req.method === 'POST' && (pathname === '/api/login' || pathname === '/api/heartbeat')) {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const blockedList = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'));
                if (blockedList.includes(data.username)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Banned' }));
                }
                const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));

                if (pathname === '/api/heartbeat') {
                    const sessionCheck = verifyActiveProtectedSession(users, data.username, data.token, data.sessionId, data.deviceId, clientIp, req);
                    if (!sessionCheck.ok) {
                        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                        res.writeHead(sessionCheck.status, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: sessionCheck.error }));
                    }

                    if (sessionCheck.device) {
                        Object.assign(sessionCheck.device, buildDeviceRecord(data.deviceId, clientIp, req, data, sessionCheck.device));
                    }
                    if (sessionCheck.user.activeSession) {
                        sessionCheck.user.activeSession.clientDetails = sanitizeClientDetails(data.clientDetails);
                        sessionCheck.user.activeSession.clientSummary = summarizeClientDetails(data.clientDetails);
                    }
                    updateUserActivity(sessionCheck.user, clientIp);
                    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, active: true }));
                }

                const user = users.find(u => u.username === data.username && u.password === data.password);

                if (!user) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Invalid credentials or expired session' }));
                }

                const accessCheck = verifyUserAccess(user, clientIp, req, data.deviceId, data);
                if (!accessCheck.ok) {
                    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                    res.writeHead(accessCheck.status, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: accessCheck.error }));
                }

                if (data.silentRefresh) {
                    const sessionCheck = verifyActiveProtectedSession(users, data.username, data.token, data.sessionId, data.deviceId, clientIp, req);
                    if (!sessionCheck.ok) {
                        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                        res.writeHead(sessionCheck.status, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: sessionCheck.error }));
                    }

                    updateUserActivity(sessionCheck.user, clientIp);
                    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        success: true,
                        token: sessionCheck.user.activeSession.token,
                        sessionId: sessionCheck.user.activeSession.id,
                        heartbeatMs: ACTIVE_SESSION_HEARTBEAT_MS
                    }));
                }

                updateUserActivity(user, clientIp);
                const activeSession = createActiveSession(user, data, clientIp, req);
                const shouldLogLogin = data.pdfVersion;

                if (shouldLogLogin) {
                    appendAccessLog({
                        username: data.username,
                        pdfVersion: data.pdfVersion,
                        ip: clientIp,
                        action: 'login',
                        deviceId: normalizeDeviceId(data.deviceId),
                        clientSummary: summarizeClientDetails(data.clientDetails)
                    });
                }
                fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    token: activeSession.token,
                    sessionId: activeSession.id,
                    heartbeatMs: ACTIVE_SESSION_HEARTBEAT_MS
                }));
            } catch (err) {
                res.writeHead(400); res.end('Invalid request');
            }
        });
        return;
    }

    if (req.method === 'GET' && pathname === '/api/announcement') {
        const username = parsedUrl.searchParams.get('user');
        const token = parsedUrl.searchParams.get('token');
        const deviceId = parsedUrl.searchParams.get('deviceId');
        const sessionId = parsedUrl.searchParams.get('sessionId');
        const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        const sessionCheck = verifyActiveProtectedSession(users, username, token, sessionId, deviceId, clientIp, req);

        if (!sessionCheck.ok) {
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
            res.writeHead(sessionCheck.status, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: sessionCheck.error }));
        }

        const user = sessionCheck.user;
        updateUserActivity(user, clientIp);
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            announcement: userHasDismissedAnnouncement(user, ACTIVE_ANNOUNCEMENT.id) ? null : ACTIVE_ANNOUNCEMENT
        }));
        return;
    }

    if (req.method === 'POST' && pathname === '/api/announcement/dismiss') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
                const sessionCheck = verifyActiveProtectedSession(users, data.username, data.token, data.sessionId, data.deviceId, clientIp, req);

                if (!sessionCheck.ok) {
                    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                    res.writeHead(sessionCheck.status, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: sessionCheck.error }));
                }

                const user = sessionCheck.user;
                dismissAnnouncementForUser(user, data.announcementId || ACTIVE_ANNOUNCEMENT.id);
                updateUserActivity(user, clientIp);
                fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
            }
        });
        return;
    }

    if (req.method === 'POST' && pathname === '/api/presence/close') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = body ? JSON.parse(body) : {};
                const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
                const sessionCheck = verifyActiveProtectedSession(users, data.username, data.token, data.sessionId, data.deviceId, clientIp, req);

                if (!sessionCheck.ok) {
                    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                    res.writeHead(sessionCheck.status, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: sessionCheck.error }));
                }

                const user = sessionCheck.user;
                const clearedActiveSession = clearActiveSessionIfCurrent(user, data.token, data.sessionId, data.deviceId);
                updateUserActivity(user, clientIp);
                fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                appendAccessLog({
                    username: data.username,
                    pdfVersion: data.pdfVersion || null,
                    ip: clientIp,
                    action: 'viewer_closed'
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, clearedActiveSession }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
            }
        });
        return;
    }

    if (req.method === 'GET' && pathname === '/api/annotations') {
        const user = parsedUrl.searchParams.get('user');
        const file = parsedUrl.searchParams.get('file');
        const token = parsedUrl.searchParams.get('token');
        const deviceId = parsedUrl.searchParams.get('deviceId');
        const sessionId = parsedUrl.searchParams.get('sessionId');

        const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        const sessionCheck = verifyActiveProtectedSession(users, user, token, sessionId, deviceId, clientIp, req);
        if (!sessionCheck.ok) {
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
            res.writeHead(sessionCheck.status); return res.end(sessionCheck.error);
        }

        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        const annPath = getAnnotationPath(user, file);
        const annotations = readAnnotationMapFromPath(annPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(annotations));
        return;
    }

    if (req.method === 'POST' && pathname === '/api/annotations') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
                const sessionCheck = verifyActiveProtectedSession(users, data.user, data.token, data.sessionId, data.deviceId, clientIp, req);
                if (!sessionCheck.ok) {
                    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                    res.writeHead(sessionCheck.status); return res.end(sessionCheck.error);
                }

                fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                const annPath = getAnnotationPath(data.user, data.file);
                const annotations = readAnnotationMapFromPath(annPath);

                annotations[data.page] = data.dataUrl;
                fs.writeFileSync(annPath, JSON.stringify(annotations));
                res.writeHead(200); res.end();
            } catch(e) {
                res.writeHead(500); res.end();
            }
        });
        return;
    }

    if (req.method === 'GET' && pathname === '/api/admin') {
        const pwd = parsedUrl.searchParams.get('pwd');
        const adminPassword = getAdminPassword();

        if (pwd !== adminPassword) {
            res.writeHead(401);
            return res.end('Unauthorized');
        }

        try {
            const dbData = fs.readFileSync(DB_FILE, 'utf8');
            const blockedData = fs.readFileSync(BLOCKED_FILE, 'utf8');
            const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            users.forEach(user => ensureSecurityFields(user));
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                database: JSON.parse(dbData),
                blocked: JSON.parse(blockedData),
                users,
                maxDevicesPerUser: MAX_DEVICES_PER_USER,
                annotations: listAnnotationSummaries(users)
            }));
        } catch(e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Database read error' }));
        }
        return;
    }


    if (req.method === 'POST' && pathname === '/api/admin/user/device/approve') {
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
                users.forEach(user => ensureSecurityFields(user));
                const result = approvePendingDevice(users, data.username, data.deviceId, 'admin', clientIp);

                if (!result.success) {
                    res.writeHead(result.status, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: result.error }));
                }

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

    if (req.method === 'POST' && pathname === '/api/admin/user/device/reject') {
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
                users.forEach(user => ensureSecurityFields(user));
                const result = rejectPendingDevice(users, data.username, data.deviceId, 'admin', clientIp);

                if (!result.success) {
                    res.writeHead(result.status, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: result.error }));
                }

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
                users.forEach(user => ensureSecurityFields(user));
                const user = users.find(u => u.username === data.username);

                if (!user) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'User not found' }));
                }

                user.devices = [];
                user.pendingDevices = [];
                user.activeSession = null;
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

    if (req.method === 'GET' && pathname === '/api/admin/annotations') {
        const pwd = parsedUrl.searchParams.get('pwd');
        const user = parsedUrl.searchParams.get('user');
        const file = parsedUrl.searchParams.get('file');
        const adminPassword = getAdminPassword();

        if (pwd !== adminPassword) {
            res.writeHead(401);
            return res.end('Unauthorized');
        }

        if (!user || !file) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing annotation target' }));
        }

        try {
            const annotationMap = readAnnotationMapFromPath(getAnnotationPath(user, file));
            const pages = Object.keys(annotationMap)
                .map(page => Number(page))
                .filter(page => Number.isFinite(page))
                .sort((a, b) => a - b)
                .map(page => ({
                    page,
                    dataUrl: annotationMap[String(page)]
                }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ user, file, pages }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Annotation read error' }));
        }
        return;
    }

    if (req.method === 'DELETE' && pathname === '/api/admin/logs') {
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
                const data = JSON.parse(body || '{}');
                const logsToDelete = Array.isArray(data.logs) ? data.logs : [];
                if (!logsToDelete.length || logsToDelete.length > 1000) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Invalid logs payload' }));
                }

                const targets = logsToDelete
                    .filter(log => log && typeof log.timestamp === 'string' && typeof log.username === 'string')
                    .map(log => ({
                        timestamp: log.timestamp,
                        username: log.username,
                        pdfVersion: Object.prototype.hasOwnProperty.call(log, 'pdfVersion') ? log.pdfVersion : undefined,
                        action: Object.prototype.hasOwnProperty.call(log, 'action') ? log.action : undefined
                    }));

                if (!targets.length) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'No valid logs selected' }));
                }

                const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
                let deletedCount = 0;
                const remainingLogs = dbData.filter(log => {
                    const targetIndex = targets.findIndex(target =>
                        log.timestamp === target.timestamp &&
                        log.username === target.username &&
                        (target.pdfVersion === undefined || (log.pdfVersion || null) === target.pdfVersion) &&
                        (target.action === undefined || (log.action || 'access') === target.action)
                    );

                    if (targetIndex === -1) return true;
                    targets.splice(targetIndex, 1);
                    deletedCount += 1;
                    return false;
                });

                fs.writeFileSync(DB_FILE, JSON.stringify(remainingLogs, null, 2));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, deletedCount }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Database write error' }));
            }
        });
        return;
    }

    if (req.method === 'DELETE' && pathname === '/api/admin/users') {
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
                const data = JSON.parse(body || '{}');
                const usernames = Array.isArray(data.usernames) ? data.usernames.filter(username => typeof username === 'string' && username.trim()) : [];
                if (!usernames.length || usernames.length > 500) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Invalid users payload' }));
                }

                const selected = new Set(usernames);
                const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
                const remainingUsers = users.filter(user => !selected.has(user.username));
                const deletedCount = users.length - remainingUsers.length;

                fs.writeFileSync(USERS_FILE, JSON.stringify(remainingUsers, null, 2));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, deletedCount }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Users write error' }));
            }
        });
        return;
    }

    if (req.method === 'DELETE' && pathname === '/api/admin/annotations') {
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
                const data = JSON.parse(body || '{}');
                const annotations = Array.isArray(data.annotations) ? data.annotations : [];
                if (!annotations.length || annotations.length > 500) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Invalid annotations payload' }));
                }

                let deletedCount = 0;
                annotations.forEach(annotation => {
                    if (!annotation || typeof annotation.user !== 'string' || typeof annotation.file !== 'string') return;
                    const annotationPath = getAnnotationPath(annotation.user, annotation.file);
                    if (fs.existsSync(annotationPath)) {
                        fs.unlinkSync(annotationPath);
                        deletedCount += 1;
                    }
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, deletedCount }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Annotation delete error' }));
            }
        });
        return;
    }

    if (req.method === 'DELETE' && pathname === '/api/admin') {
        const pwd = parsedUrl.searchParams.get('pwd');
        const timestamp = parsedUrl.searchParams.get('timestamp');
        const username = parsedUrl.searchParams.get('username');
        const adminPassword = getAdminPassword();
        
        if (pwd !== adminPassword) {
            res.writeHead(401);
            return res.end('Unauthorized');
        }

        try {
            let dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            const initialLength = dbData.length;
            dbData = dbData.filter(log => !(log.timestamp === timestamp && log.username === username));
            
            if (dbData.length !== initialLength) {
                fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Record not found' }));
            }
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Database write error' }));
        }
        return;
    }

    if (req.method === 'POST' && pathname === '/api/admin/ban') {
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
                let blocked = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'));
                let updated = false;

                if (data.username) {
                    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
                    const u = users.find(usr => usr.username === data.username);
                    if (u && u.ip && !blocked.includes(u.ip)) {
                        blocked.push(u.ip);
                        updated = true;
                    }
                    if (!blocked.includes(data.username)) {
                        blocked.push(data.username);
                        updated = true;
                    }
                }

                if (updated) {
                    fs.writeFileSync(BLOCKED_FILE, JSON.stringify(blocked, null, 2));
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch(e) {
                res.writeHead(500); res.end();
            }
        });
        return;
    }

    if (req.method === 'DELETE' && pathname === '/api/admin/ban') {
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
                let blocked = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'));
                if (data.identifier) {
                    blocked = blocked.filter(b => b !== data.identifier);
                    // if it was a username, also unban their associated IP
                    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
                    const u = users.find(usr => usr.username === data.identifier);
                    if (u && u.ip) {
                        blocked = blocked.filter(b => b !== u.ip);
                    }
                    fs.writeFileSync(BLOCKED_FILE, JSON.stringify(blocked, null, 2));
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch(e) {
                res.writeHead(500); res.end();
            }
        });
        return;
    }

    if (req.method === 'DELETE' && pathname === '/api/admin/user') {
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
                if (data.username) {
                    let users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
                    const filteredUsers = users.filter(u => u.username !== data.username);
                    fs.writeFileSync(USERS_FILE, JSON.stringify(filteredUsers, null, 2));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(400); res.end('Bad Request');
                }
            } catch(e) {
                res.writeHead(500); res.end();
            }
        });
        return;
    }

    if (req.method === 'GET' && pathname === '/api/document') {
        const file = parsedUrl.searchParams.get('file');
        const user = parsedUrl.searchParams.get('user');
        const token = parsedUrl.searchParams.get('token');
        const deviceId = parsedUrl.searchParams.get('deviceId');
        const sessionId = parsedUrl.searchParams.get('sessionId');

        if (!file || !user || !token || !sessionId) {
            res.writeHead(401);
            return res.end('Unauthorized: Missing session credentials');
        }

        try {
            const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            const sessionCheck = verifyActiveProtectedSession(users, user, token, sessionId, deviceId, clientIp, req);

            if (!sessionCheck.ok) {
                fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                res.writeHead(sessionCheck.status);
                return res.end(sessionCheck.error);
            }

            const userData = sessionCheck.user;
            const blockedUsers = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'));
            if (blockedUsers.includes(user) || (userData.ip && blockedUsers.includes(userData.ip))) {
                res.writeHead(403);
                return res.end("You're banned from getting access to the Question Bank.");
            }

            // Update user status
            updateUserActivity(userData, clientIp);
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

            // Log access to DB_FILE
            appendAccessLog({
                username: user,
                pdfVersion: file,
                ip: clientIp,
                action: 'open_document',
                deviceId,
                clientSummary: userData.activeSession ? userData.activeSession.clientSummary : null
            });

        } catch(e) {
            console.error('Auth check error:', e);
            res.writeHead(500);
            return res.end('Internal Server Error');
        }

        // Secure file path resolving
        const safeFilePath = path.join(__dirname, 'PDF', path.basename(file));
        
        fs.readFile(safeFilePath, (err, content) => {
            if (err) {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(200, { 'Content-Type': 'application/pdf' });
                res.end(content);
            }
        });
        return;
    }

    if (pathname.toLowerCase().startsWith('/pdf/')) {
        res.writeHead(403);
        return res.end('Direct access to PDF directory is forbidden. Use the secure viewer.');
    }

    // Serve static files
    if (pathname === '/admin') {
        pathname = '/admin.html';
    }
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    
    // Decode URI component for files like PDFs with spaces
    filePath = decodeURIComponent(filePath);

    const extname = path.extname(filePath);
    let contentType = 'text/html';
    switch (extname) {
        case '.js': contentType = 'text/javascript'; break;
        case '.css': contentType = 'text/css'; break;
        case '.json': contentType = 'application/json'; break;
        case '.png': contentType = 'image/png'; break;
        case '.jpg': contentType = 'image/jpg'; break;
        case '.pdf': contentType = 'application/pdf'; break;
    }

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${err.code}`);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });

    } catch (routeErr) {
        console.error('[ERROR] Runtime Crash in route:', req.url, routeErr);
        res.writeHead(500);
        res.end('Internal Server Error');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Database logs saved to: ${DB_FILE}`);
});

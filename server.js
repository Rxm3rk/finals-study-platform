const http = require('http');
const fs = require('fs');
const path = require('path');

// Global crash handlers to prevent silent Railway deaths
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});


const PORT = process.env.PORT || 3000;
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
const MAX_APPROVED_USERS = 19;
const MAX_DEVICES_PER_USER = 2;

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
    dbData.push({
        timestamp: new Date().toISOString(),
        ...entry
    });
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
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

function isUserApproved(user) {
    return user.approved !== false;
}

function ensureSecurityFields(user, defaultApproved = true) {
    if (typeof user.approved !== 'boolean') {
        user.approved = defaultApproved;
    }
    if (!Object.prototype.hasOwnProperty.call(user, 'approvedAt')) {
        user.approvedAt = user.approved ? (user.createdAt || null) : null;
    }
    if (!Object.prototype.hasOwnProperty.call(user, 'approvedBy')) {
        user.approvedBy = user.approved ? 'legacy' : null;
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
    return users.filter(user => isUserApproved(user)).length;
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

function verifyProtectedSession(users, username, token, deviceId, clientIp, req) {
    const user = findUserBySession(users, username, token);
    if (!user) {
        return { ok: false, status: 401, error: 'Invalid session' };
    }

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

    return { ok: true, user };
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
                updateUserActivity(newUser, clientIp);
                users.push(newUser);
                fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
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
                const user = users.find(u => u.username === data.username && (u.password === data.password || u.token === data.token));
                
                if (!user) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Invalid credentials or expired session' }));
                }

                const accessCheck = verifyUserAccess(user, clientIp, req, data.deviceId);
                if (!accessCheck.ok) {
                    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                    res.writeHead(accessCheck.status, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: accessCheck.error }));
                }

                updateUserActivity(user, clientIp);

                if (pathname === '/api/login') {
                    // Generate a new session token on each fresh login to prevent concurrent sharing
                    user.token = require('crypto').randomBytes(16).toString('hex');
                    const shouldLogLogin = data.pdfVersion && !data.silentRefresh;

                    if (shouldLogLogin) {
                        appendAccessLog({
                            username: data.username,
                            pdfVersion: data.pdfVersion,
                            ip: clientIp,
                            action: 'login'
                        });
                    }
                    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, token: user.token }));
                } else {
                    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                }
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
        const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        const sessionCheck = verifyProtectedSession(users, username, token, deviceId, clientIp, req);

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
                const sessionCheck = verifyProtectedSession(users, data.username, data.token, data.deviceId, clientIp, req);

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
                const sessionCheck = verifyProtectedSession(users, data.username, data.token, data.deviceId, clientIp, req);

                if (!sessionCheck.ok) {
                    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                    res.writeHead(sessionCheck.status, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: sessionCheck.error }));
                }

                const user = sessionCheck.user;
                updateUserActivity(user, clientIp);
                fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                appendAccessLog({
                    username: data.username,
                    pdfVersion: data.pdfVersion || null,
                    ip: clientIp,
                    action: 'viewer_closed'
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
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

        const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        const sessionCheck = verifyProtectedSession(users, user, token, deviceId, clientIp, req);
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
                const sessionCheck = verifyProtectedSession(users, data.user, data.token, data.deviceId, clientIp, req);
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
                approvedUserCount: countApprovedUsers(users),
                maxApprovedUsers: MAX_APPROVED_USERS,
                maxDevicesPerUser: MAX_DEVICES_PER_USER,
                annotations: listAnnotationSummaries(users)
            }));
        } catch(e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Database read error' }));
        }
        return;
    }

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
                users.forEach(user => ensureSecurityFields(user, user.username === data.username ? false : true));
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

    if (req.method === 'DELETE' && pathname === '/api/admin') {
        const pwd = parsedUrl.searchParams.get('pwd');
        const timestamp = parsedUrl.searchParams.get('timestamp');
        const username = parsedUrl.searchParams.get('username');
        const adminPassword = process.env.ADMIN_PASSWORD || 'rxm3rk_admin';
        
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
        const adminPassword = process.env.ADMIN_PASSWORD || 'rxm3rk_admin';
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
        const adminPassword = process.env.ADMIN_PASSWORD || 'rxm3rk_admin';
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
        const adminPassword = process.env.ADMIN_PASSWORD || 'rxm3rk_admin';
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

        if (!file || !user || !token) {
            res.writeHead(401);
            return res.end('Unauthorized: Missing session credentials');
        }

        try {
            const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            const sessionCheck = verifyProtectedSession(users, user, token, deviceId, clientIp, req);

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
                action: 'open_document'
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

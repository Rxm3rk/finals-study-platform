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

const server = http.createServer((req, res) => {
    try {
        // CORS headers just in case
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        const host = req.headers.host || 'localhost';
        const parsedUrl = new URL(req.url, `http://${host}`);
        let pathname = parsedUrl.pathname;


    if (pathname === '/health') {
        res.writeHead(200);
        return res.end('OK');
    }

    if (req.method === 'POST' && pathname === '/api/login') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
                
                dbData.push({
                    username: data.username,
                    pdfVersion: data.pdfVersion,
                    timestamp: new Date().toISOString()
                });
                
                fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Saved to database' }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
            }
        });
        return;
    }

    if (req.method === 'GET' && pathname === '/api/admin') {
        const pwd = parsedUrl.searchParams.get('pwd');
        const adminPassword = process.env.ADMIN_PASSWORD || 'rxm3rk_admin';
        
        if (pwd !== adminPassword) {
            res.writeHead(401);
            return res.end('Unauthorized');
        }

        try {
            const dbData = fs.readFileSync(DB_FILE, 'utf8');
            const blockedData = fs.readFileSync(BLOCKED_FILE, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                database: JSON.parse(dbData), 
                blocked: JSON.parse(blockedData) 
            }));
        } catch(e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Database read error' }));
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

    if (req.method === 'GET' && pathname === '/api/document') {
        const file = parsedUrl.searchParams.get('file');
        const user = parsedUrl.searchParams.get('user');

        if (!file || !user) {
            res.writeHead(400);
            return res.end('Missing file or user parameters');
        }

        try {
            const blockedUsers = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'));
            if (blockedUsers.includes(user)) {
                res.writeHead(403);
                return res.end('Access Denied: User is blocked.');
            }
        } catch(e) {
            console.error('Blocked JSON parse error:', e);
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

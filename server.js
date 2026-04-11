const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// Initialize DB if not exists
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
}

const server = http.createServer((req, res) => {
    // CORS headers just in case
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    const BLOCKED_FILE = path.join(__dirname, 'blocked.json');
    if (!fs.existsSync(BLOCKED_FILE)) {
        fs.writeFileSync(BLOCKED_FILE, JSON.stringify([], null, 2));
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    let pathname = parsedUrl.pathname;

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
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`Database logs saved to: ${DB_FILE}`);
});

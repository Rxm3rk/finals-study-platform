const fs = require('fs');
const https = require('https');

const adminPwd = process.env.ADMIN_PASSWORD || 'rxm3rk_admin';
const defaultUrl = 'https://stage5.up.railway.app/api/admin?pwd=' + encodeURIComponent(adminPwd);
const targetUrl = process.argv[2] || defaultUrl;

console.log("Fetching live database from production...");

https.get(targetUrl, (res) => {
    let data = '';

    if (res.statusCode !== 200) {
        console.error(`Status Code: ${res.statusCode} - Authorization Failed or Service Down.`);
        process.exit(1);
    }

    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const parsed = JSON.parse(data);
            
            if (parsed.database) {
                fs.writeFileSync('database.json', JSON.stringify(parsed.database, null, 2));
                console.log(`Saved ${parsed.database.length} access logs to database.json`);
            }
            if (parsed.blocked) {
                fs.writeFileSync('blocked.json', JSON.stringify(parsed.blocked, null, 2));
                console.log(`Saved ${parsed.blocked.length} blocked users to blocked.json`);
            }
            console.log("Successfully backed up production data locally! Safe to push to Git.");
        } catch(e) {
            console.error("Backup failed parsing. Deploy aborted.", e);
            process.exit(1);
        }
    });
}).on('error', (err) => {
    console.error("Connection failed. Is the server running?", err);
    process.exit(1);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const { execFile } = require('child_process');
const path = require('path');

const NATIVE_MODE = process.env.NATIVE_MODE === '1';
const MATTING_URL = process.env.MATTING_URL || 'http://localhost:8000';

/** Prefer IPv4 loopback for health checks — Node may resolve `localhost` to ::1 while the
 *  matting service only listens on IPv4, which falsely reports the service as down. */
function mattingHealthCheckUrl() {
    try {
        const u = new URL(MATTING_URL);
        if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
        u.pathname = '/openapi.json';
        u.search = '';
        return u.toString();
    } catch {
        return 'http://127.0.0.1:8000/openapi.json';
    }
}

let docker = null;
if (!NATIVE_MODE) {
    try {
        const Docker = require('dockerode');
        docker = new Docker({ socketPath: '/var/run/docker.sock' });
    } catch {}
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const BOT_WS_URL = process.env.BOT_WS_URL || 'http://sticker-bot:3001';
const COMPOSE_FILE = process.env.COMPOSE_FILE || '/app/docker-compose.yml';
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || 'sticker-maker';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let botState = 'initializing';
let lastQr = null;

async function refreshBotStateFromHttp() {
    try {
        const r = await fetch(`${BOT_WS_URL}/status`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const data = await r.json();
        if (data && typeof data.state === 'string') {
            botState = data.state;
            lastQr = data.qr != null ? data.qr : null;
        }
    } catch {
        /* keep cached bridge state */
    }
}

// --------------- Bot bridge via Socket.IO client ---------------

let botSocket = null;

function connectToBot() {
    if (botSocket) botSocket.disconnect();
    botSocket = ioClient(BOT_WS_URL, { reconnection: true, reconnectionDelay: 2000 });

    botSocket.on('connect', async () => {
        console.log('[Bridge] Connected to sticker-bot event server');
        try {
            const res = await fetch(`${BOT_WS_URL}/status`);
            const data = await res.json();
            botState = data.state;
            lastQr = data.qr != null ? data.qr : null;
            io.emit('status', { state: botState, qr: botState === 'qr' ? lastQr : null });
        } catch {}
    });

    botSocket.on('status', (payload) => {
        if (!payload || typeof payload.state !== 'string') return;
        botState = payload.state;
        lastQr = payload.qr != null ? payload.qr : null;
        io.emit('status', { state: botState, qr: botState === 'qr' ? lastQr : null });
    });

    botSocket.on('qr', (qr) => {
        botState = 'qr';
        lastQr = qr;
        io.emit('qr', qr);
        io.emit('status', { state: 'qr', qr });
    });

    botSocket.on('authenticated', () => {
        io.emit('authenticated');
    });

    botSocket.on('ready', () => {
        botState = 'ready';
        lastQr = null;
        io.emit('ready');
        io.emit('status', { state: 'ready', qr: null });
    });

    botSocket.on('disconnected', (reason) => {
        botState = 'disconnected';
        lastQr = null;
        io.emit('disconnected', reason);
        io.emit('status', { state: 'disconnected', qr: null });
    });

    botSocket.on('request', (data) => {
        io.emit('request', data);
    });

    botSocket.on('request:update', (data) => {
        io.emit('request:update', data);
    });

    botSocket.on('disconnect', () => {
        console.log('[Bridge] Lost connection to sticker-bot, will reconnect...');
    });
}

connectToBot();

// --------------- REST API ---------------

app.get('/api/status', async (_req, res) => {
    await refreshBotStateFromHttp();

    let gpuStatus = 'not_created';

    if (docker) {
        try {
            const container = docker.getContainer('video-matting-api');
            const info = await container.inspect();
            gpuStatus = info.State.Running ? 'running' : 'stopped';
        } catch {}
    } else {
        try {
            const r = await fetch(mattingHealthCheckUrl(), { signal: AbortSignal.timeout(8000) });
            gpuStatus = r.ok ? 'running' : 'stopped';
        } catch {
            gpuStatus = 'not_running';
        }
    }

    res.json({
        bot: {
            state: botState,
            qr: botState === 'qr' ? lastQr : null,
        },
        gpu: { status: gpuStatus },
        nativeMode: NATIVE_MODE,
    });
});

function runCompose(args) {
    return new Promise((resolve, reject) => {
        const allArgs = [
            'compose',
            '-f', COMPOSE_FILE,
            '-p', COMPOSE_PROJECT,
            ...args
        ];
        execFile('docker', allArgs, { timeout: 120000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            resolve(stdout);
        });
    });
}

app.post('/api/gpu/start', async (_req, res) => {
    if (NATIVE_MODE) return res.status(400).json({ success: false, error: 'GPU service is managed externally in native mode' });
    try {
        await runCompose(['--profile', 'gpu', 'up', '-d', 'video-matting']);
        res.json({ success: true, status: 'running' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/gpu/stop', async (_req, res) => {
    if (NATIVE_MODE) return res.status(400).json({ success: false, error: 'GPU service is managed externally in native mode' });
    try {
        await runCompose(['stop', 'video-matting']);
        res.json({ success: true, status: 'stopped' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/logout', async (_req, res) => {
    try {
        const response = await fetch(`${BOT_WS_URL}/logout`, { method: 'POST' });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------- Whitelist proxy routes ---------------

app.get('/api/whitelist', async (_req, res) => {
    try {
        const r = await fetch(`${BOT_WS_URL}/whitelist`);
        res.json(await r.json());
    } catch (err) { res.status(502).json({ error: err.message }); }
});

app.put('/api/whitelist/enabled', async (req, res) => {
    try {
        const r = await fetch(`${BOT_WS_URL}/whitelist/enabled`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        res.json(await r.json());
    } catch (err) { res.status(502).json({ error: err.message }); }
});

app.post('/api/whitelist/entry', async (req, res) => {
    try {
        const r = await fetch(`${BOT_WS_URL}/whitelist/entry`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        res.json(await r.json());
    } catch (err) { res.status(502).json({ error: err.message }); }
});

app.delete('/api/whitelist/entry/:chatId', async (req, res) => {
    try {
        const r = await fetch(`${BOT_WS_URL}/whitelist/entry/${encodeURIComponent(req.params.chatId)}`, { method: 'DELETE' });
        res.json(await r.json());
    } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get('/api/contacts', async (_req, res) => {
    try {
        const r = await fetch(`${BOT_WS_URL}/contacts`);
        res.json(await r.json());
    } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get('/api/groups', async (_req, res) => {
    try {
        const r = await fetch(`${BOT_WS_URL}/groups`);
        res.json(await r.json());
    } catch (err) { res.status(502).json({ error: err.message }); }
});

// --------------- Request history proxy ---------------

app.get('/api/history', async (_req, res) => {
    try {
        const r = await fetch(`${BOT_WS_URL}/history`);
        res.json(await r.json());
    } catch (err) { res.status(502).json({ error: err.message }); }
});

// --------------- Socket.IO: send current state to new browsers ---------------

io.on('connection', async (socket) => {
    await refreshBotStateFromHttp();
    socket.emit('status', {
        state: botState,
        qr: botState === 'qr' ? lastQr : null,
    });
});

// --------------- Start ---------------

server.listen(3000, () => {
    console.log('[GUI] Dashboard available at http://localhost:3000');
});

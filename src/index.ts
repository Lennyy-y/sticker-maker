import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import sharp from 'sharp';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, readdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
const execAsync = promisify(exec);
const MATTING_URL = process.env.MATTING_API_URL || 'http://localhost:8000';

// ============================================================
// TASK QUEUE — limits concurrent sticker processing
// ============================================================

class TaskQueue {
    private running = 0;
    private waiting: (() => void)[] = [];
    constructor(private concurrency: number) {}
    async run<T>(fn: () => Promise<T>): Promise<T> {
        while (this.running >= this.concurrency)
            await new Promise<void>(resolve => this.waiting.push(resolve));
        this.running++;
        try { return await fn(); }
        finally { this.running--; this.waiting.shift()?.(); }
    }
    get pending() { return this.waiting.length; }
    get active() { return this.running; }
}

const stickerQueue = new TaskQueue(3);
const mattingQueue = new TaskQueue(1);

// ============================================================
// REQUEST HISTORY — in-memory ring buffer (last 50)
// ============================================================

interface RequestRecord {
    id: string;
    from: string;
    chatName: string;
    flags: string;
    mediaType: string;
    timestamp: number;
    status: 'queued' | 'processing' | 'done' | 'error';
}

const requestHistory: RequestRecord[] = [];
const MAX_HISTORY = 50;

function pushRequest(record: RequestRecord) {
    requestHistory.unshift(record);
    if (requestHistory.length > MAX_HISTORY) requestHistory.pop();
}

// ============================================================
// WHITELIST (JSON file + in-memory Set for O(1) lookup)
// ============================================================

interface WhitelistEntry { chat_id: string; name: string; type: 'contact' | 'group'; }
interface WhitelistData { enabled: boolean; entries: WhitelistEntry[]; }

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const WL_PATH = path.join(DATA_DIR, 'whitelist.json');

function loadWhitelistData(): WhitelistData {
    try {
        return JSON.parse(readFileSync(WL_PATH, 'utf-8'));
    } catch {
        return { enabled: false, entries: [] };
    }
}

function saveWhitelistData(data: WhitelistData) {
    writeFileSync(WL_PATH, JSON.stringify(data, null, 2));
}

const wlData = loadWhitelistData();
let whitelistEnabled = wlData.enabled;
const whitelistSet = new Set<string>(wlData.entries.map(e => e.chat_id));
console.log(`[Whitelist] Loaded: enabled=${whitelistEnabled}, ${whitelistSet.size} entries`);

// ============================================================
// Animated WebP builder — uses sharp-encoded frames (same libwebp
// that makes static borderless images work) and hand-assembles the
// RIFF container so every flag is guaranteed correct.
// ============================================================

function extractWebpBitstream(webpBuf: Buffer): Buffer {
    let offset = 12; // skip RIFF header
    const chunks: Buffer[] = [];
    while (offset + 8 <= webpBuf.length) {
        const fourCC = webpBuf.toString('ascii', offset, offset + 4);
        const chunkSize = webpBuf.readUInt32LE(offset + 4);
        const paddedSize = chunkSize + (chunkSize % 2);
        if (fourCC === 'VP8 ' || fourCC === 'VP8L' || fourCC === 'ALPH') {
            chunks.push(webpBuf.subarray(offset, offset + 8 + paddedSize));
        }
        offset += 8 + paddedSize;
    }
    return Buffer.concat(chunks);
}

function buildAnimatedWebp(
    frames: { webpBuf: Buffer; durationMs: number }[],
    canvasWidth: number,
    canvasHeight: number,
    hasAlpha: boolean = true,
): Buffer {
    const vp8xFlags = 0x02 | (hasAlpha ? 0x10 : 0x00);
    const vp8xPayload = Buffer.alloc(10);
    vp8xPayload[0] = vp8xFlags;
    vp8xPayload.writeUIntLE(canvasWidth - 1, 4, 3);
    vp8xPayload.writeUIntLE(canvasHeight - 1, 7, 3);

    // ANIM: transparent bg for alpha, white bg for opaque; infinite loop
    const animPayload = Buffer.alloc(6);
    animPayload.writeUInt32LE(hasAlpha ? 0x00000000 : 0xFFFFFFFF, 0);
    animPayload.writeUInt16LE(0, 4);

    const anmfChunks: Buffer[] = [];
    for (const frame of frames) {
        const bitstream = extractWebpBitstream(frame.webpBuf);
        const anmfDataSize = 16 + bitstream.length;
        const anmfData = Buffer.alloc(16);
        anmfData.writeUIntLE(0, 0, 3);                          // x offset
        anmfData.writeUIntLE(0, 3, 3);                          // y offset
        anmfData.writeUIntLE(canvasWidth - 1, 6, 3);            // frame width - 1
        anmfData.writeUIntLE(canvasHeight - 1, 9, 3);           // frame height - 1
        anmfData.writeUIntLE(frame.durationMs, 12, 3);          // duration
        anmfData[15] = 0x02; // dispose=0 (none), blend=1 (do not blend / overwrite)

        const anmfHdr = Buffer.alloc(8);
        anmfHdr.write('ANMF', 0, 4, 'ascii');
        anmfHdr.writeUInt32LE(anmfDataSize, 4);

        anmfChunks.push(anmfHdr, anmfData, bitstream);
        if (anmfDataSize % 2 !== 0) anmfChunks.push(Buffer.alloc(1));
    }

    const vp8xHdr = Buffer.from('VP8X\x0a\x00\x00\x00');
    const animHdr = Buffer.from('ANIM\x06\x00\x00\x00');
    const body = Buffer.concat([vp8xHdr, vp8xPayload, animHdr, animPayload, ...anmfChunks]);

    const riffHdr = Buffer.alloc(12);
    riffHdr.write('RIFF', 0, 4, 'ascii');
    riffHdr.writeUInt32LE(4 + body.length, 4);
    riffHdr.write('WEBP', 8, 4, 'ascii');

    return Buffer.concat([riffHdr, body]);
}

// ============================================================
// UTILITY: Text rendering helpers
// ============================================================

/** Uses Puppeteer to render a 512x512 transparent PNG containing the top and bottom text.
 *  This naturally supports emojis, complex text wrapping, and non-latin text perfectly. */
async function buildTextOverlayImage(browser: any, topText: string, bottomText: string, timestamp: number): Promise<string> {
    const page = await browser.newPage();
    const safeTop = topText.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    const safeBottom = bottomText.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    
    const fontObj = readFileSync('/usr/src/app/Anton-Regular.ttf');
    const b64 = fontObj.toString('base64');

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
    <style>
        @font-face { font-family: 'Anton'; src: url('data:font/ttf;base64,${b64}'); }
        body {
            margin: 0; padding: 0;
            width: 512px; height: 512px;
            background: transparent;
            font-family: 'Anton', 'Noto Color Emoji', sans-serif;
            font-size: 48px; color: white;
            text-align: center;
            display: flex; flex-direction: column; justify-content: space-between;
            overflow: hidden; text-transform: uppercase; line-height: 1.2;
            -webkit-text-stroke: 1.5px black;
        }
        .text-container {
            padding: 10px;
            filter: drop-shadow(1px 1px 0px black) drop-shadow(-1px -1px 0px black) drop-shadow(1px -1px 0px black) drop-shadow(-1px 1px 0px black) drop-shadow(0px 2px 2px rgba(0,0,0,0.8));
        }
    </style>
    </head>
    <body>
        <div class="text-container top">${safeTop}</div>
        <div class="text-container bottom">${safeBottom}</div>
    </body></html>`;

    await page.setViewport({ width: 512, height: 512, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(`(async () => { await document.fonts.ready; })()`);

    const outPath = `/tmp/text_overlay_${timestamp}.png`;
    await page.screenshot({ path: outPath, omitBackground: true });
    await page.close();
    return outPath;
}

// ============================================================
// PIPELINE STAGE 1: Background Removal
// ============================================================

class MattingServiceUnavailableError extends Error {
    constructor() {
        super('GPU matting service is not running. Start with: docker compose --profile gpu up');
        this.name = 'MattingServiceUnavailableError';
    }
}

function isMattingConnectionError(err: any): boolean {
    const code = err?.code || err?.cause?.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'ECONNABORTED')
        return true;
    const msg = String(err?.message || '');
    if (msg.includes('timeout') && msg.includes('exceeded')) return true;
    return false;
}

/** Remove background from a static image using the SAM2 GPU service */
async function removeBackgroundFromImage(buffer: Buffer): Promise<Buffer> {
    const cleanPng = await sharp(buffer).toFormat('png').toBuffer();

    const form = new FormData();
    form.append('file', cleanPng, { filename: 'input.png', contentType: 'image/png' });

    try {
        const response = await axios.post(`${MATTING_URL}/process-image`, form, {
            headers: form.getHeaders(),
            responseType: 'arraybuffer',
            timeout: 60000
        });
        return Buffer.from(response.data);
    } catch (err: any) {
        if (isMattingConnectionError(err)) throw new MattingServiceUnavailableError();
        throw err;
    }
}

/** Remove background from a video using the Python GPU matting service.
 *  Returns a directory of RGBA PNG frames + fps metadata.
 *  PNG frames natively preserve alpha — VP9 WebM silently strips it. */
async function removeBackgroundFromVideo(
    buffer: Buffer,
    kind: 'mp4' | 'gif' = 'mp4',
): Promise<{framesDir: string, fps: number}> {
    const form = new FormData();
    const filename = kind === 'gif' ? 'input.gif' : 'input.mp4';
    const contentType = kind === 'gif' ? 'image/gif' : 'video/mp4';
    form.append('file', buffer, { filename, contentType });

    let response;
    try {
        response = await axios.post(`${MATTING_URL}/process`, form, {
            headers: form.getHeaders(),
            responseType: 'arraybuffer',
            timeout: 900000,
        });
    } catch (err: any) {
        if (isMattingConnectionError(err)) throw new MattingServiceUnavailableError();
        throw err;
    }

    const timestamp = Date.now();
    const tarPath = path.join(os.tmpdir(), `matting_${timestamp}.tar`);
    const framesDir = path.join(os.tmpdir(), `matting_frames_${timestamp}`);
    mkdirSync(framesDir, { recursive: true });
    writeFileSync(tarPath, Buffer.from(response.data));

    await execAsync(`tar xf ${tarPath} -C ${framesDir}`);
    unlinkSync(tarPath);

    const meta = JSON.parse(readFileSync(path.join(framesDir, 'meta.json'), 'utf-8'));
    console.log(`[Matting] Extracted ${meta.frame_count} PNG frames at ${meta.fps} fps`);
    
    return { framesDir, fps: meta.fps };
}

// ============================================================
// PIPELINE STAGE 2a: Video Processing (scale → speed → text → WebP)
// ============================================================

interface VideoOptions {
    square: boolean;
    borderless: boolean;
    speed: number;
    overlaySrc?: string;
    framesDir?: string;
    framesFps?: number;
}

async function processVideoToWebp(buffer: Buffer, opts: VideoOptions): Promise<Buffer> {
    const timestamp = Date.now();
    let result: Buffer = Buffer.from('');

    // Borderless with pre-matted frames: skip ffmpeg entirely, use sharp
    // for resize/pad/encode — the exact same pipeline proven for static images.
    if (opts.borderless && opts.framesDir) {
        // Prioritize resolution reduction over framerate drops — a smaller
        // sticker at 20fps looks far better than a 512px sticker at 8fps.
        const borderlessProfiles = [
            { fps: 20, q: 50, size: 512 },
            { fps: 20, q: 35, size: 512 },
            { fps: 20, q: 50, size: 420 },
            { fps: 20, q: 35, size: 380 },
            { fps: 15, q: 50, size: 380 },
            { fps: 15, q: 35, size: 320 },
            { fps: 12, q: 35, size: 280 },
            { fps: 10, q: 25, size: 256 },
        ];

        const allFrames = readdirSync(opts.framesDir).filter(f => f.endsWith('.png')).sort();
        const sourceFps = opts.framesFps || 15;

        for (let i = 0; i < borderlessProfiles.length; i++) {
            const profile = borderlessProfiles[i];
            const frameDurationMs = Math.round(1000 / profile.fps);

            const targetCount = Math.max(1, Math.round(allFrames.length * profile.fps / sourceFps));
            const selectedFrames: string[] = [];
            for (let f = 0; f < targetCount; f++) {
                const srcIdx = Math.min(Math.floor(f * allFrames.length / targetCount), allFrames.length - 1);
                selectedFrames.push(allFrames[srcIdx]);
            }

            const sharpFrames: { webpBuf: Buffer; durationMs: number }[] = [];
            for (const f of selectedFrames) {
                const pngBuf = readFileSync(path.join(opts.framesDir, f));
                const webpBuf = await sharp(pngBuf)
                    .resize(profile.size, profile.size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality: profile.q, alphaQuality: 100 })
                    .toBuffer();
                sharpFrames.push({ webpBuf, durationMs: frameDurationMs });
            }

            result = buildAnimatedWebp(sharpFrames, profile.size, profile.size);

            if (result.length < 480000) {
                console.log(`[Compression] Profile ${i + 1} OK: ${(result.length / 1024).toFixed(1)} KB, ${profile.fps}fps, q${profile.q}, ${profile.size}px, ${selectedFrames.length} frames`);
                break;
            } else {
                console.log(`[Compression] Profile ${i + 1} too large: ${(result.length / 1024).toFixed(1)} KB`);
            }
        }

        rmSync(opts.framesDir, { recursive: true, force: true });
        return result;
    }

    // Non-borderless compression profiles (fps/quality only, full 512px)
    const compressionProfiles = [
        { fps: 20, q: 50 },
        { fps: 15, q: 50 },
        { fps: 15, q: 30 },
        { fps: 12, q: 25 },
        { fps: 10, q: 15 },
        { fps: 8,  q: 10 },
        { fps: 8,  q: 0 },
        { fps: 6,  q: 0 },
    ];

    // Non-borderless: ffmpeg extracts frames → sharp encodes → builder assembles
    // (avoids system libwebp_anim ghosting on WhatsApp Web)
    const pngFramesDir = path.join('/tmp', `webp_frames_${timestamp}`);
    mkdirSync(pngFramesDir, { recursive: true });

    let inputArgs: string[] = [];
    let tempInput: string | null = null;

    if (opts.framesDir && opts.framesFps) {
        inputArgs.push(`-framerate ${opts.framesFps} -i ${opts.framesDir}/frame_%04d.png`);
    } else {
        tempInput = path.join('/tmp', `vid_in_${timestamp}.mp4`);
        writeFileSync(tempInput, buffer);
        inputArgs.push(`-i ${tempInput}`);
    }

    if (opts.overlaySrc) {
        inputArgs.push(`-i ${opts.overlaySrc}`);
    }

    let filterArgs: string[] = [];
    if (opts.square) {
        filterArgs.push("crop='min(iw,ih)':'min(iw,ih)'");
        filterArgs.push("scale=512:512");
    } else {
        filterArgs.push("scale=512:512:force_original_aspect_ratio=decrease");
    }
    if (opts.speed !== 1.0) filterArgs.push(`setpts=${1 / opts.speed}*PTS`);

    let filterString = filterArgs.join(',');

    for (let i = 0; i < compressionProfiles.length; i++) {
        const profile = compressionProfiles[i];
        const fpsFilter = `fps=${profile.fps}`;
        const activeFilterStr = filterString ? `${filterString},${fpsFilter}` : fpsFilter;

        rmSync(pngFramesDir, { recursive: true, force: true });
        mkdirSync(pngFramesDir, { recursive: true });

        let filterFlag = `-vf "${activeFilterStr}"`;
        let mapArg = '';
        if (opts.overlaySrc) {
            filterFlag = `-filter_complex "[0:v]${activeFilterStr}[bg];[bg][1:v]overlay=0:0[out]"`;
            mapArg = '-map "[out]"';
        }

        await execAsync(`ffmpeg -y ${inputArgs.join(' ')} ${filterFlag} ${mapArg} -an ${pngFramesDir}/frame_%04d.png`);

        const frameFiles = readdirSync(pngFramesDir).filter(f => f.endsWith('.png')).sort();
        if (frameFiles.length === 0) continue;

        const frameDurationMs = Math.round(1000 / profile.fps);
        const sharpFrames: { webpBuf: Buffer; durationMs: number }[] = [];
        for (const f of frameFiles) {
            const pngBuf = readFileSync(path.join(pngFramesDir, f));
            const webpBuf = await sharp(pngBuf)
                .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .webp({ quality: profile.q, alphaQuality: 100 })
                .toBuffer();
            sharpFrames.push({ webpBuf, durationMs: frameDurationMs });
        }
        result = buildAnimatedWebp(sharpFrames, 512, 512);

        if (result.length < 480000) {
            console.log(`[Compression] Profile ${i + 1} OK: ${(result.length / 1024).toFixed(1)} KB, ${profile.fps}fps, q${profile.q}, ${frameFiles.length} frames`);
            break;
        } else {
            console.log(`[Compression] Profile ${i + 1} too large: ${(result.length / 1024).toFixed(1)} KB`);
        }
    }

    // Cleanup
    rmSync(pngFramesDir, { recursive: true, force: true });
    if (tempInput) unlinkSync(tempInput);
    if (opts.overlaySrc) try { unlinkSync(opts.overlaySrc); } catch (e) {}
    if (opts.framesDir) {
        rmSync(opts.framesDir, { recursive: true, force: true });
    }
    return result;
}

// ============================================================
// PIPELINE STAGE 2b: Static Image Processing (scale → text)
// ============================================================

interface ImageOptions {
    square: boolean;
    borderless: boolean;
    overlaySrc?: string;
}

/** Process a static image buffer into a sticker-ready image.
 *  Borderless → WebP with alpha via sharp (guaranteed correct VP8X flags).
 *  Non-borderless → PNG via ffmpeg for scaling/cropping/overlay. */
async function processImage(buffer: Buffer, opts: ImageOptions): Promise<{ buffer: Buffer; mimeType: string }> {
    if (opts.borderless && !opts.overlaySrc) {
        const webpBuf = await sharp(buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality: 80, alphaQuality: 100 })
            .toBuffer();
        return { buffer: webpBuf, mimeType: 'image/webp' };
    }

    const timestamp = Date.now();
    const tempInput = path.join('/tmp', `img_in_${timestamp}.png`);
    const tempOutput = path.join('/tmp', `img_out_${timestamp}.png`);

    let resized: Buffer;
    if (opts.borderless) {
        resized = await sharp(buffer).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toFormat('png').toBuffer();
    } else {
        resized = await sharp(buffer).toFormat('png').toBuffer();
    }
    writeFileSync(tempInput, resized);
    
    let inputArgs = [`-i ${tempInput}`];
    if (opts.overlaySrc) inputArgs.push(`-i ${opts.overlaySrc}`);
    
    let filterArgs: string[] = [];
    if (!opts.borderless) {
        if (opts.square) {
            filterArgs.push("crop='min(iw,ih)':'min(iw,ih)'");
            filterArgs.push("scale=512:512");
        } else {
            filterArgs.push("scale=512:512:force_original_aspect_ratio=decrease");
        }
    }
    
    let filterString = filterArgs.join(',');
    let filterFlag = filterString ? '-vf' : '';
    let mapArg = '';

    if (opts.overlaySrc) {
        if (filterString) {
            filterString = `[0:v]${filterString}[bg];[bg][1:v]overlay=0:0[out]`;
        } else {
            filterString = `[0:v][1:v]overlay=0:0[out]`;
        }
        filterFlag = '-filter_complex';
        mapArg = '-map "[out]"';
    }
    
    if (filterFlag) {
        await execAsync(`ffmpeg -y ${inputArgs.join(' ')} ${filterFlag} "${filterString}" ${mapArg} ${tempOutput}`);
        let result = Buffer.from(readFileSync(tempOutput));
        unlinkSync(tempInput);
        unlinkSync(tempOutput);
        if (opts.overlaySrc) try { unlinkSync(opts.overlaySrc); } catch (e) {}

        if (opts.borderless) {
            const webpBuf = await sharp(result).webp({ quality: 80, alphaQuality: 100 }).toBuffer();
            return { buffer: webpBuf, mimeType: 'image/webp' };
        }
        const webpBuf = await sharp(result)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality: 80, alphaQuality: 100 })
            .toBuffer();
        return { buffer: webpBuf, mimeType: 'image/webp' };
    }
    
    unlinkSync(tempInput);
    const webpBuf = await sharp(resized)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 80, alphaQuality: 100 })
        .toBuffer();
    return { buffer: webpBuf, mimeType: 'image/webp' };
}

// ============================================================
// WHATSAPP CLIENT SETUP
// ============================================================

const BOOT_TIMESTAMP = Math.floor(Date.now() / 1000);

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disk-cache-size=0',
            '--media-cache-size=0',
            '--disable-application-cache',
            '--v8-cache-options=none'
        ]
    }
});

// ============================================================
// INTERNAL EVENT SERVER (port 3001, Docker-internal only)
// ============================================================

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });

let botState: 'initializing' | 'qr' | 'ready' | 'disconnected' = 'initializing';
let lastQr: string | null = null;

app.use(express.json());

app.get('/status', (_req, res) => {
    res.json({
        state: botState,
        qr: botState === 'qr' ? lastQr : null,
    });
});

app.post('/logout', async (_req, res) => {
    try {
        await client.logout();
        botState = 'disconnected';
        lastQr = null;
        io.emit('disconnected');
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------- Whitelist API ---------------

app.get('/whitelist', (_req, res) => {
    const data = loadWhitelistData();
    res.json({ enabled: data.enabled, entries: data.entries.sort((a, b) => a.name.localeCompare(b.name)) });
});

app.put('/whitelist/enabled', (req, res) => {
    const enabled = !!req.body.enabled;
    const data = loadWhitelistData();
    data.enabled = enabled;
    saveWhitelistData(data);
    whitelistEnabled = enabled;
    console.log(`[Whitelist] ${enabled ? 'Enabled' : 'Disabled'}`);
    res.json({ success: true, enabled });
});

app.post('/whitelist/entry', (req, res) => {
    const { chat_id, name, type } = req.body;
    if (!chat_id || !name || !type) return res.status(400).json({ error: 'chat_id, name, type required' });
    const data = loadWhitelistData();
    data.entries = data.entries.filter(e => e.chat_id !== chat_id);
    data.entries.push({ chat_id, name, type });
    saveWhitelistData(data);
    whitelistSet.add(chat_id);
    console.log(`[Whitelist] Added ${type}: ${name} (${chat_id})`);
    res.json({ success: true });
});

app.delete('/whitelist/entry/:chatId', (req, res) => {
    const chatId = decodeURIComponent(req.params.chatId);
    const data = loadWhitelistData();
    data.entries = data.entries.filter(e => e.chat_id !== chatId);
    saveWhitelistData(data);
    whitelistSet.delete(chatId);
    console.log(`[Whitelist] Removed: ${chatId}`);
    res.json({ success: true });
});

app.get('/contacts', async (_req, res) => {
    try {
        const contacts = await client.getContacts();
        const result = contacts
            .filter(c => !c.isGroup && !c.isMe && c.id._serialized.endsWith('@c.us'))
            .map(c => ({ id: c.id._serialized, name: c.name || c.pushname || c.number || c.id.user, number: c.number }));
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/groups', async (_req, res) => {
    try {
        const chats = await client.getChats();
        const groups = chats
            .filter(c => c.isGroup)
            .map(c => ({ id: c.id._serialized, name: c.name, participantCount: (c as any).participants?.length || 0 }));
        res.json(groups);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/history', (_req, res) => {
    res.json(requestHistory);
});

httpServer.listen(3001, () => {
    console.log('[EventServer] Listening on port 3001 (internal)');
});

client.on('qr', (qr) => {
    console.log('Scan this QR code in WhatsApp to log in:');
    qrcode.generate(qr, { small: true });
    botState = 'qr';
    lastQr = qr;
    io.emit('qr', qr);
    io.emit('status', { state: 'qr', qr });
});

client.on('authenticated', () => {
    console.log('WhatsApp authenticated.');
    io.emit('authenticated');
});

client.on('ready', () => {
    console.log('Sticker Bot is ready and connected!');
    botState = 'ready';
    lastQr = null;
    io.emit('ready');
    io.emit('status', { state: 'ready', qr: null });
});

client.on('disconnected', (reason) => {
    console.log('WhatsApp disconnected:', reason);
    botState = 'disconnected';
    lastQr = null;
    io.emit('disconnected', reason);
    io.emit('status', { state: 'disconnected', qr: null });
});

// ============================================================
// MESSAGE HANDLER — CLEAN PIPELINE
// ============================================================

client.on('message_create', async (msg) => {
    if (msg.timestamp < BOOT_TIMESTAMP) return;
    if (whitelistEnabled && !whitelistSet.has(msg.from)) return;

    // Normalize every known Unicode quotation mark variant → ASCII straight quotes.
    // Covers: smart quotes, Hebrew gershayim/geresh, guillemets, fullwidth,
    // CJK brackets, ornamental quotes, primes, and more.
    const normalizedBody = msg.body.trim()
        .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036\u00AB\u00BB\u05F4\u275D\u275E\u301D\u301E\u301F\uFF02]/g, '"')
        .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u05F3\u275B\u275C\uFF07]/g, "'");
    
    const rawArgs = normalizedBody.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    if (rawArgs.length === 0) return;

    const command = rawArgs[0]!.toLowerCase();
    const lowerArgs = rawArgs.map(a => a.toLowerCase());

    if (command === '/sticker') {
        // --- RESOLVE MEDIA TARGET (before queue — fast, no heavy work) ---
        let mediaTarget = msg;
        try {
            if (msg.hasQuotedMsg) {
                const quotedMsg = await msg.getQuotedMessage();
                if (quotedMsg.hasMedia) mediaTarget = quotedMsg;
            }
        } catch { /* use original msg */ }

        if (!mediaTarget.hasMedia) {
            await msg.reply('Please attach media to your message, or reply to an existing image/video with /sticker');
            return;
        }
        if (mediaTarget.type === 'sticker') {
            await msg.reply('You cannot sticker a sticker! 🛑');
            return;
        }

        // --- BUILD REQUEST RECORD ---
        const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        let chatName = msg.from;
        try { chatName = (await msg.getChat()).name || msg.from; } catch {}

        const record: RequestRecord = {
            id: requestId,
            from: msg.from,
            chatName,
            flags: normalizedBody,
            mediaType: 'pending',
            timestamp: Date.now(),
            status: 'queued'
        };
        pushRequest(record);
        io.emit('request', record);

        // --- QUEUE THE HEAVY WORK ---
        await stickerQueue.run(async () => {
            record.status = 'processing';
            io.emit('request:update', { id: requestId, status: 'processing' });

            try {
                // --- PARSE FLAGS ---
                let speedMultiplier = 1.0;
                const speedIndex = lowerArgs.indexOf('-speed');
                if (speedIndex !== -1 && rawArgs.length > speedIndex + 1) {
                    const parsed = parseFloat(rawArgs[speedIndex + 1]);
                    if (!isNaN(parsed)) speedMultiplier = Math.max(0.5, Math.min(2.0, parsed));
                }

                let topText = '';
                const ttIndex = lowerArgs.indexOf('-tt');
                if (ttIndex !== -1 && rawArgs.length > ttIndex + 1) {
                    topText = rawArgs[ttIndex + 1].replace(/^"|"$/g, '').toUpperCase();
                }

                let bottomText = '';
                const btIndex = lowerArgs.indexOf('-bt');
                if (btIndex !== -1 && rawArgs.length > btIndex + 1) {
                    bottomText = rawArgs[btIndex + 1].replace(/^"|"$/g, '').toUpperCase();
                }

                const wantsSquare = lowerArgs.includes('-square');
                const wantsBorderless = lowerArgs.includes('-borderless');

                // --- DOWNLOAD MEDIA ---
                const downloadPromise = mediaTarget.downloadMedia();
                const timeoutPromise = new Promise<undefined>((_, reject) => {
                    setTimeout(() => reject(new Error('DOWNLOAD_TIMEOUT')), 10000);
                });

                let media;
                try {
                    media = await Promise.race([downloadPromise, timeoutPromise]);
                    if (!media) return;
                } catch (err: any) {
                    if (err.message === 'DOWNLOAD_TIMEOUT') {
                        await msg.reply('I cannot download this media! It might be too old or no longer available on WhatsApp Web.');
                        return;
                    }
                    throw err;
                }

                const isVideo = media.mimetype.includes('video') || media.mimetype.includes('gif');
                const isStaticImage = media.mimetype.includes('image') && !isVideo;
                record.mediaType = isVideo ? 'video' : 'image';
                let mediaBuffer: any = Buffer.from(media.data, 'base64');
                let finalMimeType = media.mimetype;

                // ==============================================
                // PIPELINE EXECUTION (ordered correctly)
                // ==============================================

                // STAGE 1: Background removal (if -borderless) — serialized on GPU
                let mattedFrames: {framesDir: string, fps: number} | null = null;
                if (wantsBorderless) {
                    const matKind: 'mp4' | 'gif' = media.mimetype.includes('gif') ? 'gif' : 'mp4';
                    console.log(
                        `[Pipeline] Stage 1: Background removal (${isVideo ? 'video' : 'image'}, matting kind=${matKind})`,
                    );
                    if (isStaticImage) {
                        mediaBuffer = await mattingQueue.run(async () => {
                            console.log('[Matting] Static image → SAM2…');
                            const out = await removeBackgroundFromImage(mediaBuffer);
                            console.log('[Matting] Static image done');
                            return out;
                        });
                        finalMimeType = 'image/png';
                    } else if (isVideo) {
                        mattedFrames = await mattingQueue.run(async () => {
                            console.log('[Matting] Video/GIF → SAM2 (can take several minutes on Apple Silicon)…');
                            const out = await removeBackgroundFromVideo(mediaBuffer, matKind);
                            console.log('[Matting] Video/GIF done');
                            return out;
                        });
                        finalMimeType = 'image/webp';
                    }
                }

                // Generate text overlay via Puppeteer if needed
                let overlaySrc: string | undefined = undefined;
                if (topText || bottomText) {
                    const timestamp = Date.now();
                    const browser = (client as any).pupBrowser;
                    overlaySrc = await buildTextOverlayImage(browser, topText, bottomText, timestamp);
                }

                // STAGE 2: Processing (scale → speed → text → encoding)
                if (isVideo) {
                    console.log(`[Pipeline] Stage 2: Video processing (speed=${speedMultiplier}, text=${!!topText || !!bottomText})`);
                    mediaBuffer = await processVideoToWebp(mediaBuffer, {
                        square: wantsSquare,
                        borderless: wantsBorderless,
                        speed: speedMultiplier,
                        overlaySrc,
                        framesDir: mattedFrames?.framesDir,
                        framesFps: mattedFrames?.fps
                    });
                    finalMimeType = 'image/webp';
                } else if (isStaticImage && (wantsSquare || wantsBorderless || topText || bottomText)) {
                    console.log(`[Pipeline] Stage 2: Image processing`);
                    const imgResult = await processImage(mediaBuffer, {
                        square: wantsSquare,
                        borderless: wantsBorderless,
                        overlaySrc
                    });
                    mediaBuffer = imgResult.buffer;
                    finalMimeType = imgResult.mimeType;
                }

                // STAGE 3: Send the sticker
                const processedMedia = new MessageMedia(
                    finalMimeType,
                    mediaBuffer.toString('base64'),
                    media.filename || 'sticker.mp4'
                );

                await msg.reply(processedMedia, undefined, {
                    sendMediaAsSticker: true,
                    stickerName: 'Generated via Bot',
                    stickerAuthor: 'My Sticker Bot'
                });

                record.status = 'done';
                io.emit('request:update', { id: requestId, status: 'done' });

            } catch (error: any) {
                record.status = 'error';
                io.emit('request:update', { id: requestId, status: 'error' });

                if (error instanceof MattingServiceUnavailableError) {
                    await msg.reply('The -borderless flag requires the GPU matting service, which is not running.\n\nThis is the lite build. To enable background removal, restart with:\n  docker compose --profile gpu up --build');
                    return;
                }
                console.error('Failed to process sticker:', error);
                await msg.reply('Oops, something went wrong while creating your sticker.');
            }
        });
    }
});

// ============================================================
// BOOT + GRACEFUL SHUTDOWN
// ============================================================

client.initialize();

const gracefulShutdown = async () => {
    console.log('\nShutting down gracefully...');
    httpServer.close();
    try {
        await client.destroy();
        console.log('WhatsApp connection closed natively. Session saved.');
    } catch (err) {
        console.error('Failed to close client:', err);
    }
    process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
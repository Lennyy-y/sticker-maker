import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import sharp from 'sharp';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, readdirSync, rmSync } from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';

const execAsync = promisify(exec);

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
): Buffer {
    // VP8X: Animation(0x02) + Alpha(0x10) = 0x12
    const vp8xPayload = Buffer.alloc(10);
    vp8xPayload[0] = 0x12;
    vp8xPayload.writeUIntLE(canvasWidth - 1, 4, 3);
    vp8xPayload.writeUIntLE(canvasHeight - 1, 7, 3);

    // ANIM: transparent background, infinite loop
    const animPayload = Buffer.alloc(6);
    animPayload.writeUInt32LE(0x00000000, 0);
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
    return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ERR_BAD_REQUEST';
}

/** Remove background from a static image using the SAM2 GPU service */
async function removeBackgroundFromImage(buffer: Buffer): Promise<Buffer> {
    const cleanPng = await sharp(buffer).toFormat('png').toBuffer();

    const form = new FormData();
    form.append('file', cleanPng, { filename: 'input.png', contentType: 'image/png' });

    try {
        const response = await axios.post('http://video-matting:8000/process-image', form, {
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
async function removeBackgroundFromVideo(buffer: Buffer): Promise<{framesDir: string, fps: number}> {
    const form = new FormData();
    form.append('file', buffer, { filename: 'input.mp4', contentType: 'video/mp4' });

    let response;
    try {
        response = await axios.post('http://video-matting:8000/process', form, {
            headers: form.getHeaders(),
            responseType: 'arraybuffer',
            timeout: 120000
        });
    } catch (err: any) {
        if (isMattingConnectionError(err)) throw new MattingServiceUnavailableError();
        throw err;
    }

    const timestamp = Date.now();
    const tarPath = path.join('/tmp', `matting_${timestamp}.tar`);
    const framesDir = path.join('/tmp', `matting_frames_${timestamp}`);
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

/** Process any video buffer (raw MP4 or matted PNG frames) into a final animated WebP sticker.
 *
 *  Two-stage pipeline with explicit frame control for WhatsApp Web compatibility:
 *    Stage A — ffmpeg extracts filtered/scaled PNG frames
 *    Stage B — cwebp encodes each frame individually, then webpmux assembles
 *              them with dispose=BACKGROUND + blend=NO_BLEND per frame.
 *              This forces every frame to fully replace the canvas, preventing
 *              the delta/ghosting artifacts WhatsApp Web's renderer produces
 *              when frames use the default BLEND + NO_DISPOSE flags. */
async function processVideoToWebp(buffer: Buffer, opts: VideoOptions): Promise<Buffer> {
    const timestamp = Date.now();
    const tempOutput = path.join('/tmp', `vid_out_${timestamp}.webp`);
    const pngFramesDir = path.join('/tmp', `webp_frames_${timestamp}`);
    mkdirSync(pngFramesDir, { recursive: true });

    let result: Buffer = Buffer.from('');

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

    // Borderless with pre-matted frames: skip ffmpeg entirely, use sharp
    // for resize/pad/encode — the exact same pipeline proven for static images.
    if (opts.borderless && opts.framesDir) {
        const allFrames = readdirSync(opts.framesDir).filter(f => f.endsWith('.png')).sort();
        const sourceFps = opts.framesFps || 15;

        for (let i = 0; i < compressionProfiles.length; i++) {
            const profile = compressionProfiles[i];
            const frameDurationMs = Math.round(1000 / profile.fps);

            // Select frames to match target fps (uniform sampling)
            const targetCount = Math.max(1, Math.round(allFrames.length * profile.fps / sourceFps));
            const selectedFrames: string[] = [];
            for (let f = 0; f < targetCount; f++) {
                const srcIdx = Math.min(Math.floor(f * allFrames.length / targetCount), allFrames.length - 1);
                selectedFrames.push(allFrames[srcIdx]);
            }

            const sharpFrames: { webpBuf: Buffer; durationMs: number }[] = [];
            for (const f of selectedFrames) {
                const pngBuf = readFileSync(path.join(opts.framesDir, f));
                // Identical to the static image borderless path:
                // sharp resize + contain + transparent background → WebP with alpha
                const webpBuf = await sharp(pngBuf)
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality: profile.q, alphaQuality: 100 })
                    .toBuffer();
                sharpFrames.push({ webpBuf, durationMs: frameDurationMs });
            }

            result = buildAnimatedWebp(sharpFrames, 512, 512);

            if (result.length < 480000) {
                console.log(`[Compression] Profile ${i + 1} OK: ${(result.length / 1024).toFixed(1)} KB, ${profile.fps}fps, q${profile.q}, ${selectedFrames.length} frames`);
                break;
            } else {
                console.log(`[Compression] Profile ${i + 1} too large: ${(result.length / 1024).toFixed(1)} KB`);
            }
        }

        // Cleanup
        rmSync(opts.framesDir, { recursive: true, force: true });
        return result;
    }

    // All other cases: ffmpeg-based pipeline (non-borderless, or raw video input)
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
    if (opts.square) filterArgs.push("crop='min(iw,ih)':'min(iw,ih)'");
    filterArgs.push("scale=512:512:force_original_aspect_ratio=increase");
    filterArgs.push("crop=512:512");
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

        await execAsync(
            `ffmpeg -y -framerate ${profile.fps} -i ${pngFramesDir}/frame_%04d.png` +
            ` -c:v libwebp_anim -lossless 0 -q:v ${profile.q} -loop 0 -an ${tempOutput}`
        );
        result = Buffer.from(readFileSync(tempOutput));

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
    try { unlinkSync(tempOutput); } catch (e) {}
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
        if (opts.square) filterArgs.push("crop='min(iw,ih)':'min(iw,ih)'");
        filterArgs.push("scale=512:512:force_original_aspect_ratio=increase");
        filterArgs.push("crop=512:512");
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
        return { buffer: result, mimeType: 'image/png' };
    }
    
    unlinkSync(tempInput);
    return { buffer: resized, mimeType: 'image/png' };
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

client.on('qr', (qr) => {
    console.log('Scan this QR code in WhatsApp to log in:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Sticker Bot is ready and connected!');
});

// ============================================================
// MESSAGE HANDLER — CLEAN PIPELINE
// ============================================================

client.on('message_create', async (msg) => {
    if (msg.timestamp < BOOT_TIMESTAMP) return;

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
        try {
            // --- RESOLVE MEDIA TARGET ---
            let mediaTarget = msg;
            if (msg.hasQuotedMsg) {
                const quotedMsg = await msg.getQuotedMessage();
                if (quotedMsg.hasMedia) mediaTarget = quotedMsg;
            }

            if (!mediaTarget.hasMedia) {
                await msg.reply('Please attach media to your message, or reply to an existing image/video with /sticker');
                return;
            }
            if (mediaTarget.type === 'sticker') {
                await msg.reply('You cannot sticker a sticker! 🛑');
                return;
            }

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
            let mediaBuffer: any = Buffer.from(media.data, 'base64');
            let finalMimeType = media.mimetype;

            // ==============================================
            // PIPELINE EXECUTION (ordered correctly)
            // ==============================================

            // STAGE 1: Background removal (if -borderless)
            let mattedFrames: {framesDir: string, fps: number} | null = null;
            if (wantsBorderless) {
                console.log(`[Pipeline] Stage 1: Background removal (${isVideo ? 'video' : 'image'})`);
                if (isStaticImage) {
                    mediaBuffer = await removeBackgroundFromImage(mediaBuffer);
                    finalMimeType = 'image/png';
                } else if (isVideo) {
                    mattedFrames = await removeBackgroundFromVideo(mediaBuffer);
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

        } catch (error: any) {
            if (error instanceof MattingServiceUnavailableError) {
                await msg.reply('The -borderless flag requires the GPU matting service, which is not running.\n\nThis is the lite build. To enable background removal, restart with:\n  docker compose --profile gpu up --build');
                return;
            }
            console.error('Failed to process sticker:', error);
            await msg.reply('Oops, something went wrong while creating your sticker.');
        }
    }
});

// ============================================================
// BOOT + GRACEFUL SHUTDOWN
// ============================================================

client.initialize();

const gracefulShutdown = async () => {
    console.log('\nShutting down gracefully...');
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
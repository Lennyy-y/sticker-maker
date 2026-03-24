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

/** Remove background from a static image using the SAM2 GPU service */
async function removeBackgroundFromImage(buffer: Buffer): Promise<Buffer> {
    const cleanPng = await sharp(buffer).toFormat('png').toBuffer();

    const form = new FormData();
    form.append('file', cleanPng, { filename: 'input.png', contentType: 'image/png' });

    const response = await axios.post('http://video-matting:8000/process-image', form, {
        headers: form.getHeaders(),
        responseType: 'arraybuffer',
        timeout: 60000
    });

    return Buffer.from(response.data);
}

/** Remove background from a video using the Python GPU matting service.
 *  Returns a directory of RGBA PNG frames + fps metadata.
 *  PNG frames natively preserve alpha — VP9 WebM silently strips it. */
async function removeBackgroundFromVideo(buffer: Buffer): Promise<{framesDir: string, fps: number}> {
    const form = new FormData();
    form.append('file', buffer, { filename: 'input.mp4', contentType: 'video/mp4' });

    const response = await axios.post('http://video-matting:8000/process', form, {
        headers: form.getHeaders(),
        responseType: 'arraybuffer',
        timeout: 120000
    });

    // Extract the tar archive of PNG frames from Python service
    const timestamp = Date.now();
    const tarPath = path.join('/tmp', `matting_${timestamp}.tar`);
    const framesDir = path.join('/tmp', `matting_frames_${timestamp}`);
    mkdirSync(framesDir, { recursive: true });
    writeFileSync(tarPath, Buffer.from(response.data));

    // Extract tar
    await execAsync(`tar xf ${tarPath} -C ${framesDir}`);
    unlinkSync(tarPath);

    // Read fps from meta.json
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
    if (opts.borderless) {
        filterArgs.push("format=rgba");
        filterArgs.push("scale=512:512:force_original_aspect_ratio=decrease");
        filterArgs.push("pad=512:512:-1:-1:color=0x00000000");
    } else {
        if (opts.square) filterArgs.push("crop='min(iw,ih)':'min(iw,ih)'");
        filterArgs.push("scale=512:512:force_original_aspect_ratio=increase");
        filterArgs.push("crop=512:512");
    }
    if (opts.speed !== 1.0) filterArgs.push(`setpts=${1 / opts.speed}*PTS`);

    let filterString = filterArgs.join(',');

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

    for (let i = 0; i < compressionProfiles.length; i++) {
        const profile = compressionProfiles[i];
        const fpsFilter = `fps=${profile.fps}`;
        const activeFilterStr = filterString ? `${filterString},${fpsFilter}` : fpsFilter;

        // Clear frames from previous attempt
        rmSync(pngFramesDir, { recursive: true, force: true });
        mkdirSync(pngFramesDir, { recursive: true });

        // --- Stage A: ffmpeg → individual PNG frames ---
        let filterFlag = `-vf "${activeFilterStr}"`;
        let mapArg = '';
        if (opts.overlaySrc) {
            filterFlag = `-filter_complex "[0:v]${activeFilterStr}[bg];[bg][1:v]overlay=0:0[out]"`;
            mapArg = '-map "[out]"';
        }

        await execAsync(`ffmpeg -y ${inputArgs.join(' ')} ${filterFlag} ${mapArg} -an ${pngFramesDir}/frame_%04d.png`);

        const frameFiles = readdirSync(pngFramesDir).filter(f => f.endsWith('.png')).sort();
        if (frameFiles.length === 0) continue;

        // --- Stage B: cwebp + webpmux with explicit dispose/blend flags ---
        // Each PNG → individual .webp via cwebp, then webpmux assembles with
        // +dispose_to_background (1) and -b (NO_BLEND) so every frame fully
        // replaces the canvas. This is what prevents ghosting on WhatsApp Web.
        const frameDurationMs = Math.round(1000 / profile.fps);
        const webpFramesDir = path.join(pngFramesDir, 'webps');
        mkdirSync(webpFramesDir, { recursive: true });

        for (const f of frameFiles) {
            const pngPath = path.join(pngFramesDir, f);
            const webpPath = path.join(webpFramesDir, f.replace('.png', '.webp'));
            await execAsync(`cwebp -quiet -lossy -q ${profile.q} "${pngPath}" -o "${webpPath}"`);
        }

        const muxArgs = frameFiles
            .map(f => `-frame ${path.join(webpFramesDir, f.replace('.png', '.webp'))} +${frameDurationMs}+0+0+1-b`)
            .join(' ');

        await execAsync(`webpmux ${muxArgs} -loop 0 -o ${tempOutput}`);

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

/** Process a static image buffer into a sticker-ready PNG. */
async function processImage(buffer: Buffer, opts: ImageOptions): Promise<Buffer> {
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
        const result = Buffer.from(readFileSync(tempOutput));
        unlinkSync(tempInput);
        unlinkSync(tempOutput);
        if (opts.overlaySrc) try { unlinkSync(opts.overlaySrc); } catch (e) {}
        return result;
    }
    
    unlinkSync(tempInput);
    return resized;
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
                mediaBuffer = await processImage(mediaBuffer, {
                    square: wantsSquare,
                    borderless: wantsBorderless,
                    overlaySrc
                });
                finalMimeType = 'image/png';
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

        } catch (error) {
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
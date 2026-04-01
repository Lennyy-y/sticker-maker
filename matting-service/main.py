from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import StreamingResponse, Response
from PIL import Image
import numpy as np
import torch
import imageio
import tempfile
import os
import shutil
import tarfile
import json
import io
import rembg
import scipy.ndimage

video_predictor = None
rembg_session = None


def get_device():
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


DEVICE = get_device()
CHECKPOINT = os.environ.get(
    "SAM2_CHECKPOINT",
    os.path.join(os.path.dirname(__file__), "checkpoints", "sam2.1_hiera_large.pt"),
)
MODEL_CFG = "configs/sam2.1/sam2.1_hiera_l.yaml"
MAX_FRAMES = 90


def cleanup_temp(*paths):
    for p in paths:
        if p and os.path.exists(p):
            try:
                if os.path.isdir(p):
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    os.remove(p)
            except Exception:
                pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    global video_predictor, rembg_session

    print("Loading RemBG u2net model...")
    # Load u2net which provides pixel-perfect salient object detection
    rembg_session = rembg.new_session("u2net")
    # Warmup
    dummy = Image.new("RGB", (64, 64), (128, 128, 128))
    _ = rembg.remove(dummy, session=rembg_session, only_mask=True)
    print("RemBG loaded and warmed up.")

    print("Loading SAM 2.1 hiera_large into GPU...")
    if DEVICE == "cuda":
        torch.autocast("cuda", dtype=torch.bfloat16).__enter__()
        if torch.cuda.get_device_properties(0).major >= 8:
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True

    from sam2.build_sam import build_sam2_video_predictor

    video_predictor = build_sam2_video_predictor(MODEL_CFG, CHECKPOINT, device=DEVICE)
    if DEVICE == "mps":
        video_predictor.float()
    print("SAM2 video predictor ready.")

    print("Pipeline fully loaded on GPU.")
    yield


app = FastAPI(lifespan=lifespan)


@app.post("/process-image")
async def process_image(file: UploadFile = File(...)):
    """Remove background from a static image using RemBG."""
    try:
        data = await file.read()
        
        # RemBG does full alpha matting natively for images
        print("[Image] Running RemBG foreground detection...")
        result_data = rembg.remove(data, session=rembg_session)
        
        result = Image.open(io.BytesIO(result_data))

        bbox = result.getbbox()
        if bbox:
            result = result.crop(bbox)

        buf = io.BytesIO()
        result.save(buf, format="PNG")
        buf.seek(0)

        return Response(content=buf.getvalue(), media_type="image/png")

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Failed to process image.")


@app.post("/process")
async def process_video(file: UploadFile = File(...)):
    """Remove background from video using RemBG for frame 0, and SAM2 temporal propagation."""
    if not file.filename.endswith(('.mp4', '.gif')):
        raise HTTPException(status_code=400, detail="Only .mp4 and .gif files are supported.")

    temp_dir = tempfile.mkdtemp()
    temp_input = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
    jpeg_dir = os.path.join(temp_dir, "jpegs")
    os.makedirs(jpeg_dir, exist_ok=True)

    try:
        with open(temp_input.name, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        reader = imageio.get_reader(temp_input.name)
        fps = reader.get_meta_data()['fps']

        original_frames = []
        frame_count = 0
        for frame in reader:
            if frame_count >= MAX_FRAMES:
                break
            original_frames.append(Image.fromarray(frame))
            frame_count += 1
        reader.close()

        if frame_count == 0:
            raise HTTPException(status_code=400, detail="No frames found in video.")

        h, w = np.array(original_frames[0]).shape[:2]

        MIN_DIM = 480
        scale_factor = 1
        if min(h, w) < MIN_DIM:
            scale_factor = max(2, MIN_DIM // min(h, w) + 1)

        sam_h, sam_w = h * scale_factor, w * scale_factor

        for i, img in enumerate(original_frames):
            sam_img = img.resize((sam_w, sam_h), Image.LANCZOS) if scale_factor > 1 else img
            sam_img.save(os.path.join(jpeg_dir, f"{i:05d}.jpg"), "JPEG", quality=95)

        print(f"[SAM2 Video] Extracted {frame_count} frames at {fps} fps, native {w}x{h}"
              + (f", upscaled to {sam_w}x{sam_h} for SAM2" if scale_factor > 1 else ""))

        # 2. Run RemBG on frame 0 to get a perfect subject mask
        print("[SAM2 Video] Identifying subject on frame 0 using RemBG...")
        frame0_for_sam = original_frames[0].resize((sam_w, sam_h), Image.LANCZOS) if scale_factor > 1 else original_frames[0]
        
        rembg_mask_pil = rembg.remove(frame0_for_sam, session=rembg_session, only_mask=True)
        rembg_mask_np = np.array(rembg_mask_pil)

        # Ensure mask is binary or soft boolean, SAM2 mask expects (1, H, W) float/bool tensor
        # But `add_new_mask` in SAM2 actually takes a boolean/integer mask usually of shape (H, W)
        mask_input = (rembg_mask_np > 128).astype(np.uint8)

        if mask_input.sum() == 0:
            raise HTTPException(status_code=400, detail="Could not detect foreground subject.")
            
        print(f"  [Video] Prompting SAM2 with RemBG exact subject mask...")

        autocast_ctx = (
            torch.autocast("cuda", dtype=torch.bfloat16)
            if DEVICE == "cuda"
            else torch.autocast(DEVICE, enabled=False)
        )
        with torch.inference_mode(), autocast_ctx:
            state = video_predictor.init_state(video_path=jpeg_dir)

            # Feed the exact RemBG mask as the seed prompt for SAM2
            _, _, mask_logits = video_predictor.add_new_mask(
                inference_state=state,
                frame_idx=0,
                obj_id=1,
                mask=mask_input,
            )

            # 3. Propagate through all frames
            video_masks = {}
            for out_frame_idx, out_obj_ids, out_mask_logits in video_predictor.propagate_in_video(state):
                out_logits = out_mask_logits[0].cpu().numpy().squeeze()
                video_masks[out_frame_idx] = out_logits

            video_predictor.reset_state(state)

        if 1 in video_masks:
            video_masks[0] = video_masks[1]

        print(f"[SAM2 Video] Propagation complete: {len(video_masks)} frames masked")

        handled_frames = []
        global_min_x, global_min_y = float('inf'), float('inf')
        global_max_x, global_max_y = 0, 0

        for i in range(frame_count):
            frame_rgb = np.array(original_frames[i])
            logits = video_masks.get(i, np.full((sam_h, sam_w), -10.0, dtype=np.float32))

            # Use sigmoid on raw SAM2 logits to get the hard probability mask [0..1]
            raw_prob = 1.0 / (1.0 + np.exp(-np.clip(logits, -20.0, 20.0)))

            # Apply Gaussian blur on the probabilities to feather the alpha mask linearly
            # This fixes the binary "stair-step" aliasing inherent to SAM2 logits.
            feathered_prob = scipy.ndimage.gaussian_filter(raw_prob, sigma=1.5)
            alpha = (feathered_prob * 255.0).astype(np.uint8)

            if alpha.shape[0] != h or alpha.shape[1] != w:
                alpha = np.array(Image.fromarray(alpha).resize((w, h), Image.BILINEAR))

            # Straight alpha compositing for PNGs (browsers double-dip if we pre-multiply).
            # We preserve the native RGB colors in semi-transparent edges for perfect blending.
            frame_clean = frame_rgb.copy()
            frame_clean[alpha == 0] = [0, 0, 0] # black out pure background for PNG compression
            rgba = np.dstack([frame_clean, alpha])
            pil_frame = Image.fromarray(rgba, "RGBA")

            bbox = pil_frame.getbbox()
            if bbox:
                min_x, min_y, max_x, max_y = bbox
                global_min_x = min(global_min_x, min_x)
                global_min_y = min(global_min_y, min_y)
                global_max_x = max(global_max_x, max_x)
                global_max_y = max(global_max_y, max_y)

            handled_frames.append(pil_frame)

        # 5. Crop all frames to global bounding box and save as PNGs
        final_frames_dir = os.path.join(temp_dir, "frames")
        os.makedirs(final_frames_dir, exist_ok=True)

        if global_min_x != float('inf'):
            crop_box = (global_min_x, global_min_y, global_max_x, global_max_y)
            for i, p_img in enumerate(handled_frames):
                p_img.crop(crop_box).save(os.path.join(final_frames_dir, f"frame_{i:04d}.png"))
        else:
            for i in range(frame_count):
                Image.new("RGBA", (512, 512), (0, 0, 0, 0)).save(
                    os.path.join(final_frames_dir, f"frame_{i:04d}.png"))

        meta_path = os.path.join(final_frames_dir, "meta.json")
        with open(meta_path, "w") as f:
            json.dump({"fps": min(30, fps), "frame_count": frame_count}, f)

        # 6. Package as tar
        tar_path = os.path.join(temp_dir, "frames.tar")
        with tarfile.open(tar_path, "w") as tar:
            for fname in sorted(os.listdir(final_frames_dir)):
                tar.add(os.path.join(final_frames_dir, fname), arcname=fname)

        tar_size = os.path.getsize(tar_path)
        print(f"[SAM2 Video] Packaged {frame_count} PNG frames as tar: {tar_size / 1024:.0f}KB")

        def iterfile():
            try:
                with open(tar_path, "rb") as f:
                    while chunk := f.read(65536):
                        yield chunk
            finally:
                cleanup_temp(temp_dir, temp_input.name)

        headers = {"Content-Length": str(os.path.getsize(tar_path))}
        return StreamingResponse(iterfile(), media_type="application/x-tar", headers=headers)

    except HTTPException:
        raise
    except Exception as e:
        cleanup_temp(temp_dir, temp_input.name)
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Failed to process media.")

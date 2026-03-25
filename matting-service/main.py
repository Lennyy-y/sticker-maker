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

auto_mask_generator = None
video_predictor = None


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


def _is_background(seg: np.ndarray, area: int, total_pixels: int, h: int, w: int) -> bool:
    """Classify a mask as background based on how many distinct image edges it
    contacts.  Real background wraps around the subject and touches 3-4 edges.
    A cartoon character's hat touching only the top edge (1 edge) is NOT background.
    """
    area_ratio = area / total_pixels
    if area_ratio > 0.85:
        return True

    # Count distinct edges this mask significantly contacts (>5% of edge length)
    min_contact = 0.05
    edges = 0
    if seg[0, :].sum() / w > min_contact:
        edges += 1
    if seg[-1, :].sum() / w > min_contact:
        edges += 1
    if seg[:, 0].sum() / h > min_contact:
        edges += 1
    if seg[:, -1].sum() / h > min_contact:
        edges += 1

    return edges >= 3 and area_ratio > 0.05


def analyze_foreground(img_np: np.ndarray):
    """Run SAM2 automatic mask generator and classify every segment as foreground
    or background.

    Pass 1 — edge-count classification:
        Background must touch 3+ image edges (it wraps around the subject).
        Masks touching only 1-2 edges are kept as foreground.

    Pass 2 — spatial enclosure rescue:
        Any mask initially flagged as background whose centroid falls inside the
        foreground's bounding box is rescued back to foreground.  This catches
        solid-color body parts (shirt, belt, face) that SAM2 segments separately
        and that happen to touch the frame edge.

    Returns:
        foreground_mask: uint8 HxW array (255 = foreground, 0 = background)
        fg_points: list of [x, y] centroids — one per foreground segment
        bg_points: list of [x, y] points known to be background
    """
    h, w = img_np.shape[:2]
    total_pixels = h * w

    masks = auto_mask_generator.generate(img_np)
    print(f"  [AutoMask] Generated {len(masks)} candidate masks")

    if not masks:
        return np.ones((h, w), dtype=np.uint8) * 255, [[w // 2, h // 2]], []

    # --- Pass 1: edge-count classification ---
    foreground = np.zeros((h, w), dtype=bool)
    fg_points = []
    bg_candidates = []

    for m in masks:
        seg = m['segmentation']
        if _is_background(seg, m['area'], total_pixels, h, w):
            bg_candidates.append(m)
        else:
            foreground |= seg
            if m['area'] > total_pixels * 0.005:
                ys, xs = np.where(seg)
                fg_points.append([int(xs.mean()), int(ys.mean())])

    # --- Pass 2: rescue enclosed "background" masks ---
    # If a mask flagged as background has its centroid inside the foreground
    # bounding box, it's actually part of the subject (solid-color interior region).
    if foreground.any() and bg_candidates:
        fg_ys, fg_xs = np.where(foreground)
        fg_x0, fg_y0 = int(fg_xs.min()), int(fg_ys.min())
        fg_x1, fg_y1 = int(fg_xs.max()), int(fg_ys.max())

        remaining_bg = []
        fg_area = foreground.sum()
        for m in bg_candidates:
            seg = m['segmentation']
            ys, xs = np.where(seg)
            cx, cy = int(xs.mean()), int(ys.mean())

            # Only rescue if centroid is inside the foreground bbox AND the mask
            # is smaller than the existing foreground. Large masks (>40% of frame
            # or bigger than the foreground) are the actual background, not an
            # interior body part like a shirt or face.
            area_ratio = m['area'] / total_pixels
            if (fg_x0 <= cx <= fg_x1 and fg_y0 <= cy <= fg_y1
                    and area_ratio < 0.4 and m['area'] < fg_area):
                foreground |= seg
                fg_area = foreground.sum()
                if m['area'] > total_pixels * 0.005:
                    fg_points.append([cx, cy])
                print(f"    [Rescue] Enclosed mask ({area_ratio*100:.1f}% area) "
                      f"at ({cx},{cy}) recovered as foreground")
            else:
                remaining_bg.append(m)
        bg_candidates = remaining_bg

    # --- Fallbacks ---
    if not foreground.any():
        sorted_masks = sorted(masks, key=lambda m: m['area'], reverse=True)
        for m in sorted_masks:
            if m['area'] / total_pixels < 0.85:
                foreground = m['segmentation']
                ys, xs = np.where(foreground)
                fg_points = [[int(xs.mean()), int(ys.mean())]]
                break

    if not foreground.any():
        foreground = masks[0]['segmentation']
        fg_points = [[w // 2, h // 2]]

    if not fg_points:
        ys, xs = np.where(foreground)
        fg_points = [[int(xs.mean()), int(ys.mean())]]

    # Negative prompts: image corners are almost always background.
    margin = max(5, min(h, w) // 20)
    corners = [
        [margin, margin],
        [w - margin, margin],
        [margin, h - margin],
        [w - margin, h - margin],
    ]
    bg_points = [p for p in corners if not foreground[p[1], p[0]]]

    fg_area = foreground.sum() / total_pixels
    print(f"  [AutoMask] Foreground covers {fg_area * 100:.1f}% of frame, "
          f"{len(fg_points)} positive + {len(bg_points)} negative prompts, "
          f"{len(bg_candidates)} background masks")

    return foreground.astype(np.uint8) * 255, fg_points, bg_points


@asynccontextmanager
async def lifespan(app: FastAPI):
    global auto_mask_generator, video_predictor

    print(f"Loading SAM 2.1 hiera_large on {DEVICE.upper()}...")

    if DEVICE == "cuda":
        torch.autocast("cuda", dtype=torch.bfloat16).__enter__()
        if torch.cuda.get_device_properties(0).major >= 8:
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True

    from sam2.build_sam import build_sam2, build_sam2_video_predictor
    from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator

    sam2_model = build_sam2(MODEL_CFG, CHECKPOINT, device=DEVICE)
    if DEVICE == "mps":
        sam2_model = sam2_model.float()
    auto_mask_generator = SAM2AutomaticMaskGenerator(
        model=sam2_model,
        points_per_side=32,
        pred_iou_thresh=0.7,
        stability_score_thresh=0.92,
        min_mask_region_area=100,
    )
    print("SAM2 automatic mask generator ready.")

    video_predictor = build_sam2_video_predictor(MODEL_CFG, CHECKPOINT, device=DEVICE)
    if DEVICE == "mps":
        video_predictor.float()
    print("SAM2 video predictor ready.")

    dummy = np.ones((64, 64, 3), dtype=np.uint8) * 128
    _ = auto_mask_generator.generate(dummy)
    print(f"SAM 2.1 hiera_large fully loaded on {DEVICE.upper()} and warmed up.")
    yield


app = FastAPI(lifespan=lifespan)


@app.post("/process-image")
async def process_image(file: UploadFile = File(...)):
    """Remove background from a static image using SAM2 automatic mask generation."""
    try:
        data = await file.read()
        img = Image.open(io.BytesIO(data)).convert("RGB")
        img_np = np.array(img)
        orig_h, orig_w = img_np.shape[:2]

        # Upscale small images for better SAM2 boundary detection
        MIN_DIM = 480
        scale_factor = 1
        if min(orig_h, orig_w) < MIN_DIM:
            scale_factor = max(2, MIN_DIM // min(orig_h, orig_w) + 1)
        
        if scale_factor > 1:
            sam_w, sam_h = orig_w * scale_factor, orig_h * scale_factor
            sam_np = np.array(img.resize((sam_w, sam_h), Image.LANCZOS))
            print(f"[Image] Upscaled {orig_w}x{orig_h} → {sam_w}x{sam_h} for SAM2")
        else:
            sam_np = img_np

        print("[Image] Running automatic foreground detection...")
        mask, _, _ = analyze_foreground(sam_np)

        # Downscale mask back to original resolution if upscaled.
        # NEAREST preserves the binary 0/255 mask — LANCZOS would create
        # semi-transparent edge pixels that show as a halo on WhatsApp Web.
        if scale_factor > 1:
            mask = np.array(Image.fromarray(mask).resize((orig_w, orig_h), Image.NEAREST))

        img_clean = img_np * (mask[:, :, np.newaxis] > 0)
        rgba = np.dstack([img_clean, mask])
        result = Image.fromarray(rgba, "RGBA")

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
    """Remove background from video using SAM2 video predictor with temporal propagation."""
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

        # 1. Extract frames — keep originals for final compositing, save high-quality
        #    JPEGs for SAM2 (it only reads JPEG from disk). Quality 95 preserves edge
        #    fidelity — default 75 creates blocking artifacts that SAM2 misinterprets
        #    as object boundaries.
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

        # If frames are small, upscale for SAM2 — it struggles on low-res input.
        # Masks are produced at SAM2 input resolution, then downscaled when applied.
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

        # 2. Run automatic foreground detection on frame 0 to find the subject.
        #    This returns per-segment centroids as positive prompts and corner
        #    background points as negative prompts — simulating a human clicking
        #    every visible part of the subject on Meta's demo.
        frame0_for_sam = np.array(original_frames[0].resize((sam_w, sam_h), Image.LANCZOS)) if scale_factor > 1 else np.array(original_frames[0])
        print("[SAM2 Video] Identifying subject on frame 0...")
        fg_mask, fg_points, bg_points = analyze_foreground(frame0_for_sam)

        ys, xs = np.where(fg_mask > 0)
        if len(ys) == 0:
            raise HTTPException(status_code=400, detail="Could not detect foreground subject.")

        all_points = np.array(fg_points + bg_points, dtype=np.float32)
        all_labels = np.array(
            [1] * len(fg_points) + [0] * len(bg_points), dtype=np.int32
        )

        fg_box = np.array(
            [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
            dtype=np.float32,
        )
        print(f"  [Video] Prompting with {len(fg_points)} positive + "
              f"{len(bg_points)} negative points, bbox {fg_box.tolist()}")

        autocast_ctx = (
            torch.autocast("cuda", dtype=torch.bfloat16)
            if DEVICE == "cuda"
            else torch.autocast(DEVICE, enabled=False)
        )
        with torch.inference_mode(), autocast_ctx:
            state = video_predictor.init_state(video_path=jpeg_dir)

            # Feed per-segment positive points + background negative points + tight bbox
            _, _, mask_logits = video_predictor.add_new_points_or_box(
                inference_state=state,
                frame_idx=0,
                obj_id=1,
                points=all_points,
                labels=all_labels,
                box=fg_box,
            )

            # 3. Propagate through all frames
            video_masks = {}
            for out_frame_idx, out_obj_ids, out_mask_logits in video_predictor.propagate_in_video(state):
                mask = (out_mask_logits[0] > 0.0).cpu().numpy().squeeze()
                video_masks[out_frame_idx] = mask

            video_predictor.reset_state(state)

        # Frame 0's mask is from sparse point/box prompts with no temporal
        # context, so it often has edge artifacts. Frame 1's temporally
        # propagated mask is much cleaner — copy it to frame 0.
        if 1 in video_masks:
            video_masks[0] = video_masks[1]

        print(f"[SAM2 Video] Propagation complete: {len(video_masks)} frames masked")

        # 4. Apply masks to original frames and compute global bounding box.
        #    SAM2 masks are at sam_h x sam_w resolution — downscale to native if needed.
        processed_frames = []
        global_min_x, global_min_y = float('inf'), float('inf')
        global_max_x, global_max_y = 0, 0

        for i in range(frame_count):
            frame_rgb = np.array(original_frames[i])
            mask = video_masks.get(i, np.zeros((sam_h, sam_w), dtype=bool))

            alpha = (mask.astype(np.uint8) * 255)
            if alpha.shape[0] != h or alpha.shape[1] != w:
                alpha = np.array(Image.fromarray(alpha).resize((w, h), Image.NEAREST))

            frame_clean = frame_rgb * (alpha[:, :, np.newaxis] > 0)
            rgba = np.dstack([frame_clean, alpha])
            pil_frame = Image.fromarray(rgba, "RGBA")

            bbox = pil_frame.getbbox()
            if bbox:
                min_x, min_y, max_x, max_y = bbox
                global_min_x = min(global_min_x, min_x)
                global_min_y = min(global_min_y, min_y)
                global_max_x = max(global_max_x, max_x)
                global_max_y = max(global_max_y, max_y)

            processed_frames.append(pil_frame)

        # 5. Crop all frames to global bounding box and save as PNGs
        final_frames_dir = os.path.join(temp_dir, "frames")
        os.makedirs(final_frames_dir, exist_ok=True)

        if global_min_x != float('inf'):
            crop_box = (global_min_x, global_min_y, global_max_x, global_max_y)
            for i, p_img in enumerate(processed_frames):
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

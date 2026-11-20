"""Visual Editor: finds the streamer, the facecam window and the gameplay area, and picks a vertical layout.

Face detection uses a versioned detector from the skill registry (default: the LBP frontal-face cascade that
ships with scikit-image, no download needed; YuNet via OpenCV when its model file is installed).
All coordinates are normalised to the source frame (0..1)."""
import os

import numpy as np

from . import media

_det = None


def _detector():
    global _det
    if _det is None:
        yunet = os.environ.get("AC_YUNET_MODEL", "/models/face_detection_yunet_2023mar.onnx")
        try:  # the skill registry decides which detector is active
            from . import db
            active = (db.one("SELECT name FROM skills WHERE component='face_detector' AND status='active'") or {}).get("name")
        except Exception:
            active = None
        if active == "yunet-opencv" and os.path.exists(yunet):
            import cv2
            _det = ("yunet", cv2.FaceDetectorYN.create(yunet, "", (320, 320), 0.7))
        else:
            from skimage import data, feature
            _det = ("lbp", feature.Cascade(data.lbp_frontal_face_cascade_filename()))
    return _det


def detector_name():
    return _detector()[0]


def faces(rgb):
    """Faces in one RGB frame: list of (x, y, w, h, score) normalised."""
    H, W = rgb.shape[:2]
    kind, d = _detector()
    out = []
    if kind == "yunet":
        import cv2
        d.setInputSize((W, H))
        _, res = d.detect(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        for f in (res if res is not None else []):
            out.append((f[0] / W, f[1] / H, f[2] / W, f[3] / H, float(f[-1])))
    else:
        mn = max(18, int(min(W, H) * 0.045))
        for f in d.detect_multi_scale(img=rgb, scale_factor=1.2, step_ratio=1, min_size=(mn, mn), max_size=(int(min(W, H)),) * 2):
            out.append((f["c"] / W, f["r"] / H, f["width"] / W, f["height"] / H, 1.0))
    # merge overlapping hits (the cascade fires several times on one face)
    out.sort(key=lambda b: -b[2])
    merged = []
    for b in out:
        if all(_iou(b, m) < 0.3 and not _inside(b, m) for m in merged):
            merged.append(b)
    return merged


def _iou(a, b):
    ax2, ay2, bx2, by2 = a[0] + a[2], a[1] + a[3], b[0] + b[2], b[1] + b[3]
    iw, ih = max(0, min(ax2, bx2) - max(a[0], b[0])), max(0, min(ay2, by2) - max(a[1], b[1]))
    inter = iw * ih
    return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-9)


def _inside(a, b):
    cx, cy = a[0] + a[2] / 2, a[1] + a[3] / 2
    return b[0] <= cx <= b[0] + b[2] and b[1] <= cy <= b[1] + b[3]


def track(src, start=None, dur=None, fps=2.0, width=640):
    """Face tracks over time: clusters of detections with their stability."""
    frs, ts = media.frames(src, fps=fps, width=width, start=start, dur=dur)
    dets = [faces(f) for f in frs]
    clusters = []
    for t, ds in zip(ts, dets):
        for b in ds:
            cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
            best = None
            for c in clusters:
                if abs(c["cx"] - cx) < max(0.06, c["w"] * 0.8) and abs(c["cy"] - cy) < max(0.08, c["h"] * 0.8):
                    best = c
                    break
            if best is None:
                best = {"pts": [], "cx": cx, "cy": cy, "w": b[2], "h": b[3]}
                clusters.append(best)
            best["pts"].append((t, b))
            xs = [p[1][0] + p[1][2] / 2 for p in best["pts"]]
            ys = [p[1][1] + p[1][3] / 2 for p in best["pts"]]
            best["cx"], best["cy"] = float(np.median(xs)), float(np.median(ys))
            best["w"], best["h"] = float(np.median([p[1][2] for p in best["pts"]])), float(np.median([p[1][3] for p in best["pts"]]))
    n = max(1, len(frs))
    for c in clusters:
        c["presence"] = len({p[0] for p in c["pts"]}) / n
        c["jitter"] = float(np.std([p[1][0] + p[1][2] / 2 for p in c["pts"]]) if len(c["pts"]) > 1 else 0)
    clusters = [c for c in clusters if c["presence"] >= 0.25]
    clusters.sort(key=lambda c: -c["presence"])
    return {"frames": frs, "times": ts, "clusters": clusters, "n": n}


def _cam_window(frs, c, W, H):
    """Estimate the webcam overlay rectangle around a small, stable face using the strongest straight edges."""
    med = np.median(np.stack([f.mean(axis=2) for f in frs[: min(len(frs), 24)]]), axis=0) if frs else None
    fx, fy, fw, fh = c["cx"] - c["w"] / 2, c["cy"] - c["h"] / 2, c["w"], c["h"]
    # default: a 4:3-ish window ~3 face widths wide around the face
    box = [fx - fw * 1.1, fy - fh * 0.9, fw * 3.2, fh * 3.0]
    if med is not None:
        gx = np.abs(np.diff(med, axis=1))
        gy = np.abs(np.diff(med, axis=0))
        hpx, wpx = med.shape
        y0, y1 = int(max(0, fy - fh * 1.2) * hpx), int(min(1, fy + fh * 2.4) * hpx)
        x0, x1 = int(max(0, fx - fw * 1.6) * wpx), int(min(1, fx + fw * 2.6) * wpx)

        def col(lo, hi, y0, y1):
            lo, hi = max(1, int(lo * wpx)), min(wpx - 2, int(hi * wpx))
            if hi <= lo:
                return None
            prof = gx[y0:y1, lo:hi].mean(axis=0)
            i = int(prof.argmax())
            return (lo + i) / wpx if prof[i] > prof.mean() * 2.2 and prof[i] > 8 else None

        def row(lo, hi, x0, x1):
            lo, hi = max(1, int(lo * hpx)), min(hpx - 2, int(hi * hpx))
            if hi <= lo:
                return None
            prof = gy[lo:hi, x0:x1].mean(axis=1)
            i = int(prof.argmax())
            return (lo + i) / hpx if prof[i] > prof.mean() * 2.2 and prof[i] > 8 else None

        L = col(fx - fw * 2.0, fx - fw * 0.15, y0, y1)
        R = col(fx + fw * 1.15, fx + fw * 3.0, y0, y1)
        T = row(fy - fh * 1.6, fy - fh * 0.1, x0, x1)
        B = row(fy + fh * 1.2, fy + fh * 3.0, x0, x1)
        if L is not None:
            box[2] += box[0] - L; box[0] = L
        if R is not None:
            box[2] = R - box[0]
        if T is not None:
            box[3] += box[1] - T; box[1] = T
        if B is not None:
            box[3] = B - box[1]
        box_edges = sum(v is not None for v in (L, R, T, B))
    else:
        box_edges = 0
    # snap to frame edges when close (webcams usually sit in a corner)
    x, y, w, h = box
    if x < 0.02: w += x; x = 0
    if y < 0.02: h += y; y = 0
    if x + w > 0.98: w = 1 - x
    if y + h > 0.98: h = 1 - y
    return {"x": round(max(0, x), 4), "y": round(max(0, y), 4), "w": round(min(1, w), 4), "h": round(min(1, h), 4), "edges": box_edges}


def analyse(src, start=None, dur=None):
    """Decide the layout for a clip. Returns {layout, facecam, faces, track_keys, reason, confidence}."""
    info = media.probe(src)
    W, H = info["width"], info["height"]
    tr = track(src, start=start, dur=dur)
    cl = tr["clusters"]
    out = {"source": {"w": W, "h": H}, "faces": [{"cx": round(c["cx"], 3), "cy": round(c["cy"], 3), "w": round(c["w"], 3), "h": round(c["h"], 3), "presence": round(c["presence"], 2), "jitter": round(c["jitter"], 3)} for c in cl[:4]], "detector": detector_name()}
    # a webcam overlay: small face that barely moves, inside a window with visible edges
    small, cams = [], {}
    # two similar stable people = podcast / interview, not a webcam overlay
    pair = [c for c in cl if c["presence"] >= 0.4]
    # same person drifting splits into clusters whose presence sums to ~1; a real pair co-occurs (sum > 1.2) and sits still
    if len(pair) >= 2 and pair[0]["presence"] + pair[1]["presence"] > 1.2 and max(pair[0]["jitter"], pair[1]["jitter"]) < 0.02 and 0.6 <= pair[0]["w"] / max(1e-6, pair[1]["w"]) <= 1.6 and abs(pair[0]["cx"] - pair[1]["cx"]) > 0.25:
        sp = sorted(pair[:2], key=lambda c: c["cx"])
        out.update(layout="split", facecam=None, speakers=[{"cx": c["cx"], "cy": c["cy"], "w": c["w"], "h": c["h"]} for c in sp], confidence=0.7,
                   reason=f"Two people on camera ({round(sp[0]['presence'] * 100)}% / {round(sp[1]['presence'] * 100)}% of frames): one per half")
        return out
    for c in cl:
        near_edge = min(c["cx"] - c["w"] / 2, c["cy"] - c["h"] / 2, 1 - c["cx"] - c["w"] / 2, 1 - c["cy"] - c["h"] / 2) < 0.12
        if c["w"] < 0.2 and c["jitter"] < 0.025 and near_edge:
            cam = _cam_window(tr["frames"], c, W, H)
            if cam["edges"] >= 2 or (cam["x"] in (0,) or cam["y"] in (0,) or cam["x"] + cam["w"] >= 0.999 or cam["y"] + cam["h"] >= 0.999):
                small.append(c); cams[id(c)] = cam
    big = [c for c in cl if c not in small and c["presence"] >= 0.4]
    if small and (not big or small[0]["presence"] >= big[0]["presence"]):
        cam = cams[id(small[0])]
        out.update(layout="facecam_top", facecam=cam, confidence=round(min(1, small[0]["presence"] * (0.7 + 0.075 * cam["edges"])), 2),
                   reason=f"Small stable face in {round(small[0]['presence'] * 100)}% of frames: webcam overlay at x={cam['x']:.2f} y={cam['y']:.2f} ({cam['edges']}/4 window edges found)")
    elif len(big) >= 2 and big[1]["presence"] >= 0.4 and big[0]["presence"] + big[1]["presence"] > 1.2:
        out.update(layout="split", facecam=None, speakers=[{"cx": c["cx"], "cy": c["cy"], "w": c["w"], "h": c["h"]} for c in big[:2]], confidence=0.6,
                   reason="Two people on camera most of the time: one per half")
    elif big:
        keys = _smooth_track(tr, big[0])
        out.update(layout="track", facecam=None, track=keys, confidence=round(big[0]["presence"], 2),
                   reason=f"One person on camera ({round(big[0]['presence'] * 100)}% of frames): vertical crop follows them")
    else:
        out.update(layout="blur", facecam=None, confidence=0.5, reason="No face found: full frame over a blurred background")
    return out


def _smooth_track(tr, c, max_speed=0.08):
    """Face x-centre keyframes, smoothed and speed-limited so the crop never jumps around."""
    pts = sorted((t, b[0] + b[2] / 2) for t, b in c["pts"])
    if not pts:
        return [[0, 0.5]]
    keys, last = [], None
    for t, x in pts:
        if last is not None:
            dt = max(0.01, t - last[0])
            x = last[1] + max(-max_speed * dt, min(max_speed * dt, x - last[1]))
            if abs(x - last[1]) < 0.015:  # dead zone: hold still for small moves
                x = last[1]
        keys.append([round(t, 2), round(x, 4)])
        last = keys[-1]
    return keys[:: max(1, len(keys) // 30)]

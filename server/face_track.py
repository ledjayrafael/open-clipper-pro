#!/usr/bin/env python3
"""Track the main face through a clip and print a smoothed 9:16 crop path.

Usage: face_track.py <video> <start_seconds> <duration_seconds>

Prints one JSON object:
  {"width": W, "height": H, "fps": F, "crop_w": CW, "detector": "...",
   "faces_found": N, "samples": S, "x": [crop_x for every output frame]}
or {"error": "..."} when the video cannot be read. Never exits non-zero for
an expected failure, so the caller can fall back to a center crop.
"""
import json
import os
import sys
import urllib.request

try:
    import cv2
except Exception as exc:  # opencv missing
    print(json.dumps({"error": f"opencv import failed: {exc}"}))
    sys.exit(0)

SAMPLE_FPS = 6.0          # detections per second of video
DETECT_WIDTH = 640        # frames are downscaled to this width before detection
EMA_ALPHA = 0.3           # how fast the crop follows the subject (per sample)
DEADZONE_FRAC = 0.03      # ignore moves smaller than this * crop width (anti-jitter)
SNAP_FRAC = 0.35          # a face farther than this * crop width is a different subject
CONTINUITY_WEIGHT = 0.6   # penalty for switching to a face far from the current crop
SCENE_CUT_CORREL = 0.7    # histogram correlation below this between samples = camera cut
SUBJECT_LOST_SECONDS = 1.0  # within a shot, switch subject only after this long without them

MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/face_detector/"
             "blaze_face_short_range/float16/latest/blaze_face_short_range.tflite")
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "blaze_face_short_range.tflite")


def make_detector():
    """MediaPipe Tasks face detector, or OpenCV's bundled Haar cascade as a fallback.

    Returns (name, detect) where detect(bgr_frame) -> list of (cx, area) in frame pixels.
    """
    try:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision

        if not os.path.exists(MODEL_PATH):
            os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
            tmp = MODEL_PATH + ".part"
            urllib.request.urlretrieve(MODEL_URL, tmp)
            os.replace(tmp, MODEL_PATH)

        options = vision.FaceDetectorOptions(
            base_options=mp_python.BaseOptions(model_asset_path=MODEL_PATH),
            min_detection_confidence=0.4,
        )
        detector = vision.FaceDetector.create_from_options(options)

        def detect(frame):
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
            faces = []
            for det in result.detections:
                box = det.bounding_box
                faces.append((box.origin_x + box.width / 2.0, float(box.width * box.height)))
            return faces

        return "mediapipe", detect
    except Exception as exc:  # no mediapipe, no network for the model, ...
        sys.stderr.write(f"mediapipe unavailable, using Haar cascade: {exc}\n")

    cascade = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"))

    def detect(frame):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        boxes = cascade.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=6, minSize=(36, 36))
        return [(x + w / 2.0, float(w * h)) for (x, y, w, h) in boxes]

    return "haar", detect


def pick_face(faces, current_cx, width):
    """Largest face, but prefer staying on the subject we are already on."""
    max_area = max(area for _, area in faces)
    best, best_score = None, None
    for cx, area in faces:
        score = area / max_area
        if current_cx is not None:
            score -= CONTINUITY_WEIGHT * abs(cx - current_cx) / width
        if best_score is None or score > best_score:
            best, best_score = cx, score
    return best


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "usage: face_track.py <video> <start> <duration>"}))
        return
    video, start, duration = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        print(json.dumps({"error": "could not open video"}))
        return
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if fps <= 0 or fps > 240:
        fps = 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    crop_w = int(round(height * 9 / 16)) // 2 * 2
    if crop_w >= width:
        # Source is already 9:16 or narrower: nothing to track.
        print(json.dumps({"width": width, "height": height, "fps": fps, "crop_w": width,
                          "detector": "none", "faces_found": 0, "samples": 0, "x": []}))
        return

    name, detect = make_detector()
    scale = min(1.0, DETECT_WIDTH / float(width))
    step = max(1, int(round(fps / SAMPLE_FPS)))
    total_frames = max(1, int(round(duration * fps)))

    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000.0)
    samples = []  # (frame_index, faces, is_scene_cut)
    previous_hist = None
    for index in range(total_frames):
        if index % step:
            if not cap.grab():
                break
            continue
        ok, frame = cap.read()
        if not ok:
            break
        small = cv2.resize(frame, None, fx=scale, fy=scale) if scale < 1.0 else frame
        faces = [(cx / scale, area) for cx, area in detect(small)]
        # Camera cut: the picture changes a lot between two samples.
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        hist = cv2.calcHist([gray], [0], None, [32], [0, 256])
        cv2.normalize(hist, hist)
        scene_cut = previous_hist is not None and cv2.compareHist(previous_hist, hist, cv2.HISTCMP_CORREL) < SCENE_CUT_CORREL
        previous_hist = hist
        samples.append((index, faces, scene_cut))
    cap.release()

    # Follow one subject: EMA with a deadzone while they are visible. Switch to
    # another face right away after a camera cut, but within a shot only once
    # the current subject has been gone for a while, so the crop does not
    # bounce between people standing in the same frame.
    half = crop_w / 2.0
    snap_dist = SNAP_FRAC * crop_w
    lost_limit = max(1, int(round(SUBJECT_LOST_SECONDS * SAMPLE_FPS)))
    smoothed = None
    fresh = True   # no subject yet, or a camera cut just happened
    lost = 0       # samples since the current subject was last seen
    path = []      # (frame_index, centre, is_jump)
    found = 0
    for index, faces, scene_cut in samples:
        if scene_cut:
            fresh = True
        jump = False
        if faces:
            found += 1
            near = [f for f in faces if smoothed is not None and abs(f[0] - smoothed) <= snap_dist]
            if fresh or (not near and lost + 1 >= lost_limit):
                smoothed = pick_face(faces, None if fresh else smoothed, width)
                jump, fresh, lost = True, False, 0
            elif near:
                target = pick_face(near, smoothed, width)
                if abs(target - smoothed) > DEADZONE_FRAC * crop_w:
                    smoothed += EMA_ALPHA * (target - smoothed)
                lost = 0
            else:
                lost += 1
        else:
            lost += 1
        # No subject: hold the last position (or the centre before any face is seen).
        centre = smoothed if smoothed is not None else width / 2.0
        path.append((index, centre, jump))

    if found == 0:
        path = [(0, width / 2.0, True)]

    # One crop x per output frame: interpolated between samples for smooth
    # pans, but a cut jumps on its own frame instead of whip-panning.
    xs = []
    j = 0
    for index in range(total_frames):
        while j + 1 < len(path) and path[j + 1][0] <= index:
            j += 1
        i0, c0, _ = path[j]
        if j + 1 < len(path) and i0 <= index and not path[j + 1][2]:
            i1, c1, _ = path[j + 1]
            centre = c0 + (c1 - c0) * (index - i0) / float(i1 - i0)
        else:
            centre = c0
        xs.append(int(round(min(max(centre - half, 0), width - crop_w))))

    print(json.dumps({"width": width, "height": height, "fps": fps, "crop_w": crop_w,
                      "detector": name, "faces_found": found, "samples": len(samples), "x": xs}))


if __name__ == "__main__":
    main()

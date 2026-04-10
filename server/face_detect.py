#!/usr/bin/env python3
import sys
import json
import cv2
try:
    import mediapipe as mp
except Exception as e:
    print(json.dumps({"error": "mediapipe import failed", "detail": str(e)}))
    sys.exit(0)

if len(sys.argv) < 2:
    print(json.dumps({"error": "no image path"}))
    sys.exit(0)

img_path = sys.argv[1]
img = cv2.imread(img_path)
if img is None:
    print(json.dumps({"error": "could not read image"}))
    sys.exit(0)

h, w = img.shape[:2]
mp_face = mp.solutions.face_detection
with mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.5) as detector:
    results = detector.process(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))

faces = []
if results.detections:
    for det in results.detections:
        r = det.location_data.relative_bounding_box
        x = max(0.0, r.xmin)
        y = max(0.0, r.ymin)
        rw = max(0.0, r.width)
        rh = max(0.0, r.height)
        xmin = int(x * w)
        ymin = int(y * h)
        bw = int(rw * w)
        bh = int(rh * h)
        cx = int((x + rw/2.0) * w)
        cy = int((y + rh/2.0) * h)
        area = bw * bh
        faces.append({"xmin": xmin, "ymin": ymin, "w": bw, "h": bh, "cx": cx, "cy": cy, "area": area})

# choose largest face if multiple
if len(faces) == 0:
    print(json.dumps({"width": w, "height": h, "face": None}))
else:
    faces.sort(key=lambda f: f['area'], reverse=True)
    print(json.dumps({"width": w, "height": h, "face": faces[0]}))

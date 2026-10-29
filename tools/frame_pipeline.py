#!/usr/bin/env python3
"""Run tensor_detector's real DetectionProcessor offline on frames grabbed from Nereus, recording every stage.

    source ROS + the UWRT workspace, then
    python3 tools/frame_pipeline.py FRAME_PREFIX... --out public/data/frames

FRAME_PREFIX is e.g. /tmp/perc/frames/f0003_ffc (the .jpg, _depth.npz and .json that tools/grab_frames.py saved).
For each frame it writes <name>.json: the image size, intrinsics, and per detection the class, score, box, mask
polygon, the grid samples, the 3D points before and after the depth gate and the outlier passes, the plane normal,
centroid and quaternion; plus the composite results (torpedo center, holes, pairs) as published. And <name>.webp.
"""
import argparse, json, os, sys
from pathlib import Path
import numpy as np, cv2

SRC = Path.home() / 'osu-uwrt/release/src/riptide_perception/tensor_detector'
sys.path.insert(0, str(SRC / 'src'))
import yaml
from ultralytics import YOLO
import detection, pointcloud
from detection import DetectionProcessor, ProcessorConfig, Frame
from pointcloud import CloudColorMode
from builtin_interfaces.msg import Time

cfg = yaml.safe_load(open(SRC / 'config/yolo_orientation.yaml'))['/**/yolo_orientation']['ros__parameters']
WEIGHTS = Path.home() / 'osu-uwrt/release/install/tensor_detector/share/tensor_detector/weights'

class Log:
    def info(self, *a, **k): pass
    debug = warning = error = info

class FakeTF:
    def lookup_transform(self, *a, **k): raise RuntimeError('offline')

# Record each extract() call's stages by wrapping the builder's internals
STAGES = []
orig_extract = pointcloud.PointCloudBuilder.extract
orig_depth = pointcloud.PointCloudBuilder._depth_filter
orig_outlier = pointcloud.PointCloudBuilder._outlier_indices
def depth_filter(self, pts, rgb):
    STAGES[-1]['raw'] = pts.copy()
    out = orig_depth(self, pts, rgb)
    STAGES[-1]['gated'] = out[0].copy()
    return out
def outlier(self, pts):
    idx = orig_outlier(self, pts)
    STAGES[-1]['kept'] = pts[idx].copy()
    return idx
def extract(self, frame, feature_points, mask, class_name=None):
    STAGES.append({'class': class_name, 'samples': [list(map(float, p)) for p in feature_points]})
    return orig_extract(self, frame, feature_points, mask, class_name)
pointcloud.PointCloudBuilder.extract = extract
pointcloud.PointCloudBuilder._depth_filter = depth_filter
pointcloud.PointCloudBuilder._outlier_indices = outlier

GRID, MARGIN = 8, 6

def r(a, n=4):
    return np.round(np.asarray(a, dtype=float), n).tolist()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('frames', nargs='+')
    ap.add_argument('--out', required=True)
    ap.add_argument('--table-pair', action='store_true')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    models = {}
    for prefix in args.frames:
        meta = json.load(open(prefix + '.json'))
        cam = meta['cam']
        if cam not in models:
            models[cam] = YOLO(str(WEIGHTS / cfg[f'{cam}_model']), task='segment')
        model = models[cam]
        cmap = yaml.safe_load(cfg[f'{cam}_class_id_map'])
        conf, iou = cfg[f'{cam}_threshold'], cfg[f'{cam}_iou']
        img = cv2.imread(prefix + '.jpg')
        depth = np.load(prefix + '_depth.npz')['depth'].astype(np.float32)
        K = np.array(meta['K']).reshape(3, 3)
        proc = DetectionProcessor(ProcessorConfig(class_detect_shrink=0.0, min_points=5, slalom_history_size=1, grid_step=8,
                                                  max_sample_points=500, cloud_color_mode=CloudColorMode.CLASS,
                                                  publish_box_markers=False), Log(), lambda: None, FakeTF())
        proc.set_torpedo_enabled(cam == 'ffc')
        if args.table_pair:
            proc.set_table_pair_enabled(True)
        results = model(img, verbose=False, conf=conf, iou=iou)
        frame = Frame(image=img.copy(), depth=depth, fx=K[0, 0], fy=K[1, 1], cx=K[0, 2], cy=K[1, 2], K=K,
                      frame_id=meta["frame_id"], timestamp=Time(sec=1), class_id_map=cmap, conf=conf,
                      want_markers=False, want_cloud=False, want_overlay_points=False)
        STAGES.clear()
        dets, _ = proc.process(results, frame)
        res = results[0]
        boxes = []
        for i, b in enumerate(res.boxes.cpu().numpy()):
            poly = res.masks.xy[i] if res.masks is not None else []
            step = max(1, len(poly) // 80)
            # Depth on the detector's own sample grid (aligned to the box corner, grid_step 8 px), MARGIN steps past
            # the box on every side, so the page can resample with a grown mask and show the background bleed
            x_min, y_min, x_max, y_max = map(int, b.xyxy[0])
            gx0, gy0 = x_min - MARGIN * GRID, y_min - MARGIN * GRID
            xs = np.arange(gx0, x_max + MARGIN * GRID + 1, GRID)
            ys = np.arange(gy0, y_max + MARGIN * GRID + 1, GRID)
            H, W = depth.shape[:2]
            zs = []
            for y in ys:
                for x in xs:
                    z = float(depth[y, x]) if 0 <= x < W and 0 <= y < H else 0.0
                    zs.append(round(z, 4) if np.isfinite(z) and z > 0 else 0)
            boxes.append({'class': cmap.get(int(b.cls[0]), '?'), 'score': round(float(b.conf[0]), 3),
                          'box': r(b.xyxy[0], 1), 'mask': r(poly[::step], 1),
                          'grid': {'x0': int(gx0), 'y0': int(gy0), 'nx': len(xs), 'ny': len(ys), 'step': GRID, 'z': zs}})
        stages = [{'class': s['class'], 'samples': r(s['samples'], 1),
                   'raw': r(s.get('raw', []), 4), 'gated': r(s.get('gated', []), 4), 'kept': r(s.get('kept', []), 4)}
                  for s in STAGES]
        published = []
        for d in dets.detections:
            h = d.results[0]
            p, q = h.pose.pose.position, h.pose.pose.orientation
            published.append({'class': h.hypothesis.class_id, 'score': round(float(h.hypothesis.score), 3),
                              'p': r([p.x, p.y, p.z]), 'q': r([q.x, q.y, q.z, q.w])})
        name = Path(prefix).name
        H, W = img.shape[:2]
        out = {'name': name, 'cam': cam, 'size': [W, H], 'K': r(K.flatten(), 3), 'boxes': boxes, 'stages': stages,
               'published': published, 'live': meta['dets']}
        json.dump(out, open(f'{args.out}/{name}.json', 'w'), separators=(',', ':'))
        cv2.imwrite(f'{args.out}/{name}.webp', cv2.resize(img, (W // 2, H // 2), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_WEBP_QUALITY, 80])
        print(name, [b['class'] for b in boxes], '->', [p['class'] for p in published])

main()

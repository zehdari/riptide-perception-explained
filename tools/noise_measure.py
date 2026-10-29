#!/usr/bin/env python3
"""Detection scatter against range from the Nereus holds (tour.py *_hold.json), along and across the camera ray.

    python3 tools/noise_measure.py /tmp/perc/tour/*_hold.json -o public/data/noise_measured.json

Each hold keeps Talos still (MPC position hold) at one distance from a prop for 15 s. Every detection is moved into the
map frame with TF at its stamp (so the robot's own small motion drops out), and its scatter about the hold's mean is
split into the component along the camera ray and the two across it.
"""
import argparse, json, math
import numpy as np
from scipy.spatial.transform import Rotation as Rot
ap = argparse.ArgumentParser(); ap.add_argument('holds', nargs='+'); ap.add_argument('-o', required=True)
args = ap.parse_args()
rows = []
for f in args.holds:
    h = json.load(open(f))
    by = {}
    for d in h['dets']:
        if d['cam_map'] is None: continue
        by.setdefault(d['c'], []).append(d)
    for cls, ds in by.items():
        if len(ds) < 15: continue
        pc = np.array([d['p'] for d in ds])
        pm = np.array([Rot.from_quat(d['cam_map'][3:]).apply(d['p']) + np.array(d['cam_map'][:3]) for d in ds])
        cam = np.array([d['cam_map'][:3] for d in ds]).mean(0)
        mean = pm.mean(0); ray = mean - cam; r = float(np.linalg.norm(ray)); ray /= r
        dev = pm - mean
        along = dev @ ray
        across = dev - np.outer(along, ray)
        # camera-frame too (includes the robot's own motion)
        devc = pc - pc.mean(0); rayc = pc.mean(0) / np.linalg.norm(pc.mean(0)); alc = devc @ rayc
        rows.append({'hold': f.split('/')[-1].replace('_hold.json', ''), 'class': cls, 'n': len(ds), 'range': round(r, 3),
                     'std_along': round(float(along.std(ddof=1)), 5), 'std_across': round(float(np.sqrt((across ** 2).sum(1).mean() / 2)), 5),
                     'std_along_cam': round(float(alc.std(ddof=1)), 5), 'span_s': round(ds[-1]['t'] - ds[0]['t'], 2),
                     'rate_hz': round((len(ds) - 1) / max(ds[-1]['t'] - ds[0]['t'], 1e-3), 2)})
rows.sort(key=lambda x: (x['class'], x['range']))
for x in rows: print(x)
json.dump({'source': 'Nereus, Talos holding still with the MPC at each distance for 15 s; scatter in the map frame', 'rows': rows}, open(args.o, 'w'), indent=0)

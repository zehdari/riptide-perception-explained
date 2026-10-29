#!/usr/bin/env python3
"""Copy a few Nereus synthetic training samples (image + YOLO-seg polygons) into the site.

    python3 tools/train_samples.py

Reads ~/datasets/robosub2026_{ffc,dfc}/yolo-seg (made by `nereus-dataset generate`), writes
public/img/train/<name>.webp (960 px wide) and public/data/train_samples.json: for each sample its camera,
size, and every label as [class name, [x0, y0, x1, y1, ...]] in normalized image coordinates (polygons thinned).
"""
import json, os
from pathlib import Path
import cv2, yaml

HOME = Path.home()
OUT = Path(__file__).resolve().parents[1] / 'public'
PICKS = [('ffc', 'torpedo_004908'), ('ffc', 'slalom_002540'), ('ffc', 'gate_000395'), ('ffc', 'bins_008475'),
         ('ffc', 'surface_006500'), ('ffc', 'background_009000'), ('dfc', 'table_003000'), ('dfc', 'bins_001200')]
samples = []
for cam, name in PICKS:
    root = HOME / f'datasets/robosub2026_{cam}/yolo-seg'
    names = yaml.safe_load(open(root / 'data.yaml'))['names']
    img = lbl = None
    for split in ('train', 'val'):
        if (root / f'images/{split}/{name}.jpg').exists():
            img, lbl = root / f'images/{split}/{name}.jpg', root / f'labels/{split}/{name}.txt'
    if img is None:
        # nearest existing sample of that task
        task = name.rsplit('_', 1)[0]
        cand = sorted(f for f in os.listdir(root / 'images/train') if f.startswith(task + '_'))
        name = cand[len(cand) // 3][:-4]
        img, lbl = root / f'images/train/{name}.jpg', root / f'labels/train/{name}.txt'
    im = cv2.imread(str(img))
    h, w = im.shape[:2]
    cv2.imwrite(str(OUT / f'img/train/{name}.webp'), cv2.resize(im, (960, int(h * 960 / w)), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_WEBP_QUALITY, 78])
    labels = []
    for line in open(lbl) if lbl.exists() else []:
        v = list(map(float, line.split()))
        pts = v[1:]
        step = max(1, len(pts) // 2 // 60)
        thin = [round(p, 4) for i in range(0, len(pts) // 2, step) for p in pts[2 * i:2 * i + 2]]
        labels.append([names[int(v[0])], thin])
    samples.append({'name': name, 'cam': cam, 'size': [w, h], 'labels': labels})
    print(cam, name, [l[0] for l in labels])
json.dump(samples, open(OUT / 'data/train_samples.json', 'w'), separators=(',', ':'))

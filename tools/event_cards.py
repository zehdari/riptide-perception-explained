#!/usr/bin/env python3
"""Snapshots of the annotated YOLO stream at each mapping or tree event, for the overview's replay.

    python3 tools/event_cards.py HERO_JSON FRAMES_DIR OUT_DIR PREFIX

FRAMES_DIR is what tools/nereus/annot_video.py leaves next to its mp4 (NNNNNN.jpg + list.txt). Adds 'cards' to the
hero JSON: [t, image, text, kind] where kind is 'map' (mapping's log) or 'tree' (the behaviour tree).
"""
import json, os, re, sys, bisect
import cv2
hero, fdir, out, prefix = sys.argv[1:5]
d = json.load(open(hero))
files, durs = [], []
for line in open(f'{fdir}/list.txt'):
    if line.startswith('file'): files.append(line.split("'")[1])
    elif line.startswith('duration'): durs.append(float(line.split()[1]))
t0 = d.get('video', {}).get('t0', 0.028)
times = [t0]
for x in durs[:-1]: times.append(times[-1] + x)
MAP = re.compile(r'agree|reacquir|released|Moved table|bin fit:|BinaryClassifier started|moved \d+ cm|centered')
TREE = re.compile(r'^(Searching for|Chasing|Lost sight|.* found$|.* in view)')
events = [(t, m, 'map') for t, lvl, m in d['log'] if MAP.search(m)]
events += [(t, m, 'tree') for t, m in d.get('tree_log', []) if TREE.search(m)]
events.sort()
os.makedirs(out, exist_ok=True)
cards, last = [], -1e9
for t, msg, kind in events:
    if t - last < 2.5: continue
    i = max(0, bisect.bisect_right(times, t + 0.3) - 1)
    img = cv2.imread(files[i])
    if img is None: continue
    img = cv2.resize(img, (480, int(img.shape[0] * 480 / img.shape[1])), interpolation=cv2.INTER_AREA)
    name = f'{prefix}_{len(cards):03d}.webp'
    cv2.imwrite(f'{out}/{name}', img, [cv2.IMWRITE_WEBP_QUALITY, 72])
    cards.append([round(t, 2), name, msg, kind]); last = t
d['cards'] = cards
d.pop('video', None)
json.dump(d, open(hero, 'w'), separators=(',', ':'))
print(len(cards), 'cards', sum(os.path.getsize(f'{out}/{c[1]}') for c in cards) // 1024, 'KB')

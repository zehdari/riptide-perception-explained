#!/usr/bin/env python3
"""Cut a mission JSON (tools/bag_to_mission.py) down to what the overview's replay draws.

    python3 tools/hero_data.py MISSION_JSON OUT_JSON [--video public/video/x.mp4 --video-t0 S]

Aligns mapping's log lines (wall clock) to the mission clock by matching each 'reset <name>' line to the
mapping target change that caused it, and derives the mission's phases from the targets.
"""
import argparse, json, re
import numpy as np
ap = argparse.ArgumentParser()
ap.add_argument('mission'); ap.add_argument('out')
ap.add_argument('--video'); ap.add_argument('--video-t0', type=float, default=0.0)
args = ap.parse_args()
d = json.load(open(args.mission))
PROPS = ['gate', 'slalom_parent', 'torpedo', 'bin', 'table']
TASK = {'gate': 'gate', 'slalom_parent': 'slalom', 'torpedo': 'torpedo', 'bin': 'bins', 'table': 'table'}

# log alignment: wall time of 'reset X' ~ mission time of the first target change naming X after the previous match
resets = [(w, m.group(1)) for w, lvl, msg in d.get('log_wall', []) if (m := re.match(r'reset (\w+)$', msg))]
changes = [(t, [s.strip() for s in tg.split(',') if s.strip()]) for t, tg, lock in d['targets']]
pairs = []; j = 0
for w, name in resets:
    while j < len(changes) and name not in changes[j][1]: j += 1
    if j < len(changes): pairs.append(w - changes[j][0])
# the sim clock runs on the wall clock's epoch: start from t0, refine with the close matches only
close = [p for p in pairs if abs(p - d['t0']) < 5]
off = float(np.median(close)) if close else d['t0']
print('log offset - t0', off - d['t0'], 'from', len(close), 'of', len(pairs), 'matches, residuals', [round(p - off, 2) for p in close])
log = [[round(w - off, 2), lvl, msg] for w, lvl, msg in d.get('log_wall', []) if lvl != 'TREE']
tree_log = [[round(w - off, 2), msg] for w, lvl, msg in d.get('log_wall', []) if lvl == 'TREE']

# phases: runs of the primary target's task
def task_of(name):
    for k, v in [('gate', 'Gate'), ('slalom', 'Slalom'), ('torpedo', 'Torpedo'), ('hole', 'Torpedo'), ('bin', 'Bins'), ('magnet', 'Bins'),
                 ('table', 'Table'), ('pill', 'Table'), ('plug', 'Table'), ('bandage', 'Table'), ('helmet', 'Table'), ('warning', 'Table'), ('nut', 'Table'),
                 ('octagon', 'Octagon'), ('return', 'Home')]:
        if k in name: return v
    return None
starts = []
for t, names in changes:
    task = next((task_of(n) for n in names if task_of(n)), None)
    if task: starts.append((t, task))
TREE_PHASE = {'GATE TIME': 'Gate', 'BIN TIME': 'Bins', 'WINNING TIME': 'Home', 'TORPEDO TIME': 'Torpedo', 'TABLE TIME': 'Table'}
starts += [(t, TREE_PHASE[m]) for t, m in tree_log if m in TREE_PHASE]
phases = []
for t, task in sorted(starts):
    if phases and phases[-1][2] == task: continue
    phases.append([t, None, task])
dur = max(r[0] for r in d['truth_path'])
for i, p in enumerate(phases): p[1] = phases[i + 1][0] if i + 1 < len(phases) else dur
# the first phase begins when the robot starts moving
out = {
    'duration': round(dur, 1),
    'course': [p for p in d['course'] if p['task'] in TASK.values()],
    # the priors the run actually used: each map object's first published pose (offset still zero)
    'priors': {k: {'parent': 'map', 'p': d['estimates'][k]['rows'][0][1:4]} for k in PROPS if k in d['estimates']},
    'estimates': {k: {'rows': [r[:8] for r in d['estimates'][k]['rows']]} for k in PROPS if k in d['estimates']},
    'detections': [{k: x[k] for k in ('t', 'c', 'p', 'f')} for x in d['detections'] if x.get('f') == 'map' and x['c'] in PROPS],
    'truth_path': [r for r in d['truth_path']],
    'targets': d['targets'], 'offset': d['offset'], 'log': log, 'tree_log': tree_log, 'phases': phases,
}
xs = [p['position_m'][0] for p in out['course']] + [r[1] for r in out['truth_path']]
ys = [p['position_m'][1] for p in out['course']] + [r[2] for r in out['truth_path']]
out['box'] = [min(xs) - 1.5, min(ys) - 1.5, max(xs) + 1.5, max(ys) + 1.5]
if args.video: out['video'] = {'src': args.video.replace('public/', ''), 't0': args.video_t0}
json.dump(out, open(args.out, 'w'), separators=(',', ':'))
print('wrote', args.out, 'phases', [(round(a), p) for a, b, p in phases])

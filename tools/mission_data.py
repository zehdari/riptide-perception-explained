#!/usr/bin/env python3
"""Chapter 8's data: per-prop error against the simulator's truth, the offset, targets and mapping's log, for both runs.

    python3 tools/mission_data.py SHIFTED_MISSION_JSON SHIFTED_HERO_JSON EXACT_MISSION_JSON EXACT_HERO_JSON OUT_JSON --shift 0.6,-0.4
"""
import argparse, json, math
ap = argparse.ArgumentParser()
ap.add_argument('m2'); ap.add_argument('h2'); ap.add_argument('m1'); ap.add_argument('h1'); ap.add_argument('out')
ap.add_argument('--shift', default='0.6,-0.4')
a = ap.parse_args()
PROPS = {'gate': 'gate', 'slalom_parent': 'slalom', 'torpedo': 'torpedo', 'bin': 'bins', 'table': 'table'}
def run(mp, hp, shift):
    m = json.load(open(mp)); h = json.load(open(hp))
    truth = {p['task']: p['position_m'] for p in m['course']}
    props = {}
    for name, task in PROPS.items():
        rows = m['estimates'][name]['rows']; tr = truth[task]
        prior = rows[0][1:4]
        ser = []
        last = None
        for r in rows:
            t, x, y, z, vx, vy = r[:6]
            if last is not None and t - last < 1.0: continue
            last = t
            ser.append([round(t, 1), round(math.hypot(x - tr[0], y - tr[1]), 3), round(2 * math.sqrt(max(vx + vy, 0)), 3) if vx < 0.999 else None])
        f = rows[-1]
        props[name] = {'truth': tr, 'prior': prior, 'final': f[1:4], 'final_err': round(math.hypot(f[1] - tr[0], f[2] - tr[1]), 3),
                       'prior_err': round(math.hypot(prior[0] - tr[0], prior[1] - tr[1]), 3), 'series': ser,
                       'final_sigma': round(math.sqrt(max(f[4] + f[5], 0)), 3), 'confirmed': f[4] < 0.999}
    off = [[round(r[0], 1), round(r[1], 3), round(r[2], 3)] for i, r in enumerate(m['offset']) if i % 4 == 0]
    return {'props': props, 'offset': off, 'shift': shift, 'duration': h['duration'], 'phases': h['phases'], 'log': h['log'],
            'targets': m['targets'], 'tree_log': h.get('tree_log', [])}
out = {'shifted': run(a.m2, a.h2, [float(v) for v in a.shift.split(',')]), 'exact': run(a.m1, a.h1, [0, 0])}
json.dump(out, open(a.out, 'w'), separators=(',', ':'))
for k, v in out.items():
    print(k, {n: (p['prior_err'], p['final_err'], p['final_sigma'], p['confirmed']) for n, p in v['props'].items()}, 'offset', v['offset'][-1])

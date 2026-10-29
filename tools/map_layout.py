#!/usr/bin/env python3
"""Extract Talos's RoboSub 2026 prior layout (riptide_mapping config.yaml, /talos init_data) for the course-map figures.

    python3 tools/map_layout.py [config.yaml] > public/data/map_layout.json

Default config: the installed riptide_mapping2 share (the RoboSub layout Nereus's course matches; the
mapping-estimator branch's src config has the table moved for RPAC testing).
"""
import json, sys, yaml
from pathlib import Path

path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / 'osu-uwrt/release/install/riptide_mapping2/share/riptide_mapping2/config/config.yaml'
d = yaml.safe_load(open(path))['/talos/riptide_mapping2']['ros__parameters']['init_data']
out = {}
for name, o in d.items():
    p = o['pose']
    out[name] = {'parent': o['parent'], 'p': [round(p['x'], 4), round(p['y'], 4), round(p['z'], 4)], 'yaw': round(p['yaw'], 3)}
    for k in ('lock_orientation_to_config', 'point_yaw_at_parent'):
        if o.get(k):
            out[name][k] = True
print(json.dumps(out, separators=(',', ':')))

#!/usr/bin/env python3
"""Turn a Nereus mission bag (tools/record: mapping/*, detected_objects, TF, truth, odometry) into the site's JSON.

    source ROS + the UWRT workspace, then
    python3 tools/bag_to_mission.py BAG RESOLVED_JSON OUT_JSON [--log JOURNAL_TXT] [--objects gate,torpedo,...]

Writes: the robot path (truth and EKF, 2 Hz), each object's published estimate (mean, covariance diagonal, 4 Hz and on
every change of target), map -> offset, every detection fused or not (class, range, position in its object's parent
frame at its stamp), the mapping targets over time, the behavior-tree stack, the truth course from the resolved
scenario, and (with --log) mapping's own log lines with their times.
"""
import argparse, json, math, re
from collections import defaultdict
import numpy as np
import rosbag2_py
from rclpy.serialization import deserialize_message
from rosidl_runtime_py.utilities import get_message
from rclpy.duration import Duration
from rclpy.time import Time
import tf2_ros
from tf2_geometry_msgs import do_transform_pose_stamped
from geometry_msgs.msg import PoseStamped

ap = argparse.ArgumentParser()
ap.add_argument('bag'); ap.add_argument('resolved'); ap.add_argument('out')
ap.add_argument('--log'); ap.add_argument('--config', default='/home/cameron/osu-uwrt/release/src/riptide_perception/riptide_mapping/config/config.yaml')
args = ap.parse_args()

import yaml
init = yaml.safe_load(open(args.config))['/talos/riptide_mapping2']['ros__parameters']['init_data']
parent = {k: v['parent'] for k, v in init.items()}

reader = rosbag2_py.SequentialReader()
reader.open(rosbag2_py.StorageOptions(uri=args.bag, storage_id=''), rosbag2_py.ConverterOptions('cdr', 'cdr'))
types = {t.name: t.type for t in reader.get_all_topics_and_types()}
# images and clouds are big and slow to deserialize: skip them here (tools/annot_video.py reads the images)
reader.set_filter(rosbag2_py.StorageFilter(topics=[t for t in types if not t.endswith(('/compressed', '/point_cloud', 'visualization_marker_array', 'planned_path'))]))
buf = tf2_ros.Buffer(cache_time=Duration(seconds=7200))
msgs = defaultdict(list)
def st(h): return h.stamp.sec + h.stamp.nanosec * 1e-9
while reader.has_next():
    topic, data, t = reader.read_next()
    m = deserialize_message(data, get_message(types[topic]))
    if topic in ('/tf', '/tf_static'):
        for tr in m.transforms:
            if topic == '/tf_static': buf.set_transform_static(tr, 'bag')
            else: buf.set_transform(tr, 'bag')
            if tr.child_frame_id == 'offset' and topic == '/tf':
                msgs['offset'].append((st(tr.header), [tr.transform.translation.x, tr.transform.translation.y, tr.transform.translation.z]))
        continue
    msgs[topic].append((t * 1e-9, m))

R = lambda v, n=3: [round(float(x), n) for x in v]
out = {}
# time base: sim clock (message stamps); t0 = first tree stack message or first odom
odom = msgs['/talos/odometry/filtered']; truth = msgs['/talos/simulator/ground_truth']
stack = msgs['/talos/autonomy/tree_stack']
t0 = st(odom[0][1].header)
out['t0'] = t0
def thin(seq, dt):
    last = -1e9; res = []
    for s, m in seq:
        if s - last >= dt: res.append((s, m)); last = s
    return res
pose = lambda m: m.pose.pose
out['truth_path'] = [[round(st(m.header) - t0, 2)] + R([pose(m).position.x, pose(m).position.y, pose(m).position.z]) +
                     [round(math.atan2(2 * (pose(m).orientation.w * pose(m).orientation.z + pose(m).orientation.x * pose(m).orientation.y),
                                       1 - 2 * (pose(m).orientation.y ** 2 + pose(m).orientation.z ** 2)), 3)]
                     for _, m in thin([(st(m.header), m) for _, m in truth], 0.5)]
out['ekf_path'] = [[round(st(m.header) - t0, 2)] + R([pose(m).position.x, pose(m).position.y, pose(m).position.z])
                   for _, m in thin([(st(m.header), m) for _, m in odom], 0.5)]
out['truth_frame'] = truth[0][1].header.frame_id; out['ekf_frame'] = odom[0][1].header.frame_id

# targets over time
tg = []
for _, m in msgs['/talos/state/mapping']:
    pass
for t, m in msgs['/talos/state/mapping']:
    v = [m.target_object, bool(m.lock_map)]
    if not tg or tg[-1][1:] != v: tg.append([round(t - t0, 2)] + v)
out['targets'] = tg  # (bag receive time; sim clock ~ same with use_sim_time)

# tree stack
ts = []
for t, m in stack:
    s = list(m.stack)
    if not ts or ts[-1][1] != s: ts.append([round(t - t0, 2), s])
out['tree'] = ts

# estimates
est = {}
for topic, seq in msgs.items():
    if not topic.startswith('/talos/mapping/') or topic.endswith('/fused'): continue
    name = topic.split('/')[-1]
    rows = []; last = None
    for _, m in seq:
        p = m.pose.pose.position; c = m.pose.covariance
        q = m.pose.pose.orientation
        yaw = math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y ** 2 + q.z ** 2))
        row = [round(st(m.header) - t0, 2)] + R([p.x, p.y, p.z]) + [float('%.3g' % c[0]), float('%.3g' % c[7]), float('%.3g' % c[14]), float('%.3g' % c[1]), round(yaw, 3), float('%.3g' % c[35])]
        if last is None or row[0] - last[0] >= 0.25 or any(abs(a - b) > 1e-3 for a, b in zip(row[1:7], last[1:7])):
            rows.append(row); last = row
    est[name] = {'frame': seq[0][1].header.frame_id, 'rows': rows}
out['estimates'] = est
out['estimate_cols'] = ['t', 'x', 'y', 'z', 'var_x', 'var_y', 'var_z', 'cov_xy', 'yaw', 'var_yaw']
out['offset'] = [[round(s - t0, 2)] + R(v) for s, v in thin(msgs['offset'], 0.25)]

# fused
fz = []
for t, m in msgs['/talos/mapping/fused']:
    fz.append([round(t - t0, 2), m.data])
out['fused'] = fz

# detections: position in the object's parent frame at the detection stamp
dets = []; miss = 0
for _, m in msgs['/talos/detected_objects']:
    for d in m.detections:
        for r in d.results:
            cls = r.hypothesis.class_id
            p = r.pose.pose.position
            rng = math.sqrt(p.x ** 2 + p.y ** 2 + p.z ** 2)
            row = {'t': round(st(m.header) - t0, 3), 'c': cls, 's': round(r.hypothesis.score, 2), 'r': round(rng, 3), 'cam': 'dfc' if 'dfc' in m.header.frame_id else 'ffc'}
            par = parent.get(cls)
            if par:
                ps = PoseStamped(); ps.header = m.header; ps.pose = r.pose.pose
                try:
                    tr = buf.lookup_transform(par, m.header.frame_id, Time.from_msg(m.header.stamp))
                    q = do_transform_pose_stamped(ps, tr).pose.position
                    row['p'] = R([q.x, q.y, q.z]); row['f'] = par
                    trw = buf.lookup_transform('map', m.header.frame_id, Time.from_msg(m.header.stamp))
                    row['cam_map'] = R([trw.transform.translation.x, trw.transform.translation.y, trw.transform.translation.z])
                except Exception as e:
                    miss += 1
            dets.append(row)
out['detections'] = dets
print('detections', len(dets), 'tf misses', miss)

# truth course
res = json.load(open(args.resolved))
out['course'] = res['scenario']['task_placements']
out['task_frames'] = res['scenario'].get('task_frames', [])
out['priors'] = {k: {'parent': v['parent'], 'p': R([v['pose']['x'], v['pose']['y'], v['pose']['z']]), 'yaw': v['pose']['yaw']} for k, v in init.items()}

if args.log:
    lines = []
    for line in open(args.log):
        mm = re.search(r'\[(INFO|WARN|ERROR)\] \[(\d+\.\d+)\] \[talos\.riptide_mapping2\]: (.*)', line)
        if mm: lines.append([float(mm.group(2)), mm.group(1), mm.group(3).strip()])
        mm = re.search(r'\[(INFO|WARN|ERROR)\] \[(\d+\.\d+)\] \[talos\.autonomy\]: (Setting mapping.*|Performing.*|[A-Z ]{3,} TIME.*)', line)
        if mm: lines.append([float(mm.group(2)), 'TREE', mm.group(3).strip()])
    out['log_wall'] = lines
json.dump(out, open(args.out, 'w'), separators=(',', ':'))
print('wrote', args.out, sum(len(v['rows']) for v in est.values()), 'estimate rows')

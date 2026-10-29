#!/usr/bin/env python3
"""Golden data for the JS port: runs the real riptide_mapping2 map_estimator / binary_classifier and the detector's
geometry on seeded scenarios, records every input and output.

    python3 tools/golden.py [--perception ~/osu-uwrt/release/src/riptide_perception]

Writes public/data/golden_estimator.json and public/data/golden_geometry.json.
"""
import argparse
import json
import math
import os
import sys
from pathlib import Path

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("--perception", default=os.path.expanduser("~/osu-uwrt/release/src/riptide_perception"))
args = ap.parse_args()
sys.path.insert(0, os.path.join(args.perception, "riptide_mapping/riptide_mapping2"))
sys.path.insert(0, os.path.join(args.perception, "tensor_detector/src"))

from map_estimator import MapEstimator, ObjectSpec, detection_covariance, NoiseSettings  # noqa: E402
from binary_classifier import BinaryClassifier, DetectionSample  # noqa: E402
import geometry  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "public" / "data"
L = lambda a: np.asarray(a, dtype=float).tolist()  # noqa: E731


def yaw_rot(psi):
    c, s = math.cos(psi), math.sin(psi)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


# A slice of the Talos course (config.yaml init_data)
SPECS = {
    "gate": ObjectSpec("map", np.array([4.810167, -2.217889, -0.75]), math.radians(170.645069)),
    "slalom_parent": ObjectSpec("map", np.array([8.332382, 0.560795, -1.3]), math.radians(-152.691724), True),
    "torpedo": ObjectSpec("map", np.array([18.352, 2.481, -1.372]), math.radians(-169.8)),
    "gate_repair": ObjectSpec("gate_frame", np.array([0.0, -0.75, 0.5]), 0.0),
}


class Recorder:
    def __init__(self, title, watch, seed):
        self.est = MapEstimator(SPECS)
        self.rng = np.random.default_rng(seed)
        self.title = title
        self.watch = watch
        self.ops = []
        self.stamp = 0.0
        self.noise = NoiseSettings()

    def snapshot(self):
        e = self.est
        snap = {"positions": {}, "yaws": {}}
        for name in self.watch:
            m, c = e.position(name)
            snap["positions"][name] = [L(m), L(c)]
            snap["yaws"][name] = list(e.yaw(name))
        o, oc = e.offset()
        snap["offset"] = [L(o), L(oc)]
        snap["course_yaw"] = list(e.course_yaw())
        snap["released"] = {n: bool(e.released(n)) for n in self.watch if e.is_map_object(n)}
        snap["confirmed"] = {n: bool(e.confirmed(n)) for n in self.watch}
        return snap

    def detect(self, name, truth, cam, cam_yaw=0.0, targeted=True, dt=0.1, travel=0.05, w=0.1, v=0.2, yaw=None):
        self.stamp += dt
        self.est.predict(travel, dt)
        rot = yaw_rot(cam_yaw)
        p_cam = rot.T @ (np.asarray(truth) - np.asarray(cam))
        cov = detection_covariance(p_cam, rot, w, v, self.noise)
        z = self.rng.multivariate_normal(np.asarray(truth), cov)
        yaw_var = math.radians(self.noise.yaw_std_deg) ** 2 if yaw is not None else None
        yv = None if yaw is None else float(yaw + self.rng.normal(0, math.radians(3)))
        accepted, reason = self.est.observe(name, self.stamp, z, cov, yv, yaw_var, targeted)
        self.ops.append({"op": "observe", "predict": [travel, dt], "name": name, "stamp": self.stamp,
                         "position": L(z), "cov": L(cov), "yaw": yv, "yaw_var": yaw_var, "targeted": targeted,
                         "cov_inputs": [L(p_cam), L(rot), w, v],
                         "accepted": bool(accepted), "reason": reason, "after": self.snapshot()})

    def predict(self, distance, dt):
        self.stamp += dt
        self.est.predict(distance, dt)
        self.ops.append({"op": "predict", "distance": distance, "dt": dt, "after": self.snapshot()})

    def reset(self, name, verify=False):
        self.est.reset(name, verify)
        self.ops.append({"op": "reset", "name": name, "verify": verify, "after": self.snapshot()})

    def dump(self):
        return {"title": self.title, "watch": self.watch, "ops": self.ops}


def truth_of(name, offset, deviation=(0, 0, 0), course_yaw=0.0):
    return yaw_rot(course_yaw) @ SPECS[name].position + np.asarray(offset) + np.asarray(deviation)


scenarios = []

# (a) one map object: a stray detection, then 30 noisy ones
r = Recorder("acquire", ["gate"], 1)
off = np.array([0.4, -0.3, 0.05])
gate = truth_of("gate", off)
cam = gate + np.array([-2.5, 0.3, 0.2])
r.detect("gate", gate + np.array([1.8, 1.0, 0.0]), cam, yaw=math.radians(170))
for _ in range(30):
    r.detect("gate", gate, cam, yaw=math.radians(172))
    cam = cam + np.array([0.05, 0.0, 0.0])
# rejections in a row until it reacquires
for _ in range(32):
    r.detect("gate", gate + np.array([0.0, 1.2, 0.0]), cam)
scenarios.append(r.dump())

# (b) three props, the torpedo's prior 1.5 m off: it is released
r = Recorder("released", ["gate", "slalom_parent", "torpedo"], 2)
off = np.array([0.5, 0.2, 0.0])
for name, dev in (("gate", (0, 0, 0)), ("slalom_parent", (0.05, -0.05, 0)), ("torpedo", (1.2, -0.9, 0))):
    t = truth_of(name, off, dev)
    cam = t + np.array([-2.0, 0.2, 0.1])
    for _ in range(14):
        r.detect(name, t, cam, travel=0.03)
    r.reset(name)
    r.predict(6.0, 15.0)
# background detections of the gate while nothing targets it
t = truth_of("gate", off)
for _ in range(6):
    r.detect("gate", t, t + np.array([-3.0, 0, 0]), targeted=False)
scenarios.append(r.dump())

# (c) drift: see the gate, travel 40 m while odometry drifts 0.6 m, revisit
r = Recorder("drift", ["gate", "torpedo"], 3)
off = np.array([0.2, 0.1, 0.0])
t = truth_of("gate", off)
for _ in range(15):
    r.detect("gate", t, t + np.array([-2.0, 0.0, 0.0]))
r.reset("gate")
for _ in range(8):
    r.predict(5.0, 6.0)
off2 = off + np.array([0.5, -0.33, 0.02])
t = truth_of("gate", off2)
for _ in range(15):
    r.detect("gate", t, t + np.array([2.0, 0.5, 0.0]), cam_yaw=math.pi)
scenarios.append(r.dump())

# (d) a child-frame object, in its parent frame
r = Recorder("child", ["gate_repair"], 4)
t = SPECS["gate_repair"].position + np.array([0.1, 0.08, -0.03])
for _ in range(20):
    r.detect("gate_repair", t, np.array([-2.0, 0.0, 0.0]), yaw=0.1)
r.reset("gate_repair")
for _ in range(5):
    r.detect("gate_repair", t, np.array([-1.5, 0.0, 0.0]))
scenarios.append(r.dump())

# (e) verify after retarget: a few that agree confirm it; then it moved
r = Recorder("verify", ["gate", "gate_repair"], 5)
off = np.array([-0.3, 0.25, 0.0])
t = truth_of("gate", off)
for _ in range(15):
    r.detect("gate", t, t + np.array([-2.0, 0.0, 0.0]))
r.predict(3.0, 10.0)
r.reset("gate", verify=True)
for _ in range(4):
    r.detect("gate", t, t + np.array([-2.0, 0.0, 0.0]))
r.predict(1.0, 5.0)
r.reset("gate", verify=True)
for _ in range(6):
    r.detect("gate", t + np.array([0.9, 0.6, 0.0]), t + np.array([-2.0, 0.0, 0.0]))
c = SPECS["gate_repair"].position
for _ in range(12):
    r.detect("gate_repair", c, np.array([-2.0, 0.0, 0.0]))
r.reset("gate_repair", verify=True)
for _ in range(4):
    r.detect("gate_repair", c, np.array([-2.0, 0.0, 0.0]))
scenarios.append(r.dump())

# (f) acquisition far from the prior: 12 that agree over 2 s
r = Recorder("far", ["gate", "torpedo"], 6)
off = np.array([0.3, 0.2, 0.0])
t = truth_of("gate", off)
for _ in range(15):
    r.detect("gate", t, t + np.array([-2.0, 0.0, 0.0]))
r.reset("gate")
t = truth_of("torpedo", off, (2.0, -1.5, 0.0))
for _ in range(26):
    r.detect("torpedo", t, t + np.array([-2.0, 0.0, 0.0]))
scenarios.append(r.dump())

cov_cases = []
rng = np.random.default_rng(7)
for _ in range(12):
    p = rng.normal(0, 2, 3)
    rot = yaw_rot(rng.uniform(-3, 3))
    w, v = rng.uniform(0, 0.5), rng.uniform(0, 0.4)
    cov_cases.append({"p": L(p), "rot": L(rot), "w": w, "v": v, "cov": L(detection_covariance(p, rot, w, v, NoiseSettings()))})

(OUT).mkdir(parents=True, exist_ok=True)
with open(OUT / "golden_estimator.json", "w") as f:
    json.dump({"specs": {n: {"parent": s.parent, "position": L(s.position), "yaw": s.yaw, "lock_yaw": s.lock_yaw}
                         for n, s in SPECS.items()},
               "scenarios": scenarios, "detection_covariance": cov_cases}, f)


# ---------- geometry ----------
def depth_filter(points, scale=3.0, min_spread=0.05):  # pointcloud._depth_filter (numpy part)
    if scale <= 0 or len(points) < 3:
        return np.ones(len(points), bool)
    z = points[:, 2]
    med = np.median(z)
    mad = np.median(np.abs(z - med))
    spread = max(mad * 1.4826, min_spread)
    return np.abs(z - med) <= scale * spread


def outlier_indices(points_3d):  # pointcloud._outlier_indices
    n = len(points_3d)
    if n == 0:
        return np.array([], dtype=int)
    k = min(10, max(1, int(n * 0.8)))
    radius_idx = np.where(geometry.radius_outlier_mask(points_3d, min_neighbors=k))[0]
    if len(radius_idx) == 0:
        return radius_idx
    survivors = points_3d[radius_idx]
    k2 = min(10, max(1, int(len(survivors) * 0.8)))
    stat_mask = geometry.statistical_outlier_mask(survivors, k=k2)
    return radius_idx[stat_mask]


rng = np.random.default_rng(11)
fx = fy = 520.0
cx, cy = 640.0, 360.0
K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1.0]])
patches = []
for case in range(4):
    # a tilted board 1.5-3 m away, grid-sampled pixels, depth noise, edge pixels that read the far background
    n_true = np.array([rng.uniform(-0.4, 0.4), rng.uniform(-0.3, 0.3), -1.0])
    n_true /= np.linalg.norm(n_true)
    p0 = np.array([rng.uniform(-0.3, 0.3), rng.uniform(-0.2, 0.2), rng.uniform(1.5, 3.0)])
    x0, y0 = int(cx - 80 + rng.integers(-60, 60)), int(cy - 60 + rng.integers(-40, 40))
    bbox = [x0, y0, x0 + 160, y0 + 120]
    pix = [(u, v) for v in range(bbox[1], bbox[3], 8) for u in range(bbox[0], bbox[2], 8)]
    pts = []
    for (u, v) in pix:
        pt, _ = geometry.ray_plane_intersection(u, v, K, n_true, p0)
        z = pt[2] + rng.normal(0, 0.004 * pt[2])
        if rng.random() < 0.08:
            z = pt[2] + rng.uniform(1.5, 4.0)  # background bleed
        pts.append(geometry.pixel_to_3d(u, v, z, fx, fy, cx, cy))
    pts = np.array(pts)
    keep = depth_filter(pts)
    gated = pts[keep]
    idx = outlier_indices(gated)
    inl = gated[idx]
    normal, d, centroid = geometry.fit_plane(inl)
    if normal[2] > 0:
        normal = -normal
    q = geometry.quat_from_normal_stable(normal)
    ui, vi = geometry.inplane_basis(normal)
    hit, t = geometry.ray_plane_intersection((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2, K, normal, centroid)
    patches.append({"bbox": bbox, "points": L(pts), "keep": L(keep.astype(int)), "inliers": L(idx),
                    "normal": L(normal), "d": float(-np.dot(normal, centroid)), "centroid": L(centroid), "quat": L(q),
                    "basis": [L(ui), L(vi)], "hit": L(hit), "t": float(t),
                    "radius_mask": L(geometry.radius_outlier_mask(gated, min_neighbors=7).astype(int)),
                    "stat_mask": L(geometry.statistical_outlier_mask(gated, k=6).astype(int))})

normals = []
for _ in range(10):
    n = rng.normal(0, 1, 3)
    n /= np.linalg.norm(n)
    dirn = rng.normal(0, 1, 3)
    normals.append({"n": L(n), "dir": L(dirn), "quat": L(geometry.quat_from_normal_stable(n)),
                    "quat_dir": L(geometry.quat_from_normal_and_inplane_dir(n, dirn)),
                    "basis": [L(b) for b in geometry.inplane_basis(n)]})

# binary classifier: two fire vinyls 0.6 m apart, a few strays
bc = BinaryClassifier(None)
bc.start("fire", "bin_target1", "bin_target2")
a, b = np.array([13.2, 12.1, -2.1]), np.array([13.7, 12.45, -2.05])
steps = []
now = 100.0
for i in range(70):
    now += 0.1
    if i == 30:
        steps.append({"op": "freeze", "ret": list(bc.freeze_buffer())})
    if i == 45:
        steps.append({"op": "start_second", "ret": list(bc.start_second())})
    centre = a if (i < 40 and i % 3 != 2) or (i >= 40 and i % 4 == 0) else b
    p = centre + rng.normal(0, [0.03, 0.03, 0.08])
    if i % 11 == 5:
        p = centre + np.array([0.5, -0.4, 0.0])
    s = DetectionSample(float(p[0]), float(p[1]), float(p[2]), 0.9, now)
    res = bc.observe(s, now)
    steps.append({"op": "observe", "sample": [s.x, s.y, s.z, s.score, s.stamp_sec], "now": now,
                  "accepted": bool(res.accepted), "target": res.target_name, "reason": res.reason,
                  "distance": res.distance_m, "state": bc.state,
                  "c1": None if bc.instance1_centroid is None else L(bc.instance1_centroid),
                  "c2": None if bc.instance2_centroid is None else L(bc.instance2_centroid)})

with open(OUT / "golden_geometry.json", "w") as f:
    json.dump({"K": L(K), "intr": [fx, fy, cx, cy], "patches": patches, "normals": normals,
               "classifier": {"params": bc.params.__dict__, "steps": steps}}, f)
print("wrote", OUT / "golden_estimator.json", OUT / "golden_geometry.json")
for s in scenarios:
    print(s["title"], [(o.get("accepted"), o.get("reason")) for o in s["ops"] if o["op"] == "observe" and o["reason"]][:12])

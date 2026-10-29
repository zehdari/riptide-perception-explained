#!/usr/bin/env python3
"""Photo tour + noise holds: place Talos (set_sim_pose), hold it there with the MPC, switch cameras, save frames and detections."""
import json, math, sys, time, numpy as np, rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import CompressedImage, Image, CameraInfo
from vision_msgs.msg import Detection3DArray
from nav_msgs.msg import Odometry
from riptide_msgs2.msg import ControllerCommand
from robot_localization.srv import SetPose
from std_srvs.srv import SetBool
from cv_bridge import CvBridge
import tf2_ros
from rclpy.time import Time

OUT = sys.argv[1]; PLAN = json.load(open(sys.argv[2]))
def quat_yaw(y): return (0.0, 0.0, math.sin(y / 2), math.cos(y / 2))
class T(Node):
    def __init__(s):
        super().__init__('perc_tour'); s.b = CvBridge(); s.rgb = {}; s.depth = {}; s.info = {}; s.det = None; s.dets = []; s.odom = None
        for cam in ('ffc', 'dfc'):
            base = f'/talos/{cam}/zed_node'
            s.create_subscription(CompressedImage, base + '/rgb/image_rect_color/compressed', lambda m, c=cam: s.rgb.__setitem__(c, m), qos_profile_sensor_data)
            s.create_subscription(Image, base + '/depth/depth_registered', lambda m, c=cam: s.depth.__setitem__(c, m), qos_profile_sensor_data)
            s.create_subscription(CameraInfo, base + '/rgb/camera_info', lambda m, c=cam: s.info.__setitem__(c, list(m.k)), 1)
        s.create_subscription(Detection3DArray, '/talos/detected_objects', s.on_det, 10)
        s.create_subscription(Odometry, '/talos/odometry/filtered', lambda m: setattr(s, 'odom', m), 10)
        s.lin = s.create_publisher(ControllerCommand, '/talos/controller/linear', 10)
        s.ang = s.create_publisher(ControllerCommand, '/talos/controller/angular', 10)
        s.place = s.create_client(SetPose, '/talos/set_sim_pose')
        s.dfc = s.create_client(SetBool, '/talos/set_camera_is_dfc')
        s.tfb = tf2_ros.Buffer(); s.tfl = tf2_ros.TransformListener(s.tfb, s)
        s.collect = False
    def on_det(s, m):
        s.det = m
        if s.collect:
            st = m.header.stamp.sec + m.header.stamp.nanosec * 1e-9
            try:
                tr = s.tfb.lookup_transform('map', m.header.frame_id, Time.from_msg(m.header.stamp))
                t, q = tr.transform.translation, tr.transform.rotation
                cam = [t.x, t.y, t.z, q.x, q.y, q.z, q.w]
            except Exception:
                cam = None
            for d in m.detections:
                for r in d.results:
                    p = r.pose.pose.position; o = r.pose.pose.orientation
                    s.dets.append({'t': st, 'c': r.hypothesis.class_id, 's': r.hypothesis.score, 'p': [p.x, p.y, p.z], 'q': [o.x, o.y, o.z, o.w], 'cam_map': cam})
    def spin_for(s, d):
        end = time.monotonic() + d
        while time.monotonic() < end: rclpy.spin_once(s, timeout_sec=0.02)
    def call(s, cl, req):
        cl.wait_for_service(timeout_sec=10); f = cl.call_async(req)
        end = time.monotonic() + 10
        while not f.done() and time.monotonic() < end: rclpy.spin_once(s, timeout_sec=0.05)
        return f.result()
    def go(s, x, y, z, yaw):
        req = SetPose.Request(); req.pose.header.frame_id = 'map'
        p = req.pose.pose.pose; p.position.x, p.position.y, p.position.z = x, y, z
        p.orientation.x, p.orientation.y, p.orientation.z, p.orientation.w = quat_yaw(yaw)
        s.call(s.place, req); s.spin_for(0.5)
        lin = ControllerCommand(mode=ControllerCommand.POSITION); lin.setpoint_vect.x, lin.setpoint_vect.y, lin.setpoint_vect.z = x, y, z
        ang = ControllerCommand(mode=ControllerCommand.POSITION)
        ang.setpoint_quat.x, ang.setpoint_quat.y, ang.setpoint_quat.z, ang.setpoint_quat.w = quat_yaw(yaw)
        for _ in range(5): s.lin.publish(lin); s.ang.publish(ang); s.spin_for(0.1)
    def save(s, name, cam):
        st = lambda h: h.stamp.sec + h.stamp.nanosec * 1e-9
        m = s.det; img = s.rgb[cam]; dep = s.depth[cam]
        open(f'{OUT}/{name}.jpg', 'wb').write(bytes(img.data))
        np.savez_compressed(f'{OUT}/{name}_depth.npz', depth=s.b.imgmsg_to_cv2(dep, 'passthrough').astype(np.float16))
        dets = [{'class': r.hypothesis.class_id, 'score': r.hypothesis.score, 'p': [r.pose.pose.position.x, r.pose.pose.position.y, r.pose.pose.position.z],
                 'q': [r.pose.pose.orientation.x, r.pose.pose.orientation.y, r.pose.pose.orientation.z, r.pose.pose.orientation.w]} for dd in m.detections for r in dd.results] if m else []
        json.dump({'cam': cam, 'K': s.info[cam], 'stamp_det': st(m.header) if m else 0, 'stamp_rgb': st(img.header), 'stamp_depth': st(dep.header),
                   'frame_id': f'talos/{cam}_left_camera_optical_frame', 'dets': dets}, open(f'{OUT}/{name}.json', 'w'))
        print('saved', name, [d['class'] for d in dets], flush=True)

rclpy.init(); n = T(); n.spin_for(2.0)
cur = None
for step in PLAN:
    cam = step.get('cam', 'ffc')
    if cam != cur:
        n.call(n.dfc, SetBool.Request(data=(cam == 'dfc'))); n.spin_for(4.0); cur = cam
    n.go(*step['pose'])
    n.spin_for(step.get('settle', 5.0))
    if step.get('hold'):
        n.dets = []; n.collect = True; n.spin_for(step['hold']); n.collect = False
        json.dump({'pose': step['pose'], 'cam': cam, 'dets': n.dets}, open(f"{OUT}/{step['name']}_hold.json", 'w'))
        print('hold', step['name'], len(n.dets), flush=True)
    for k in range(step.get('frames', 1)):
        n.det = None; end = time.monotonic() + 3
        while n.det is None and time.monotonic() < end: rclpy.spin_once(n, timeout_sec=0.05)
        n.save(f"{step['name']}_{k}", cam); n.spin_for(0.7)

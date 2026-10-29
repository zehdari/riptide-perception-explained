#!/usr/bin/env python3
"""Save matched RGB + depth + detections from the active camera every few seconds while something is detected."""
import sys, time, json, numpy as np, rclpy, cv2
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import CompressedImage, Image, CameraInfo
from vision_msgs.msg import Detection3DArray
from cv_bridge import CvBridge
out = sys.argv[1]; period = float(sys.argv[2]) if len(sys.argv) > 2 else 4.0
class G(Node):
    def __init__(s):
        super().__init__('perc_grab'); s.b = CvBridge(); s.depth = {}; s.rgb = {}; s.info = {}; s.last = 0.0; s.n = 0
        for cam in ('ffc', 'dfc'):
            base = f'/talos/{cam}/zed_node'
            s.create_subscription(CompressedImage, base + '/rgb/image_rect_color/compressed', lambda m, c=cam: s.rgb.__setitem__(c, m), qos_profile_sensor_data)
            s.create_subscription(Image, base + '/depth/depth_registered', lambda m, c=cam: s.depth.__setitem__(c, m), qos_profile_sensor_data)
            s.create_subscription(CameraInfo, base + '/rgb/camera_info', lambda m, c=cam: s.info.__setitem__(c, list(m.k)), 1)
        s.create_subscription(Detection3DArray, '/talos/detected_objects', s.det, 10)
    def det(s, m):
        if not m.detections or time.monotonic() - s.last < period: return
        cam = 'dfc' if 'dfc' in m.header.frame_id else 'ffc'
        if cam not in s.rgb or cam not in s.depth or cam not in s.info: return
        s.last = time.monotonic()
        st = lambda h: h.stamp.sec + h.stamp.nanosec * 1e-9
        img = s.rgb[cam]; dep = s.depth[cam]
        d = s.b.imgmsg_to_cv2(dep, 'passthrough').astype(np.float16)
        name = f'{out}/f{s.n:04d}_{cam}'
        open(name + '.jpg', 'wb').write(bytes(img.data))
        np.savez_compressed(name + '_depth.npz', depth=d)
        dets = [{'class': r.hypothesis.class_id, 'score': r.hypothesis.score, 'p': [r.pose.pose.position.x, r.pose.pose.position.y, r.pose.pose.position.z],
                 'q': [r.pose.pose.orientation.x, r.pose.pose.orientation.y, r.pose.pose.orientation.z, r.pose.pose.orientation.w]} for dd in m.detections for r in dd.results]
        json.dump({'cam': cam, 'K': s.info[cam], 'stamp_det': st(m.header), 'stamp_rgb': st(img.header), 'stamp_depth': st(dep.header), 'frame_id': m.header.frame_id, 'dets': dets}, open(name + '.json', 'w'))
        s.n += 1; print(name, [x['class'] for x in dets], flush=True)
rclpy.init(); rclpy.spin(G())

#!/usr/bin/env python3
"""Extract the annotated YOLO stream from a bag into an mp4 on the mission clock (frames held until the next one)."""
import sys, subprocess, os, rosbag2_py
from rclpy.serialization import deserialize_message
from rosidl_runtime_py.utilities import get_message
bag, t0, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
width = int(sys.argv[4]) if len(sys.argv) > 4 else 640
r = rosbag2_py.SequentialReader()
r.open(rosbag2_py.StorageOptions(uri=bag, storage_id=''), rosbag2_py.ConverterOptions('cdr', 'cdr'))
r.set_filter(rosbag2_py.StorageFilter(topics=['/talos/yolo_orientation/annotated/compressed']))
T = get_message('sensor_msgs/msg/CompressedImage')
d = out + '.frames'; os.makedirs(d, exist_ok=True)
items = []
while r.has_next():
    _, data, t = r.read_next()
    m = deserialize_message(data, T)
    st = m.header.stamp.sec + m.header.stamp.nanosec * 1e-9
    if st == 0: st = t * 1e-9
    fn = f'{d}/{len(items):06d}.jpg'; open(fn, 'wb').write(bytes(m.data)); items.append((st - t0, fn))
items.sort()
with open(d + '/list.txt', 'w') as f:
    for i, (s, fn) in enumerate(items):
        dur = (items[i + 1][0] - s) if i + 1 < len(items) else 0.1
        f.write(f"file '{fn}'\nduration {max(dur, 0.01):.3f}\n")
print('frames', len(items), 'first', items[0][0] if items else None, 'last', items[-1][0] if items else None)
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', d + '/list.txt', '-vf', f'scale={width}:-2,fps=10',
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '30', '-preset', 'slow', '-g', '20', '-movflags', '+faststart', '-an', out], check=True)
open(out + '.t0', 'w').write(str(items[0][0] if items else 0))

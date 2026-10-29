#!/usr/bin/env python3
"""Cut the overview's hero video from a viewer screen recording: from the kill-switch release to the end of the tree,
sped up, with the current task and mission time burned in, plus chapter times for the page.

    python3 tools/nereus/hero_video.py RECORDING.mp4 REC_START_WALL SIM_LOG.txt OUT.mp4 OUT_CHAPTERS.json [--speed 8]
"""
import argparse, json, re, subprocess
ap = argparse.ArgumentParser()
ap.add_argument('rec'); ap.add_argument('rec_start', type=float); ap.add_argument('log'); ap.add_argument('out'); ap.add_argument('chapters')
ap.add_argument('--speed', type=float, default=8); ap.add_argument('--width', type=int, default=1280)
a = ap.parse_args()
lines = []
for line in open(a.log):
    m = re.search(r'\[(\d{10}\.\d+)\] \[talos\.autonomy\]: (.*)', line)
    if m: lines.append((float(m.group(1)), m.group(2).strip()))
start = next(t for t, m in lines if m.startswith('KILL SWITCH INSERTED')) - 1.0
end = next(t for t, m in lines if m.startswith('Tree ended')) + 3.0
TASKS = [('GATE TIME', 'Gate'), ('SALMONI TIME', 'Slalom'), ('RANDOM PINGER TIME', 'Pinger'), ('Setting mapping to target torpedo', 'Torpedo'),
         ('Searching for helmet', 'Table'), ('BIN TIME', 'Bins'), ('magnet', 'Magnets'), ('WINNING TIME', 'Home')]
ch = []
for key, name in TASKS:
    t = next((t for t, m in lines if key in m and t > start), None)
    if t is not None and not any(c[1] == name for c in ch): ch.append([t, name])
ch.sort()
ss = start - a.rec_start
dur = end - start
vt = lambda t: (t - start) / a.speed
# burned-in label: task name and mission clock
font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
draws = []
for i, (t, name) in enumerate(ch):
    t1 = ch[i + 1][0] if i + 1 < len(ch) else end
    draws.append(f"drawtext=fontfile={font}:text='{name}':x=24:y=h-th-28:fontsize=34:fontcolor=white:box=1:boxcolor=0x0f2633cc:boxborderw=12:enable='between(t,{vt(t):.2f},{vt(t1):.2f})'")
draws.append(f"drawtext=fontfile={font}:text='%{{eif\\:floor((t*{a.speed})/60)\\:d}}\\:%{{eif\\:mod(floor(t*{a.speed}),60)\\:d\\:2}}   ×{a.speed:g}':x=w-tw-24:y=h-th-28:fontsize=26:fontcolor=white:box=1:boxcolor=0x0f2633cc:boxborderw=10")
vf = f"trim=start={ss:.2f}:duration={dur:.2f},setpts=(PTS-STARTPTS)/{a.speed},fps=30,scale={a.width}:-2," + ','.join(draws)
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', a.rec, '-vf', vf, '-an', '-c:v', 'libx264', '-crf', '28', '-preset', 'slow', '-pix_fmt', 'yuv420p',
                '-g', '30', '-movflags', '+faststart', a.out], check=True)
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-ss', f'{vt(ch[3][0]) + 4 if len(ch) > 3 else 5:.1f}', '-i', a.out, '-frames:v', '1', a.out.replace('.mp4', '.jpg')], check=True)
json.dump({'speed': a.speed, 'mission_start_wall': start, 'chapters': [[round(vt(t), 2), n] for t, n in ch]}, open(a.chapters, 'w'))
print('video', round(dur / a.speed, 1), 's; chapters', [(round(vt(t), 1), n) for t, n in ch])

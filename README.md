# How Talos sees

An interactive explainer for [`riptide_perception`](https://github.com/osu-uwrt/riptide_perception/tree/mapping-estimator), the detector and mapping that tell the Ohio State Underwater Robotics Team's AUV Talos where the RoboSub props are. Live at **https://zehdari.github.io/riptide-perception-explained/**. Companion to [How Talos flies](https://zehdari.github.io/riptide-mpc-explained/).

Written for new team members. **Vision:** camera calibration (pinhole, distortion, stereo, ChArUco), training the YOLO models, the detector at runtime, turning a mask into a 3D pose, composite props. **Mapping:** the detection noise model, the per-object Kalman filter and acquisition by agreement, the robust course-map solve, frames/targets and what `RepairCompMpcTree` asks of mapping, and a full mission in Nereus. **Your turn:** running, recording, tuning and retraining.

## How it works

`src/engine/` is a JavaScript port of `riptide_mapping2/map_estimator.py` (`estimator.js`), the detector geometry (`geometry.js`) and the binary classifier (`cluster.js`). `tests/` replays scenarios recorded from the real Python by `tools/golden.py` and checks the port matches to 1e-6.

Real data comes from [Nereus](https://github.com/osu-uwrt/nereus) running Talos's whole stack (`ros2 launch nereus sim.launch.py active_control_model:=mpc mpc_model:=sim`) and `RepairCompMpcTree`:

- `tools/frame_pipeline.py` runs `tensor_detector`'s own `DetectionProcessor` offline on grabbed RGB + depth frames, recording every stage → `public/data/frames/`.
- `tools/bag_to_mission.py` turns a mission bag into JSON; `tools/hero_data.py`, `tools/event_cards.py` and `tools/mission_data.py` cut it down for the overview replay and Chapter 10; `tools/noise_measure.py` measures detection scatter from position holds.
- `tools/nereus/` has the helpers used to drive the sim: `run_tree.py`, `tour.py` (place Talos, hold, grab frames), `grab_frames.py`, `annot_video.py`, and the moved-course scenario.

```sh
npm ci
npm run dev        # http://localhost:5173/riptide-perception-explained/
npm test           # the port against the Python
npm run build      # static site in dist/
```

Pushes to `main` deploy to GitHub Pages via `.github/workflows/pages.yml`.

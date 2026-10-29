import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { MapEstimator, detection_covariance } from '../src/engine/estimator.js';
import { close } from './close.js';

const golden = JSON.parse(readFileSync(new URL('../public/data/golden_estimator.json', import.meta.url)));

function snapshot(e, watch) {
  const snap = { positions: {}, yaws: {} };
  for (const name of watch) {
    snap.positions[name] = e.position(name);
    snap.yaws[name] = e.yaw(name);
  }
  snap.offset = e.offset();
  snap.course_yaw = e.course_yaw();
  snap.released = Object.fromEntries(watch.filter((n) => e.is_map_object(n)).map((n) => [n, e.released(n)]));
  snap.confirmed = Object.fromEntries(watch.map((n) => [n, e.confirmed(n)]));
  return snap;
}

test('detection_covariance matches Python', () => {
  for (const [i, c] of golden.detection_covariance.entries()) close(detection_covariance(c.p, c.rot, c.w, c.v), c.cov, `case ${i}`);
});

for (const sc of golden.scenarios) {
  test(`scenario ${sc.title} replays like map_estimator.py`, () => {
    const e = new MapEstimator(golden.specs);
    sc.ops.forEach((op, i) => {
      const where = `${sc.title} op ${i} (${op.op})`;
      if (op.op === 'observe') {
        e.predict(...op.predict);
        const [accepted, reason] = e.observe(op.name, op.stamp, op.position, op.cov, op.yaw, op.yaw_var, op.targeted);
        close(accepted, op.accepted, `${where} accepted`);
        close(reason, op.reason, `${where} reason`);
        close(detection_covariance(...op.cov_inputs), op.cov, `${where} cov`);
      } else if (op.op === 'predict') {
        e.predict(op.distance, op.dt);
      } else if (op.op === 'reset') {
        e.reset(op.name, op.verify);
      }
      close(snapshot(e, sc.watch), op.after, where, 1e-6, 1e-8);
    });
  });
}

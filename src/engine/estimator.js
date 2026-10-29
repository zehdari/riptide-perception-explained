// JavaScript port of riptide_mapping2/map_estimator.py (the course map estimator). Same names, same math.
//
// The prior map (config init_data) is a dead-reckoned layout of the course, and the odometry frame drifts away from it.
// Every map-parented object is modeled as
//     position = R(course yaw) * prior + offset + deviation
// offset:      where the course sits in the odometry frame. Random-walks with distance traveled (dead-reckoning drift).
// deviation:   how far the dead-reckoned layout is off for that one object. Heavy-tailed: mostly small, sometimes meters.
// course yaw:  start-heading misalignment between the layout and odometry.
//
// Objects parented to another mapping frame keep a 3-state filter in that frame. Yaw is a scalar filter per object.

import {
  zeros, eye, diag, copy, vcopy, dot, norm, vadd, vsub, vscale, add, scale, transpose, sym, outer,
  matmul, matvec, sandwich, solve, inv, eigvalsh, block,
} from './linalg.js';

export const MAP_FRAME = 'map';

export const wrap_angle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const radians = (d) => (d * Math.PI) / 180;
const isFiniteAll = (v) => v.flat().every((x) => Number.isFinite(x));

export const EstimatorSettings = {
  offset_std_xy: 1.0,
  offset_std_z: 0.3,
  drift_var_per_m_xy: 0.002,
  drift_var_per_m_z: 0.0002,
  drift_var_per_s_xy: 1e-5,
  drift_var_per_s_z: 1e-6,
  layout_std_xy: 0.25,
  layout_std_z: 0.15,
  layout_robust_scale: 2.0,
  course_yaw_std_deg: 2.0,
  fix_merge_distance: 1.0,
  child_std_xy: 0.5,
  child_std_z: 0.3,
  yaw_std_deg: 30.0,
  gate_chi2: 16.27,
  yaw_gate_chi2: 10.83,
  gate_min_updates: 10,
  confirm_detections: 10,
  verify_detections: 3,
  gate_max_rejects: 30,
  acquire_detections: 4,
  acquire_radius_m: 0.3,
  acquire_window_s: 4.0,
  acquire_prior_chi2: 16.27,
  acquire_far_detections: 12,
  acquire_far_s: 2.0,
};

export const NoiseSettings = {
  base_std: 0.01,
  lateral_std_per_m: 0.003,
  range_std_per_m: 0.008,
  range_std_per_m2: 0.003,
  timing_std: 0.03,
  yaw_std_deg: 3.0,
  correlation_time: 0.3,
  max_inflation: 30.0,
};

const newTrack = (o = {}) => ({ updates: 0, rejects: 0, last_stamp: null, established: false, confirmed: false, verifying: -1, ...o });

// Covariance (parent frame) of one detection at position_camera. Depth error grows along the camera ray, bearing error
// across it. A stamp error turns vehicle rotation into a sideways smear and vehicle translation into a shift
export function detection_covariance(position_camera, rotation_parent_camera, angular_speed, linear_speed, noise = NoiseSettings) {
  const p = vcopy(position_camera);
  const r = norm(p);
  const lateral_var = (noise.base_std + noise.lateral_std_per_m * r) ** 2 + (angular_speed * noise.timing_std * r) ** 2;
  const along_var = (noise.base_std + noise.range_std_per_m * r + noise.range_std_per_m2 * r * r) ** 2;
  let cov = scale(eye(3), lateral_var);
  if (r > 1e-6) {
    const ray = vscale(p, 1 / r);
    cov = add(cov, scale(outer(ray, ray), along_var - lateral_var));
  }
  cov = add(cov, scale(eye(3), (linear_speed * noise.timing_std) ** 2));
  return sandwich(rotation_parent_camera, cov);
}

// Move current toward target at no more than max_speed (<= 0: jump)
export function slew_vector(current, target, max_speed, dt) {
  if (max_speed <= 0) return vcopy(target);
  const delta = vsub(target, current);
  const dist = norm(delta);
  const step = max_speed * Math.max(dt, 0);
  if (dist <= step) return vcopy(target);
  return vadd(current, vscale(delta, step / dist));
}

export function slew_angle(current, target, max_rate, dt) {
  if (max_rate <= 0) return target;
  const delta = wrap_angle(target - current);
  const step = max_rate * Math.max(dt, 0);
  if (Math.abs(delta) <= step) return target;
  return wrap_angle(current + Math.sign(delta) * step);
}

// point rotated by yaw about z, and its derivative in yaw
export function _rotate(yaw, point) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const [x, y, z] = point;
  return [[c * x - s * y, s * x + c * y, z], [-s * x - c * y, c * x - s * y, 0]];
}

const slice3 = (x, i) => [x[i], x[i + 1], x[i + 2]];

export class MapEstimator {
  // specs: {name: {parent, position: [x,y,z], yaw (rad), lock_yaw}}
  constructor(specs, settings = {}, noise = {}) {
    this.settings = { ...EstimatorSettings, ...settings };
    this.noise = { ...NoiseSettings, ...noise };
    this.specs = {};
    for (const [name, spec] of Object.entries(specs)) {
      this.specs[name] = { parent: spec.parent, position: vcopy(spec.position), yaw: Number(spec.yaw || 0), lock_yaw: Boolean(spec.lock_yaw) };
    }
    // Odometry path length and time so far (predict()), the clocks fixes and drift are measured on
    this.distance = 0;
    this.time = 0;

    // Tracks: map objects in the odometry frame, the rest in their parent frame
    this.track_mean = {};
    this.track_cov = {};
    for (const [name, spec] of Object.entries(this.specs)) {
      this.track_mean[name] = vcopy(spec.position);
      this.track_cov[name] = this.is_map_object(name) ? this._layout_prior() : this._child_prior();
    }
    this.acquiring = new Set(); // map objects whose track is their estimate (detected or seeded, not a fix yet)
    this.live = new Map(); // map objects whose track is a fix: name -> [distance, time] last seen
    this.seen = new Map(); // [distance, time] of each map track's last detection
    this.frozen = [];
    this._solution = null;
    this._structure = null; // fixes the last full (multi-start) solve ran on
    this._warm = null;

    // Detections held back until enough agree: [stamp, position, cov, yaw, yaw_var, targeted]
    this.pending = new Map();

    this.yaw_mean = {};
    this.yaw_var = {};
    this.tracks = {};
    for (const [name, spec] of Object.entries(this.specs)) {
      this.yaw_mean[name] = wrap_angle(spec.yaw);
      this.yaw_var[name] = this._yaw_prior();
      this.tracks[name] = newTrack();
    }
  }

  // ----- priors -----

  _offset_prior() { const s = this.settings; return diag([s.offset_std_xy ** 2, s.offset_std_xy ** 2, s.offset_std_z ** 2]); }
  _layout_prior() { const s = this.settings; return diag([s.layout_std_xy ** 2, s.layout_std_xy ** 2, s.layout_std_z ** 2]); }
  _child_prior() { const s = this.settings; return diag([s.child_std_xy ** 2, s.child_std_xy ** 2, s.child_std_z ** 2]); }
  _yaw_prior() { return radians(this.settings.yaw_std_deg) ** 2; }

  _drift(distance, dt) {
    const s = this.settings;
    distance = Math.max(distance, 0); dt = Math.max(dt, 0);
    const xy = s.drift_var_per_m_xy * distance + s.drift_var_per_s_xy * dt;
    const z = s.drift_var_per_m_z * distance + s.drift_var_per_s_z * dt;
    return diag([xy, xy, z]);
  }

  // ----- queries -----

  is_map_object(name) { return this.specs[name].parent === MAP_FRAME; }

  // Mean and covariance in the parent frame (map objects: in the odometry frame, offset included)
  position(name) {
    if (!this.is_map_object(name) || this.acquiring.has(name)) return [vcopy(this.track_mean[name]), copy(this.track_cov[name])];
    return this._predicted(name);
  }

  // Translation of the object's frame from its TF parent (map objects hang off the offset frame)
  frame_translation(name) {
    if (!this.is_map_object(name)) return vcopy(this.track_mean[name]);
    return vsub(this.position(name)[0], this.offset()[0]);
  }

  // Where the course sits in the odometry frame now
  offset() {
    const sol = this._solve();
    if (sol === null) return [[0, 0, 0], add(this._offset_prior(), this._drift(this.distance, this.time))];
    const o = sol.o;
    const cov = add(block(sol.cov, [o, o + 1, o + 2]), this._drift(this.distance - sol.distance, this.time - sol.time));
    return [slice3(sol.x, o), sym(cov)];
  }

  course_yaw() {
    const sol = this._solve();
    if (sol === null) return [0, radians(this.settings.course_yaw_std_deg) ** 2];
    return [sol.x[0], sol.cov[0][0]];
  }

  yaw(name) {
    if (this.specs[name].lock_yaw) return [this.yaw_mean[name], 0];
    return [this.yaw_mean[name], this.yaw_var[name]];
  }

  // Whether fresh detections while targeted have confirmed the object since its last reset
  confirmed(name) { return this.tracks[name].confirmed; }

  // Whether the fixes say this object's prior is off (its layout weight is mostly gone)
  released(name) {
    const sol = this._solve();
    return sol !== null && (name in sol.weights ? sol.weights[name] : 1) < 0.5;
  }

  // The map's estimate of a map object: R(course yaw) * prior + offset now + its deviation
  _predicted(name) {
    const prior = this.specs[name].position;
    const sol = this._solve();
    if (sol === null) {
      const cov = add(add(this._offset_prior(), this._drift(this.distance, this.time)), this._layout_prior());
      return [vcopy(prior), cov];
    }
    const { x, cov: P } = sol;
    const [rotated, g] = _rotate(x[0], prior);
    const o = sol.o;
    const idx = [0, o, o + 1, o + 2];
    const hasDev = name in sol.d;
    const J = zeros(3, hasDev ? 7 : 4);
    for (let i = 0; i < 3; i++) { J[i][0] = g[i]; J[i][1 + i] = 1; }
    let mean = vadd(rotated, slice3(x, o));
    if (hasDev) {
      const d = sol.d[name];
      idx.push(d, d + 1, d + 2);
      for (let i = 0; i < 3; i++) J[i][4 + i] = 1;
      mean = vadd(mean, slice3(x, d));
    }
    let cov = add(sandwich(J, block(P, idx)), this._drift(this.distance - sol.distance, this.time - sol.time));
    if (!hasDev) cov = add(cov, this._layout_prior());
    return [mean, sym(cov)];
  }

  // ----- filter -----

  // The vehicle traveled `distance` (odometry path length) over dt since the last call
  predict(distance, dt) {
    this.distance += Math.max(Number(distance), 0);
    this.time += Math.max(Number(dt), 0);
  }

  // Back-to-back detections of one object share most of their error, so each counts for less
  inflation(name, stamp) {
    const last = this.tracks[name].last_stamp;
    if (last === null) return 1;
    const dt = Math.max(stamp - last, 1e-3);
    return Math.min(Math.max(1, this.noise.correlation_time / dt), this.noise.max_inflation);
  }

  // Fuse one detection (position in the parent frame). Only a targeted object's detections confirm or establish it;
  // the rest still say where it is. agreed: already agreed with others (the binary classifier clusters before it names
  // a target). Returns [accepted, reason]
  observe(name, stamp, position = null, position_cov = null, yaw = null, yaw_var = null, targeted = true, agreed = false) {
    const inflation = this.inflation(name, stamp);
    let moved = '';

    if (position !== null && position !== undefined) {
      const z = vcopy(position);
      const R = scale(position_cov, inflation);
      if (!(isFiniteAll(z) && isFiniteAll(R))) return [false, 'non-finite detection'];
      let started = false; // the map track is started (or aged by the drift since it was last seen) once per detection
      if (this.tracks[name].verifying >= 0) {
        if (this.is_map_object(name)) { this._start_or_age_track(name); started = true; }
        const nu = vsub(z, this.track_mean[name]);
        const d2 = dot(nu, solve(add(this.track_cov[name], R), nu));
        if (d2 > this.settings.gate_chi2) {
          // Not where it was: find it again from scratch (this detection is the first of the new search)
          moved = `moved ${(Math.hypot(nu[0], nu[1]) * 100).toFixed(0)} cm since it was last seen, finding it again`;
          this.reset(name);
          started = false;
        }
      }
      if (!agreed && this._acquiring_by_agreement(name)) {
        const [accepted, reason] = this._agree(name, stamp, z, copy(position_cov), yaw, yaw_var, targeted);
        return [accepted, [moved, reason].filter((r) => r).join('; ')];
      }
      if (this.is_map_object(name) && !started) this._start_or_age_track(name);
      const [accepted, reason] = this._update_position(name, z, R);
      if (!accepted) return [false, reason];
    }
    const track = this.tracks[name];

    if (yaw !== null && yaw !== undefined && yaw_var !== null && yaw_var !== undefined && !this.specs[name].lock_yaw && Number.isFinite(yaw)) {
      this._update_yaw(name, Number(yaw), Number(yaw_var) * inflation);
    }

    track.updates += 1;
    track.rejects = 0;
    track.last_stamp = stamp;
    const hasPos = position !== null && position !== undefined;
    if (hasPos) {
      if (targeted && track.updates >= this.settings.confirm_detections) track.established = true;
      if (targeted && track.verifying >= 0) {
        track.verifying += 1;
        if (track.verifying >= this.settings.verify_detections) { track.verifying = -1; track.confirmed = true; }
      }
      if (targeted && track.verifying < 0 && track.established) track.confirmed = true;
      this.seen.set(name, [this.distance, this.time]);
      if (this.is_map_object(name) && (this.live.has(name) || track.updates >= this.settings.gate_min_updates)) {
        // Enough detections: the track is a fix the map is solved from
        this.acquiring.delete(name);
        this.live.set(name, [this.distance, this.time]);
        this._solution = null;
      }
    }
    return [true, moved];
  }

  // No detection accepted since the last full reset (and not checking a known estimate): wait for agreement
  _acquiring_by_agreement(name) {
    const track = this.tracks[name];
    return this.settings.acquire_detections > 1 && track.updates === 0 && track.verifying < 0;
  }

  // Where the map expects the object (its layout and course-yaw uncertainty included)
  _acquisition_prior(name) {
    if (this.is_map_object(name) && !this.acquiring.has(name) && !this.live.has(name)) return this._predicted(name);
    return [this.track_mean[name], this.track_cov[name]];
  }

  // Hold the detection until enough agree; then start the track from the agreeing ones only
  _agree(name, stamp, z, R, yaw, yaw_var, targeted) {
    const s = this.settings;
    const held = (this.pending.get(name) || []).filter((d) => stamp - d[0] <= s.acquire_window_s);
    held.push([stamp, z, R, yaw, yaw_var, targeted]);
    this.pending.set(name, held);

    const agree = (a, b) => {
      const gap = norm(vsub(a[1], b[1]));
      const ev = eigvalsh(add(a[2], b[2]));
      const sigma = Math.sqrt(Math.max(ev[ev.length - 1], 0));
      return gap <= Math.max(s.acquire_radius_m, 3 * sigma);
    };

    let members = null;
    for (const a of held) {
      const m = held.filter((b) => agree(a, b));
      if (members === null || m.length > members.length) members = m;
    }
    const mean = vscale(members.reduce((acc, m) => vadd(acc, m[1]), [0, 0, 0]), 1 / members.length);
    const [prior_mean, prior_cov] = this._acquisition_prior(name);
    const nu = vsub(mean, prior_mean);
    let spread = zeros(3);
    for (const m of members) spread = add(spread, m[2]);
    spread = scale(spread, 1 / members.length / members.length);
    const far = dot(nu, solve(add(prior_cov, spread), nu)) > s.acquire_prior_chi2;
    const needed = far ? s.acquire_far_detections : s.acquire_detections;
    const stamps = members.map((m) => m[0]);
    const span = Math.max(...stamps) - Math.min(...stamps);
    if (members.length < needed || (far && span < s.acquire_far_s)) {
      return [false, `acquiring: ${members.length}/${needed} detections agree` +
        (far ? ` over ${span.toFixed(1)}/${s.acquire_far_s.toFixed(1)} s, away from the map's estimate` : '')];
    }

    this.pending.delete(name);
    for (const m of [...members].sort((a, b) => a[0] - b[0])) this.observe(name, m[0], m[1], m[2], m[3], m[4], m[5], true);
    const dropped = held.length - members.length;
    let reason = `${members.length} detections agree` + (dropped ? `, ${dropped} that didn't dropped` : '');
    if (far) reason += `, ${Math.hypot(nu[0], nu[1]).toFixed(1)} m from where the map had it: taking them over the prior`;
    return [true, reason];
  }

  _start_or_age_track(name) {
    if (this.acquiring.has(name) || this.live.has(name)) {
      // Odometry drifted since its last detection, so older detections count for less
      const [distance, time] = this.seen.get(name) || [this.distance, this.time];
      this.track_cov[name] = add(this.track_cov[name], this._drift(this.distance - distance, this.time - time));
      return;
    }
    // First detection since a reset: start from where the map has it. Verifying: as uncertain as the map says (its
    // drift since included); else uncertain enough to need fresh detections
    const [mean, cov] = this._predicted(name);
    this.track_mean[name] = mean;
    this.track_cov[name] = this.tracks[name].verifying >= 0 ? cov : add(cov, this._layout_prior());
    this.acquiring.add(name);
  }

  _update_position(name, z, R) {
    const s = this.settings;
    const track = this.tracks[name];
    const mean = this.track_mean[name];
    let P = this.track_cov[name];
    const nu = vsub(z, mean);
    const S = add(P, R);
    const d2 = dot(nu, solve(S, nu));

    if (track.updates >= s.gate_min_updates && d2 > s.gate_chi2) {
      track.rejects += 1;
      if (track.rejects >= s.gate_max_rejects) {
        this.live.delete(name); // it was locked onto the wrong thing: drop that fix, don't freeze it
        this._solution = null;
        this.reset(name);
        return [false, `${s.gate_max_rejects} rejections in a row (last ${Math.sqrt(d2).toFixed(1)} sigma), reacquiring`];
      }
      return [false, `${Math.sqrt(d2).toFixed(1)} sigma from the estimate`];
    }

    const K = matmul(P, inv(S));
    this.track_mean[name] = vadd(mean, matvec(K, nu));
    const IK = add(eye(3), scale(K, -1));
    P = add(sandwich(IK, P), sandwich(K, R));
    this.track_cov[name] = sym(P);
    return [true, ''];
  }

  _update_yaw(name, yaw, v) {
    const nu = wrap_angle(yaw - this.yaw_mean[name]);
    const S = this.yaw_var[name] + v;
    if (this.tracks[name].updates >= this.settings.gate_min_updates && (nu * nu) / S > this.settings.yaw_gate_chi2) return;
    const K = this.yaw_var[name] / S;
    this.yaw_mean[name] = wrap_angle(this.yaw_mean[name] + K * nu);
    this.yaw_var[name] = (1 - K) * this.yaw_var[name];
  }

  // ----- the map solve -----

  _fixes() {
    const live = [...this.live.entries()].map(([name, [d, t]]) => ({ name, mean: this.track_mean[name], cov: this.track_cov[name], distance: d, time: t }));
    return [...this.frozen, ...live];
  }

  // The live fix stops changing; merged into the object's last frozen fix when barely any travel apart
  _freeze(name) {
    const [distance, time] = this.live.get(name);
    this.live.delete(name);
    const fix = { name, mean: vcopy(this.track_mean[name]), cov: copy(this.track_cov[name]), distance, time };
    for (let i = this.frozen.length - 1; i >= 0; i--) {
      const other = this.frozen[i];
      if (other.name === name && Math.abs(other.distance - distance) < this.settings.fix_merge_distance) {
        const A = inv(other.cov), B = inv(fix.cov);
        other.cov = inv(add(A, B));
        other.mean = matvec(other.cov, vadd(matvec(A, other.mean), matvec(B, fix.mean)));
        other.distance = Math.max(other.distance, distance);
        other.time = Math.max(other.time, time);
        return;
      }
    }
    this.frozen.push(fix);
  }

  _solve() {
    if (this._solution !== null) return this._solution;
    const fixes = this._fixes();
    if (!fixes.length) return null;
    const s = this.settings;
    const order = fixes.map((_, k) => k).sort((a, b) => (fixes[a].distance - fixes[b].distance) || (fixes[a].time - fixes[b].time));
    const names = [...new Set(fixes.map((f) => f.name))].sort();
    const n = 1 + 3 * fixes.length + 3 * names.length;
    const node = {};
    order.forEach((k, rank) => { node[k] = 1 + 3 * rank; });
    const dev = {};
    names.forEach((name, j) => { dev[name] = 1 + 3 * fixes.length + 3 * j; });
    const layout_inv = inv(this._layout_prior());
    const yaw_var = radians(s.course_yaw_std_deg) ** 2;
    const scl = s.layout_robust_scale;
    const fix_inv = fixes.map((f) => inv(f.cov));

    // Offset chain: the first node from the start prior, then drift between consecutive nodes
    const chain = [];
    order.forEach((k, rank) => {
      const f = fixes[k];
      if (rank === 0) {
        chain.push([null, node[k], inv(add(this._offset_prior(), this._drift(f.distance, f.time)))]);
      } else {
        const p = fixes[order[rank - 1]];
        const Q = add(this._drift(f.distance - p.distance, f.time - p.time), scale(eye(3), 1e-6));
        chain.push([node[order[rank - 1]], node[k], inv(Q)]);
      }
    });

    const weights = (x) => {
      const w = {};
      for (const name of names) {
        const d = slice3(x, dev[name]);
        const r2 = dot(d, matvec(layout_inv, d));
        w[name] = scl > 0 ? 1 / (1 + r2 / scl ** 2) : 1;
      }
      return w;
    };

    const normal = (x, w) => {
      const A = zeros(n);
      const b = new Array(n).fill(0);
      A[0][0] += yaw_var > 0 ? 1 / yaw_var : 1e12;
      fixes.forEach((f, k) => {
        const [rotated, g] = _rotate(x[0], this.specs[f.name].position);
        const y = vadd(vsub(f.mean, rotated), vscale(g, x[0]));
        const idx = [0, node[k], node[k] + 1, node[k] + 2, dev[f.name], dev[f.name] + 1, dev[f.name] + 2];
        const J = zeros(3, 7);
        for (let i = 0; i < 3; i++) { J[i][0] = g[i]; J[i][1 + i] = 1; J[i][4 + i] = 1; }
        const JtW = matmul(transpose(J), fix_inv[k]);
        const H = matmul(JtW, J);
        const r = matvec(JtW, y);
        for (let a = 0; a < 7; a++) {
          for (let c = 0; c < 7; c++) A[idx[a]][idx[c]] += H[a][c];
          b[idx[a]] += r[a];
        }
      });
      for (const [a, c, Qi] of chain) {
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
          A[c + i][c + j] += Qi[i][j];
          if (a !== null) {
            A[a + i][a + j] += Qi[i][j];
            A[a + i][c + j] -= Qi[i][j];
            A[c + i][a + j] -= Qi[i][j];
          }
        }
      }
      for (const name of names) {
        const d = dev[name];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) A[d + i][d + j] += w[name] * layout_inv[i][j];
      }
      return [A, b];
    };

    const cost = (x) => {
      let total = yaw_var > 0 ? x[0] ** 2 / yaw_var : 0;
      fixes.forEach((f, k) => {
        const [rotated] = _rotate(x[0], this.specs[f.name].position);
        const r = vsub(vsub(vsub(f.mean, rotated), slice3(x, node[k])), slice3(x, dev[f.name]));
        total += dot(r, matvec(fix_inv[k], r));
      });
      for (const [a, c, Qi] of chain) {
        const r = a !== null ? vsub(slice3(x, c), slice3(x, a)) : slice3(x, c);
        total += dot(r, matvec(Qi, r));
      }
      for (const name of names) {
        const d = slice3(x, dev[name]);
        const r2 = dot(d, matvec(layout_inv, d));
        total += scl > 0 ? scl ** 2 * Math.log1p(r2 / scl ** 2) : r2;
      }
      return total;
    };

    const run = (x, iterations, first_weights = null) => {
      let w = first_weights || weights(x);
      for (let it = 0; it < iterations; it++) {
        const [A, b] = normal(x, w);
        const x_new = solve(A, b);
        let maxd = 0;
        for (let i = 0; i < n; i++) maxd = Math.max(maxd, Math.abs(x_new[i] - x[i]));
        const done = maxd < 1e-7;
        x = x_new;
        w = weights(x);
        if (done) break;
      }
      return x;
    };

    // Same fixes as last time (a live track moved): continue from the last answer. New or frozen fixes: also try
    // starting from every way of blaming one prior, and keep the best explanation
    const structure = JSON.stringify(fixes.map((f, k) => [f.name, k < this.frozen.length]));
    let x;
    if (structure === this._structure && this._warm !== null && this._warm.length === n) {
      x = run(this._warm, 8);
    } else {
      const zero = () => new Array(n).fill(0);
      const starts = [run(zero(), 30)];
      if (scl > 0 && names.length > 1) {
        for (const name of names) {
          const w = {};
          for (const other of names) w[other] = other === name ? 0 : 1;
          starts.push(run(zero(), 30, w));
        }
      }
      if (this._warm !== null && this._warm.length === n) starts.push(run(this._warm, 30));
      let best = null, bestCost = Infinity;
      for (const st of starts) { const c = cost(st); if (c < bestCost) { best = st; bestCost = c; } }
      x = best;
      this._structure = structure;
    }

    const w = weights(x);
    const [A] = normal(x, w);
    const last = fixes[order[order.length - 1]];
    this._warm = x;
    this._solution = { x, cov: inv(A), o: node[order[order.length - 1]], d: dev, weights: w, distance: last.distance, time: last.time };
    return this._solution;
  }

  // ----- edits from services -----

  // Forget what detections taught this track. A map object's fix is kept: it is frozen into the map, and its new track
  // starts from where the map has it. verify (a new target): an object known well keeps its estimate, widened by the
  // drift since it was last seen, and verify_detections that agree with it confirm it
  reset(name, verify = false) {
    verify = verify && this.tracks[name].established;
    if (this.is_map_object(name)) {
      if (this.live.has(name)) { this._freeze(name); this._solution = null; }
      this.acquiring.delete(name);
      this.seen.delete(name);
    } else if (verify) {
      const [distance, time] = this.seen.get(name) || [this.distance, this.time];
      this.track_cov[name] = add(this.track_cov[name], this._drift(this.distance - distance, this.time - time));
    } else {
      this.track_cov[name] = this._child_prior();
    }
    if (!verify) this.yaw_var[name] = this._yaw_prior();
    this.tracks[name] = newTrack({ established: verify, verifying: verify ? 0 : -1 });
    this.pending.delete(name);
  }

  // Put the object at position (parent frame) with its prior covariance
  seed(name, position, yaw = null) {
    this.reset(name);
    this.track_mean[name] = vcopy(position);
    if (this.is_map_object(name)) {
      this.track_cov[name] = this._layout_prior();
      this.acquiring.add(name);
      this.seen.set(name, [this.distance, this.time]);
    }
    if (yaw !== null) this.yaw_mean[name] = wrap_angle(yaw);
  }

  // Translate the object in its parent frame, covariance unchanged
  shift(name, delta) {
    this.track_mean[name] = vadd(this.track_mean[name], delta);
    if (this.is_map_object(name)) {
      // Moving it means its prior and everything seen of it move too
      this.specs[name].position = vadd(this.specs[name].position, delta);
      for (const fix of this.frozen) if (fix.name === name) fix.mean = vadd(fix.mean, delta);
      this._solution = null;
    }
  }

  // Rotate the object's position about its parent frame's z axis (for when the parent frame yaws)
  rotate_position(name, dyaw) {
    const c = Math.cos(dyaw), s = Math.sin(dyaw);
    const rot = [[c, -s, 0], [s, c, 0], [0, 0, 1]];
    if (this.is_map_object(name)) {
      const [mean] = this.position(name);
      this.shift(name, vsub(matvec(rot, mean), mean));
    } else {
      this.track_mean[name] = matvec(rot, this.track_mean[name]);
      this.track_cov[name] = sandwich(rot, this.track_cov[name]);
    }
  }

  add_yaw(name, dyaw) { this.yaw_mean[name] = wrap_angle(this.yaw_mean[name] + dyaw); }

  // The prior map changed under us: move the object with it and forget its detections
  set_prior(name, position, yaw) {
    this.specs[name].position = vcopy(position);
    this.specs[name].yaw = Number(yaw);
    this.reset(name);
    this.frozen = this.frozen.filter((fix) => fix.name !== name);
    this._solution = null;
    this._structure = null;
    if (!this.is_map_object(name)) this.track_mean[name] = vcopy(this.specs[name].position);
    this.yaw_mean[name] = wrap_angle(yaw);
  }
}

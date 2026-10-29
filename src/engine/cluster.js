// JavaScript port of riptide_mapping2/binary_classifier.py: two identical-looking props (the bin's two fire vinyls)
// told apart by clustering where their detections land.
//
// stopped -> acquire_first -> track_first -> [frozen] -> acquire_second -> track_second -> stopped

// fraction of farthest cluster points dropped before averaging the centroid
export const CLUSTER_TRIM_QUANTILE = 0.90;

export const State = {
  STOPPED: 'stopped',
  ACQUIRE_FIRST: 'acquire_first',
  TRACK_FIRST: 'track_first',
  FROZEN: 'frozen',
  ACQUIRE_SECOND: 'acquire_second',
  TRACK_SECOND: 'track_second',
};

export const DEFAULTS = {
  buffer_size: 500,
  buffer_ttl_sec: 15.0,
  min_cluster_detections: 6,
  cluster_radius_m: 0.15,
  assignment_gate_m: 0.20,
  exclusion_radius_m: 0.30,
  min_instance_separation_m: 0.40,
  max_cluster_variance_m2: 0.02,
  centroid_ema_alpha: 0.15,
  use_3d_distance: false,
};

const result = (accepted, target_name, reason, distance_m = null) => ({ accepted, target_name, reason, distance_m });

const nanmedian = (vals) => {
  const s = vals.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
};
const nanquantile = (vals, q) => {
  const s = vals.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos), hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};
const nanmean = (vals) => { const f = vals.filter((v) => !Number.isNaN(v)); return f.reduce((a, b) => a + b, 0) / f.length; };

export class BinaryClassifier {
  constructor(params = {}) {
    this.params = { ...DEFAULTS, ...params };
    this.samples = []; // {x, y, z, score, stamp_sec}
    this.state = State.STOPPED;
    this.class_name = '';
    this.instance1_name = '';
    this.instance2_name = '';
    this.instance1_centroid = null;
    this.instance2_centroid = null;
  }

  get running() { return this.state !== State.STOPPED; }
  get first_locked() { return this.instance1_centroid !== null; }
  get second_locked() { return this.instance2_centroid !== null; }
  get buffer_frozen() { return this.state === State.FROZEN; }

  metric_point(p) { return this.params.use_3d_distance ? p.slice(0, 3) : p.slice(0, 2); }
  distance(a, b) {
    const ma = this.metric_point(a), mb = this.metric_point(b);
    return Math.hypot(...ma.map((v, i) => v - mb[i]));
  }

  _append(sample) {
    this.samples.push(sample);
    const cap = Math.max(1, this.params.buffer_size);
    if (this.samples.length > cap) this.samples.splice(0, this.samples.length - cap);
  }

  start(class_name, instance1_name, instance2_name) {
    class_name = class_name.trim(); instance1_name = instance1_name.trim(); instance2_name = instance2_name.trim();
    if (this.running) return [false, 'BinaryClassifier is already running'];
    if (class_name === '') return [false, 'class_name cannot be empty'];
    if (instance1_name === '' || instance2_name === '') return [false, 'instance names cannot be empty'];
    if (instance1_name === instance2_name) return [false, 'instance names must be different'];
    this.samples = [];
    this.class_name = class_name;
    this.instance1_name = instance1_name;
    this.instance2_name = instance2_name;
    this.instance1_centroid = null;
    this.instance2_centroid = null;
    this.state = State.ACQUIRE_FIRST;
    return [true, `BinaryClassifier started for class ${class_name}`];
  }

  // Freeze the buffer while autonomy goes off to do the first task
  freeze_buffer() {
    if (!this.running) return [false, 'BinaryClassifier is not running'];
    if (this.state === State.FROZEN) return [true, 'BinaryClassifier buffer already frozen'];
    if (this.state !== State.TRACK_FIRST) return [false, 'Can only lock the buffer while tracking the first instance'];
    this.state = State.FROZEN;
    return [true, 'BinaryClassifier buffer frozen'];
  }

  start_second() {
    if (!this.running) return [false, 'BinaryClassifier is not running'];
    if (!this.first_locked) return [false, 'Cannot start second instance before first instance is locked'];
    if (this.state === State.ACQUIRE_SECOND || this.state === State.TRACK_SECOND) return [true, 'BinaryClassifier is already working on second instance'];
    this.state = State.ACQUIRE_SECOND;
    const candidate = this.find_best_cluster(this.samples_outside_first_instance());
    if (candidate !== null) {
      const separation = this.distance(candidate.centroid, this.instance1_centroid);
      if (separation >= this.params.min_instance_separation_m) {
        this.instance2_centroid = candidate.centroid;
        this.state = State.TRACK_SECOND;
      }
    }
    return [true, 'BinaryClassifier switched to second instance'];
  }

  stop() {
    if (!this.running) return [false, 'BinaryClassifier is not running'];
    this.samples = [];
    this.state = State.STOPPED;
    this.class_name = this.instance1_name = this.instance2_name = '';
    this.instance1_centroid = this.instance2_centroid = null;
    return [true, 'BinaryClassifier stopped'];
  }

  observe(sample, now_sec) {
    if (!this.running) return result(false, '', 'classifier stopped');
    if (this.state === State.FROZEN) return this.observe_track_first(sample);
    this.prune(now_sec);
    this._append(sample);
    this.prune(now_sec);
    switch (this.state) {
      case State.ACQUIRE_FIRST: return this.observe_acquire_first(sample);
      case State.TRACK_FIRST: return this.observe_track_first(sample);
      case State.ACQUIRE_SECOND: return this.observe_acquire_second(sample);
      case State.TRACK_SECOND: return this.observe_track_second(sample);
      default: return result(false, '', 'invalid classifier state');
    }
  }

  observe_acquire_first(sample) {
    if (this.instance1_centroid === null) {
      const cluster = this.find_best_cluster([...this.samples]);
      if (cluster !== null) { this.instance1_centroid = cluster.centroid; this.state = State.TRACK_FIRST; }
    }
    if (this.instance1_centroid === null) return result(false, '', 'acquiring first instance');
    return this.assign_to_locked_instance(sample, this.instance1_centroid, this.instance1_name, 1, 'first instance locked, sample outside gate');
  }

  observe_track_first(sample) {
    return this.assign_to_locked_instance(sample, this.instance1_centroid, this.instance1_name, 1, 'tracking first instance, sample outside gate');
  }

  observe_acquire_second(sample) {
    const p = point(sample);
    if (this.instance1_centroid !== null) {
      const d = this.distance(p, this.instance1_centroid);
      if (d < this.params.exclusion_radius_m) return result(false, '', 'sample inside first instance exclusion radius', d);
    }
    if (this.instance2_centroid === null) {
      const cluster = this.find_best_cluster(this.samples_outside_first_instance());
      if (cluster !== null) {
        const separation = this.distance(cluster.centroid, this.instance1_centroid);
        if (separation < this.params.min_instance_separation_m) return result(false, '', 'second candidate too close to first instance', separation);
        this.instance2_centroid = cluster.centroid;
        this.state = State.TRACK_SECOND;
      }
    }
    if (this.instance2_centroid === null) return result(false, '', 'acquiring second instance');
    return this.assign_to_locked_instance(sample, this.instance2_centroid, this.instance2_name, 2, 'second instance locked, sample outside gate');
  }

  observe_track_second(sample) {
    if (this.instance1_centroid !== null) {
      const d = this.distance(point(sample), this.instance1_centroid);
      if (d < this.params.exclusion_radius_m) return result(false, '', 'sample inside first instance exclusion radius', d);
    }
    return this.assign_to_locked_instance(sample, this.instance2_centroid, this.instance2_name, 2, 'tracking second instance, sample outside gate');
  }

  assign_to_locked_instance(sample, centroid, target_name, instance_num, reject_reason) {
    if (centroid === null) return result(false, '', 'instance is not locked');
    const d = this.distance(point(sample), centroid);
    if (d > this.params.assignment_gate_m) return result(false, '', reject_reason, d);
    this.update_centroid(instance_num, point(sample));
    return result(true, target_name, 'assigned', d);
  }

  // slow EMA so a single noisy detection can't yank the lock around
  update_centroid(instance_num, p) {
    const a = this.params.centroid_ema_alpha;
    const ema = (c) => c.map((v, i) => (1 - a) * v + a * p[i]);
    if (instance_num === 1 && this.instance1_centroid !== null) this.instance1_centroid = ema(this.instance1_centroid);
    if (instance_num === 2 && this.instance2_centroid !== null) this.instance2_centroid = ema(this.instance2_centroid);
  }

  samples_outside_first_instance() {
    if (this.instance1_centroid === null) return [...this.samples];
    return this.samples.filter((s) => {
      const d = this.distance(point(s), this.instance1_centroid);
      return d >= this.params.exclusion_radius_m && d >= this.params.min_instance_separation_m;
    });
  }

  find_best_cluster(samples) {
    return find_best_cluster(samples.map(point), this.params, (p) => this.metric_point(p));
  }

  age_buffer(now_sec) {
    if (!this.running || this.state === State.FROZEN) return;
    this.prune(now_sec);
  }

  prune(now_sec) {
    if (this.params.buffer_ttl_sec <= 0) return;
    this.samples = this.samples.filter((s) => now_sec - s.stamp_sec <= this.params.buffer_ttl_sec);
  }
}

const point = (s) => (Array.isArray(s) ? s : [s.x, s.y, s.z]);

// Greedy mode-seek: whichever point has the most neighbours within cluster_radius wins; the farthest tail of its
// cluster (vs the median) is trimmed before averaging, and a cluster spread too wide to be one object is rejected.
// points: [[x, y, z], ...]. Returns {centroid, count, variance_m2, members} or null
export function find_best_cluster(points, params = DEFAULTS, metric = null) {
  params = { ...DEFAULTS, ...params };
  metric = metric || ((p) => (params.use_3d_distance ? p.slice(0, 3) : p.slice(0, 2)));
  const md = (a, b) => { const x = metric(a), y = metric(b); return Math.hypot(...x.map((v, i) => v - y[i])); };
  const min_count = Math.max(1, params.min_cluster_detections);
  if (points.length < min_count) return null;

  let best = null, best_count = 0;
  for (let i = 0; i < points.length; i++) {
    const idx = [];
    for (let j = 0; j < points.length; j++) if (md(points[j], points[i]) <= params.cluster_radius_m) idx.push(j);
    if (idx.length > best_count) { best_count = idx.length; best = idx; }
  }
  if (best === null || best_count < min_count) return null;

  let members = best;
  let cluster = members.map((i) => points[i]);
  const center = [0, 1, 2].map((k) => nanmedian(cluster.map((p) => p[k])));
  const d2c = cluster.map((p) => md(p, center));
  if (d2c.length >= min_count + 2) {
    const cutoff = nanquantile(d2c, CLUSTER_TRIM_QUANTILE);
    const keep = d2c.map((d) => d <= cutoff);
    const trimmed = cluster.filter((_, i) => keep[i]);
    if (trimmed.length >= min_count) { cluster = trimmed; members = members.filter((_, i) => keep[i]); }
  }
  const centroid = [0, 1, 2].map((k) => nanmean(cluster.map((p) => p[k])));
  const mc = metric(centroid);
  const variance_m2 = nanmean(cluster.map((p) => metric(p).reduce((a, v, i) => a + (v - mc[i]) ** 2, 0)));
  if (params.max_cluster_variance_m2 > 0 && variance_m2 > params.max_cluster_variance_m2) return null;
  return { centroid, count: cluster.length, variance_m2, members };
}

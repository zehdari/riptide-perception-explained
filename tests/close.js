import assert from 'node:assert/strict';

// Deep numeric comparison: |a - b| <= atol + rtol * |b|
export function close(a, b, path = '', rtol = 1e-6, atol = 1e-9) {
  if (Array.isArray(b)) {
    assert.ok(Array.isArray(a), `${path}: expected array, got ${a}`);
    assert.equal(a.length, b.length, `${path}: length`);
    b.forEach((v, i) => close(a[i], v, `${path}[${i}]`, rtol, atol));
  } else if (typeof b === 'number') {
    assert.ok(Math.abs(a - b) <= atol + rtol * Math.abs(b), `${path}: ${a} != ${b}`);
  } else if (b && typeof b === 'object') {
    for (const k of Object.keys(b)) close(a[k], b[k], `${path}.${k}`, rtol, atol);
  } else {
    assert.equal(a, b, path);
  }
}

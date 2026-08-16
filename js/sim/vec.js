// Minimal 2D vector helpers. Pure functions, no mutation of inputs.

export function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
export function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
export function scale(a, s) { return { x: a.x * s, y: a.y * s }; }
export function len(a) { return Math.hypot(a.x, a.y); }
export function dot(a, b) { return a.x * b.x + a.y * b.y; }
export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

export function norm(a) {
  const l = len(a);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function clampLen(a, max) {
  const l = len(a);
  if (l <= max) return a;
  return scale(a, max / l);
}

export function lerp(a, b, t) { return a + (b - a) * t; }

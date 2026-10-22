import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, Camera, DragController, DRAG_THRESHOLD, buildGraph, hitNode } from '../public/graph.js';

const node = (id, x, y, extra = {}) => ({ id, x, y, vx: 0, vy: 0, fx: null, fy: null, radius: 5, exists: true, ...extra });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const run = (sim, ticks) => { for (let i = 0; i < ticks; i += 1) sim.tick(); };

test('buildGraph computes degrees and radii, ignores self and dangling links, and avoids stacked nodes', () => {
  const g = buildGraph({
    nodes: [{ id: 'a', label: 'a', exists: true }, { id: 'b', label: 'b', exists: true }, { id: 'c', label: 'c', exists: false }],
    edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }, { source: 'a', target: 'a' }, { source: 'a', target: 'zzz' }],
  });
  assert.equal(g.links.length, 2);
  assert.deepEqual(g.nodes.map((n) => n.degree), [2, 1, 1]);
  assert.ok(g.nodes[0].radius > g.nodes[1].radius, 'more connected nodes are bigger');
  assert.equal(new Set(g.nodes.map((n) => `${n.x},${n.y}`)).size, 3);
});

test('links pull distant nodes together and unlinked nodes push apart', () => {
  const a = node('a', -400, 0);
  const b = node('b', 400, 0);
  run(new Simulation({ nodes: [a, b], links: [[a, b]] }), 300);
  assert.ok(dist(a, b) < 400, `linked nodes closed in: ${dist(a, b)}`);

  const c = node('c', -10, 0);
  const d = node('d', 10, 0);
  run(new Simulation({ nodes: [c, d], links: [] }, { centerStrength: 0 }), 100);
  assert.ok(dist(c, d) > 20, `unlinked nodes spread: ${dist(c, d)}`);
});

test('the simulation cools down and stops, and reheating or an alphaTarget keeps it running', () => {
  const sim = new Simulation({ nodes: [node('a', 5, 5), node('b', -5, 5)], links: [] });
  assert.equal(sim.active, true);
  run(sim, 1000);
  assert.equal(sim.active, false);
  sim.reheat(0.5);
  assert.equal(sim.active, true);
  run(sim, 1000);
  sim.alphaTarget = 0.3;
  run(sim, 1000);
  assert.equal(sim.active, true);
});

test('a pinned node stays exactly where it was dropped while the rest keep moving, and moves again once released', () => {
  const a = node('a', 0, 0, { fx: 200, fy: -50 });
  const b = node('b', 210, -40);
  const sim = new Simulation({ nodes: [a, b], links: [[a, b]] }, { centerStrength: 0 });
  sim.reheat(1);
  run(sim, 50);
  assert.deepEqual([a.x, a.y], [200, -50]);
  assert.notDeepEqual([b.x, b.y], [210, -40]);
  a.fx = a.fy = null;
  sim.reheat(1);
  run(sim, 50);
  assert.notDeepEqual([a.x, a.y], [200, -50]);
});

test('zoomAt keeps the world point under the cursor fixed while the zoom eases', () => {
  const cam = new Camera();
  cam.panX = 300;
  cam.panY = 200;
  const before = cam.toWorld(420, 260);
  cam.zoomAt(420, 260, -240);
  assert.ok(cam.targetScale > 1);
  for (let i = 0; i < 60; i += 1) {
    cam.update();
    const w = cam.toWorld(420, 260);
    assert.ok(Math.abs(w.x - before.x) < 1e-6 && Math.abs(w.y - before.y) < 1e-6);
  }
  assert.ok(Math.abs(cam.scale - cam.targetScale) < 0.01);
});

test('wheel zoom uses 1.5^(-delta/120) and is clamped', () => {
  const cam = new Camera();
  cam.zoomAt(0, 0, 120);
  assert.ok(Math.abs(cam.targetScale - 1 / 1.5) < 1e-9);
  for (let i = 0; i < 50; i += 1) cam.zoomAt(0, 0, 1200);
  assert.equal(cam.targetScale, 0.1);
  for (let i = 0; i < 50; i += 1) cam.zoomAt(0, 0, -1200);
  assert.equal(cam.targetScale, 8);
});

test('panning while a zoom is easing shifts the zoom focus with the view', () => {
  const cam = new Camera();
  cam.zoomAt(100, 100, -120);
  cam.update();
  cam.panBy(30, -10);
  const w = cam.toWorld(130, 90);
  for (let i = 0; i < 40; i += 1) cam.update();
  const after = cam.toWorld(130, 90);
  assert.ok(Math.abs(after.x - w.x) < 1e-6 && Math.abs(after.y - w.y) < 1e-6);
});

test('a pointer that moves less than the threshold is a click, more is a drag', () => {
  assert.equal(DRAG_THRESHOLD, 5);
  const drag = new DragController();
  const target = { id: 'n' };
  drag.down(target, 100, 100);
  assert.equal(drag.move(103, 104), false);
  assert.deepEqual(drag.up(), { target, click: true });
  assert.equal(drag.target, null);

  drag.down(target, 100, 100);
  assert.equal(drag.move(106, 100), true);
  assert.equal(drag.move(100, 100), true, 'once dragging, it stays a drag even if the pointer returns');
  assert.deepEqual(drag.up(), { target, click: false });
  assert.equal(drag.move(500, 500), false, 'no target, nothing to drag');
});

test('hitNode finds the node under the pointer, prefers the one drawn on top, and misses empty space', () => {
  const under = node('under', 0, 0, { radius: 10 });
  const over = node('over', 4, 0, { radius: 10 });
  assert.equal(hitNode([under, over], 2, 0, 1), over);
  assert.equal(hitNode([under, over], -12, 0, 1), under);
  assert.equal(hitNode([under, over], 60, 0, 1), null);
  // the pointer margin is a constant number of screen pixels, so it shrinks in world units when zoomed in
  assert.equal(hitNode([under], 13, 0, 1), under);
  assert.equal(hitNode([under], 13, 0, 4), null);
});

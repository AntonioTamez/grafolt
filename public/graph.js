// Graph view: a small force simulation, a pan/zoom camera and pointer interaction. Forces are
// d3-style and cool down, dragging a node pins it and reheats the simulation, a press that moves
// less than 5 px is a click, the wheel zooms by 1.5^(-delta/120) around the cursor, and the canvas
// is scaled by devicePixelRatio so it stays sharp on scaled displays.
// Everything above mountGraph is pure (no DOM) so it can be unit tested.

export const DEFAULTS = { centerStrength: 0.01, repelStrength: 900, linkStrength: 0.04, linkDistance: 90, velocityDecay: 0.8 };
export const DRAG_THRESHOLD = 5; // px; further than this and a press stops being a click
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const HIT_MARGIN = 4; // px of forgiveness around a node

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Nodes and links for the simulation: degree-based radius, no self or dangling links, spread-out start. */
export function buildGraph({ nodes, edges }) {
  const byId = new Map();
  const list = nodes.map((n, i) => {
    const angle = i * 2.4; // golden-angle spiral: no two nodes start on the same spot
    const reach = 30 * Math.sqrt(i + 1);
    const node = { ...n, x: Math.cos(angle) * reach, y: Math.sin(angle) * reach, vx: 0, vy: 0, fx: null, fy: null, degree: 0 };
    byId.set(n.id, node);
    return node;
  });
  const links = [];
  for (const { source, target } of edges) {
    const a = byId.get(source);
    const b = byId.get(target);
    if (!a || !b || a === b) continue;
    links.push([a, b]);
    a.degree += 1;
    b.degree += 1;
  }
  for (const n of list) n.radius = 4 + 1.8 * Math.sqrt(n.degree);
  return { nodes: list, links, byId };
}

export class Simulation {
  constructor({ nodes, links }, config = {}) {
    this.nodes = nodes;
    this.links = links;
    this.config = { ...DEFAULTS, ...config };
    this.alpha = 1;
    this.alphaTarget = 0;
    this.alphaMin = 0.001;
    this.alphaDecay = 1 - this.alphaMin ** (1 / 300); // cools in about 300 ticks
  }

  get active() {
    return this.alpha >= this.alphaMin || this.alphaTarget > 0;
  }

  reheat(alpha = 1) {
    this.alpha = Math.max(this.alpha, alpha);
  }

  tick() {
    const { centerStrength, repelStrength, linkStrength, linkDistance, velocityDecay } = this.config;
    this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
    const { alpha, nodes } = this;
    for (const n of nodes) {
      n.vx -= n.x * centerStrength * alpha;
      n.vy -= n.y * centerStrength * alpha;
    }
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = Math.max(dx * dx + dy * dy, 25);
        const push = (repelStrength * alpha) / d2;
        a.vx += dx * push;
        a.vy += dy * push;
        b.vx -= dx * push;
        b.vy -= dy * push;
      }
    }
    for (const [a, b] of this.links) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const pull = ((d - linkDistance) * linkStrength * alpha) / d;
      a.vx += dx * pull;
      a.vy += dy * pull;
      b.vx -= dx * pull;
      b.vy -= dy * pull;
    }
    for (const n of nodes) {
      if (n.fx !== null && n.fx !== undefined) {
        n.x = n.fx;
        n.vx = 0;
      } else {
        n.x += n.vx;
        n.vx *= velocityDecay;
      }
      if (n.fy !== null && n.fy !== undefined) {
        n.y = n.fy;
        n.vy = 0;
      } else {
        n.y += n.vy;
        n.vy *= velocityDecay;
      }
    }
  }
}

export class Camera {
  constructor() {
    this.scale = 1;
    this.targetScale = 1;
    this.panX = 0;
    this.panY = 0;
    this.focus = null; // the screen point a running zoom keeps fixed
  }

  get settled() {
    return Math.abs(this.targetScale - this.scale) < 1e-3;
  }

  toWorld(sx, sy) {
    return { x: (sx - this.panX) / this.scale, y: (sy - this.panY) / this.scale };
  }

  panBy(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    if (this.focus) {
      this.focus.sx += dx;
      this.focus.sy += dy;
    }
  }

  zoomAt(sx, sy, deltaY) {
    this.targetScale = clamp(this.targetScale * 1.5 ** (-deltaY / 120), MIN_SCALE, MAX_SCALE);
    const { x, y } = this.toWorld(sx, sy);
    this.focus = { sx, sy, wx: x, wy: y };
  }

  /** One easing step; re-anchors the pan so the zoom focus does not drift. */
  update() {
    this.scale = this.settled ? this.targetScale : this.scale + (this.targetScale - this.scale) * 0.25;
    if (this.focus) {
      this.panX = this.focus.sx - this.focus.wx * this.scale;
      this.panY = this.focus.sy - this.focus.wy * this.scale;
    }
  }
}

/** Tells a click from a drag: a press only becomes a drag once it travels past the threshold. */
export class DragController {
  constructor() {
    this.target = null;
    this.moved = false;
  }

  down(target, x, y) {
    this.target = target;
    this.startX = x;
    this.startY = y;
    this.moved = false;
  }

  move(x, y) {
    if (!this.target) return false;
    if (!this.moved) {
      const dx = x - this.startX;
      const dy = y - this.startY;
      this.moved = dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD;
    }
    return this.moved;
  }

  up() {
    const result = { target: this.target, click: this.target !== null && !this.moved };
    this.target = null;
    this.moved = false;
    return result;
  }
}

/** Topmost node under a world point; the pointer margin is constant in screen pixels. */
export function hitNode(nodes, wx, wy, scale) {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const n = nodes[i];
    if (Math.hypot(n.x - wx, n.y - wy) <= n.radius + HIT_MARGIN / scale) return n;
  }
  return null;
}

function draw(ctx, { graph, neighbors, camera, width, height, dpr, hover, colors }) {
  const { scale } = camera;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.translate(camera.panX, camera.panY);
  ctx.scale(scale, scale);
  const near = hover ? neighbors.get(hover.id) : null;
  const dimmed = (n) => hover && n !== hover && !near.has(n.id);

  ctx.lineWidth = 1 / scale;
  for (const [a, b] of graph.links) {
    const lit = hover && (a === hover || b === hover);
    ctx.globalAlpha = hover && !lit ? 0.12 : 1;
    ctx.strokeStyle = lit ? colors.accent : colors.border;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  for (const n of graph.nodes) {
    ctx.globalAlpha = dimmed(n) ? 0.2 : 1;
    ctx.fillStyle = n.exists ? colors.accent : colors.muted;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  // Labels fade in as you zoom in; the hovered node and its neighbours are always labelled.
  const textAlpha = clamp((scale - 0.5) / 0.4, 0, 1);
  ctx.font = `${12 / scale}px system-ui, sans-serif`;
  ctx.fillStyle = colors.text;
  for (const n of graph.nodes) {
    const alpha = n === hover || (near && near.has(n.id)) ? 1 : dimmed(n) ? 0 : textAlpha;
    if (alpha < 0.02) continue;
    ctx.globalAlpha = alpha;
    ctx.fillText(n.label, n.x + n.radius + 3 / scale, n.y + 4 / scale);
  }
  ctx.globalAlpha = 1;
}

/**
 * Attach an interactive graph to a canvas. Pointer events drag nodes (pinning them and reheating the
 * simulation), pan the background and open a note on a click; the wheel zooms around the cursor.
 * Frames are drawn on demand and stop once everything has settled.
 */
export function mountGraph(canvas, data, { onOpen = () => {} } = {}) {
  const ctx = canvas.getContext('2d');
  const graph = buildGraph(data);
  const neighbors = new Map(graph.nodes.map((n) => [n.id, new Set()]));
  for (const [a, b] of graph.links) {
    neighbors.get(a.id).add(b.id);
    neighbors.get(b.id).add(a.id);
  }
  const sim = new Simulation(graph);
  const camera = new Camera();
  const drag = new DragController();
  const stopSignal = new AbortController();
  const listen = (target, type, handler, options) => target.addEventListener(type, handler, { ...options, signal: stopSignal.signal });

  let size = { width: 0, height: 0, dpr: 0 };
  let hover = null;
  let panFrom = null;
  let raf = 0;
  let dirty = true;

  // The bitmap is sized in device pixels (CSS size x devicePixelRatio); drawing stays in CSS pixels.
  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: width, clientHeight: height } = canvas;
    if (width === size.width && height === size.height && dpr === size.dpr) return;
    camera.panBy((width - size.width) / 2, (height - size.height) / 2); // keep the view centred
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    size = { width, height, dpr };
    dirty = true;
  };

  const colors = () => {
    const css = getComputedStyle(document.body);
    const read = (name) => css.getPropertyValue(name).trim();
    return { accent: read('--accent'), border: read('--border'), muted: read('--muted'), text: read('--text') };
  };

  const frame = () => {
    raf = 0;
    resize();
    if (sim.active) {
      sim.tick();
      dirty = true;
    }
    if (!camera.settled) {
      camera.update();
      dirty = true;
    }
    if (dirty) {
      draw(ctx, { graph, neighbors, camera, ...size, hover, colors: colors() });
      dirty = false;
    }
    if (sim.active || !camera.settled) raf = requestAnimationFrame(frame);
  };
  const wake = () => {
    dirty = true;
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const nodeAt = (p) => {
    const w = camera.toWorld(p.x, p.y);
    return hitNode(graph.nodes, w.x, w.y, camera.scale);
  };

  listen(canvas, 'pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = local(e);
    const node = nodeAt(p);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointers cannot be captured */ }
    if (node) drag.down(node, p.x, p.y);
    else panFrom = p;
  });
  const release = (e) => {
    panFrom = null;
    const { target, click } = drag.up();
    if (!target) return;
    target.fx = null;
    target.fy = null;
    sim.alphaTarget = 0;
    canvas.style.cursor = 'grab';
    wake();
    if (click && e.type === 'pointerup' && target.exists) onOpen(target.id);
  };
  listen(canvas, 'pointermove', (e) => {
    // No button held but a drag or pan is active: the pointerup was lost (released outside the window).
    if (e.buttons === 0 && (drag.target || panFrom)) {
      release(e);
      return;
    }
    const p = local(e);
    if (drag.target) {
      if (!drag.move(p.x, p.y)) return;
      const w = camera.toWorld(p.x, p.y);
      drag.target.fx = w.x;
      drag.target.fy = w.y;
      sim.alphaTarget = 0.3; // keep the layout alive while a node is held
      sim.reheat(0.3);
      canvas.style.cursor = 'grabbing';
      wake();
    } else if (panFrom) {
      camera.panBy(p.x - panFrom.x, p.y - panFrom.y);
      panFrom = p;
      wake();
    } else {
      const over = nodeAt(p);
      if (over === hover) return;
      hover = over;
      canvas.style.cursor = over ? 'grab' : 'default';
      wake();
    }
  });
  listen(canvas, 'pointerup', release);
  listen(canvas, 'pointercancel', release);
  listen(canvas, 'pointerleave', () => {
    if (!hover || drag.target) return;
    hover = null;
    wake();
  });
  listen(canvas, 'wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    camera.zoomAt(p.x, p.y, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY);
    wake();
  }, { passive: false });
  listen(window, 'resize', wake);
  const observer = new ResizeObserver(wake);
  observer.observe(canvas);

  resize();
  wake();
  const view = {
    nodes: graph.nodes,
    camera,
    sim,
    stop() {
      stopSignal.abort();
      observer.disconnect();
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
  canvas.graphView = view; // lets UI smoke tests find nodes on screen
  return view;
}

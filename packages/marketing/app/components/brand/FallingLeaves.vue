<script setup lang="ts">
// Physics-enabled falling leaves — the interactive layer of the motif system.
// Leaves flutter down with per-leaf sway and rotation, settle into a loose
// pile at the bottom, and gust away from the pointer. Decorative only:
// pointer-events stay off, and prefers-reduced-motion gets a static scatter.
const props = withDefaults(
  defineProps<{
    count?: number;
    /** Leaves re-lift and fall again after settling for a while. */
    respawn?: boolean;
    /** Extra space (px) above the floor where leaves come to rest. */
    floorPadding?: number;
  }>(),
  { count: 14, respawn: true, floorPadding: 12 },
);

const COLORS = ["#6BA368", "#A8C5A1", "#ADB158", "#2E7D58", "#C89A5B"];

interface Leaf {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  phase: number;
  freq: number;
  size: number;
  color: string;
  settled: boolean;
  settledAt: number;
  fade: number;
}

const canvasEl = ref<HTMLCanvasElement | null>(null);

onMounted(() => {
  const canvas = canvasEl.value;
  const host = canvas?.parentElement;
  if (!canvas || !host) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let width = 0;
  let height = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const body = new Path2D("M6.4 -16.8 C11.8 -10.8 10.6 -3.2 0 0 C-4.4 -5.8 -2.2 -14 6.4 -16.8 Z");
  const midrib = new Path2D("M5 -12.3 C4.8 -7.8 3 -3.8 0 0 C-1.4 1.6 -2.6 3.4 -3 5.6");

  const rand = (a: number, b: number) => a + Math.random() * (b - a);

  const leaves: Leaf[] = [];
  const makeLeaf = (spawnAnywhere = false): Leaf => ({
    x: rand(0, 1) * width,
    y: spawnAnywhere ? rand(0, height) : rand(-height * 0.4, -20),
    vx: 0,
    vy: rand(18, 42),
    angle: rand(0, Math.PI * 2),
    spin: rand(-0.9, 0.9),
    phase: rand(0, Math.PI * 2),
    freq: rand(1.1, 2.1),
    size: rand(0.7, 1.5),
    color: COLORS[Math.floor(rand(0, COLORS.length))]!,
    settled: false,
    settledAt: 0,
    fade: 1,
  });

  // `count` is the floor; wide sections get more leaves so density holds.
  // New leaves spawn above the viewport, so arrival reads as a gentle rain-in.
  const ensureCount = () => {
    const target = Math.max(props.count, Math.round(width / 110));
    while (leaves.length < target) leaves.push(makeLeaf());
    if (leaves.length > target) leaves.length = target;
  };

  const resize = () => {
    const rect = host.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ensureCount();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  const drawLeaf = (l: Leaf) => {
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(l.angle);
    ctx.scale(l.size, l.size);
    ctx.globalAlpha = 0.9 * l.fade;
    ctx.fillStyle = l.color;
    ctx.fill(body);
    ctx.globalAlpha = 0.5 * l.fade;
    ctx.strokeStyle = "#F7F4EC";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.stroke(midrib);
    ctx.restore();
  };

  // Static scatter for reduced motion: settle every leaf once, draw, stop.
  //
  // Redrawn on resize as well as on mount. Resizing reassigns canvas.width,
  // which clears it, and ResizeObserver fires once on observe() — so drawing
  // only here left reduced-motion users with an empty canvas a frame later.
  if (reduced) {
    const scatter = () => {
      for (const l of leaves) {
        l.y = height - props.floorPadding - rand(0, 26);
        l.angle = rand(-0.5, 0.5) + Math.PI / 2;
        drawLeaf(l);
      }
    };
    scatter();
    ro.disconnect();
    const staticRo = new ResizeObserver(() => {
      resize();
      scatter();
    });
    staticRo.observe(host);
    onUnmounted(() => staticRo.disconnect());
    return;
  }

  // Pointer wind — impulses from pointer movement over the host element.
  let px = -1e4;
  let py = -1e4;
  let pvx = 0;
  let pvy = 0;
  // The pointer starts parked far off-canvas so nothing is near it. That makes
  // the first real move a ~10,000px delta, which would fire every leaf in range
  // off the screen — so the first event only seeds the position.
  let pointerSeen = false;
  const onPointer = (e: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    const nx = e.clientX - rect.left;
    const ny = e.clientY - rect.top;
    pvx = pointerSeen ? nx - px : 0;
    pvy = pointerSeen ? ny - py : 0;
    pointerSeen = true;
    px = nx;
    py = ny;
  };
  host.addEventListener("pointermove", onPointer);

  let raf = 0;
  let running = true;
  let last = performance.now();

  // Single entry point for the loop. Starting one here *and* scheduling another
  // at the bottom of this function ran two chains at once: every leaf advanced
  // twice per frame, and `raf` only ever held the newer handle.
  const start = () => {
    cancelAnimationFrame(raf);
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };

  // Fires once on observe(), so this also does the initial start.
  const io = new IntersectionObserver(([entry]) => {
    running = !!entry?.isIntersecting;
    if (running) start();
    else cancelAnimationFrame(raf);
  });
  io.observe(host);

  const tick = (now: number) => {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const t = now / 1000;

    ctx.clearRect(0, 0, width, height);
    const floor = height - props.floorPadding;

    for (const l of leaves) {
      if (!l.settled) {
        // Flutter: gravity toward a gentle terminal speed + sinusoidal sway.
        l.vy += (60 - l.vy) * 0.8 * dt;
        l.vx += Math.sin(t * l.freq + l.phase) * 26 * dt;
        l.vx *= 1 - 0.6 * dt;

        // Pointer gust.
        const dx = l.x - px;
        const dy = l.y - py;
        const d2 = dx * dx + dy * dy;
        if (d2 < 120 * 120) {
          const f = (1 - Math.sqrt(d2) / 120) * 0.15;
          l.vx += pvx * f * 60 * dt;
          l.vy += pvy * f * 30 * dt;
        }

        l.x += l.vx * dt;
        l.y += l.vy * dt;
        l.angle += (l.spin + Math.cos(t * l.freq + l.phase) * 0.8) * dt;

        if (l.x < -30) l.x = width + 28;
        if (l.x > width + 30) l.x = -28;

        if (l.y >= floor - rand(0, 22)) {
          l.settled = true;
          l.settledAt = t;
          l.vy = 0;
          l.vx = 0;
          l.y = Math.min(l.y, floor);
        }
      } else {
        // Ease flat like a leaf coming to rest.
        const flat = Math.round((l.angle - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
        l.angle += (flat - l.angle) * 2.2 * dt;

        // A strong gust can re-loft a settled leaf.
        const dx = l.x - px;
        const dy = l.y - py;
        if (dx * dx + dy * dy < 90 * 90 && Math.abs(pvx) > 6) {
          l.settled = false;
          l.vy = -rand(20, 70);
          l.vx = pvx * 1.4;
          l.spin = rand(-1.2, 1.2);
        } else if (props.respawn && t - l.settledAt > rand(7, 13)) {
          l.fade -= dt * 0.8;
          if (l.fade <= 0) Object.assign(l, makeLeaf(), { fade: 0.01 });
        }
      }
      if (l.fade < 1 && !l.settled) l.fade = Math.min(1, l.fade + dt * 1.2);
      drawLeaf(l);
    }

    // Pointer velocity decays between events.
    pvx *= 1 - 3 * dt;
    pvy *= 1 - 3 * dt;

    raf = requestAnimationFrame(tick);
  };

  onUnmounted(() => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    io.disconnect();
    host.removeEventListener("pointermove", onPointer);
  });
});
</script>

<template>
  <canvas
    ref="canvasEl"
    class="pointer-events-none absolute inset-0 h-full w-full"
    aria-hidden="true"
  />
</template>
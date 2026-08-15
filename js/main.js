// Entry point. Wires sim + render together with a fixed-timestep loop.

import { CONFIG } from './sim/config.js';
import { Sim } from './sim/sim.js';
import { Renderer } from './render/renderer.js';

const canvas = document.getElementById('game');
const statusEl = document.getElementById('status');

const sim = new Sim();
const renderer = new Renderer(canvas);

// Ensure the canvas has a size before the first render.
renderer._resize();

const dt = 1 / CONFIG.sim.hz;
let accumulator = 0;
let lastTime = performance.now();

function frame(now) {
  const elapsed = (now - lastTime) / 1000;
  lastTime = now;
  accumulator += Math.min(elapsed, 0.1);

  let steps = 0;
  while (accumulator >= dt && steps < CONFIG.sim.maxSubSteps) {
    sim.step(dt);
    accumulator -= dt;
    steps++;
  }
  if (steps === CONFIG.sim.maxSubSteps) accumulator = 0;

  renderer.render(sim);
  updateHud();
  requestAnimationFrame(frame);
}

function updateHud() {
  if (sim.over === 'win') {
    statusEl.textContent = 'Victory! Team reached the exit.';
    statusEl.className = 'status win';
  } else if (sim.over === 'lose') {
    statusEl.textContent = 'Defeat! The team was wiped out.';
    statusEl.className = 'status lose';
  } else if (sim.started) {
    statusEl.textContent = 'Fighting...';
    statusEl.className = 'status';
  } else {
    statusEl.textContent = 'Ready — press Space to start';
    statusEl.className = 'status';
  }
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    sim.start();
  } else if (e.code === 'KeyR') {
    sim.reset();
  }
});

requestAnimationFrame(frame);

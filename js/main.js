// Entry point. Wires sim + render together with a fixed-timestep loop.

import { CONFIG } from './sim/config.js';
import { Sim } from './sim/sim.js';
import { Renderer } from './render/renderer.js';

const canvas = document.getElementById('game');
const statusEl = document.getElementById('status');
const teamUiEl = document.getElementById('team-ui');
const btnStart = document.getElementById('btn-start');
const btnRestart = document.getElementById('btn-restart');

const sim = new Sim();
const renderer = new Renderer(canvas);

// Ensure the canvas has a size before the first render.
renderer._resize();

// Build the static team UI (icons, names, abilities). Health bars update live.
const TEAM_ORDER = ['tank', 'soldier', 'archer', 'healer'];
const memberEls = new Map(); // role -> { root, hpfill }

function buildTeamUi() {
  teamUiEl.innerHTML = '';
  for (const role of TEAM_ORDER) {
    const def = CONFIG.units[role];
    const root = document.createElement('div');
    root.className = 'member';
    root.innerHTML = `
      <div class="icon">${iconSvg(def)}</div>
      <div class="info">
        <div class="name">${def.name}</div>
        <div class="ability">${def.ability}</div>
        <div class="hpbar"><div class="hpfill"></div></div>
      </div>
    `;
    teamUiEl.appendChild(root);
    memberEls.set(role, {
      root,
      hpfill: root.querySelector('.hpfill'),
    });
  }
}

function iconSvg(def) {
  const s = 24;
  const c = def.color;
  switch (def.shape) {
    case 'square':
      return `<svg width="${s}" height="${s}"><rect x="3" y="3" width="18" height="18" fill="${c}"/></svg>`;
    case 'triangle':
      return `<svg width="${s}" height="${s}"><polygon points="12,3 3,21 21,21" fill="${c}"/></svg>`;
    case 'circle':
      return `<svg width="${s}" height="${s}"><circle cx="12" cy="12" r="9" fill="${c}"/><line x1="12" y1="6" x2="12" y2="18" stroke="#ef4444" stroke-width="2"/><line x1="6" y1="12" x2="18" y2="12" stroke="#ef4444" stroke-width="2"/></svg>`;
    default:
      return '';
  }
}

buildTeamUi();

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
  updateTeamUi();
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
    statusEl.textContent = 'Level ' + sim.level + ' — fighting...';
    statusEl.className = 'status';
  } else {
    statusEl.textContent = 'Level ' + sim.level + ' — press Space to start';
    statusEl.className = 'status';
  }
}

function updateTeamUi() {
  for (const role of TEAM_ORDER) {
    const el = memberEls.get(role);
    const u = sim.playerUnits.find(p => p.role === role);
    if (sim.deadRoles.has(role)) {
      // Permanently dead this run.
      el.root.classList.add('dead');
      el.hpfill.style.width = '0%';
      continue;
    }
    if (!u) {
      // Not yet entered the room.
      el.root.classList.remove('dead');
      el.hpfill.style.width = '100%';
      continue;
    }
    el.root.classList.toggle('dead', !u.alive);
    el.hpfill.style.width = Math.round((u.hp / u.maxHp) * 100) + '%';
  }
}

btnStart.addEventListener('click', () => sim.start());
btnRestart.addEventListener('click', () => sim.reset());

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    sim.start();
  } else if (e.code === 'KeyR') {
    sim.reset();
  }
});

requestAnimationFrame(frame);

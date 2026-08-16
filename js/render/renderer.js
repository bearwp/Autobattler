// Render layer. Reads sim state and draws it. NEVER mutates sim state.

import { CONFIG } from '../sim/config.js';

// Linearly interpolate two hex colors toward a target, returning a CSS color.
// Used to flash a unit's body white when it takes a hit.
function mixColor(hex, target, t) {
  const from = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const to = [1, 3, 5].map(i => parseInt(target.slice(i, i + 2), 16));
  const c = from.map((v, i) => Math.round(v + (to[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.showDebug = false;     // toggle intent/goal/target debug overlay with the D key
    this.highlightId = null;    // unit id to draw a highlight ring around (debug hover)
    this._resize();
    window.addEventListener('resize', () => this._resize());
    // Re-fit whenever the canvas element's layout size changes (e.g. the
    // customizer grows/shrinks), not just on window resize.
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(canvas);
    }
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Fit world into canvas with padding.
    const { width, height } = CONFIG.world;
    const pad = 40;
    this.scale = Math.min((w - pad * 2) / width, (h - pad * 2) / height);
    this.offset = {
      x: (w - width * this.scale) / 2,
      y: (h - height * this.scale) / 2,
    };
  }

  _toScreen(p) {
    return {
      x: this.offset.x + p.x * this.scale,
      y: this.offset.y + p.y * this.scale,
    };
  }

  render(sim) {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    this._drawRoom(sim);
    this._drawUnits(sim);
    this._drawBubbles(sim);
    this._drawEffects(sim);
    if (this.showDebug) this._drawDebug(sim);
  }

  // Debug overlay: shows each unit's current intent (what it's thinking), a
  // marker at its movement goal, and a line to its attack target. Toggled with
  // the D key. Reads sim state only; never mutates it.
  _drawDebug(sim) {
    const ctx = this.ctx;
    for (const u of sim.units) {
      if (!u.alive) continue;
      const p = this._toScreen(u.pos);

      // Line to the attack target.
      if (u.target && u.target.alive) {
        const tp = this._toScreen(u.target.pos);
        ctx.strokeStyle = u.team === 'player' ? 'rgba(251,191,36,0.7)' : 'rgba(248,113,113,0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(tp.x, tp.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Intent text above the unit.
      if (u.intent) {
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        const tw = ctx.measureText(u.intent).width;
        ctx.fillRect(p.x - tw / 2 - 3, p.y - 22, tw + 6, 14);
        ctx.fillStyle = u.team === 'player' ? '#fbbf24' : '#f87171';
        ctx.fillText(u.intent, p.x, p.y - 11);
      }
    }

    // Leader's current play, shown at the top of the room.
    if (sim.play) {
      const target = sim.units.find(x => x.id === sim.play.targetId);
      const label = sim.play.type === 'focus' ? 'Focus fire'
        : sim.play.type === 'backline' ? 'Focus backline'
        : sim.play.type === 'retreat' ? 'Retreat'
        : sim.play.type === 'hold' ? 'Hold the line'
        : sim.play.type === 'scatter' ? 'Scatter'
        : sim.play.type;
      const full = target
        ? `Play: ${label} → ${target.def.name || 'target'}`
        : `Play: ${label}`;
      ctx.font = 'bold 13px monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      const tw = ctx.measureText(full).width;
      const tl = this._toScreen({ x: 0, y: 0 });
      ctx.fillRect(tl.x + 8, tl.y + 8, tw + 10, 18);
      ctx.fillStyle = '#4ade80';
      ctx.fillText(full, tl.x + 13, tl.y + 21);
    }
  }

  _drawRoom(sim) {
    const ctx = this.ctx;
    const { width, height } = CONFIG.world;
    const tl = this._toScreen({ x: 0, y: 0 });
    const br = this._toScreen({ x: width, y: height });
    const w = br.x - tl.x, h = br.y - tl.y;

    // Floor.
    ctx.fillStyle = '#1a1a22';
    ctx.fillRect(tl.x, tl.y, w, h);

    // Walls.
    ctx.fillStyle = '#3a3a45';
    const wall = 0.5 * this.scale;
    ctx.fillRect(tl.x - wall, tl.y - wall, w + wall * 2, wall);          // top
    ctx.fillRect(tl.x - wall, br.y, w + wall * 2, wall);                 // bottom
    ctx.fillRect(tl.x - wall, tl.y, wall, h);                            // left
    ctx.fillRect(br.x, tl.y, wall, h);                                   // right

    // Doors (gaps in wall, colored outline).
    for (const door of [CONFIG.doors.entrance, CONFIG.doors.exit]) {
      const vertical = door.orientation === 'vertical';
      const d1 = this._toScreen({
        x: vertical ? door.x : door.x - door.width / 2,
        y: vertical ? door.y - door.width / 2 : door.y,
      });
      const d2 = this._toScreen({
        x: vertical ? door.x : door.x + door.width / 2,
        y: vertical ? door.y + door.width / 2 : door.y,
      });
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(d1.x, d1.y);
      ctx.lineTo(d2.x, d2.y);
      ctx.stroke();
    }

    // Obstacles.
    ctx.fillStyle = '#4a4a55';
    for (const o of CONFIG.obstacles) {
      const p = this._toScreen({ x: o.x, y: o.y });
      ctx.fillRect(p.x, p.y, o.w * this.scale, o.h * this.scale);
    }
  }

  _drawUnits(sim) {
    const ctx = this.ctx;
    for (const u of sim.units) {
      if (!u.alive) continue;
      const p = this._toScreen(u.pos);
      const s = u.size * this.scale;
      // Flash white when hit: the body colour lerps toward white, the mix
      // proportional to the damage taken relative to max health. A big hit
      // blazes bright; a small tick only tints.
      ctx.fillStyle = u.hitFlash > 0
        ? mixColor(u.def.color, '#ffffff', Math.min(1, u.hitFlash))
        : u.def.color;

      // Rotate the shape to face the unit's smoothed heading.
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(u.facing ?? 0);

      switch (u.def.shape) {
        case 'square':
          ctx.fillRect(-s / 2, -s / 2, s, s);
          break;
        case 'triangle': {
          ctx.beginPath();
          ctx.moveTo(0, -s / 2);
          ctx.lineTo(-s / 2, s / 2);
          ctx.lineTo(s / 2, s / 2);
          ctx.closePath();
          ctx.fill();
          break;
        }
        case 'circle': {
          ctx.beginPath();
          ctx.arc(0, 0, s / 2, 0, Math.PI * 2);
          ctx.fill();
          // Cross for healers.
          if (u.def.attack && u.def.attack.type === 'heal') {
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 2;
            const c = s * 0.25;
            ctx.beginPath();
            ctx.moveTo(-c, 0);
            ctx.lineTo(c, 0);
            ctx.moveTo(0, -c);
            ctx.lineTo(0, c);
            ctx.stroke();
          }
          break;
        }
      }
      ctx.restore();

      // Taunted marker: orange ring around bats forced to target the tank.
      if (u.taunted) {
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, s / 2 + 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Health bar.
      const bw = s * 1.2;
      const bh = 4;
      const by = p.y - s / 2 - 8;
      ctx.fillStyle = '#000';
      ctx.fillRect(p.x - bw / 2, by, bw, bh);
      const frac = u.hp / u.maxHp;
      ctx.fillStyle = frac > 0.5 ? '#4ade80' : frac > 0.25 ? '#facc15' : '#f87171';
      ctx.fillRect(p.x - bw / 2, by, bw * frac, bh);

      // Mana bar (only for units that use mana, e.g. the healer).
      if (u.maxMana > 0) {
        const mby = by + bh + 1;
        ctx.fillStyle = '#000';
        ctx.fillRect(p.x - bw / 2, mby, bw, bh);
        ctx.fillStyle = '#22d3ee';
        ctx.fillRect(p.x - bw / 2, mby, bw * (u.mana / u.maxMana), bh);
      }

      // Debug hover highlight: ring around the unit whose card is hovered.
      if (this.highlightId === u.id) {
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, s / 2 + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // Speech bubbles: draw each active line above its speaker, fading out as it
  // expires. Reads sim state only; never mutates it.
  _drawBubbles(sim) {
    const ctx = this.ctx;
    for (const b of sim.bubbles) {
      const u = sim.units.find(x => x.id === b.unitId);
      if (!u || !u.alive) continue;
      const p = this._toScreen(u.pos);
      const alpha = Math.max(0, Math.min(1, b.life / 0.5));
      ctx.globalAlpha = alpha;
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      const tw = ctx.measureText(b.text).width;
      const bx = p.x;
      const by = p.y - u.size * this.scale / 2 - 20;
      // Bubble background with a small tail.
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.beginPath();
      ctx.roundRect(bx - tw / 2 - 5, by - 12, tw + 10, 17, 3);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(bx - 3, by + 5);
      ctx.lineTo(bx + 3, by + 5);
      ctx.lineTo(bx, by + 10);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(b.text, bx, by - 1);
      ctx.globalAlpha = 1;
    }
  }

  _drawEffects(sim) {
    const ctx = this.ctx;
    for (const fx of sim.effects) {
      const alpha = Math.max(0, Math.min(1, fx.life / 0.5));
      ctx.globalAlpha = alpha;
      switch (fx.type) {
        case 'taunt': {
          const p = this._toScreen(fx.pos);
          const r = fx.radius * this.scale;
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'cleave': {
          const p = this._toScreen(fx.pos);
          const r = fx.range * this.scale;
          const base = Math.atan2(fx.dir.y, fx.dir.x);
          ctx.fillStyle = '#f87171';
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.arc(p.x, p.y, r, base - fx.arc / 2, base + fx.arc / 2);
          ctx.closePath();
          ctx.fill();
          break;
        }
        case 'pierce': {
          const a = this._toScreen(fx.from);
          const b = this._toScreen(fx.to);
          ctx.strokeStyle = '#4ade80';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          break;
        }
        case 'heal': {
          const a = this._toScreen(fx.from);
          const b = this._toScreen(fx.to);
          ctx.strokeStyle = '#22d3ee';
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.setLineDash([]);
          break;
        }
        case 'aoe': {
          const p = this._toScreen(fx.pos);
          const r = fx.radius * this.scale;
          ctx.strokeStyle = '#fbbf24';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'attack': {
          const a = this._toScreen(fx.from);
          const b = this._toScreen(fx.to);
          ctx.strokeStyle = fx.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          break;
        }
        case 'death': {
          const p = this._toScreen(fx.pos);
          const r = (1 - fx.life / 0.4) * 0.6 * this.scale + 0.1 * this.scale;
          ctx.strokeStyle = fx.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
      }
      ctx.globalAlpha = 1;
    }
  }
}

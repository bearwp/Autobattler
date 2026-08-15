// Render layer. Reads sim state and draws it. NEVER mutates sim state.

import { CONFIG } from '../sim/config.js';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this._resize();
    window.addEventListener('resize', () => this._resize());
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
    this._drawEffects(sim);
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
      const d1 = this._toScreen({ x: door.x - door.width / 2, y: door.y });
      const d2 = this._toScreen({ x: door.x + door.width / 2, y: door.y });
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
      const s = u.def.size * this.scale;
      ctx.fillStyle = u.def.color;

      switch (u.def.shape) {
        case 'square':
          ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
          break;
        case 'triangle': {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y - s / 2);
          ctx.lineTo(p.x - s / 2, p.y + s / 2);
          ctx.lineTo(p.x + s / 2, p.y + s / 2);
          ctx.closePath();
          ctx.fill();
          break;
        }
        case 'circle': {
          ctx.beginPath();
          ctx.arc(p.x, p.y, s / 2, 0, Math.PI * 2);
          ctx.fill();
          // Cross for healer.
          if (u.role === 'healer') {
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 2;
            const c = s * 0.25;
            ctx.beginPath();
            ctx.moveTo(p.x - c, p.y);
            ctx.lineTo(p.x + c, p.y);
            ctx.moveTo(p.x, p.y - c);
            ctx.lineTo(p.x, p.y + c);
            ctx.stroke();
          }
          break;
        }
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

interface Point {
  x: number;
  y: number;
}
interface Body extends Point {
  id: string;
  vx: number;
  vy: number;
  held: boolean;
}

// Fixed 60 Hz integration: springs describe links, repulsion keeps labels apart.
// Bodies stay outside React; only their rendered positions are published per frame.
export class GraphPhysics {
  private bodies: Body[] = [];
  private byId = new Map<string, Body>();
  private links: [Body, Body][] = [];
  private temperature = 1;
  constructor(ids: string[], links: { source: string; target: string }[]) {
    this.reconcile(ids, links);
  }
  reconcile(ids: string[], links: { source: string; target: string }[]) {
    this.bodies = ids.map((id, i) => {
      const existing = this.byId.get(id);
      if (existing) return existing;
      const radius = 90 * Math.sqrt(i);
      const angle = i * Math.PI * (3 - Math.sqrt(5));
      const link = links.find((e) => e.source === id || e.target === id);
      const neighbor = link
        ? this.byId.get(link.source === id ? link.target : link.source)
        : undefined;
      return {
        id,
        x: (neighbor?.x ?? 0) + Math.cos(angle) * (neighbor ? 175 : radius),
        y: (neighbor?.y ?? 0) + Math.sin(angle) * (neighbor ? 175 : radius),
        vx: 0,
        vy: 0,
        held: false,
      };
    });
    this.byId = new Map(this.bodies.map((b) => [b.id, b]));
    this.links = links.flatMap(({ source, target }) => {
      const a = this.byId.get(source),
        b = this.byId.get(target);
      return a && b && a !== b ? [[a, b] as [Body, Body]] : [];
    });
    this.temperature = 1;
  }
  positions(): Map<string, Point> {
    return new Map(this.bodies.map((b) => [b.id, { x: b.x, y: b.y }]));
  }
  hold(id: string, x: number, y: number) {
    const b = this.byId.get(id);
    if (!b || !Number.isFinite(x) || !Number.isFinite(y)) return;
    Object.assign(b, { x, y, vx: 0, vy: 0, held: true });
    this.temperature = 1;
  }
  release(id: string) {
    const b = this.byId.get(id);
    if (b) b.held = false;
    this.temperature = 1;
  }
  step(): boolean {
    if (!this.bodies.length || this.temperature < 0.003) return false;
    const forces = this.bodies.map((b) => ({
      x: -b.x * 0.0009,
      y: -b.y * 0.0009,
    }));
    const indices = new Map(this.bodies.map((b, i) => [b, i]));
    for (let i = 0; i < this.bodies.length; i++) {
      for (let j = i + 1; j < this.bodies.length; j++) {
        const a = this.bodies[i],
          b = this.bodies[j];
        const dx = b.x - a.x || 0.01,
          dy = b.y - a.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = Math.min(4, 9000 / (distance * distance));
        const fx = (dx / distance) * force,
          fy = (dy / distance) * force;
        forces[i].x -= fx;
        forces[i].y -= fy;
        forces[j].x += fx;
        forces[j].y += fy;
      }
    }
    for (const [a, b] of this.links) {
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 175) * 0.018;
      const fx = (dx / distance) * force,
        fy = (dy / distance) * force;
      const ai = indices.get(a)!,
        bi = indices.get(b)!;
      forces[ai].x += fx;
      forces[ai].y += fy;
      forces[bi].x -= fx;
      forces[bi].y -= fy;
    }
    let moving = false;
    this.bodies.forEach((b, i) => {
      if (b.held) {
        moving = true;
        return;
      }
      b.vx = (b.vx + forces[i].x * this.temperature) * 0.78;
      b.vy = (b.vy + forces[i].y * this.temperature) * 0.78;
      const scale = Math.min(1, 14 / (Math.hypot(b.vx, b.vy) || 1));
      b.vx *= scale;
      b.vy *= scale;
      b.x += b.vx;
      b.y += b.vy;
      if (Math.hypot(b.vx, b.vy) > 0.025) moving = true;
    });
    if (!this.bodies.some((b) => b.held)) this.temperature *= 0.988;
    return moving && this.temperature >= 0.003;
  }
}

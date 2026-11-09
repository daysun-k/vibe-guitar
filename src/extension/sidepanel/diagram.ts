/** SVG chord diagram (pure string renderer). Strings drawn low E (left) → high e (right). */
import { detectBarre, type Voicing } from '../../arrange/guitar';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface DiagramOptions {
  width?: number;
  title?: string;
}

export function renderChordDiagram(v: Voicing, opts: DiagramOptions = {}): string {
  const W = opts.width ?? 140;
  const scale = W / 140;
  const left = 30;
  const top = opts.title ? 44 : 26;
  const gap = 18;
  const fretH = 24;
  const fretted = v.frets.filter((f): f is number => f !== null && f > 0);
  const maxF = fretted.length ? Math.max(...fretted) : 0;
  const minF = fretted.length ? Math.min(...fretted) : 0;
  const base = maxF <= 5 ? 1 : minF;
  const rows = Math.max(4, Math.min(5, maxF - base + 1));
  const H = top + rows * fretH + 14;
  const x = (s: number) => left + s * gap;
  const y = (fret: number) => top + (fret - base + 0.5) * fretH;
  const parts: string[] = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 ${H}" width="${W}" height="${Math.round(H * scale)}" class="chord-diagram" role="img" aria-label="${escapeHtml(v.chord)} ${v.frets.map((f) => (f === null ? 'x' : f)).join(' ')}">`);
  if (opts.title) parts.push(`<text x="${left + 2.5 * gap}" y="16" text-anchor="middle" class="dg-title">${escapeHtml(opts.title)}</text>`);
  // frets
  for (let r = 0; r <= rows; r++) {
    const yy = top + r * fretH;
    const nut = r === 0 && base === 1;
    parts.push(`<line x1="${x(0)}" y1="${yy}" x2="${x(5)}" y2="${yy}" class="${nut ? 'dg-nut' : 'dg-fret'}"/>`);
  }
  if (base > 1) parts.push(`<text x="${left - 8}" y="${top + fretH * 0.5 + 4}" text-anchor="end" class="dg-base">${base}fr</text>`);
  // strings
  for (let s = 0; s < 6; s++) parts.push(`<line x1="${x(s)}" y1="${top}" x2="${x(s)}" y2="${top + rows * fretH}" class="dg-string"/>`);
  // open / muted markers
  v.frets.forEach((f, s) => {
    if (f === null) parts.push(`<text x="${x(s)}" y="${top - 7}" text-anchor="middle" class="dg-mute">×</text>`);
    else if (f === 0) parts.push(`<circle cx="${x(s)}" cy="${top - 11}" r="4.5" class="dg-open"/>`);
  });
  // barre
  const barre = detectBarre(v);
  if (barre) {
    const yy = y(barre.fret);
    parts.push(`<rect x="${x(barre.fromString) - 7}" y="${yy - 7}" width="${x(barre.toString) - x(barre.fromString) + 14}" height="14" rx="7" class="dg-barre"/>`);
    parts.push(`<text x="${(x(barre.fromString) + x(barre.toString)) / 2}" y="${yy + 4}" text-anchor="middle" class="dg-finger">${barre.finger}</text>`);
  }
  // dots
  v.frets.forEach((f, s) => {
    if (f === null || f === 0) return;
    const g = v.fingers[s];
    if (barre && g === barre.finger && f === barre.fret && s >= barre.fromString && s <= barre.toString) return;
    parts.push(`<circle cx="${x(s)}" cy="${y(f)}" r="7.5" class="dg-dot"/>`);
    if (g) parts.push(`<text x="${x(s)}" y="${y(f) + 4}" text-anchor="middle" class="dg-finger">${g}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

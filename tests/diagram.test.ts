import { describe, expect, it } from 'vitest';
import { parseChord, voicingsForChord, fretString } from '../src/arrange';
import { escapeHtml, renderChordDiagram } from '../src/extension/sidepanel/diagram';

const find = (chord: string, frets: string) => voicingsForChord(parseChord(chord)).find((v) => fretString(v.frets) === frets)!;

describe('chord diagram SVG', () => {
  it('draws muted/open markers and finger numbers', () => {
    const svg = renderChordDiagram(find('C', 'x32010'));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.match(/class="dg-mute"/g)).toHaveLength(1);
    expect(svg.match(/class="dg-open"/g)).toHaveLength(2);
    expect(svg.match(/class="dg-dot"/g)).toHaveLength(3);
    expect(svg).toContain('>3</text>');
    expect(svg).toContain('dg-nut');
  });

  it('draws a barre and a base-fret label for high positions', () => {
    const f = renderChordDiagram(find('F', '133211'));
    expect(f).toContain('dg-barre');
    const high = voicingsForChord(parseChord('C')).find((v) => v.kind === 'barre' && (v.frets[0] ?? 0) === 8)!;
    const svg = renderChordDiagram(high);
    expect(svg).toContain('8fr');
    expect(svg).not.toContain('dg-nut');
  });

  it('escapes text', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});

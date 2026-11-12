// Small slash bass (2026-11-12 decision "베이스 음 작게"): "C♯m7♭5/G♯" keeps its spelling and only the
// "/G♯" part is drawn smaller. Display only: the visible text stays the full name.
import { describe, expect, it } from 'vitest';
import { bassHTML, slashChordHTML, splitSlashBass } from '../src/extension/sidepanel/chord-name';
import { chordHTML } from '../src/extension/sidepanel/play';
import { prettyChord } from '../src/music/key';

/** Text content of an HTML string (tags dropped, the entities escapeHtml writes decoded). */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

describe('splitSlashBass', () => {
  it('splits a trailing slash bass with its accidental (ASCII and ♯/♭)', () => {
    expect(splitSlashBass('C#m7b5/G#')).toEqual({ head: 'C#m7b5', bass: '/G#' });
    expect(splitSlashBass('C♯m7♭5/G♯')).toEqual({ head: 'C♯m7♭5', bass: '/G♯' });
    expect(splitSlashBass('A♭/E♭')).toEqual({ head: 'A♭', bass: '/E♭' });
    expect(splitSlashBass('Ab/Eb')).toEqual({ head: 'Ab', bass: '/Eb' });
    expect(splitSlashBass('D/F#')).toEqual({ head: 'D', bass: '/F#' });
    expect(splitSlashBass('G/B')).toEqual({ head: 'G', bass: '/B' });
    expect(splitSlashBass('C#m7b5(add11)/G#')).toEqual({ head: 'C#m7b5(add11)', bass: '/G#' });
    // prettyChord changes only the root and bass accidentals.
    expect(splitSlashBass(prettyChord('C#m7b5/G#'))).toEqual({ head: 'C♯m7b5', bass: '/G♯' });
  });

  it('leaves names without a slash bass whole', () => {
    for (const name of ['C', 'Bm7', 'B♭maj7', 'N.C.', '—', '–', '', 'C6/9', 'Cadd9/', '/G', 'C/H', 'C/Gb5', 'C /G', '코드 없음']) {
      expect(splitSlashBass(name), name).toEqual({ head: name, bass: '' });
    }
  });

  it('head + bass is always the name unchanged', () => {
    for (const name of ['C#m7b5/G#', 'C6/9', 'N.C.', 'A♭/E♭', 'x<y/G']) {
      const { head, bass } = splitSlashBass(name);
      expect(head + bass).toBe(name);
    }
  });
});

describe('slashChordHTML / bassHTML', () => {
  it('wraps only the bass in the small span', () => {
    expect(slashChordHTML('C♯m7♭5/G♯')).toBe('C♯m7♭5<span class="slash-bass">/G♯</span>');
    expect(slashChordHTML('Bm7')).toBe('Bm7');
    expect(slashChordHTML('N.C.')).toBe('N.C.');
    expect(bassHTML('')).toBe('');
  });

  it('escapes user-editable chart text (no markup gets through)', () => {
    const evil = '<img src=x onerror=alert(1)>&"\'/G';
    const html = slashChordHTML(evil);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;');
    expect(html.endsWith('<span class="slash-bass">/G</span>')).toBe(true);
    expect(slashChordHTML('<b>C</b>')).toBe('&lt;b&gt;C&lt;/b&gt;');
  });

  it('the rendered text is the full plain name (screen readers, copy)', () => {
    for (const name of ['C♯m7♭5/G♯', 'D/F#', 'Bm7', 'N.C.', 'a&b<c>/E']) expect(text(slashChordHTML(name)), name).toBe(name);
  });
});

describe('side panel chordHTML (lane cells, diagram captions)', () => {
  it('keeps the small accidental and quality, and puts the slash bass in its own smaller span', () => {
    expect(chordHTML('C♯m7♭5/G♯')).toBe('<span class="cn">C<span class="acc">♯</span><span class="q">m7♭5</span><span class="slash-bass">/G♯</span></span>');
    expect(chordHTML('G/B')).toBe('<span class="cn">G<span class="slash-bass">/B</span></span>');
    expect(chordHTML('B♭maj7')).toBe('<span class="cn">B<span class="acc">♭</span><span class="q">maj7</span></span>');
    expect(chordHTML('C6/9')).toBe('<span class="cn">C<span class="q">6/9</span></span>');
    expect(chordHTML('N.C.')).toBe('<span class="cn">—</span>');
  });

  it('text content is unchanged and odd names stay escaped', () => {
    for (const name of ['C♯m7♭5/G♯', 'A♭/E♭', 'Dm', 'x<y>/G']) expect(text(chordHTML(name)), name).toBe(name);
    expect(chordHTML('<i>/G')).toBe('<span class="cn">&lt;i&gt;<span class="slash-bass">/G</span></span>');
  });
});

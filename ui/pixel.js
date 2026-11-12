'use strict';
// All artwork is drawn here at runtime: 16x16 textures and icons, original to this app.

const Pixel = (() => {
  function rng(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function draw(size, fn) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const col = fn(x, y);
        if (col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); }
      }
    }
    return c.toDataURL();
  }

  const fromMap = (rows, pal) => draw(rows.length, (x, y) => pal[rows[y][x]] || null);
  const pick = (r, list) => list[Math.floor(r() * list.length)];
  const shade = (hex, k) => '#' + [1, 3, 5].map((i) => Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * k)).toString(16).padStart(2, '0')).join('');
  // A flat-coloured block face with a darker rim, used as the icon for each mod site.
  const block = (hex, seed) => { const r = rng(seed); return draw(16, (x, y) => shade(hex, (x === 0 || y === 0 || x === 15 || y === 15 ? 0.62 : 0.86) + r() * 0.24)); };

  const DIRT = ['#866043', '#866043', '#79553a', '#79553a', '#966c4a', '#593d29', '#b9855c', '#6d6d6d'];
  const GRASS = ['#5d9c3a', '#6aaa41', '#528b33', '#74b548'];

  const icons = {
    modrinth: () => block('#1bd96a', 11),
    curseforge: () => block('#f16436', 12),
    logo: () => {
      const r = rng(3);
      return draw(16, (x, y) => (y < 3 || (y === 3 && r() < 0.6) || (y === 4 && r() < 0.25) ? pick(r, GRASS) : pick(r, DIRT)));
    },
    missing: () => draw(2, (x, y) => ((x + y) % 2 ? '#000000' : '#f800f8')),
    // Stands in for a project that has no icon of its own: a plain cube.
    noicon: () => fromMap([
      '................',
      '................',
      '......gggg......',
      '....gg....gg....',
      '..gg........gg..',
      '..ggg......ggg..',
      '..g..gg..gg..g..',
      '..g....gg....g..',
      '..g....gg....g..',
      '..g....gg....g..',
      '..g....gg....g..',
      '..gg...gg...gg..',
      '....gg.gg.gg....',
      '......gggg......',
      '................',
      '................',
    ], { '.': '#33353b', g: '#9a9da6' }),
    library: () => fromMap([
      '................',
      '.kkkkkkkkkkkkkk.',
      '.kooooooooooook.',
      '.koyyyyyyyyyyok.',
      '.koyyyyyyyyyyok.',
      '.kooooooooooook.',
      '.kkkkkkswkkkkkk.',
      '.koooooswoooook.',
      '.koyyyysskyyyok.',
      '.koyyyyyyyyyyok.',
      '.koyyyyyyyyyyok.',
      '.koyyyyyyyyyyok.',
      '.koyyyyyyyyyyok.',
      '.kooooooooooook.',
      '.kkkkkkkkkkkkkk.',
      '................',
    ], { k: '#2e1f0d', o: '#7d5320', y: '#b5822e', s: '#c9c9c9', w: '#ffffff' }),
    settings: () => fromMap([
      '................',
      '......kkkk......',
      '..kk.kggggk.kk..',
      '.kggkkghhgkkggk.',
      '.kghgggggggghgk.',
      '..kggggkkggggk..',
      '.kkgggk..kgggkk.',
      '.kghgk....kghgk.',
      '.kghgk....kghgk.',
      '.kkgggk..kgggkk.',
      '..kggggkkggggk..',
      '.kghgggggggghgk.',
      '.kggkkghhgkkggk.',
      '..kk.kggggk.kk..',
      '......kkkk......',
      '................',
    ], { k: '#1b1b1b', g: '#8f8f8f', h: '#c4c4c4' }),
  };

  const cache = {};
  const get = (set, name) => (cache[name] = cache[name] || set[name]());
  return { icon: (name) => get(icons, name) };
})();

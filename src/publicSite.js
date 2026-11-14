// Genera la carpeta "sitio-publico" lista para arrastrar a Netlify (página estática, sin base de datos).
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');

function exportPublicSite(snapshot, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const copy = (from, to) => fs.copyFileSync(from, path.join(outDir, to));
  copy(path.join(PUBLIC, 'bombo', 'publico.html'), 'index.html');
  copy(path.join(PUBLIC, 'bombo', 'publico.css'), 'publico.css');
  copy(path.join(PUBLIC, 'bombo', 'publico.js'), 'publico.js');
  copy(path.join(PUBLIC, 'bombo', 'bombo.js'), 'bombo.js');
  copy(path.join(PUBLIC, 'brand', 'logo.png'), 'logo.png');
  copy(path.join(path.dirname(require.resolve('matter-js')), 'matter.min.js'), 'matter.min.js');
  // Escena 3D (misma del stream) con sus librerías, solo los archivos que usa
  copy(path.join(PUBLIC, 'bombo', 'overlay3d.js'), 'overlay3d.js');
  copy(path.join(PUBLIC, 'bombo', 'stage3d.css'), 'stage3d.css');
  const NM = path.join(__dirname, '..', 'node_modules');
  const vendor = (from, to) => { const dst = path.join(outDir, 'vendor', to); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(NM, from), dst); };
  vendor('cannon-es/dist/cannon-es.js', 'cannon-es.js');
  for (const f of ['build/three.module.js', 'build/three.core.js',
    'examples/jsm/environments/RoomEnvironment.js',
    'examples/jsm/postprocessing/EffectComposer.js', 'examples/jsm/postprocessing/RenderPass.js',
    'examples/jsm/postprocessing/UnrealBloomPass.js', 'examples/jsm/postprocessing/OutputPass.js',
    'examples/jsm/postprocessing/ShaderPass.js', 'examples/jsm/postprocessing/MaskPass.js', 'examples/jsm/postprocessing/Pass.js',
    'examples/jsm/shaders/CopyShader.js', 'examples/jsm/shaders/LuminosityHighPassShader.js', 'examples/jsm/shaders/OutputShader.js']) {
    vendor('three/' + f, 'three/' + f);
  }
  // Solo datos públicos: códigos de ticket y usuarios enmascarados. Sin ids internos.
  const ids = new Map();
  const anon = (p) => { if (!ids.has(p)) ids.set(p, ids.size + 1); return ids.get(p); };
  const data = {
    generated_at: new Date().toISOString(),
    draw: snapshot.draw,
    tickets: {
      A: snapshot.tickets.A.map((t) => ({ code: t.code, user: t.user, p: anon(t.p) })),
      B: snapshot.tickets.B.map((t) => ({ code: t.code, user: t.user, p: anon(t.p) })),
    },
    prizes: snapshot.prizes.map(({ urn, label, qty }) => ({ urn, label, qty })),
    winners: snapshot.winners.map((w) => ({ urn: w.urn, code: w.code, user: w.user, prize: w.prize, p: anon(w.p) })),
    discarded: (snapshot.discarded || []).map((d) => ({ urn: d.urn, p: anon(d.p) })), // "al agua": ya no participan
  };
  fs.writeFileSync(path.join(outDir, 'data.json'), JSON.stringify(data));
  // Que Netlify no guarde en caché los datos (para que una nueva publicación se vea al tiro).
  fs.writeFileSync(path.join(outDir, '_headers'), '/data.json\n  Cache-Control: no-cache\n');
  return { dir: outDir, tickets: data.tickets.A.length + data.tickets.B.length, winners: data.winners.length };
}

module.exports = { exportPublicSite };

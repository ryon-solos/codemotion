// Code Motion UI: two screens. #/ is home, #/edit/<project> is the editor.
import { renderHome } from './home.js';
import { renderEditor } from './editor.js';

const app = document.getElementById('app');
let cleanup = null;

async function route() {
  cleanup?.(); cleanup = null;
  app.replaceChildren();
  const m = /^#\/edit\/([^?]+)(?:\?t=([\d.]+))?/.exec(location.hash);
  if (m) { cleanup = await renderEditor(app, decodeURIComponent(m[1]), m[2] != null ? +m[2] : null); document.title = 'Code Motion'; }
  else { cleanup = await renderHome(app); document.title = 'Code Motion'; }
}
window.addEventListener('hashchange', route);
route();

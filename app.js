/* ============================================================
   ORION LUX PANEL — app.js
   Vanilla JS, no build step, runs on GitHub Pages.
   ============================================================ */

'use strict';

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const VAULT_KEY        = 'orionlux_vault';
const REPO_CFG_KEY     = 'orionlux_repo';
const PBKDF2_ITER      = 150000;
const ARS_RATE_DEFAULT = 1450;
let   ARS_RATE         = ARS_RATE_DEFAULT;

// ─────────────────────────────────────────────────────────────
// APP STATE
// ─────────────────────────────────────────────────────────────
let ghToken   = null;   // decrypted PAT — in-memory only
let fileSha   = null;   // current SHA from GitHub API
let savedJSON = '';     // last JSON pushed to GitHub (for dirty check)
let state     = null;   // live app state (deep copy of data.json)
let activeTab = 'costos';
let ventasFilter = 'all';
let ventasSearch = '';
let showARS   = false;

// ─────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// Display a stored USD value according to current currency mode
const fmt = n => showARS
  ? '$' + Math.round(Number(n) * ARS_RATE).toLocaleString('es-AR', { maximumFractionDigits: 0 }) + ' ARS'
  : '$' + (Math.round(Number(n) * 100) / 100).toFixed(2);

// Convert a raw input value to stored USD, always rounded to 2 decimal cents
const toUSD = v => Math.round((showARS ? (parseFloat(v) || 0) / ARS_RATE : (parseFloat(v) || 0)) * 100) / 100;

// Convert a stored USD value to the display input value
const toDisplay = n => showARS
  ? Math.round(Number(n) * ARS_RATE)
  : Math.round(Number(n) * 100) / 100;

function toast(msg, type = 'info', duration = 4000) {
  const el = document.createElement('div');
  el.className = 'toast' + (type !== 'info' ? ' ' + type : '');
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function pad(n, len = 4) {
  return String(n).padStart(len, '0');
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ─────────────────────────────────────────────────────────────
// DERIVED FINANCE
// ─────────────────────────────────────────────────────────────
function precioVenta(p) {
  return p.costo * (1 + p.markupPct / 100);
}

function gananciaUnidad(p) {
  return precioVenta(p) - p.costo - p.envio;
}

function gananciaPorProducto(p) {
  return p.vendidos * gananciaUnidad(p);
}

function ventaMonto(venta) {
  let total = 0;
  for (const item of venta.items) {
    const p = state.productos.find(x => x.id === item.productoId);
    if (p) total += item.cantidad * precioVenta(p);
  }
  return total;
}

function ventaSaldo(venta) {
  return ventaMonto(venta) - (venta.montoPagado || 0);
}

// ─────────────────────────────────────────────────────────────
// WEB CRYPTO — vault helpers
// ─────────────────────────────────────────────────────────────
async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, hash: 'SHA-256', iterations: PBKDF2_ITER },
    keyMat,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function b64encode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64decode(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function encryptToken(token, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await deriveKey(password, salt);
  const enc  = new TextEncoder();
  const ct   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(token));
  return {
    salt:       b64encode(salt),
    iv:         b64encode(iv),
    ciphertext: b64encode(ct)
  };
}

async function decryptToken(vault, password) {
  const salt = b64decode(vault.salt);
  const iv   = b64decode(vault.iv);
  const ct   = b64decode(vault.ciphertext);
  const key  = await deriveKey(password, salt);
  const dec  = new TextDecoder();
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return dec.decode(plain);
}

function loadVault() {
  try { return JSON.parse(localStorage.getItem(VAULT_KEY)); }
  catch { return null; }
}

function saveVault(v) {
  localStorage.setItem(VAULT_KEY, JSON.stringify(v));
}

function clearVault() {
  localStorage.removeItem(VAULT_KEY);
}

// ─────────────────────────────────────────────────────────────
// REPO CONFIG
// ─────────────────────────────────────────────────────────────
function loadRepoCfg() {
  try { return JSON.parse(localStorage.getItem(REPO_CFG_KEY)) || {}; }
  catch { return {}; }
}

function saveRepoCfg(cfg) {
  localStorage.setItem(REPO_CFG_KEY, JSON.stringify(cfg));
}

function repoCfgComplete() {
  const c = loadRepoCfg();
  return !!(c.owner && c.repo);
}

// ─────────────────────────────────────────────────────────────
// GITHUB API
// ─────────────────────────────────────────────────────────────
function apiHeaders() {
  return {
    'Authorization': `Bearer ${ghToken}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json'
  };
}

function contentsUrl() {
  const c = loadRepoCfg();
  const branch = c.branch || 'main';
  const path   = c.path   || 'data.json';
  return `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${path}?ref=${branch}`;
}

function b64encodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64decodeUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

async function fetchRemoteData() {
  if (!repoCfgComplete()) return null;
  setSyncStatus('syncing', 'Cargando…');
  try {
    const res = await fetch(contentsUrl(), { headers: apiHeaders() });
    if (!res.ok) {
      if (res.status === 401) { toast('Token inválido o expirado.', 'error'); }
      else { toast(`Error al cargar datos (${res.status})`, 'error'); }
      return null;
    }
    const json = await res.json();
    fileSha = json.sha;
    return JSON.parse(b64decodeUtf8(json.content.replace(/\n/g, '')));
  } catch (e) {
    toast('Error de red al cargar datos.', 'error');
    return null;
  }
}

async function pushData() {
  if (!repoCfgComplete()) {
    toast('Configurá el repositorio en ⚙️ antes de guardar.', 'warning');
    return;
  }
  const c       = loadRepoCfg();
  const branch  = c.branch || 'main';
  const path    = c.path   || 'data.json';
  const content = JSON.stringify(state, null, 2);
  const b64     = b64encodeUtf8(content);
  const ts      = new Date().toISOString().slice(0, 16).replace('T', ' ');

  setSyncStatus('saving', 'Publicando…');

  const body = {
    message: `panel: actualización ${ts}`,
    content: b64,
    sha:     fileSha,
    branch
  };

  const url = `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${path}`;

  try {
    let res = await fetch(url, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) });

    if (res.status === 409) {
      // sha conflict — refresh and retry once
      const fresh = await fetchRemoteData();
      if (fresh) state = fresh;
      body.sha = fileSha;
      res = await fetch(url, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) });
    }

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 401) toast('Token inválido o expirado.', 'error');
      else toast(`Error al guardar (${res.status}): ${errText.slice(0, 100)}`, 'error');
      setSyncStatus('error', 'Error al guardar');
      return;
    }

    const data = await res.json();
    fileSha  = data.content.sha;
    savedJSON = content;
    setSyncStatus('saved', 'Publicado ✓');
    toast('Publicado ✓ — el sitio se está redeployando', 'success');
  } catch (e) {
    toast('Error de red al guardar.', 'error');
    setSyncStatus('error', 'Sin conexión');
  }
}

// ─────────────────────────────────────────────────────────────
// SYNC STATUS
// ─────────────────────────────────────────────────────────────
function setSyncStatus(type, text) {
  const el = $('sync-status');
  el.className = 'sync-status ' + type;
  el.textContent = text;
}

async function fetchArsRate() {
  try {
    const res  = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    if (data && data.rates && data.rates.ARS) {
      ARS_RATE = Math.round(data.rates.ARS);
      updateRateDisplay();
    }
  } catch {
    // silently keep the default fallback rate
  }
}

function updateRateDisplay() {
  const el = $('ars-rate-display');
  if (el) el.textContent = `1 USD = $${ARS_RATE.toLocaleString('es-AR')} ARS`;
}

function markDirty() {
  const current = JSON.stringify(state, null, 2);
  if (current !== savedJSON) {
    setSyncStatus('unsaved', 'Cambios sin guardar');
  }
}

// ─────────────────────────────────────────────────────────────
// LOGIN SCREEN SETUP
// ─────────────────────────────────────────────────────────────
function setupLogin() {
  const vault = loadVault();
  const tokenField = $('login-token-field');
  const resetBtn   = $('btn-reset-vault');

  if (vault) {
    tokenField.classList.add('hidden');
    resetBtn.classList.remove('hidden');
  } else {
    tokenField.classList.remove('hidden');
    resetBtn.classList.add('hidden');
  }

  $('inp-pass').addEventListener('keydown', e => {
    if (e.key === 'Enter') attemptLogin();
  });
  $('inp-token').addEventListener('keydown', e => {
    if (e.key === 'Enter') attemptLogin();
  });

  $('btn-login').addEventListener('click', attemptLogin);

  $('btn-reset-vault').addEventListener('click', () => {
    clearVault();
    $('login-error').textContent = '';
    setupLogin();
  });
}

async function attemptLogin() {
  const passEl   = $('inp-pass');
  const tokenEl  = $('inp-token');
  const errorEl  = $('login-error');
  const password = passEl.value;

  if (!password) { errorEl.textContent = 'Ingresá tu contraseña.'; return; }

  errorEl.textContent = '';
  $('btn-login').textContent = 'Ingresando…';
  $('btn-login').disabled = true;

  try {
    const vault = loadVault();

    if (vault) {
      // Returning user — decrypt stored token
      let token;
      try {
        token = await decryptToken(vault, password);
      } catch {
        errorEl.textContent = 'Contraseña incorrecta.';
        $('btn-login').textContent = 'Entrar';
        $('btn-login').disabled = false;
        return;
      }
      if (!token || token.length < 10) {
        errorEl.textContent = 'Contraseña incorrecta.';
        $('btn-login').textContent = 'Entrar';
        $('btn-login').disabled = false;
        return;
      }
      ghToken = token;
    } else {
      // First run — encrypt and save token
      const token = tokenEl.value.trim();
      if (!token) { errorEl.textContent = 'Ingresá tu token de GitHub.'; $('btn-login').textContent = 'Entrar'; $('btn-login').disabled = false; return; }
      const newVault = await encryptToken(token, password);
      saveVault(newVault);
      ghToken = token;
    }

    passEl.value  = '';
    tokenEl.value = '';
    await enterDashboard();
  } catch (e) {
    errorEl.textContent = 'Error inesperado: ' + e.message;
    $('btn-login').textContent = 'Entrar';
    $('btn-login').disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD ENTRY
// ─────────────────────────────────────────────────────────────
async function enterDashboard() {
  $('login-screen').style.display = 'none';
  $('app').classList.add('visible');
  $('btn-login').textContent = 'Entrar';
  $('btn-login').disabled = false;

  // Load data
  if (repoCfgComplete()) {
    const remote = await fetchRemoteData();
    if (remote) {
      state = remote;
    } else {
      await loadLocalData();
    }
  } else {
    await loadLocalData();
    setSyncStatus('unsaved', 'Sin repo configurado');
  }

  savedJSON = JSON.stringify(state, null, 2);

  if (!repoCfgComplete()) {
    showNoBanner();
  } else {
    setSyncStatus('saved', 'Al día');
  }

  renderAll();
  setupTopBar();
  setupTabs();
  setupSettings();

  updateRateDisplay();
  fetchArsRate().then(() => {
    updateRateDisplay();
    if (showARS) renderAll();
  });
}

async function loadLocalData() {
  try {
    const res = await fetch('data.json');
    state = await res.json();
  } catch {
    state = { currency:'USD', costosVariables:[], productos:[], ventas:[], meta:{ lastSaleSeq:0 } };
  }
}

function showNoBanner() {
  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.id = 'no-repo-banner';
  banner.innerHTML = '⚠️ No hay repositorio configurado. Configurá <strong>owner</strong> y <strong>repo</strong> en ⚙️ para activar el guardado en la nube.';
  document.querySelector('.main-content').prepend(banner);
}

// ─────────────────────────────────────────────────────────────
// TOP BAR
// ─────────────────────────────────────────────────────────────
function setupTopBar() {
  $('btn-save').addEventListener('click', pushData);
  $('btn-logout').addEventListener('click', logout);
  $('btn-currency').addEventListener('click', () => {
    showARS = !showARS;
    $('btn-currency').textContent = showARS ? 'USD' : 'ARS';
    $('btn-currency').classList.toggle('btn-currency-active', showARS);
    renderAll();
  });
}

function logout() {
  ghToken   = null;
  fileSha   = null;
  savedJSON = '';
  state     = null;
  $('app').classList.remove('visible');
  $('login-screen').style.display = '';
  setupLogin();
  // re-render clears old DOM but we fully rebuild on next login
}

// ─────────────────────────────────────────────────────────────
// TABS
// ─────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'resumen') renderResumen();
}

// ─────────────────────────────────────────────────────────────
// SETTINGS MODAL
// ─────────────────────────────────────────────────────────────
function setupSettings() {
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-settings-cancel').addEventListener('click', closeSettings);
  $('btn-settings-save').addEventListener('click', saveSettings);
  $('settings-modal').addEventListener('click', e => {
    if (e.target === $('settings-modal')) closeSettings();
  });
}

function openSettings() {
  const c = loadRepoCfg();
  $('cfg-owner').value  = c.owner  || '';
  $('cfg-repo').value   = c.repo   || '';
  $('cfg-branch').value = c.branch || 'main';
  $('cfg-path').value   = c.path   || 'data.json';
  $('settings-modal').classList.add('open');
}

function closeSettings() {
  $('settings-modal').classList.remove('open');
}

function saveSettings() {
  const cfg = {
    owner:  $('cfg-owner').value.trim(),
    repo:   $('cfg-repo').value.trim(),
    branch: $('cfg-branch').value.trim() || 'main',
    path:   $('cfg-path').value.trim() || 'data.json'
  };
  saveRepoCfg(cfg);
  closeSettings();
  toast('Configuración guardada.', 'success');
  const banner = $('no-repo-banner');
  if (banner) banner.remove();
  if (repoCfgComplete()) {
    fetchRemoteData().then(remote => {
      if (remote) { state = remote; savedJSON = JSON.stringify(state, null, 2); renderAll(); setSyncStatus('saved', 'Al día'); }
    });
  }
}

// ─────────────────────────────────────────────────────────────
// RENDER ALL
// ─────────────────────────────────────────────────────────────
function renderAll() {
  renderCostos();
  renderInventario();
  renderVentas();
  if (activeTab === 'resumen') renderResumen();
}

// ─────────────────────────────────────────────────────────────
//  TAB 1 — COSTOS
// ─────────────────────────────────────────────────────────────
function renderCostos() {
  const list = $('costos-list');
  list.innerHTML = '';

  for (const costo of state.costosVariables) {
    const row = document.createElement('div');
    row.className = 'costo-row';
    row.dataset.id = costo.id;

    const catInput = document.createElement('input');
    catInput.type  = 'text';
    catInput.value = costo.categoria;
    catInput.placeholder = 'Categoría';
    catInput.addEventListener('input', e => {
      costo.categoria = e.target.value;
      markDirty();
    });

    const montoInput = document.createElement('input');
    montoInput.type        = 'number';
    montoInput.value       = toDisplay(costo.monto);
    montoInput.placeholder = showARS ? 'ARS' : 'USD';
    montoInput.min         = '0';
    montoInput.step        = showARS ? '1' : '0.01';
    montoInput.addEventListener('input', e => {
      costo.monto = toUSD(e.target.value);
      updateCostosTotal();
      markDirty();
      if (activeTab === 'resumen') renderResumen();
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-icon btn-danger';
    delBtn.innerHTML = '🗑';
    delBtn.title = 'Eliminar';
    delBtn.addEventListener('click', () => {
      state.costosVariables = state.costosVariables.filter(c => c.id !== costo.id);
      renderCostos();
      markDirty();
      if (activeTab === 'resumen') renderResumen();
    });

    row.appendChild(catInput);
    row.appendChild(montoInput);
    row.appendChild(delBtn);
    list.appendChild(row);
  }

  updateCostosTotal();

  $('btn-add-costo').onclick = () => {
    state.costosVariables.push({ id: 'cv-' + uid(), categoria: '', monto: 0 });
    renderCostos();
    markDirty();
  };
}

function updateCostosTotal() {
  const total = state.costosVariables.reduce((s, c) => s + (c.monto || 0), 0);
  $('costos-total').textContent = fmt(total);
  const note = $('costos-currency-note');
  if (note) note.textContent = showARS ? '(valores en ARS, guardados en USD)' : '(USD)';
}

// ─────────────────────────────────────────────────────────────
//  TAB 2 — INVENTARIO
// ─────────────────────────────────────────────────────────────
const CATEGORIES = ['Earrings', 'Rings', 'Necklaces', 'Bracelets'];

function renderInventario() {
  const container = $('inventario-content');
  container.innerHTML = '';

  const allCats = [...new Set(state.productos.map(p => p.categoria))];
  const orderedCats = [...CATEGORIES.filter(c => allCats.includes(c)), ...allCats.filter(c => !CATEGORIES.includes(c))];

  for (const cat of orderedCats) {
    const prods = state.productos.filter(p => p.categoria === cat);
    if (!prods.length) continue;

    const header = document.createElement('div');
    header.className = 'inv-category-header';
    header.textContent = cat;
    container.appendChild(header);

    const wrap = document.createElement('div');
    wrap.className = 'inv-table-wrap card';
    wrap.style.padding = '0';
    wrap.style.marginBottom = '0.5rem';

    const table = document.createElement('table');
    table.className = 'inv-table';
    table.innerHTML = `
      <thead><tr>
        <th>Nombre / Variante</th>
        <th>Categoría</th>
        <th>ID</th>
        <th>Costo</th>
        <th>Envío</th>
        <th>Markup %</th>
        <th>P. Venta</th>
        <th>Ganancia/u</th>
        <th>Stock</th>
        <th>Vendidos</th>
        <th>Comprados</th>
        <th>Ganancia total</th>
        <th>Acciones</th>
      </tr></thead>
      <tbody></tbody>`;

    const tbody = table.querySelector('tbody');

    for (const p of prods) {
      tbody.appendChild(buildProductRow(p));
    }

    wrap.appendChild(table);
    container.appendChild(wrap);
  }

  $('btn-add-producto').onclick = addNewProducto;
}

function buildProductRow(p) {
  const tr = document.createElement('tr');
  tr.dataset.id = p.id;

  const pv = precioVenta(p);
  const gu = gananciaUnidad(p);
  const gt = gananciaPorProducto(p);

  const numInput = (val, field, step = '0.01', width = '70px', isMoney = false) => {
    const inp = document.createElement('input');
    inp.type  = 'number';
    inp.value = isMoney ? toDisplay(val) : val;
    inp.step  = isMoney ? (showARS ? '1' : step) : step;
    inp.min   = '0';
    inp.style.width = width;
    inp.addEventListener('change', e => {
      p[field] = isMoney ? toUSD(e.target.value) : (parseFloat(e.target.value) || 0);
      refreshProductRow(tr, p);
      markDirty();
      if (activeTab === 'resumen') renderResumen();
    });
    return inp;
  };

  // Col: nombre + variante (two stacked inputs)
  const tdNombre = document.createElement('td');
  tdNombre.style.minWidth = '160px';

  const nombreInp = document.createElement('input');
  nombreInp.type = 'text'; nombreInp.value = p.nombre;
  nombreInp.placeholder = 'Nombre';
  nombreInp.style.cssText = 'width:100%;background:transparent;border:1px solid transparent;border-radius:4px;padding:.22rem .35rem;font-size:.84rem;font-weight:500;color:var(--silver-hi);font-family:var(--font);display:block';
  nombreInp.addEventListener('focus', e => e.target.style.borderColor = 'var(--silver-lo)');
  nombreInp.addEventListener('blur',  e => { e.target.style.borderColor = 'transparent'; });
  nombreInp.addEventListener('change', e => { p.nombre = e.target.value; markDirty(); });

  const varianteInp = document.createElement('input');
  varianteInp.type = 'text'; varianteInp.value = p.variante;
  varianteInp.placeholder = 'Variante';
  varianteInp.style.cssText = 'width:100%;background:transparent;border:1px solid transparent;border-radius:4px;padding:.18rem .35rem;font-size:.72rem;color:var(--silver-lo);font-family:var(--font);display:block;margin-top:.1rem';
  varianteInp.addEventListener('focus', e => e.target.style.borderColor = 'var(--silver-lo)');
  varianteInp.addEventListener('blur',  e => { e.target.style.borderColor = 'transparent'; });
  varianteInp.addEventListener('change', e => { p.variante = e.target.value; markDirty(); });

  tdNombre.appendChild(nombreInp);
  tdNombre.appendChild(varianteInp);

  // Col: categoria (own cell)
  const tdCat = document.createElement('td');
  const catSel = document.createElement('select');
  catSel.style.cssText = 'background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:.3rem .4rem;font-size:.75rem;color:var(--silver);font-family:var(--font);cursor:pointer;width:100%';
  [...CATEGORIES, 'Other'].forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    if (c === p.categoria) o.selected = true;
    catSel.appendChild(o);
  });
  catSel.addEventListener('change', e => { p.categoria = e.target.value; markDirty(); renderInventario(); });
  tdCat.appendChild(catSel);

  // Col: id
  const tdId = document.createElement('td');
  tdId.innerHTML = `<span class="inv-id-badge">${escHtml(p.id)}</span>`;

  // Editable cols
  const tdCosto  = document.createElement('td'); tdCosto.appendChild(numInput(p.costo, 'costo', '0.01', '70px', true));
  const tdEnvio  = document.createElement('td'); tdEnvio.appendChild(numInput(p.envio, 'envio', '0.01', '70px', true));

  // Markup % — editing this updates precio venta input
  const markupInp = document.createElement('input');
  markupInp.type = 'number'; markupInp.value = p.markupPct;
  markupInp.step = '1'; markupInp.min = '0'; markupInp.style.width = '65px';
  markupInp.addEventListener('change', e => {
    p.markupPct = parseFloat(e.target.value) || 0;
    pvInp.value = toDisplay(precioVenta(p));
    refreshProductRow(tr, p);
    markDirty();
    if (activeTab === 'resumen') renderResumen();
  });
  const tdMarkup = document.createElement('td'); tdMarkup.appendChild(markupInp);

  // Precio venta — editing this back-calculates markup
  const pvInp = document.createElement('input');
  pvInp.type = 'number'; pvInp.value = toDisplay(pv);
  pvInp.step = showARS ? '1' : '0.01'; pvInp.min = '0'; pvInp.style.width = '80px';
  pvInp.classList.add('fw-600');
  pvInp.addEventListener('change', e => {
    const newPV = toUSD(e.target.value);
    // markup = (pv / costo - 1) * 100, only if costo > 0
    p.markupPct = p.costo > 0 ? Math.round(((newPV / p.costo) - 1) * 1000000) / 10000 : 0;
    markupInp.value = Math.round(p.markupPct * 100) / 100;
    refreshProductRow(tr, p);
    markDirty();
    if (activeTab === 'resumen') renderResumen();
  });
  const tdPV = document.createElement('td'); tdPV.appendChild(pvInp);

  const tdGU = document.createElement('td');
  tdGU.textContent = fmt(gu);
  tdGU.className = gu >= 0 ? 'text-green fw-600' : 'text-red fw-600';

  const tdStock   = document.createElement('td'); tdStock.textContent   = p.stock;   tdStock.className = 'fw-600';
  const tdVendidos= document.createElement('td'); tdVendidos.textContent= p.vendidos;
  const tdComprados=document.createElement('td'); tdComprados.textContent=p.comprados;

  const tdGT = document.createElement('td');
  tdGT.textContent = fmt(gt);
  tdGT.className = gt >= 0 ? 'text-green' : 'text-red';

  // Actions
  const tdActions = document.createElement('td');
  tdActions.innerHTML = '';

  const actDiv = document.createElement('div');
  actDiv.className = 'inv-actions';

  // + Stock
  const stockInp = document.createElement('input');
  stockInp.type  = 'number'; stockInp.value = '1'; stockInp.min = '1'; stockInp.className = 'input-sm';
  stockInp.style.width = '48px';
  const stockBtn = document.createElement('button');
  stockBtn.className = 'btn btn-green btn-sm';
  stockBtn.textContent = '+ Stock';
  stockBtn.addEventListener('click', () => {
    const n = parseInt(stockInp.value) || 1;
    p.stock    += n;
    p.comprados += n;
    refreshProductRow(tr, p);
    markDirty();
    if (activeTab === 'resumen') renderResumen();
  });

  // − Vender
  const venderInp = document.createElement('input');
  venderInp.type  = 'number'; venderInp.value = '1'; venderInp.min = '1'; venderInp.className = 'input-sm';
  venderInp.style.width = '48px';
  const venderBtn = document.createElement('button');
  venderBtn.className = 'btn btn-danger btn-sm';
  venderBtn.textContent = '− Vender';
  venderBtn.addEventListener('click', () => {
    const n = parseInt(venderInp.value) || 1;
    if (p.stock < n) { toast(`Stock insuficiente. Stock actual: ${p.stock}`, 'error'); return; }
    p.stock    -= n;
    p.vendidos += n;
    refreshProductRow(tr, p);
    markDirty();
    if (activeTab === 'resumen') renderResumen();
  });

  const stockGroup  = document.createElement('div'); stockGroup.className = 'stock-action';
  stockGroup.appendChild(stockInp); stockGroup.appendChild(stockBtn);
  const venderGroup = document.createElement('div'); venderGroup.className = 'stock-action';
  venderGroup.appendChild(venderInp); venderGroup.appendChild(venderBtn);

  // ↑ ↓ reorder within full productos array
  const upBtn = document.createElement('button');
  upBtn.className = 'btn btn-icon btn-sm'; upBtn.textContent = '↑'; upBtn.title = 'Subir';
  upBtn.addEventListener('click', () => {
    const idx = state.productos.indexOf(p);
    if (idx > 0) {
      state.productos.splice(idx, 1);
      state.productos.splice(idx - 1, 0, p);
      markDirty(); renderInventario();
    }
  });

  const downBtn = document.createElement('button');
  downBtn.className = 'btn btn-icon btn-sm'; downBtn.textContent = '↓'; downBtn.title = 'Bajar';
  downBtn.addEventListener('click', () => {
    const idx = state.productos.indexOf(p);
    if (idx < state.productos.length - 1) {
      state.productos.splice(idx, 1);
      state.productos.splice(idx + 1, 0, p);
      markDirty(); renderInventario();
    }
  });

  const orderGroup = document.createElement('div'); orderGroup.className = 'stock-action';
  orderGroup.appendChild(upBtn); orderGroup.appendChild(downBtn);

  actDiv.appendChild(stockGroup);
  actDiv.appendChild(venderGroup);
  actDiv.appendChild(orderGroup);
  tdActions.appendChild(actDiv);

  tr.appendChild(tdNombre);
  tr.appendChild(tdCat);
  tr.appendChild(tdId);
  tr.appendChild(tdCosto);
  tr.appendChild(tdEnvio);
  tr.appendChild(tdMarkup);
  tr.appendChild(tdPV);
  tr.appendChild(tdGU);
  tr.appendChild(tdStock);
  tr.appendChild(tdVendidos);
  tr.appendChild(tdComprados);
  tr.appendChild(tdGT);
  tr.appendChild(tdActions);

  return tr;
}

function refreshProductRow(tr, p) {
  const pv = precioVenta(p);
  const gu = gananciaUnidad(p);
  const gt = gananciaPorProducto(p);

  const tds = tr.querySelectorAll('td');
  // td[0]=nombre, td[1]=cat, td[2]=id, td[3]=costo, td[4]=envio, td[5]=markup, td[6]=PV, td[7]=GU, td[8]=stock, td[9]=vendidos, td[10]=comprados, td[11]=GT
  const pvInput = tds[6].querySelector('input');
  if (pvInput) pvInput.value = toDisplay(pv);
  tds[7].textContent = fmt(gu);
  tds[7].className = gu >= 0 ? 'text-green fw-600' : 'text-red fw-600';
  tds[8].textContent = p.stock;
  tds[9].textContent = p.vendidos;
  tds[10].textContent = p.comprados;
  tds[11].textContent = fmt(gt);
  tds[11].className = gt >= 0 ? 'text-green' : 'text-red';
}

function addNewProducto() {
  const id = 'PROD-' + uid().toUpperCase();
  const nuevo = {
    id, nombre: '', variante: '', categoria: 'Other',
    costo: 0, envio: 0, markupPct: 0, stock: 0, comprados: 0, vendidos: 0
  };

  // Show a mini form in a card
  const card = document.createElement('div');
  card.className = 'card';
  card.style.marginBottom = '1rem';
  const currLabel = showARS ? 'ARS' : 'USD';
  const moneyStep = showARS ? '1' : '0.01';
  card.innerHTML = `
    <div class="section-title" style="margin-bottom:1rem;font-size:0.8rem">Nuevo producto</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:0.65rem;margin-bottom:1rem">
      <div><label style="font-size:0.7rem;color:var(--silver-lo);text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:.3rem">Nombre</label><input type="text" id="np-nombre" /></div>
      <div><label style="font-size:0.7rem;color:var(--silver-lo);text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:.3rem">Variante</label><input type="text" id="np-variante" /></div>
      <div><label style="font-size:0.7rem;color:var(--silver-lo);text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:.3rem">Categoría</label>
        <select id="np-cat">
          <option>Earrings</option><option>Rings</option><option>Necklaces</option><option>Bracelets</option><option>Other</option>
        </select></div>
      <div><label style="font-size:0.7rem;color:var(--silver-lo);text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:.3rem">Costo (${currLabel})</label><input type="number" id="np-costo" value="0" min="0" step="${moneyStep}" /></div>
      <div><label style="font-size:0.7rem;color:var(--silver-lo);text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:.3rem">Envío (${currLabel})</label><input type="number" id="np-envio" value="0" min="0" step="${moneyStep}" /></div>
      <div><label style="font-size:0.7rem;color:var(--silver-lo);text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:.3rem">Markup %</label><input type="number" id="np-markup" value="0" min="0" step="1" /></div>
    </div>
    <div style="font-size:0.72rem;color:var(--silver-lo);margin-bottom:.75rem">ID generado: <span style="font-family:monospace;color:var(--silver)">${escHtml(id)}</span></div>
    <div style="display:flex;gap:.5rem">
      <button class="btn btn-accent" id="np-confirm">Crear producto</button>
      <button class="btn" id="np-cancel">Cancelar</button>
    </div>`;

  const invContent = $('inventario-content');
  invContent.prepend(card);

  card.querySelector('#np-cancel').addEventListener('click', () => { card.remove(); });
  card.querySelector('#np-confirm').addEventListener('click', () => {
    nuevo.nombre    = card.querySelector('#np-nombre').value.trim()  || 'Producto';
    nuevo.variante  = card.querySelector('#np-variante').value.trim();
    nuevo.categoria = card.querySelector('#np-cat').value;
    nuevo.costo     = toUSD(card.querySelector('#np-costo').value);
    nuevo.envio     = toUSD(card.querySelector('#np-envio').value);
    nuevo.markupPct = parseFloat(card.querySelector('#np-markup').value) || 0;
    state.productos.push(nuevo);
    card.remove();
    renderInventario();
    markDirty();
  });
}

// ─────────────────────────────────────────────────────────────
//  TAB 3 — VENTAS
// ─────────────────────────────────────────────────────────────
function renderVentas() {
  const list = $('ventas-list');
  list.innerHTML = '';

  let ventas = [...state.ventas].reverse(); // newest first

  if (ventasFilter !== 'all') {
    ventas = ventas.filter(v => v.estado === ventasFilter);
  }
  if (ventasSearch.trim()) {
    const q = ventasSearch.trim().toLowerCase();
    ventas = ventas.filter(v => (v.cliente || '').toLowerCase().includes(q));
  }

  for (const v of ventas) {
    list.appendChild(buildVentaCard(v));
  }

  if (!ventas.length) {
    list.innerHTML = '<div class="text-muted" style="padding:2rem;text-align:center;font-size:0.85rem">No hay ventas.</div>';
  }

  // Filters
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.onclick = () => {
      ventasFilter = chip.dataset.filter;
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c === chip));
      renderVentas();
    };
  });

  $('ventas-search').value = ventasSearch;
  $('ventas-search').oninput = e => {
    ventasSearch = e.target.value;
    renderVentas();
  };

  $('btn-new-venta').onclick = createVenta;
}

function buildVentaCard(venta) {
  const card = document.createElement('div');
  card.className = 'venta-card';
  card.dataset.id = venta.id;

  const monto  = ventaMonto(venta);
  const saldo  = ventaSaldo(venta);

  const estadoClass = {
    'Preorder impago':  'estado-impago',
    'Preorder pago':    'estado-pago',
    'Vendido':          'estado-vendido'
  }[venta.estado] || '';

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'venta-header';

  const idSpan = document.createElement('span');
  idSpan.className = 'venta-id';
  idSpan.textContent = venta.id;

  const fields = document.createElement('div');
  fields.className = 'venta-header-fields';

  const clienteInp = document.createElement('input');
  clienteInp.type  = 'text';
  clienteInp.value = venta.cliente || '';
  clienteInp.placeholder = 'Cliente';
  clienteInp.addEventListener('change', e => { venta.cliente = e.target.value; markDirty(); renderResumen(); });

  const fechaInp = document.createElement('input');
  fechaInp.type  = 'date';
  fechaInp.value = venta.fecha || '';
  fechaInp.addEventListener('change', e => { venta.fecha = e.target.value; markDirty(); });

  const estadoSel = document.createElement('select');
  ['Preorder impago', 'Preorder pago', 'Vendido'].forEach(opt => {
    const o = document.createElement('option');
    o.value = opt; o.textContent = opt;
    if (opt === venta.estado) o.selected = true;
    estadoSel.appendChild(o);
  });
  estadoSel.addEventListener('change', e => {
    venta.estado = e.target.value;
    // update badge
    const badge = header.querySelector('.estado-badge');
    badge.className = 'estado-badge ' + ({
      'Preorder impago': 'estado-impago',
      'Preorder pago':   'estado-pago',
      'Vendido':         'estado-vendido'
    }[venta.estado] || '');
    badge.textContent = venta.estado;
    markDirty();
    if (activeTab === 'resumen') renderResumen();
  });

  const badge = document.createElement('span');
  badge.className = 'estado-badge ' + estadoClass;
  badge.textContent = venta.estado;

  fields.appendChild(clienteInp);
  fields.appendChild(fechaInp);
  fields.appendChild(estadoSel);

  const headerRight = document.createElement('div');
  headerRight.style.cssText = 'display:flex;align-items:center;gap:.5rem';
  headerRight.appendChild(badge);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn btn-icon btn-danger btn-sm';
  delBtn.innerHTML = '🗑';
  delBtn.title = 'Eliminar venta';
  delBtn.addEventListener('click', () => {
    if (!confirm(`¿Eliminar venta ${venta.id}?`)) return;
    state.ventas = state.ventas.filter(v => v.id !== venta.id);
    renderVentas();
    markDirty();
    if (activeTab === 'resumen') renderResumen();
  });
  headerRight.appendChild(delBtn);

  header.appendChild(idSpan);
  header.appendChild(fields);
  header.appendChild(headerRight);

  // ── Body ──
  const body = document.createElement('div');
  body.className = 'venta-body';

  // Items
  const itemsDiv = document.createElement('div');
  itemsDiv.className = 'venta-items';
  const itemsTitle = document.createElement('div');
  itemsTitle.className = 'venta-items-title';
  itemsTitle.textContent = 'Productos';
  itemsDiv.appendChild(itemsTitle);

  const itemsContainer = document.createElement('div');
  itemsDiv.appendChild(itemsContainer);

  function renderItems() {
    itemsContainer.innerHTML = '';
    for (const item of venta.items) {
      const p = state.productos.find(x => x.id === item.productoId);
      const row = document.createElement('div');
      row.className = 'venta-item-row';

      const nameTd = document.createElement('div');
      nameTd.style.cssText = 'font-size:0.83rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      nameTd.textContent = p ? `${p.nombre} — ${p.variante}` : item.productoId;

      const qtyInp = document.createElement('input');
      qtyInp.type  = 'number';
      qtyInp.value = item.cantidad;
      qtyInp.min   = '1';
      qtyInp.step  = '1';
      qtyInp.style.cssText = 'width:56px;padding:.28rem .4rem;font-size:.8rem';
      qtyInp.addEventListener('change', e => {
        item.cantidad = parseInt(e.target.value) || 1;
        updateVentaFinancials(venta, finContainer);
        markDirty();
        if (activeTab === 'resumen') renderResumen();
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-icon btn-danger btn-sm';
      removeBtn.innerHTML = '×';
      removeBtn.addEventListener('click', () => {
        venta.items = venta.items.filter(i => i !== item);
        renderItems();
        updateVentaFinancials(venta, finContainer);
        markDirty();
        if (activeTab === 'resumen') renderResumen();
      });

      row.appendChild(nameTd);
      row.appendChild(qtyInp);
      row.appendChild(removeBtn);
      itemsContainer.appendChild(row);
    }

    // Add item row
    const addRow = document.createElement('div');
    addRow.className = 'add-item-row';

    const prodSel = document.createElement('select');
    const defaultOpt = document.createElement('option');
    defaultOpt.value = ''; defaultOpt.textContent = '— Agregar producto —';
    prodSel.appendChild(defaultOpt);
    const orderedProds = [...state.productos].sort((a,b) => a.categoria.localeCompare(b.categoria) || a.nombre.localeCompare(b.nombre));
    for (const p of orderedProds) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = `${p.nombre} (${p.variante}) — ${fmt(precioVenta(p))}`;
      prodSel.appendChild(o);
    }

    const qtyAdd = document.createElement('input');
    qtyAdd.type = 'number'; qtyAdd.value = '1'; qtyAdd.min = '1'; qtyAdd.step = '1';
    qtyAdd.style.cssText = 'width:60px;padding:.3rem .45rem;font-size:.8rem';

    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm';
    addBtn.textContent = '+ Agregar';
    addBtn.addEventListener('click', () => {
      if (!prodSel.value) return;
      venta.items.push({ productoId: prodSel.value, cantidad: parseInt(qtyAdd.value) || 1 });
      renderItems();
      updateVentaFinancials(venta, finContainer);
      markDirty();
      if (activeTab === 'resumen') renderResumen();
    });

    addRow.appendChild(prodSel);
    addRow.appendChild(qtyAdd);
    addRow.appendChild(addBtn);
    itemsContainer.appendChild(addRow);
  }

  renderItems();

  // Financials
  const finContainer = document.createElement('div');
  finContainer.className = 'venta-financials';
  buildVentaFinancials(venta, finContainer);

  // Notas
  const notasDiv = document.createElement('div');
  notasDiv.className = 'venta-notas';
  const notasLabel = document.createElement('label');
  notasLabel.textContent = 'Notas';
  const notasArea = document.createElement('textarea');
  notasArea.value = venta.notas || '';
  notasArea.rows  = 2;
  notasArea.addEventListener('change', e => { venta.notas = e.target.value; markDirty(); });
  notasDiv.appendChild(notasLabel);
  notasDiv.appendChild(notasArea);

  body.appendChild(itemsDiv);
  body.appendChild(finContainer);
  body.appendChild(notasDiv);

  card.appendChild(header);
  card.appendChild(body);

  return card;
}

function buildVentaFinancials(venta, container) {
  container.innerHTML = '';

  const monto = ventaMonto(venta);
  const saldo = ventaSaldo(venta);

  // Monto adeudado (read-only)
  const adField = document.createElement('div');
  adField.className = 'fin-field';
  adField.innerHTML = `<label>Monto adeudado</label><div style="font-size:1rem;font-weight:600;padding-top:.45rem">${fmt(monto)}</div>`;

  // Monto pagado (editable)
  const pagField = document.createElement('div');
  pagField.className = 'fin-field';
  const pagLabel = document.createElement('label');
  pagLabel.textContent = 'Monto pagado';
  const pagInp = document.createElement('input');
  pagInp.type  = 'number';
  pagInp.value = toDisplay(venta.montoPagado || 0);
  pagInp.min   = '0'; pagInp.step = showARS ? '1' : '0.01';
  pagInp.addEventListener('change', e => {
    venta.montoPagado = toUSD(e.target.value);
    updateVentaFinancials(venta, container);
    markDirty();
    if (activeTab === 'resumen') renderResumen();
  });
  pagField.appendChild(pagLabel);
  pagField.appendChild(pagInp);

  // Saldo
  const salField = document.createElement('div');
  salField.className = 'fin-field';
  const salLabel = document.createElement('label');
  salLabel.textContent = 'Saldo';
  const salVal = document.createElement('div');
  salVal.className = 'fin-saldo ' + (saldo <= 0 ? 'text-green' : 'text-red');
  salVal.textContent = fmt(saldo);
  salField.appendChild(salLabel);
  salField.appendChild(salVal);

  container.appendChild(adField);
  container.appendChild(pagField);
  container.appendChild(salField);
}

function updateVentaFinancials(venta, container) {
  buildVentaFinancials(venta, container);
}

function createVenta() {
  state.meta.lastSaleSeq = (state.meta.lastSaleSeq || 0) + 1;
  const newVenta = {
    id:           'V-' + pad(state.meta.lastSaleSeq),
    cliente:      '',
    fecha:        todayISO(),
    estado:       'Preorder impago',
    items:        [],
    montoPagado:  0,
    notas:        ''
  };
  state.ventas.push(newVenta);
  markDirty();
  ventasFilter = 'all';
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === 'all'));
  renderVentas();
  // Scroll to new card (it's first after reverse)
  const list = $('ventas-list');
  if (list.firstElementChild) list.firstElementChild.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─────────────────────────────────────────────────────────────
//  TAB 4 — RESUMEN
// ─────────────────────────────────────────────────────────────
function renderResumen() {
  const container = $('resumen-content');
  container.innerHTML = '';

  // ── Calculations ──
  // Revenue
  const ingresosCobrados     = state.ventas.reduce((s, v) => s + (v.montoPagado || 0), 0);
  const ingresosAdeudados    = state.ventas.reduce((s, v) => s + ventaMonto(v), 0);
  const saldoPendiente       = state.ventas.reduce((s, v) => { const sal = ventaSaldo(v); return s + (sal > 0 ? sal : 0); }, 0);
  const facturacionPasada    = state.productos.reduce((s, p) => s + p.vendidos * precioVenta(p), 0);
  const facturacionPotencial = state.productos.reduce((s, p) => s + p.stock * precioVenta(p), 0);
  const facturacionAllTime   = facturacionPasada + facturacionPotencial;

  // COGS
  const costoMercaderia      = state.productos.reduce((s, p) => s + p.comprados * p.costo, 0);
  const costoEnvioProveedor  = state.productos.reduce((s, p) => s + p.comprados * p.envio, 0);
  const totalCOGS            = costoMercaderia + costoEnvioProveedor;

  // Gross profit (on collected revenue)
  const margenBrutoCobrado   = ingresosCobrados - totalCOGS;
  const pctMargenBruto       = ingresosCobrados > 0 ? (margenBrutoCobrado / ingresosCobrados * 100) : 0;

  // Operating expenses
  const totalOpex            = state.costosVariables.reduce((s, c) => s + (c.monto || 0), 0);

  // Net result (cash)
  const resultadoNeto        = ingresosCobrados - totalCOGS - totalOpex;
  const ebitda               = resultadoNeto; // sin depreciación ni impuestos en este modelo

  // Inventory / pipeline
  const valorStockCosto      = state.productos.reduce((s, p) => s + p.stock * p.costo, 0);
  const margenBrutoPotencial = state.productos.reduce((s, p) => s + p.stock * gananciaUnidad(p), 0);
  const ganRealizadaVentas   = state.productos.reduce((s, p) => s + gananciaPorProducto(p), 0);
  const unidadesEnStock      = state.productos.reduce((s, p) => s + p.stock, 0);
  const unidadesCompradas    = state.productos.reduce((s, p) => s + p.comprados, 0);
  const unidadesVendidas     = state.productos.reduce((s, p) => s + p.vendidos, 0);

  // Sales pipeline
  const countImpago  = state.ventas.filter(v => v.estado === 'Preorder impago').length;
  const countPago    = state.ventas.filter(v => v.estado === 'Preorder pago').length;
  const countVendido = state.ventas.filter(v => v.estado === 'Vendido').length;
  const totalVentas  = state.ventas.length;

  // ── Helpers ──
  const row = (label, value, cls = '', indent = false, bold = false, sep = false) => `
    <div class="pnl-row${sep ? ' pnl-sep' : ''}${bold ? ' pnl-bold' : ''}">
      <span class="pnl-label${indent ? ' pnl-indent' : ''}">${label}</span>
      <span class="pnl-value ${cls}">${value}</span>
    </div>`;

  const section = (title) => `<div class="pnl-section-title">${title}</div>`;

  const pct = (n) => (Math.round(n * 10) / 10).toFixed(1) + '%';

  // ── Headline ──
  const headline = document.createElement('div');
  headline.className = 'headline-card ' + (resultadoNeto >= 0 ? 'verde' : 'rojo');
  headline.innerHTML = `
    <div class="headline-label">Resultado neto (caja)</div>
    <div class="headline-status ${resultadoNeto >= 0 ? 'verde' : 'rojo'}">${resultadoNeto >= 0 ? 'EN VERDE' : 'EN ROJO'}</div>
    <div class="headline-amount ${resultadoNeto >= 0 ? 'verde' : 'rojo'}">${fmt(resultadoNeto)}</div>
    <div style="margin-top:.85rem;font-size:.75rem;color:var(--silver-lo);letter-spacing:.04em">
      Cobrado ${fmt(ingresosCobrados)} &nbsp;−&nbsp; COGS ${fmt(totalCOGS)} &nbsp;−&nbsp; Opex ${fmt(totalOpex)}
    </div>`;
  container.appendChild(headline);

  // ── Two-column layout: P&L + Pipeline ──
  const cols = document.createElement('div');
  cols.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:.85rem;margin-bottom:.85rem';

  // ── P&L Statement ──
  const pnlCard = document.createElement('div');
  pnlCard.className = 'card';
  pnlCard.innerHTML = `
    <div class="pnl-title">Estado de Resultados (P&L)</div>

    ${section('Ingresos')}
    ${row('Facturación pasada (vendido)', fmt(facturacionPasada), 'text-silver', true)}
    ${row('Facturación potencial (stock)', fmt(facturacionPotencial), 'text-silver', true)}
    ${row('Facturación all-time', fmt(facturacionAllTime), 'text-silver', false, true, true)}
    ${row('Cobrado de clientes', fmt(ingresosCobrados), ingresosCobrados >= 0 ? 'text-green' : 'text-red', true)}
    ${row('Pendiente de cobro', fmt(saldoPendiente), saldoPendiente > 0 ? 'text-red' : 'text-green', true)}

    ${section('Costo de mercadería vendida (COGS)')}
    ${row('Costo de productos', fmt(costoMercaderia), '', true)}
    ${row('Envío proveedor', fmt(costoEnvioProveedor), '', true)}
    ${row('Total COGS', fmt(totalCOGS), 'text-red', false, true, true)}

    ${section('Margen bruto')}
    ${row('Margen bruto ($)', fmt(margenBrutoCobrado), margenBrutoCobrado >= 0 ? 'text-green' : 'text-red', false, true)}
    ${row('Margen bruto (%)', pct(pctMargenBruto), margenBrutoCobrado >= 0 ? 'text-green' : 'text-red', true)}

    ${section('Gastos operativos (Opex)')}
    ${state.costosVariables.map(c => row(c.categoria || '—', fmt(c.monto), '', true)).join('')}
    ${row('Total Opex', fmt(totalOpex), 'text-red', false, true, true)}

    ${section('Resultado')}
    ${row('EBITDA / Resultado neto', fmt(ebitda), ebitda >= 0 ? 'text-green fw-700' : 'text-red fw-700', false, true, true)}`;
  cols.appendChild(pnlCard);

  // ── Pipeline / Inventory ──
  const pipeCard = document.createElement('div');
  pipeCard.className = 'card';
  pipeCard.innerHTML = `
    <div class="pnl-title">Inventario & Pipeline</div>

    ${section('Facturación')}
    ${row('Facturación pasada (vendido)', fmt(facturacionPasada), '', true)}
    ${row('Facturación potencial (stock)', fmt(facturacionPotencial), '', true)}
    ${row('Facturación all-time', fmt(facturacionAllTime), 'text-green', false, true, true)}

    ${section('Stock actual')}
    ${row('Unidades en stock', unidadesEnStock, '', true)}
    ${row('Valor en stock (costo)', fmt(valorStockCosto), '', true)}
    ${row('Margen bruto potencial', fmt(margenBrutoPotencial), margenBrutoPotencial >= 0 ? 'text-green' : 'text-red', true, true)}

    ${section('Histórico')}
    ${row('Unidades compradas', unidadesCompradas, '', true)}
    ${row('Unidades vendidas', unidadesVendidas, '', true)}
    ${row('Margen realizado', fmt(ganRealizadaVentas), ganRealizadaVentas >= 0 ? 'text-green' : 'text-red', true, true)}

    ${section('Cobranzas')}
    ${row('Total facturado a clientes', fmt(ingresosAdeudados), '', true)}
    ${row('Cobrado', fmt(ingresosCobrados), 'text-green', true)}
    ${row('Pendiente de cobro', fmt(saldoPendiente), saldoPendiente > 0 ? 'text-red' : 'text-green', true, true)}

    ${section('Ventas por estado')}
    ${row('Preorder impago', countImpago, 'text-red', true)}
    ${row('Preorder pago', countPago, '', true)}
    ${row('Vendido / entregado', countVendido, 'text-green', true)}
    ${row('Total órdenes', totalVentas, '', false, true, true)}`;
  cols.appendChild(pipeCard);

  container.appendChild(cols);

  // ── Top products ──
  const sortedProds = [...state.productos]
    .map(p => ({ ...p, gt: gananciaPorProducto(p) }))
    .filter(p => p.vendidos > 0)
    .sort((a, b) => b.gt - a.gt)
    .slice(0, 8);

  if (sortedProds.length) {
    const topCard = document.createElement('div');
    topCard.className = 'card';
    topCard.innerHTML = `<div class="pnl-title">Top productos por margen realizado</div>`;
    for (const p of sortedProds) {
      const rowEl = document.createElement('div');
      rowEl.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:.45rem 0;border-bottom:1px solid var(--border);font-size:.83rem';
      rowEl.innerHTML = `
        <span>${escHtml(p.nombre)} <span style="color:var(--silver-lo);font-size:.75rem">${escHtml(p.variante)}</span></span>
        <span class="${p.gt >= 0 ? 'text-green' : 'text-red'} fw-600">${fmt(p.gt)}</span>`;
      topCard.appendChild(rowEl);
    }
    container.appendChild(topCard);
  }
}

function barSegment(count, total, color) {
  if (!total) return '';
  const pct = (count / total * 100).toFixed(1);
  return `<div style="width:${pct}%;background:${color};transition:width .3s"></div>`;
}

// ─────────────────────────────────────────────────────────────
// XSS helper
// ─────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupLogin();
});

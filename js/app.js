import * as store from './crypto-store.js';
import * as engine from './face-engine.js';
import { Camera, describeCameraError } from './camera.js';

/* =============================== Utilidades =============================== */

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONSENT_TERM_VERSION = '1.0';
const MAX_SAMPLES = 10;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const SETTINGS_KEY = 'faceid-seguro:settings';

const settings = Object.assign(
  { threshold: 0.5, mode: 'fast', autolock: 10, cameraId: '' },
  safeJson(localStorage.getItem(SETTINGS_KEY)),
);

function safeJson(text) {
  try { return JSON.parse(text) || {}; } catch { return {}; }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function setStatus(text, level = 'info') {
  $('status-bar').className = `status-bar status-${level}`;
  $('status-text').textContent = text;
}

function toast(text, level = 'info', ms = 4500) {
  const t = el('div', { class: `toast ${level}`, role: level === 'error' ? 'alert' : 'status', text });
  $('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

function setFormMessage(node, text, level = 'error') {
  node.textContent = text;
  node.className = `form-message ${text ? level : ''}`;
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleString('pt-BR'); } catch { return iso; }
}

function sanitizeText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function confirmDialog({ title, text, okLabel = 'Confirmar', danger = true, requireText = '' }) {
  const dlg = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  const ok = $('confirm-ok');
  ok.textContent = okLabel;
  ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  const wrap = $('confirm-input-wrap');
  const input = $('confirm-input');
  input.value = '';
  wrap.hidden = !requireText;
  ok.disabled = Boolean(requireText);
  if (requireText) {
    $('confirm-input-label').textContent = `Digite "${requireText}" para confirmar`;
    input.oninput = () => { ok.disabled = input.value.trim() !== requireText; };
  }
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' && (!requireText || input.value.trim() === requireText));
    dlg.returnValue = 'cancel';
    dlg.showModal();
    (requireText ? input : $('confirm-ok')).focus();
  });
}

/* =============================== Estado =============================== */

const camera = new Camera();
let people = [];
let peopleById = new Map();
let matcher = null;
let modelsReady = false;
let recognizeLoopId = 0;
let registerLoopId = 0;
let samples = [];
let lastActivity = Date.now();
let failedUnlocks = 0;
let unlockBlockedUntil = 0;
let lastRecognizedSignature = '';
let lastLoopStatus = '';

/* =============================== Cofre =============================== */

async function showVaultScreen(message = '', level = 'error') {
  $('app').hidden = true;
  $('vault-screen').hidden = false;
  const initialized = await store.isVaultInitialized();
  $('vault-create-form').hidden = initialized;
  $('vault-unlock-form').hidden = !initialized;
  setFormMessage($('vault-message'), message, level);
  (initialized ? $('vault-unlock-password') : $('vault-create-password')).focus();
}

function setVaultBusy(busy) {
  $('vault-loading').hidden = !busy;
  document.querySelectorAll('#vault-screen button, #vault-screen input').forEach((n) => { n.disabled = busy; });
}

function passwordScore(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return Math.min(score, 4);
}

function validateNewPassword(pw, confirm) {
  if (pw.length < 8) return 'A senha deve ter pelo menos 8 caracteres.';
  if (passwordScore(pw) < 2) return 'Senha fraca. Use letras maiúsculas, minúsculas, números ou símbolos.';
  if (pw !== confirm) return 'As senhas não conferem.';
  return '';
}

async function onCreateVault(ev) {
  ev.preventDefault();
  const pw = $('vault-create-password').value;
  const error = validateNewPassword(pw, $('vault-create-confirm').value)
    || (!$('vault-terms').checked ? 'É necessário aceitar o termo de uso responsável.' : '');
  if (error) return setFormMessage($('vault-message'), error);
  setVaultBusy(true);
  try {
    await store.createVault(pw);
    $('vault-create-form').reset();
    await enterApp();
    toast('Cofre criado com sucesso. Seus dados serão criptografados.', 'success');
  } catch (err) {
    setFormMessage($('vault-message'), err.message);
  } finally {
    setVaultBusy(false);
  }
}

async function onUnlock(ev) {
  ev.preventDefault();
  const wait = Math.ceil((unlockBlockedUntil - Date.now()) / 1000);
  if (wait > 0) return setFormMessage($('vault-message'), `Muitas tentativas. Aguarde ${wait}s.`);
  const input = $('vault-unlock-password');
  setVaultBusy(true);
  setFormMessage($('vault-message'), '');
  try {
    await store.unlock(input.value);
    failedUnlocks = 0;
    input.value = '';
    await enterApp();
  } catch (err) {
    if (err instanceof store.WrongPasswordError) {
      failedUnlocks++;
      if (failedUnlocks >= 5) {
        unlockBlockedUntil = Date.now() + 30_000 * (failedUnlocks - 4);
        setFormMessage($('vault-message'), `Senha incorreta. Bloqueado por ${30 * (failedUnlocks - 4)}s.`);
      } else {
        setFormMessage($('vault-message'), `Senha incorreta (tentativa ${failedUnlocks}).`);
      }
      input.select();
    } else {
      setFormMessage($('vault-message'), err.message);
    }
  } finally {
    setVaultBusy(false);
    if (!$('vault-screen').hidden) input.focus();
  }
}

async function onForgot() {
  const ok = await confirmDialog({
    title: 'Apagar todos os dados?',
    text: 'Sem a senha mestra não é possível descriptografar os dados. Esta ação remove permanentemente todos os cadastros deste navegador.',
    okLabel: 'Apagar tudo',
    requireText: 'APAGAR',
  });
  if (!ok) return;
  try {
    await store.wipeAll();
    await showVaultScreen('Todos os dados foram apagados. Crie um novo cofre.', 'success');
  } catch (err) {
    setFormMessage($('vault-message'), err.message);
  }
}

async function enterApp() {
  $('vault-screen').hidden = true;
  $('app').hidden = false;
  lastActivity = Date.now();
  applySettingsToUi();
  await refreshPeople();
  if (!modelsReady) {
    setStatus('Carregando modelos de IA (processamento local)…', 'busy');
    try {
      const { backend } = await engine.loadModels((msg) => setStatus(msg, 'busy'));
      modelsReady = true;
      setStatus(`Pronto. Motor de IA local ativo (${backend.toUpperCase()}). ${people.length} pessoa(s) cadastrada(s).`, 'success');
    } catch (err) {
      setStatus(err.message, 'error');
      toast(err.message, 'error', 10_000);
    }
  } else {
    setStatus(`Cofre desbloqueado. ${people.length} pessoa(s) cadastrada(s).`, 'success');
  }
  updateButtons();
}

function lockApp(reason = '') {
  stopRecognition();
  stopRegisterCamera();
  store.lock();
  people = [];
  peopleById = new Map();
  matcher = null;
  samples = [];
  renderSamples();
  $('people-grid').replaceChildren();
  $('recognized-list').replaceChildren();
  $('register-form').reset();
  $('change-password-form').reset();
  lastRecognizedSignature = '';
  showVaultScreen(reason, 'warning');
}

/* =============================== Pessoas =============================== */

async function refreshPeople() {
  const { people: list, corrupted } = await store.listPeople();
  people = list;
  peopleById = new Map(people.map((p) => [p.id, p]));
  rebuildMatcher();
  renderPeople();
  if (corrupted) toast(`${corrupted} registro(s) não puderam ser lidos (dados corrompidos).`, 'warning', 8000);
}

function rebuildMatcher() {
  matcher = engine.buildMatcher(people, settings.threshold);
}

function renderPeople() {
  $('people-count').textContent = String(people.length);
  const q = sanitizeText($('people-search').value, 80).toLocaleLowerCase('pt-BR');
  const filtered = q ? people.filter((p) => p.name.toLocaleLowerCase('pt-BR').includes(q)) : people;
  $('people-empty').hidden = filtered.length > 0;
  $('people-empty').textContent = people.length ? 'Nenhuma pessoa encontrada para esta busca.' : '';
  if (!people.length) {
    $('people-empty').replaceChildren('Nenhuma pessoa cadastrada ainda. Use a aba ', el('strong', { text: 'Cadastrar' }), '.');
  }
  $('people-grid').replaceChildren(...filtered.map((p) => el('li', { class: 'person-card' }, [
    el('img', { src: p.photo, alt: `Foto de ${p.name}`, loading: 'lazy' }),
    el('div', { class: 'body' }, [
      el('span', { class: 'name', text: p.name }),
      p.note ? el('span', { class: 'small muted', text: p.note }) : null,
      el('span', { class: 'small muted', text: `${p.descriptors.length} amostra(s) · cadastrado em ${formatDate(p.createdAt)}` }),
      el('span', { class: 'small muted', text: `Consentimento (termo v${p.consent?.termVersion || '?'}) registrado por ${p.consent?.by || '—'} em ${formatDate(p.consent?.at)}` }),
    ]),
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Excluir dados', onclick: () => onDeletePerson(p) }),
    ]),
  ])));
}

async function onDeletePerson(person) {
  const ok = await confirmDialog({
    title: 'Excluir cadastro?',
    text: `Os dados de "${person.name}" (foto e biometria) serão removidos permanentemente.`,
    okLabel: 'Excluir',
  });
  if (!ok) return;
  try {
    await store.deletePerson(person.id);
    await refreshPeople();
    toast(`Cadastro de ${person.name} excluído.`, 'success');
    setStatus(`Cadastro excluído. ${people.length} pessoa(s) cadastrada(s).`, 'success');
  } catch (err) {
    handleError(err);
  }
}

/* =============================== Câmera =============================== */

async function populateCameras() {
  try {
    const devices = await Camera.listDevices();
    const select = $('camera-select');
    select.replaceChildren(...devices.map((d, i) => el('option', { value: d.deviceId, text: d.label || `Câmera ${i + 1}` })));
    if (devices.some((d) => d.deviceId === settings.cameraId)) select.value = settings.cameraId;
    select.hidden = devices.length < 2;
  } catch { /* não crítico */ }
}

async function startCamera(video, wrap) {
  if (!modelsReady) throw new Error('Os modelos de IA ainda não foram carregados.');
  setStatus('Solicitando acesso à câmera…', 'busy');
  const id = await camera.start(video, settings.cameraId || $('camera-select').value || undefined);
  if (id) { settings.cameraId = id; saveSettings(); }
  wrap.classList.add('live');
  camera.onEnded = () => {
    toast('A câmera foi desconectada.', 'warning');
    stopRecognition();
    stopRegisterCamera();
  };
  populateCameras();
}

/* =============================== Reconhecimento =============================== */

async function startRecognition() {
  stopRegisterCamera();
  $('recognize-start').disabled = true;
  try {
    await startCamera($('recognize-video'), $('recognize-video-wrap'));
  } catch (err) {
    $('recognize-start').disabled = false;
    const msg = describeCameraError(err);
    setStatus(msg, 'error');
    toast(msg, 'error', 9000);
    return;
  }
  $('recognize-stop').disabled = false;
  $('recognize-rec').hidden = false;
  if (!people.length) toast('Nenhuma pessoa cadastrada: todos os rostos aparecerão como "Desconhecido".', 'warning');
  setStatus('Reconhecimento em tempo real ativo.', 'success');
  recognitionLoop(++recognizeLoopId);
}

function stopRecognition() {
  const wasRunning = recognizeLoopId && $('recognize-rec').hidden === false;
  recognizeLoopId++;
  if (camera.video === $('recognize-video')) camera.stop();
  $('recognize-video-wrap').classList.remove('live');
  $('recognize-rec').hidden = true;
  $('recognize-start').disabled = !modelsReady;
  $('recognize-stop').disabled = true;
  $('recognize-fps').textContent = '';
  const c = $('recognize-overlay');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
  $('recognized-list').replaceChildren();
  $('recognized-empty').hidden = false;
  lastRecognizedSignature = '';
  lastLoopStatus = '';
  if (wasRunning && !$('app').hidden) setStatus('Reconhecimento parado. Câmera desligada.', 'info');
}

async function recognitionLoop(loopId) {
  const video = $('recognize-video');
  const canvas = $('recognize-overlay');
  let frames = 0;
  let fpsStart = performance.now();
  let errors = 0;
  while (loopId === recognizeLoopId) {
    if (document.hidden || video.readyState < 2 || video.paused) { await sleep(250); continue; }
    const t0 = performance.now();
    let results;
    try {
      results = await engine.detectAll(video, settings.mode);
      errors = 0;
    } catch (err) {
      if (++errors > 5) {
        setStatus(`Erro no processamento das imagens: ${err.message}`, 'error');
        stopRecognition();
        return;
      }
      await sleep(500);
      continue;
    }
    if (loopId !== recognizeLoopId) return;
    const faces = results.map((r) => {
      const match = matcher ? matcher.findBestMatch(r.descriptor) : null;
      const person = match && match.label !== 'unknown' ? peopleById.get(match.label) : null;
      return {
        box: r.detection.box,
        person,
        confidence: person ? engine.distanceToConfidence(match.distance, settings.threshold) : 0,
      };
    });
    drawFaces(canvas, video, faces);
    renderRecognized(faces);
    updateLoopStatus(faces);

    frames++;
    const now = performance.now();
    if (now - fpsStart >= 1000) {
      const fps = (frames * 1000) / (now - fpsStart);
      $('recognize-fps').textContent = `${fps < 10 ? fps.toFixed(1).replace('.', ',') : Math.round(fps)} quadros/s`;
      frames = 0;
      fpsStart = now;
    }
    await sleep(Math.max(0, 70 - (performance.now() - t0)));
  }
}

function drawFaces(canvas, video, faces) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const fontSize = Math.max(14, Math.round(w / 40));
  ctx.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
  ctx.lineWidth = Math.max(2, w / 320);
  for (const f of faces) {
    const x = w - f.box.x - f.box.width; // vídeo espelhado
    const { y, width, height } = f.box;
    const color = f.person ? '#22c55e' : '#ef4444';
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 10);
    ctx.stroke();
    const label = f.person ? `${f.person.name} · ${f.confidence}%` : 'Desconhecido';
    const tw = ctx.measureText(label).width + fontSize;
    const lh = fontSize * 1.6;
    const ly = y - lh - 4 > 0 ? y - lh - 4 : y + height + 4;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, ly, tw, lh, 8);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + fontSize / 2, ly + lh * 0.7);
  }
}

function renderRecognized(faces) {
  const signature = faces.map((f) => (f.person ? `${f.person.id}:${Math.round(f.confidence / 5)}` : 'u')).sort().join('|');
  if (signature === lastRecognizedSignature) return;
  lastRecognizedSignature = signature;
  $('recognized-empty').hidden = faces.length > 0;
  const sorted = [...faces].sort((a, b) => Number(Boolean(b.person)) - Number(Boolean(a.person)));
  $('recognized-list').replaceChildren(...sorted.map((f) => (f.person
    ? el('li', { class: 'recognized-item known' }, [
      el('img', { class: 'avatar', src: f.person.photo, alt: `Foto de ${f.person.name}` }),
      el('div', {}, [
        el('div', { class: 'name', text: f.person.name }),
        f.person.note ? el('div', { class: 'small muted', text: f.person.note }) : null,
        el('div', { class: 'small muted', text: `Confiança: ${f.confidence}%` }),
        el('div', { class: 'meter' }, el('div', { style: `width:${f.confidence}%` })),
      ]),
    ])
    : el('li', { class: 'recognized-item unknown' }, [
      el('div', { class: 'avatar avatar-unknown', 'aria-hidden': 'true', text: '?' }),
      el('div', {}, [
        el('div', { class: 'name', text: 'Desconhecido' }),
        el('div', { class: 'small muted', text: 'Pessoa não cadastrada ou não reconhecida' }),
      ]),
    ]))));
}

function updateLoopStatus(faces) {
  const known = faces.filter((f) => f.person).length;
  let text;
  let level = 'success';
  if (!faces.length) { text = 'Procurando rostos… posicione-se em frente à câmera.'; level = 'info'; }
  else if (known === faces.length) text = `${faces.length} rosto(s) detectado(s) — todos identificados.`;
  else { text = `${faces.length} rosto(s) detectado(s) — ${known} identificado(s), ${faces.length - known} desconhecido(s).`; level = known ? 'success' : 'warning'; }
  if (text !== lastLoopStatus) { lastLoopStatus = text; setStatus(text, level); }
}

/* =============================== Cadastro =============================== */

async function toggleRegisterCamera() {
  if (camera.video === $('register-video')) {
    stopRegisterCamera();
    setStatus('Câmera do cadastro desligada.', 'info');
    return;
  }
  stopRecognition();
  const btn = $('register-camera-toggle');
  btn.disabled = true;
  try {
    await startCamera($('register-video'), $('register-video-wrap'));
    btn.textContent = 'Desligar câmera';
    $('register-capture').disabled = false;
    setStatus('Câmera ligada. Centralize o rosto e clique em "Capturar amostra".', 'success');
    registerPreviewLoop(++registerLoopId);
  } catch (err) {
    const msg = describeCameraError(err);
    setStatus(msg, 'error');
    toast(msg, 'error', 9000);
  } finally {
    btn.disabled = !modelsReady;
  }
}

function stopRegisterCamera() {
  registerLoopId++;
  if (camera.video === $('register-video')) camera.stop();
  $('register-video-wrap').classList.remove('live');
  $('register-camera-toggle').textContent = 'Ligar câmera';
  $('register-capture').disabled = true;
  const c = $('register-overlay');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
}

async function registerPreviewLoop(loopId) {
  const video = $('register-video');
  const canvas = $('register-overlay');
  while (loopId === registerLoopId) {
    if (!document.hidden && video.readyState >= 2) {
      try {
        const dets = await engine.detectFaces(video);
        if (loopId !== registerLoopId) return;
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        ctx.lineWidth = Math.max(2, w / 320);
        ctx.strokeStyle = dets.length === 1 ? '#22d3ee' : '#f59e0b';
        for (const d of dets) {
          ctx.beginPath();
          ctx.roundRect(w - d.box.x - d.box.width, d.box.y, d.box.width, d.box.height, 10);
          ctx.stroke();
        }
      } catch { /* ignora quadros com erro */ }
    }
    await sleep(200);
  }
}

async function addSample(source, label) {
  if (samples.length >= MAX_SAMPLES) throw new Error(`Máximo de ${MAX_SAMPLES} amostras.`);
  const result = await engine.detectSingle(source);
  if (samples.length) {
    const dist = engine.euclideanDistance(samples[0].descriptor, result.descriptor);
    if (dist > 0.6) throw new Error(`A amostra "${label}" parece ser de outra pessoa. Todas as amostras devem ser da mesma pessoa.`);
  }
  samples.push({ descriptor: result.descriptor, photo: engine.cropFace(source, result.detection.box) });
  renderSamples();
}

async function onCapture() {
  const btn = $('register-capture');
  btn.disabled = true;
  setStatus('Analisando rosto…', 'busy');
  try {
    await addSample($('register-video'), `#${samples.length + 1}`);
    setStatus(`Amostra ${samples.length} capturada com sucesso.`, 'success');
    setFormMessage($('register-message'), '');
  } catch (err) {
    setStatus(err.message, 'warning');
    toast(err.message, 'warning');
  } finally {
    btn.disabled = camera.video !== $('register-video');
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Não foi possível ler a imagem "${file.name}".`)); };
    img.src = url;
  });
}

async function onUpload(ev) {
  const files = [...ev.target.files];
  ev.target.value = '';
  if (!files.length) return;
  if (!modelsReady) return toast('Aguarde o carregamento dos modelos de IA.', 'warning');
  let ok = 0;
  for (const file of files) {
    if (!ALLOWED_TYPES.includes(file.type)) { toast(`"${file.name}": formato não suportado (use JPG, PNG ou WEBP).`, 'error'); continue; }
    if (file.size > MAX_UPLOAD_BYTES) { toast(`"${file.name}": arquivo maior que 10 MB.`, 'error'); continue; }
    setStatus(`Analisando "${file.name}"…`, 'busy');
    try {
      const img = await loadImage(file);
      await addSample(img, file.name);
      ok++;
    } catch (err) {
      toast(`"${file.name}": ${err.message}`, 'warning', 7000);
    }
  }
  setStatus(ok ? `${ok} amostra(s) adicionada(s) a partir de foto(s). Total: ${samples.length}.` : 'Nenhuma amostra válida nas imagens enviadas.', ok ? 'success' : 'warning');
}

function renderSamples() {
  $('samples-list').replaceChildren(...samples.map((s, i) => el('li', { class: 'sample' }, [
    el('img', { src: s.photo, alt: `Amostra ${i + 1}` }),
    el('button', {
      type: 'button',
      title: 'Remover amostra',
      'aria-label': `Remover amostra ${i + 1}`,
      text: '×',
      onclick: () => { samples.splice(i, 1); renderSamples(); },
    }),
  ])));
}

function resetRegisterForm() {
  $('register-form').reset();
  samples = [];
  renderSamples();
  setFormMessage($('register-message'), '');
}

async function onRegister(ev) {
  ev.preventDefault();
  const msg = $('register-message');
  const name = sanitizeText($('register-name').value, 80);
  const note = sanitizeText($('register-note').value, 120);
  const consentBy = sanitizeText($('register-consent-by').value, 80);
  if (name.length < 2) return setFormMessage(msg, 'Informe o nome completo (mínimo 2 caracteres).');
  if (!$('register-consent').checked) return setFormMessage(msg, 'O cadastro só pode ser feito com o consentimento da pessoa.');
  if (consentBy.length < 2) return setFormMessage(msg, 'Informe quem registrou o consentimento.');
  if (!samples.length) return setFormMessage(msg, 'Capture ao menos uma amostra do rosto (recomendado: 3).');

  let closest = null;
  for (const p of people) {
    for (const d of p.descriptors) {
      for (const s of samples) {
        const dist = engine.euclideanDistance(Float32Array.from(d), s.descriptor);
        if (!closest || dist < closest.dist) closest = { person: p, dist };
      }
    }
  }
  if (closest && closest.dist < settings.threshold) {
    const proceed = await confirmDialog({
      title: 'Possível cadastro duplicado',
      text: `Este rosto é muito parecido com "${closest.person.name}", que já está cadastrado. Deseja cadastrar mesmo assim?`,
      okLabel: 'Cadastrar mesmo assim',
      danger: false,
    });
    if (!proceed) return;
  }

  const now = new Date().toISOString();
  const person = {
    id: crypto.randomUUID(),
    name,
    note,
    photo: samples[0].photo,
    descriptors: samples.map((s) => Array.from(s.descriptor)),
    consent: { given: true, at: now, by: consentBy, termVersion: CONSENT_TERM_VERSION },
    createdAt: now,
  };
  $('register-save').disabled = true;
  try {
    await store.savePerson(person);
    await refreshPeople();
    resetRegisterForm();
    setFormMessage(msg, `${name} cadastrado(a) com sucesso!`, 'success');
    toast(`${name} cadastrado(a) com segurança.`, 'success');
    setStatus(`Cadastro salvo e criptografado. ${people.length} pessoa(s) cadastrada(s).`, 'success');
  } catch (err) {
    handleError(err, msg);
  } finally {
    $('register-save').disabled = false;
  }
}

/* =============================== Configurações =============================== */

function applySettingsToUi() {
  $('threshold').value = String(settings.threshold);
  $('threshold-value').textContent = Number(settings.threshold).toFixed(2).replace('.', ',');
  $('detector-mode').value = settings.mode;
  $('autolock').value = String(settings.autolock);
}

async function onChangePassword(ev) {
  ev.preventDefault();
  const oldPw = $('cp-old').value;
  const newPw = $('cp-new').value;
  const error = validateNewPassword(newPw, $('cp-confirm').value);
  if (error) return toast(error, 'error');
  setStatus('Recriptografando dados com a nova senha…', 'busy');
  try {
    await store.changePassword(oldPw, newPw);
    $('change-password-form').reset();
    toast('Senha alterada. Todos os dados foram recriptografados.', 'success');
    setStatus('Senha mestra alterada com sucesso.', 'success');
  } catch (err) {
    const m = err instanceof store.WrongPasswordError ? 'Senha atual incorreta.' : err.message;
    toast(m, 'error');
    setStatus(m, 'error');
  }
}

async function onExport() {
  try {
    const backup = await store.exportBackup();
    const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `faceid-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Backup exportado. Ele continua criptografado com sua senha mestra.', 'success');
  } catch (err) {
    handleError(err);
  }
}

async function onImport(ev) {
  const [file] = ev.target.files;
  ev.target.value = '';
  if (!file) return;
  if (file.size > 200 * 1024 * 1024) return toast('Arquivo de backup grande demais.', 'error');
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    return toast('O arquivo selecionado não é um JSON válido.', 'error');
  }
  const ok = await confirmDialog({
    title: 'Importar backup?',
    text: 'Todos os dados atuais deste navegador serão SUBSTITUÍDOS pelo backup. Depois será necessário desbloquear com a senha mestra usada no backup.',
    okLabel: 'Substituir dados',
  });
  if (!ok) return;
  try {
    const count = await store.importBackup(backup);
    lockApp(`Backup importado (${count} cadastro(s)). Desbloqueie com a senha do backup.`);
  } catch (err) {
    handleError(err);
  }
}

async function onWipe() {
  const ok = await confirmDialog({
    title: 'Apagar todos os dados?',
    text: 'Todas as pessoas, fotos, dados biométricos e a senha mestra serão removidos permanentemente deste navegador.',
    okLabel: 'Apagar tudo',
    requireText: 'APAGAR',
  });
  if (!ok) return;
  try {
    stopRecognition();
    stopRegisterCamera();
    await store.wipeAll();
    lockApp('');
    await showVaultScreen('Todos os dados foram apagados.', 'success');
  } catch (err) {
    handleError(err);
  }
}

/* =============================== Geral =============================== */

function handleError(err, formMessageNode) {
  if (err instanceof store.VaultLockedError) return lockApp('Sessão expirada. Desbloqueie novamente.');
  const m = err?.name === 'QuotaExceededError' ? 'Espaço de armazenamento insuficiente no navegador.' : (err?.message || String(err));
  console.error(err);
  if (formMessageNode) setFormMessage(formMessageNode, m);
  setStatus(m, 'error');
  toast(m, 'error', 8000);
}

function updateButtons() {
  $('recognize-start').disabled = !modelsReady;
  $('register-camera-toggle').disabled = !modelsReady;
}

function switchTab(panelId) {
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.dataset.panel === panelId;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== panelId; });
  if (panelId !== 'panel-recognize') stopRecognition();
  if (panelId !== 'panel-register') stopRegisterCamera();
}

function bindEvents() {
  $('vault-create-form').addEventListener('submit', onCreateVault);
  $('vault-unlock-form').addEventListener('submit', onUnlock);
  $('vault-forgot').addEventListener('click', onForgot);
  $('vault-create-password').addEventListener('input', (e) => {
    const s = passwordScore(e.target.value);
    const colors = ['#ef4444', '#ef4444', '#f59e0b', '#22c55e', '#16a34a'];
    const labels = ['Muito fraca', 'Fraca', 'Razoável', 'Forte', 'Muito forte'];
    $('password-strength-bar').style.width = `${(s / 4) * 100}%`;
    $('password-strength-bar').style.background = colors[s];
    $('password-strength-label').textContent = e.target.value ? `Força: ${labels[s]}` : '';
  });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.panel)));
  $('lock-btn').addEventListener('click', () => lockApp('Cofre bloqueado.'));

  $('recognize-start').addEventListener('click', startRecognition);
  $('recognize-stop').addEventListener('click', stopRecognition);
  $('camera-select').addEventListener('change', async (e) => {
    settings.cameraId = e.target.value;
    saveSettings();
    if (camera.video === $('recognize-video')) { stopRecognition(); await startRecognition(); }
    else if (camera.video === $('register-video')) { stopRegisterCamera(); await toggleRegisterCamera(); }
  });

  $('register-camera-toggle').addEventListener('click', toggleRegisterCamera);
  $('register-capture').addEventListener('click', onCapture);
  $('register-upload').addEventListener('change', onUpload);
  $('register-form').addEventListener('submit', onRegister);
  $('register-reset').addEventListener('click', resetRegisterForm);

  $('people-search').addEventListener('input', renderPeople);

  $('threshold').addEventListener('input', (e) => {
    settings.threshold = Number(e.target.value);
    $('threshold-value').textContent = settings.threshold.toFixed(2).replace('.', ',');
    saveSettings();
    rebuildMatcher();
  });
  $('detector-mode').addEventListener('change', (e) => { settings.mode = e.target.value === 'accurate' ? 'accurate' : 'fast'; saveSettings(); });
  $('autolock').addEventListener('change', (e) => { settings.autolock = Number(e.target.value) || 0; saveSettings(); });
  $('change-password-form').addEventListener('submit', onChangePassword);
  $('export-btn').addEventListener('click', onExport);
  $('import-input').addEventListener('change', onImport);
  $('vault-import-input').addEventListener('change', onImport);
  $('wipe-btn').addEventListener('click', onWipe);

  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((evt) => document.addEventListener(evt, () => { lastActivity = Date.now(); }, { passive: true }));
  setInterval(() => {
    if (!store.isUnlocked() || !settings.autolock) return;
    if (Date.now() - lastActivity > settings.autolock * 60_000) lockApp('Cofre bloqueado automaticamente por inatividade.');
  }, 15_000);

  window.addEventListener('pagehide', () => { camera.stop(); });
  window.addEventListener('unhandledrejection', (e) => handleError(e.reason));
}

async function init() {
  if (location.protocol === 'file:') {
    $('file-protocol-warning').hidden = false;
    return;
  }
  bindEvents();
  if (!store.isSupported()) {
    $('vault-screen').hidden = false;
    setFormMessage($('vault-message'), 'Este navegador não suporta armazenamento seguro (Web Crypto/IndexedDB) ou o site não está em contexto seguro. Use Edge/Chrome/Firefox atualizados via http://localhost ou HTTPS.');
    return;
  }
  try {
    await showVaultScreen();
  } catch (err) {
    setFormMessage($('vault-message'), err.message);
  }
}

init();

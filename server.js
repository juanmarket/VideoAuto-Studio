// VideoAuto Studio — Backend
const path = require('path');
const fs = require('fs');

// Create .env if missing before dotenv loads
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  fs.writeFileSync(envPath, 'OPENAI_API_KEY=\nANTHROPIC_API_KEY=\nPEXELS_API_KEY=\nPIXABAY_API_KEY=\nCOVERR_API_KEY=\nANALYSIS_MODEL=claude-haiku-4-5-20251001\nANALYSIS_PROVIDER=anthropic\n');
}
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');

// HyperFrames — motion graphics engine
let motionRender = null;
try {
  motionRender = require('./lib/motion-render');
} catch (e) {
  console.warn('[HyperFrames] motion-render not available (install puppeteer): ' + e.message);
}

const app = express();
const PORT = 3000;

// ── Model config (change here if needed) ──────────────────────────────────────
const CLAUDE_MODEL      = 'claude-haiku-4-5-20251001';
const WHISPER_MODEL     = 'whisper-1';
const PROMPT_BATCH_SIZE = 5;    // segments per API call

// ── Analysis model (overridable from frontend per request) ──────────────────
const DEFAULT_ANALYSIS_PROVIDER = process.env.ANALYSIS_PROVIDER || 'anthropic';
const DEFAULT_ANALYSIS_MODEL    = process.env.ANALYSIS_MODEL    || 'claude-haiku-4-5-20251001';

// ── Session cost tracking ─────────────────────────────────────────────────────
let sessionCosts = {
  whisper: { minutes: 0, cost: 0 },
  claude: { input_tokens: 0, output_tokens: 0, model: '', cost: 0 },
  openai_analysis: { input_tokens: 0, output_tokens: 0, cost: 0 },
  total: 0
};

function resetSessionCosts() {
  sessionCosts = {
    whisper: { minutes: 0, cost: 0 },
    claude: { input_tokens: 0, output_tokens: 0, model: '', cost: 0 },
    openai_analysis: { input_tokens: 0, output_tokens: 0, cost: 0 },
    total: 0
  };
}

function addAnalysisCost(usage, provider, model) {
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  if (provider === 'openai') {
    sessionCosts.openai_analysis.input_tokens += inp;
    sessionCosts.openai_analysis.output_tokens += out;
    const cost = (inp * 0.15 / 1e6) + (out * 0.60 / 1e6);
    sessionCosts.openai_analysis.cost += cost;
  } else {
    // Anthropic
    sessionCosts.claude.input_tokens += inp;
    sessionCosts.claude.output_tokens += out;
    sessionCosts.claude.model = model || sessionCosts.claude.model;
    const isHaiku = (model || '').toLowerCase().includes('haiku');
    const costIn  = isHaiku ? 0.25 : 3.00;
    const costOut = isHaiku ? 1.25 : 15.00;
    const cost = (inp * costIn / 1e6) + (out * costOut / 1e6);
    sessionCosts.claude.cost += cost;
  }
  sessionCosts.total = sessionCosts.whisper.cost + sessionCosts.claude.cost + sessionCosts.openai_analysis.cost;
}

function addWhisperCost(durationSeconds) {
  const minutes = durationSeconds / 60;
  sessionCosts.whisper.minutes += minutes;
  sessionCosts.whisper.cost = sessionCosts.whisper.minutes * 0.006;
  sessionCosts.total = sessionCosts.whisper.cost + sessionCosts.claude.cost + sessionCosts.openai_analysis.cost;
}

// ── Duration limits & post-processing subdivision ────────────────────────────
// Duration limits per visual type (seconds)
const MAX_DURACIONES = {
  imagen_ia: 7,
  motion_graphic: 6,
  texto_minimal: 6,
  texto_cita: 6,
  texto_impacto: 7,
  video_stock: 8,
  texto_lista: 8,
  texto_grafica: 8,
  camara: 999, grabacion_pantalla: 999, contenido_relacionado: 999, avatar: 999
};

// Smart fallback: find the closest type that fits the duration
function safetyNetFallback(tipo, duracion, allowedSet) {
  const max = MAX_DURACIONES[tipo] || 8;
  if (duracion <= max) return tipo;

  if (duracion <= 6) {
    // Fits in motion_graphic, texto_minimal, texto_cita (max 6)
    return tipo; // already fits if max >= 6
  }
  if (duracion <= 7) {
    // Fits in imagen_ia (max 7), texto_impacto (max 7)
    if (['motion_graphic', 'texto_minimal', 'texto_cita'].includes(tipo)) {
      if (allowedSet.has('imagen_ia')) return 'imagen_ia';
      return allowedSet.has('texto_impacto') ? 'texto_impacto' : 'video_stock';
    }
    return tipo;
  }
  if (duracion <= 8) {
    // Fits in video_stock, texto_lista, texto_grafica
    if (['imagen_ia', 'texto_impacto', 'motion_graphic', 'texto_minimal', 'texto_cita'].includes(tipo)) {
      if (allowedSet.has('video_stock')) return 'video_stock';
      if (allowedSet.has('texto_lista')) return 'texto_lista';
      return 'texto_grafica';
    }
    return tipo;
  }
  // > 8s: only LONG types
  if (allowedSet.has('camara')) return 'camara';
  if (allowedSet.has('avatar')) return 'avatar';
  if (allowedSet.has('contenido_relacionado')) return 'contenido_relacionado';
  return 'video_stock'; // last resort
}

// ── Allowed types per camera format ──────────────────────────────────────────
const TIPOS_PERMITIDOS = {
  con_camara: ['imagen_ia','video_stock','motion_graphic','texto_minimal','texto_impacto','texto_cita','texto_lista','texto_grafica','contenido_relacionado','camara','grabacion_pantalla'],
  faceless_pro: ['imagen_ia','video_stock','motion_graphic','texto_minimal','texto_impacto','texto_cita','texto_lista','texto_grafica','contenido_relacionado'],
  faceless_pro_avatar: ['imagen_ia','video_stock','motion_graphic','texto_minimal','texto_impacto','texto_cita','texto_lista','texto_grafica','contenido_relacionado','avatar'],
  faceless: ['imagen_ia','video_stock','texto_impacto','texto_minimal']
};

// subdivideSegmentos removed — prompt generation is now 1:1 (one prompt per segment, no subdivision)

// ── Ensure required directories ───────────────────────────────────────────────
['uploads/audio', 'uploads/images', 'output', 'public', 'brand/backgrounds', 'sounds'].forEach(d =>
  fs.mkdirSync(path.join(__dirname, d), { recursive: true })
);

// ── SFX files (real audio files in /sounds/) ─────────────────────────────────
const SFX_FILES = {
  'wosh-1':          path.join(__dirname, 'sounds', 'wosh-1.mp3'),
  'wosh-2':          path.join(__dirname, 'sounds', 'wosh-2.mp3'),
  'woshh-dramatico': path.join(__dirname, 'sounds', 'Woshh-Dramatico.MP3')
};

// ── Profiles default data ────────────────────────────────────────────────────
const PROFILES_PATH = path.join(__dirname, 'profiles.json');
const DEFAULT_PROFILES = [
  {
    id: 'plastilina',
    nombre: 'La Vida en Plastilina',
    estilos: {
      fondo_tipo: 'degradado', fondo_color1: '#1a1a2e', fondo_color2: '#16213e', fondo_direccion: 'diagonal',
      texto_tipo: 'solido', color_texto: '#ffffff', texto_color2: '#0da892', texto_direccion: 'horizontal',
      fuente_principal: 'Syne', fuente_datos: 'IBM Plex Mono', fuentes_custom: [],
      color_acento1: '#5b4cf5', color_acento2: '#0da892',
      tamano_titulo: 72, tamano_texto: 36, tamano_dato: 120, padding_porcentaje: 10,
      icono_nombre: '', icono_color: '#5b4cf5', icono_posicion: 'arriba', icono_tamano: 48, icono_opacidad: 1.0
    }
  },
  {
    id: 'tech-neon',
    nombre: 'Tech / Neon',
    estilos: {
      fondo_tipo: 'degradado', fondo_color1: '#0a0a0a', fondo_color2: '#1a0030', fondo_direccion: 'vertical',
      texto_tipo: 'degradado', color_texto: '#00ff88', texto_color2: '#00d4ff', texto_direccion: 'horizontal',
      fuente_principal: 'Space Grotesk', fuente_datos: 'JetBrains Mono', fuentes_custom: [],
      color_acento1: '#00ff88', color_acento2: '#00d4ff',
      tamano_titulo: 72, tamano_texto: 36, tamano_dato: 120, padding_porcentaje: 10,
      icono_nombre: 'bolt', icono_color: '#00ff88', icono_posicion: 'fondo', icono_tamano: 96, icono_opacidad: 0.12
    }
  },
  {
    id: 'documental',
    nombre: 'Documental',
    estilos: {
      fondo_tipo: 'solido', fondo_color1: '#0d0d0d', fondo_color2: '#0d0d0d', fondo_direccion: 'diagonal',
      texto_tipo: 'solido', color_texto: '#ffffff', texto_color2: '#e8e8e8', texto_direccion: 'horizontal',
      fuente_principal: 'Playfair Display', fuente_datos: 'Roboto Mono', fuentes_custom: [],
      color_acento1: '#c9a84c', color_acento2: '#e8e8e8',
      tamano_titulo: 72, tamano_texto: 36, tamano_dato: 120, padding_porcentaje: 10,
      icono_nombre: '', icono_color: '#c9a84c', icono_posicion: 'arriba', icono_tamano: 48, icono_opacidad: 1.0
    }
  }
];

function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_PATH)) {
      return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
    }
  } catch (_) {}
  // First run: write defaults
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(DEFAULT_PROFILES, null, 2));
  return [...DEFAULT_PROFILES];
}

function saveProfiles(profiles) {
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2));
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/brand', express.static(path.join(__dirname, 'brand')));
app.use('/sounds', express.static(path.join(__dirname, 'sounds')));

// ── Multer: audio ─────────────────────────────────────────────────────────────
const audioUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads/audio'),
    filename: (req, file, cb) => cb(null, `audio_${Date.now()}${path.extname(file.originalname)}`)
  }),
  fileFilter: (req, file, cb) => {
    const ok = ['.mp3', '.wav', '.m4a'].includes(path.extname(file.originalname).toLowerCase());
    cb(null, ok);
  }
});

// ── Multer: images ────────────────────────────────────────────────────────────
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads/images'),
    filename: (req, file, cb) => cb(null, file.originalname)
  })
});

// ── SSE state ─────────────────────────────────────────────────────────────────
let sseClients = [];

function sendSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(payload));
}

// ── API factory helpers ───────────────────────────────────────────────────────
function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurado');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurado');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ── Generic analysis model caller ───────────────────────────────────────────
// Used for smart-segment and generate-prompts analysis.
// Supports Anthropic and OpenAI providers, selectable from the frontend.
async function callAnalysisModel({ systemPrompt, userMessage, provider, model, maxTokens = 16000 }) {
  const prov  = provider || DEFAULT_ANALYSIS_PROVIDER;
  const mdl   = model    || DEFAULT_ANALYSIS_MODEL;

  if (prov === 'openai') {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurado');
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: mdl,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage }
        ],
        max_tokens: maxTokens
      })
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI API error (${resp.status}): ${err.slice(0, 300)}`);
    }
    const json = await resp.json();
    const text = json.choices?.[0]?.message?.content || '';
    const usage = json.usage || {};
    const normalizedUsage = { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 };
    console.log(`[openai] Tokens usados: input=${normalizedUsage.input_tokens}, output=${normalizedUsage.output_tokens}`);
    addAnalysisCost(normalizedUsage, 'openai', mdl);
    return { text, usage: normalizedUsage };
  }

  // Default: Anthropic
  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: mdl,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }]
  });
  const usage = response.usage || {};
  console.log(`[anthropic] Tokens usados: input=${usage.input_tokens || 0}, output=${usage.output_tokens || 0}`);
  addAnalysisCost(usage, 'anthropic', mdl);
  return { text: response.content[0]?.text || '', usage };
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── API Keys ──────────────────────────────────────────────────────────────────
app.get('/api/keys', (req, res) => {
  const mask = val => val ? '***' + val.slice(-4) : '';
  res.json({
    openai: mask(process.env.OPENAI_API_KEY),
    anthropic: mask(process.env.ANTHROPIC_API_KEY),
    pexels: mask(process.env.PEXELS_API_KEY),
    pixabay: mask(process.env.PIXABAY_API_KEY),
    coverr: mask(process.env.COVERR_API_KEY)
  });
});

app.post('/api/save-keys', (req, res) => {
  const { openai_key, anthropic_key, pexels_key, pixabay_key, coverr_key } = req.body;
  if (openai_key) process.env.OPENAI_API_KEY = openai_key.trim();
  if (anthropic_key) process.env.ANTHROPIC_API_KEY = anthropic_key.trim();
  if (pexels_key) process.env.PEXELS_API_KEY = pexels_key.trim();
  if (pixabay_key) process.env.PIXABAY_API_KEY = pixabay_key.trim();
  if (coverr_key) process.env.COVERR_API_KEY = coverr_key.trim();

  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  function upsertLine(text, key, val) {
    const re = new RegExp(`^${key}=.*`, 'm');
    return re.test(text) ? text.replace(re, `${key}=${val}`) : text.trimEnd() + `\n${key}=${val}\n`;
  }

  if (openai_key) content = upsertLine(content, 'OPENAI_API_KEY', openai_key.trim());
  if (anthropic_key) content = upsertLine(content, 'ANTHROPIC_API_KEY', anthropic_key.trim());
  if (pexels_key) content = upsertLine(content, 'PEXELS_API_KEY', pexels_key.trim());
  if (pixabay_key) content = upsertLine(content, 'PIXABAY_API_KEY', pixabay_key.trim());
  if (coverr_key) content = upsertLine(content, 'COVERR_API_KEY', coverr_key.trim());

  fs.writeFileSync(envPath, content);
  res.json({ success: true });
});

// ── Session Costs ────────────────────────────────────────────────────────────
app.get('/api/session-costs', (req, res) => {
  res.json(sessionCosts);
});

// ── Profiles CRUD ────────────────────────────────────────────────────────────
app.get('/api/profiles', (req, res) => {
  res.json(loadProfiles());
});

app.post('/api/profiles', (req, res) => {
  const profile = req.body;
  if (!profile || !profile.id || !profile.nombre || !profile.estilos) {
    return res.status(400).json({ error: 'Perfil inválido (requiere id, nombre, estilos)' });
  }
  const profiles = loadProfiles();
  const idx = profiles.findIndex(p => p.id === profile.id);
  if (idx >= 0) {
    profiles[idx] = profile;   // update
  } else {
    profiles.push(profile);    // create
  }
  saveProfiles(profiles);
  res.json({ success: true, profile });
});

app.delete('/api/profiles/:id', (req, res) => {
  let profiles = loadProfiles();
  const before = profiles.length;
  profiles = profiles.filter(p => p.id !== req.params.id);
  if (profiles.length === before) return res.status(404).json({ error: 'Perfil no encontrado' });
  saveProfiles(profiles);
  res.json({ success: true });
});

// ── Profile background upload ────────────────────────────────────────────
const bgUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'brand/backgrounds'),
    filename: (req, file, cb) => {
      const profileId = req.body.profileId || 'unknown';
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${profileId}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const ok = ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.webm'].includes(
      path.extname(file.originalname).toLowerCase()
    );
    cb(null, ok);
  }
});

app.post('/api/profiles/upload-bg', (req, res) => {
  bgUpload.single('bgFile')(req, res, (err) => {
    if (err) {
      console.error('[upload-bg] multer error:', err.message);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Archivo demasiado grande (max 10MB)' });
      }
      return res.status(400).json({ error: err.message });
    }
    try {
      if (!req.file) return res.status(400).json({ error: 'Archivo no soportado (jpg, png, webp, mp4, webm)' });
      const relPath = 'brand/backgrounds/' + req.file.filename;
      res.json({ success: true, path: relPath });
    } catch (e) {
      console.error('[upload-bg]', e.message);
      res.status(500).json({ error: e.message });
    }
  });
});

// ── Transcription ─────────────────────────────────────────────────────────────
app.post('/api/transcribe', audioUpload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Formato de audio no soportado (MP3, WAV, M4A)' });

    const language = req.body.language || 'es';
    const n = Math.max(1, parseInt(req.body.segmentsPerImage) || 1);
    const openai = getOpenAI();

    // Reset costs at start of new transcription (new session)
    resetSessionCosts();

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: WHISPER_MODEL,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
      language
    });

    const raw = Array.isArray(transcription.segments) ? transcription.segments : [];

    // Fallback: if no segments, create one from full text
    const source = raw.length > 0 ? raw : [{
      start: 0,
      end: transcription.duration || 0,
      text: transcription.text || ''
    }];

    // Group N consecutive Whisper segments into one video segment
    const grouped = [];
    for (let i = 0; i < source.length; i += n) {
      const chunk = source.slice(i, i + n);
      grouped.push({
        id: grouped.length + 1,
        start: parseFloat(chunk[0].start.toFixed(3)),
        end: parseFloat(chunk[chunk.length - 1].end.toFixed(3)),
        text: chunk.map(s => s.text.trim()).join(' ').trim()
      });
    }

    // Track Whisper cost
    const audioDur = transcription.duration || 0;
    addWhisperCost(audioDur);
    console.log(`[whisper] Duración: ${(audioDur / 60).toFixed(2)} min, Costo: $${sessionCosts.whisper.cost.toFixed(4)}`);

    // ── DIAGNÓSTICO PASO 1: Transcripción ────────────────────────────────
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║          DIAGNÓSTICO PASO 1 — TRANSCRIPCIÓN             ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('Audio duration:', audioDur.toFixed(1), 'seconds (' + (audioDur / 60).toFixed(2) + ' min)');
    console.log('Segmentos Whisper crudos:', raw.length);
    console.log('Agrupación N:', n, '(cada', n, 'segmentos Whisper → 1 segmento de video)');
    console.log('Segmentos agrupados:', grouped.length);
    console.log('--- Detalle de segmentos agrupados ---');
    grouped.forEach(s => {
      const dur = (s.end - s.start).toFixed(1);
      console.log(`  Seg ${s.id}: ${s.start.toFixed(1)}s-${s.end.toFixed(1)}s = ${dur}s | texto: "${s.text.substring(0, 80)}${s.text.length > 80 ? '...' : ''}"`);
    });
    const duraciones = grouped.map(s => s.end - s.start);
    console.log('--- Estadísticas ---');
    console.log('  Duración mín:', Math.min(...duraciones).toFixed(1) + 's');
    console.log('  Duración máx:', Math.max(...duraciones).toFixed(1) + 's');
    console.log('  Duración promedio:', (duraciones.reduce((a, b) => a + b, 0) / duraciones.length).toFixed(1) + 's');
    console.log('  Segmentos > 8s:', duraciones.filter(d => d > 8).length);
    console.log('  Segmentos > 10s:', duraciones.filter(d => d > 10).length);
    console.log('  Segmentos > 15s:', duraciones.filter(d => d > 15).length);
    console.log('══════════════════════════════════════════════════════════\n');

    res.json({
      segments: grouped,
      audioPath: req.file.path,
      duration: audioDur,
      totalSegments: grouped.length
    });
  } catch (err) {
    console.error('[transcribe]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Generate Prompts ──────────────────────────────────────────────────────────

// Parse raw API response → array of prompt objects. Tries clean JSON first, then regex salvage.
function parseResponse(raw) {
  // Strip markdown code fences
  let clean = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  // Try clean JSON parse
  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(clean.slice(start, end + 1));
      const arr = parsed.prompts || parsed;
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch (_) { /* fall through to regex */ }
  }

  // Regex salvage — extract individual prompt objects
  const salvaged = [];
  const re = /\{\s*"id"\s*:\s*(\d+)\s*,\s*"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"tipo_recomendado"\s*:\s*"([^"]*)")?\s*(?:,\s*"razon"\s*:\s*"((?:[^"\\]|\\.)*)")?\s*(?:,\s*"keyword"\s*:\s*"([^"]*)")?\s*(?:,\s*"zoom"\s*:\s*"([^"]*)")?\s*\}/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const obj = { id: parseInt(m[1], 10), prompt: m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"') };
    if (m[3]) obj.tipo_recomendado = m[3];
    if (m[4]) obj.razon = m[4].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    if (m[5]) obj.keyword = m[5];
    if (m[6]) obj.zoom = m[6];
    salvaged.push(obj);
  }
  if (salvaged.length > 0) {
    console.warn(`[generate-prompts] JSON roto — recuperados ${salvaged.length} via regex`);
    return salvaged;
  }

  console.error('[generate-prompts] unparseable response:\n', raw.substring(0, 500));
  return [];
}

// ── Credit exhaustion error — stops all retries immediately ──────────────────
class CreditExhaustedError extends Error {
  constructor(msg) { super(msg); this.name = 'CreditExhaustedError'; }
}

function isCreditError(err) {
  const msg = (err.message || '').toLowerCase();
  return msg.includes('credit balance') || msg.includes('insufficient_quota') ||
         msg.includes('billing') || msg.includes('rate_limit') && msg.includes('quota');
}

// ── Generate a batch of prompts (calls API once, returns parsed array) ───────
async function generateBatch(systemPrompt, batch, provider, model) {
  const userMessage = batch.map(s => `[${s.id}] (${(s.end - s.start).toFixed(1)}s) ${s.text}`).join('\n');
  const ids = batch.map(s => s.id);

  console.log(`[generateBatch] Enviando ${batch.length} segmentos — IDs: [${ids.join(',')}]`);

  try {
    const result = await callAnalysisModel({ systemPrompt, userMessage, provider, model });
    const raw = result.text;
    console.log(`[generateBatch] Respuesta: ${raw.length} chars`);

    const parsed = parseResponse(raw);
    // Only keep prompts whose IDs we actually requested
    const idSet = new Set(ids);
    const valid = parsed.filter(p => idSet.has(p.id));
    console.log(`[generateBatch] Parseados: ${valid.length}/${batch.length} — IDs: [${valid.map(p => p.id).join(',')}]`);
    return valid;
  } catch (err) {
    if (isCreditError(err)) {
      console.error(`[generateBatch] ⚠ CRÉDITOS AGOTADOS — parando inmediatamente`);
      throw new CreditExhaustedError(err.message);
    }
    console.error(`[generateBatch] Error: ${err.message}`);
    return [];
  }
}

// ── Generate prompt for a single segment (individual retry) ─────────────────
async function generateSingle(seg, systemPrompt, provider, model) {
  const userMessage = `[${seg.id}] (${(seg.end - seg.start).toFixed(1)}s) ${seg.text}`;
  console.log(`[generateSingle] Reintentando seg ${seg.id}...`);

  try {
    const result = await callAnalysisModel({ systemPrompt, userMessage, provider, model, maxTokens: 2000 });
    const parsed = parseResponse(result.text);
    const match = parsed.find(p => p.id === seg.id);
    if (match) {
      console.log(`[generateSingle] seg ${seg.id} OK`);
      return match;
    }
    // If AI returned a prompt but with wrong ID, fix it
    if (parsed.length > 0) {
      parsed[0].id = seg.id;
      console.log(`[generateSingle] seg ${seg.id} recuperado (ID corregido)`);
      return parsed[0];
    }
    console.warn(`[generateSingle] seg ${seg.id} — sin resultado`);
    return null;
  } catch (err) {
    if (isCreditError(err)) {
      console.error(`[generateSingle] ⚠ CRÉDITOS AGOTADOS — parando inmediatamente`);
      throw new CreditExhaustedError(err.message);
    }
    console.error(`[generateSingle] seg ${seg.id} falló: ${err.message}`);
    return null;
  }
}

app.post('/api/generate-prompts', async (req, res) => {
  try {
    const { segments, systemPrompt, style, formatoCamara, tipoContenido, analysisProvider, analysisModel } = req.body;
    if (!segments || !segments.length) return res.status(400).json({ error: 'No hay segmentos' });

    // Force Haiku for prompt generation (cheaper, sufficient for JSON output)
    // Segmentation uses the user-selected model; prompts always use Haiku
    let prov = 'anthropic';
    let mdl  = 'claude-haiku-4-5-20251001';
    const fc   = formatoCamara || 'con_camara';
    const tc   = tipoContenido || 'auto';
    const permitidos = TIPOS_PERMITIDOS[fc] || TIPOS_PERMITIDOS.con_camara;

    console.log(`\n[generate-prompts] INICIO — ${segments.length} segmentos, formato: ${fc}, contenido: ${tc}`);
    console.log(`[generate-prompts] Segmentación usó: ${analysisProvider || DEFAULT_ANALYSIS_PROVIDER}/${analysisModel || DEFAULT_ANALYSIS_MODEL}`);
    console.log(`[generate-prompts] Prompts: ${prov}/${mdl} (forzado — Haiku es suficiente para JSON)`);

    // ── Build system prompt (all rules inline, no external suffix) ───────
    let sysPrompt = (systemPrompt || '').replace(/\{style\}/g, style || 'fotorrealista');

    // Format rules
    sysPrompt += '\n\n=== REGLAS OBLIGATORIAS DE FORMATO ===\n';

    if (fc === 'con_camara') {
      sysPrompt += `
FORMATO: Con camara.
- Puedes recomendar "camara" libremente.
- El PRIMER segmento DEBE ser "camara" — el presentador abre el video.
- Los ULTIMOS 1-2 segmentos DEBEN ser "camara" — cierre y call to action.
- "camara" debe aparecer al menos cada 8-10 segmentos.`;
    } else if (fc === 'faceless_pro_avatar') {
      sysPrompt += `
FORMATO DE CÁMARA: Faceless Pro + Personaje. NUNCA recomiendes "camara" ni "grabacion_pantalla". Este formato usa un AVATAR/PERSONAJE generado con IA para los momentos donde normalmente hablaría el presentador. Usa "avatar" para: intro, outro, momentos de conexión personal, opiniones directas del narrador, y transiciones narrativas. Usa los demás tipos (imagen_ia, video_stock, motion_graphic, contenido_relacionado, texto_impacto, texto_cita, texto_lista, texto_grafica) para el resto del contenido. DISTRIBUCIÓN IDEAL: avatar ~20-25%, imagen_ia ~25%, video_stock ~20%, texto_impacto ~10%, texto_cita ~8%, motion_graphic ~7%, texto_lista/grafica ~5%. NUNCA pongas más de 2 avatares seguidos. El avatar reemplaza lo que sería "camara" en un video con presentador.
- El PRIMER segmento DEBE ser "avatar" — el personaje abre el video.
- Los ULTIMOS 1-2 segmentos DEBEN ser "avatar" — cierre y call to action.`;
    } else if (fc === 'faceless' || fc === 'faceless_pro') {
      sysPrompt += `
FORMATO: ${fc === 'faceless' ? 'Faceless basico' : 'Faceless Pro'}.

PROHIBIDO — SIN EXCEPCIONES:
- PROHIBIDO usar "camara" como tipo_recomendado. NUNCA.
- PROHIBIDO usar "grabacion_pantalla" como tipo_recomendado.
- El PRIMER segmento debe ser "imagen_ia" o "video_stock", NUNCA "camara".
- El ULTIMO segmento debe ser "texto_impacto" o "imagen_ia", NUNCA "camara".`;
    }

    sysPrompt += `

TIPOS PERMITIDOS para ${fc} (NO recomendar tipos fuera de esta lista):
${permitidos.join(', ')}

=== REGLAS DE DURACION ===
Cada segmento incluye su duracion en segundos entre parentesis. Usa esa duracion para elegir el tipo:
- imagen_ia: maximo 7 segundos
- motion_graphic: maximo 6 segundos
- texto_minimal: maximo 6 segundos
- texto_cita: maximo 6 segundos
- texto_impacto: maximo 7 segundos
- video_stock: maximo 8 segundos
- texto_lista: maximo 8 segundos
- texto_grafica: maximo 8 segundos
- camara, grabacion_pantalla, contenido_relacionado: sin limite

Si un segmento dura mas de 8s, SOLO puede ser camara, grabacion_pantalla o contenido_relacionado.
Si un segmento dura mas de 7s, NO puede ser texto_impacto.
Si un segmento dura mas de 7s, NO puede ser imagen_ia, motion_graphic, texto_minimal ni texto_cita.
=== FIN REGLAS DE DURACION ===`;

    // Content type
    if (tc === 'tutorial') {
      sysPrompt += '\n\nTIPO DE CONTENIDO: Tutorial. Prioriza "grabacion_pantalla" para procesos digitales (si permitido). Explicaciones paso a paso.';
    } else if (tc === 'noticiero') {
      sysPrompt += '\n\nTIPO DE CONTENIDO: Noticiero. Prioriza "contenido_relacionado" y "texto_impacto" para datos. Tono informativo.';
    } else if (tc === 'documental') {
      sysPrompt += '\n\nTIPO DE CONTENIDO: Documental. Prioriza "video_stock" e "imagen_ia". Ritmo pausado.';
    } else if (tc === 'educativo') {
      sysPrompt += '\n\nTIPO DE CONTENIDO: Educativo. Prioriza "texto_lista" y "texto_grafica" para explicaciones.';
    } else if (tc === 'entretenimiento') {
      sysPrompt += '\n\nTIPO DE CONTENIDO: Entretenimiento. Ritmo rapido. Prioriza "imagen_ia" y "video_stock" llamativos.';
    } else if (tc === 'opinion') {
      sysPrompt += '\n\nTIPO DE CONTENIDO: Opinion. ' + (fc === 'con_camara' ? 'Mucha camara con inserts variados.' : 'Alterna texto_cita con imagen_ia y texto_impacto.');
    }

    // Technical instructions
    sysPrompt += `

=== INSTRUCCIONES TECNICAS ===
Responde SOLO con JSON valido, sin texto adicional. Formato:
{"prompts": [
  {"id": N, "prompt": "descripcion visual detallada en ingles", "tipo_recomendado": "tipo", "razon": "por que este tipo", "keyword": "termino de busqueda en ingles", "zoom": "ken_burns|zoom_in_rapido|zoom_out_rapido|zoom_punch|zoom_pulso|pan_izquierda|pan_derecha|zoom_dramatico|none"}
]}

REGLAS:
- Genera EXACTAMENTE un prompt por cada segmento recibido.
- El campo "id" DEBE coincidir con el [id] del segmento.
- El "prompt" debe ser una descripcion visual detallada en INGLES.
- El "keyword" es un termino de busqueda corto en INGLES para stock.
- El "zoom" indica el MOVIMIENTO DE CAMARA (efecto visual). Opciones:
  * ken_burns: zoom lento y suave (default, bueno para la mayoria)
  * zoom_in_rapido: zoom rapido hacia adentro (enfasis, revelacion)
  * zoom_out_rapido: zoom rapido hacia afuera (contexto, alejamiento)
  * zoom_punch: golpe de zoom rapido ida y vuelta (impacto, sorpresa)
  * zoom_pulso: respiracion suave (ambiente, calma)
  * pan_izquierda: paneo horizontal a la izquierda (movimiento, transicion)
  * pan_derecha: paneo horizontal a la derecha (movimiento, transicion)
  * zoom_dramatico: zoom lento y pronunciado (drama, tension)
  * none: imagen estatica sin movimiento
  Varia los zooms para crear dinamismo. No uses ken_burns en todos.
- NO omitas ningun segmento. Si recibes 5 segmentos, devuelves 5 prompts.
=== FIN INSTRUCCIONES TECNICAS ===

=== REGLAS DE RECOMENDACION DE TIPO ===

Analiza el CONTENIDO del texto de cada segmento para elegir el tipo mas apropiado:

- Si el texto menciona un NUMERO, cifra, estadistica, porcentaje, cantidad → texto_impacto
- Si el texto contiene una CITA textual, frase celebre, o alguien dice algo entre comillas → texto_cita
- Si el texto ENUMERA cosas, pasos, razones, puntos → texto_lista
- Si el texto COMPARA datos, muestra crecimiento, evolucion, o tiene multiples cifras → texto_grafica
- Si el texto describe una ESCENA, metafora, concepto abstracto, o algo visual → imagen_ia
- Si el texto habla de ACCION, movimiento, naturaleza, ambientacion → video_stock
- contenido_relacionado: SOLO usar cuando el texto menciona TODOS estos criterios:
  * Un nombre propio de persona real (ej: "Netanyahu", "Biden", "Messi")
  * O un evento especifico con fecha (ej: "7 de octubre de 2023", "la guerra de 1948")
  * O un producto/marca reconocible (ej: "iPhone 16", "Tesla Model 3")
  * O un lugar especifico que necesite foto REAL (ej: "la Franja de Gaza", "el muro de Berlin")
  NUNCA usar contenido_relacionado para:
  * Conceptos abstractos ("conflicto", "verdad", "vida")
  * Metaforas ("pedazo de tierra", "lavar el cerebro")
  * Introducciones o saludos ("Bienvenido a...")
  * Opiniones o reflexiones del narrador
  * Descripciones genericas de lugares sin nombre propio
  Si dudas entre contenido_relacionado e imagen_ia, elige imagen_ia.
  Contenido_relacionado es el tipo MAS DIFICIL de producir (el usuario busca el material manualmente), solo se usa cuando es ESTRICTAMENTE necesario.
  Un video de 12 segmentos deberia tener MAXIMO 1-2 de contenido_relacionado. Si no hay hechos reales con nombres propios o fechas, puede tener 0.
- Si el texto necesita una ANIMACION compleja, diagrama en movimiento, o transicion elaborada → motion_graphic
- Si el texto es una FRASE CORTA, idea clave, slogan → texto_minimal

El contenido del texto SIEMPRE manda sobre los porcentajes. No pongas texto_grafica si el texto dice "Bienvenido a la vida en plastilina".

DISTRIBUCIONES IDEALES POR FORMATO:
` + (fc === 'faceless_pro_avatar' ? `
Formato FACELESS PRO + PERSONAJE:
- avatar: ~20-25% (intro, outro, conexion personal, opiniones, transiciones narrativas)
- imagen_ia: ~25%
- video_stock: ~20%
- texto_impacto: ~10%
- texto_cita: ~8%
- motion_graphic: ~7%
- texto_lista/grafica: ~5%
- contenido_relacionado: ~5% (SOLO si hay hechos reales especificos)
REGLA: NUNCA mas de 2 avatares seguidos. NUNCA mas de 2 segmentos del mismo tipo seguidos.
` : fc === 'faceless_pro' ? `
Formato FACELESS PRO:
- imagen_ia: ~30%
- video_stock: ~25%
- texto_impacto: ~15%
- texto_cita: ~10%
- motion_graphic: ~10%
- texto_lista/grafica: ~5%
- contenido_relacionado: ~5% (SOLO si hay hechos reales especificos)
- texto_minimal: casi nunca
REGLA: NUNCA mas de 2 segmentos seguidos del mismo tipo.
` : fc === 'faceless' ? `
Formato FACELESS BASICO:
- imagen_ia: ~50%
- video_stock: ~30%
- texto_impacto: ~15%
- texto_minimal: ~5%
REGLA: NUNCA mas de 3 seguidos del mismo tipo.
` : `
Formato CON CAMARA:
- camara: ~40-50%
- imagen_ia: ~15%
- video_stock: ~15%
- texto_impacto: ~10%
- contenido_relacionado: ~5%
- el resto: ~5-10%
REGLA: camara puede ir seguido hasta 3 veces, los demas tipos maximo 2 seguidos.
`) + `
Estas son distribuciones GUIA, no exactas. El contenido del texto siempre tiene prioridad. Pero si ves que llevas 5 del mismo tipo seguidos, CAMBIA a otro tipo.

=== FIN REGLAS DE RECOMENDACION ===`;

    // ── DIAGNÓSTICO: System prompt de generación de prompts ──
    console.log('========== SYSTEM PROMPT PROMPTS ==========');
    console.log(sysPrompt);
    console.log('========== FIN SYSTEM PROMPT PROMPTS ==========');
    console.log(`[generate-prompts] System prompt: ${sysPrompt.length} chars (~${Math.ceil(sysPrompt.length / 4)} tokens)`);

    // ── MAIN LOOP: sequential batches of PROMPT_BATCH_SIZE ──────────────
    const totalSegments = segments.length;
    const allPrompts = [];
    const batches = [];
    for (let i = 0; i < segments.length; i += PROMPT_BATCH_SIZE) {
      batches.push(segments.slice(i, i + PROMPT_BATCH_SIZE));
    }
    const totalBatches = batches.length;

    console.log(`[generate-prompts] ${totalSegments} segmentos → ${totalBatches} lotes de ≤${PROMPT_BATCH_SIZE}, secuencial con 500ms delay`);

    let creditExhausted = false;
    let consecutiveFailures = 0;

    try {
      // ── Main batch loop ──
      for (let b = 0; b < totalBatches; b++) {
        const batch = batches[b];
        const batchNum = b + 1;

        sendSSE({
          type: 'prompt-batch-start',
          batchNum, totalBatches,
          batchSize: batch.length,
          totalReceived: allPrompts.length,
          totalSegments
        });

        // Log user prompt del primer lote como ejemplo
        if (b === 0) {
          const userPromptEjemplo = batch.map(s => `[${s.id}] (${(s.end - s.start).toFixed(1)}s) ${s.text}`).join('\n');
          console.log('========== USER PROMPT EJEMPLO (LOTE 1) ==========');
          console.log(userPromptEjemplo);
          console.log('========== FIN USER PROMPT EJEMPLO ==========');
        }

        const startTime = Date.now();
        const got = await generateBatch(sysPrompt, batch, prov, mdl);
        allPrompts.push(...got);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // Track consecutive failures for auto-fallback
        if (got.length === 0) {
          consecutiveFailures++;
          if (consecutiveFailures >= 2 && prov === 'anthropic') {
            console.warn(`[generate-prompts] Haiku falló ${consecutiveFailures} lotes seguidos — switching to GPT-4o mini`);
            prov = 'openai';
            mdl = 'gpt-4o-mini';
            consecutiveFailures = 0;
          }
        } else {
          consecutiveFailures = 0;
        }

        console.log(`[generate-prompts] Lote ${batchNum}/${totalBatches} (${prov}/${mdl}): ${got.length}/${batch.length} recibidos (${elapsed}s) — acumulado ${allPrompts.length}/${totalSegments}`);

        sendSSE({
          type: 'prompt-batch-done',
          batchNum, totalBatches,
          totalReceived: allPrompts.length,
          totalSegments
        });

        // Delay between batches (except last)
        if (b < totalBatches - 1) {
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // ── RETRY ROUND 1: individual retry for missing ─────────────────────
      let coveredIds = new Set(allPrompts.map(p => p.id));
      let missing = segments.filter(s => !coveredIds.has(s.id));

      if (missing.length > 0) {
        console.warn(`[generate-prompts] RETRY RONDA 1: ${missing.length} faltantes — [${missing.map(s => s.id).join(',')}]`);
        sendSSE({ type: 'prompt-retry', round: 1, missing: missing.length, totalSegments });

        for (const seg of missing) {
          const result = await generateSingle(seg, sysPrompt, prov, mdl);
          if (result) allPrompts.push(result);
          await new Promise(r => setTimeout(r, 300));
        }

        // Recheck
        coveredIds = new Set(allPrompts.map(p => p.id));
        missing = segments.filter(s => !coveredIds.has(s.id));
      }

      // ── RETRY ROUND 2: second and final attempt ─────────────────────────
      if (missing.length > 0) {
        console.warn(`[generate-prompts] RETRY RONDA 2 (FINAL): ${missing.length} faltantes — [${missing.map(s => s.id).join(',')}]`);
        sendSSE({ type: 'prompt-retry', round: 2, missing: missing.length, totalSegments });

        for (const seg of missing) {
          const result = await generateSingle(seg, sysPrompt, prov, mdl);
          if (result) allPrompts.push(result);
          await new Promise(r => setTimeout(r, 300));
        }
      }
    } catch (creditErr) {
      if (creditErr.name === 'CreditExhaustedError') {
        creditExhausted = true;
        console.error(`⚠ [generate-prompts] CRÉDITOS AGOTADOS — se generaron ${allPrompts.length}/${totalSegments} prompts`);
        sendSSE({
          type: 'credit-exhausted',
          totalReceived: allPrompts.length,
          totalSegments,
          message: `Créditos de API insuficientes. Se generaron ${allPrompts.length} de ${totalSegments} prompts. Recarga créditos y dale "Continuar" para completar los faltantes.`
        });
      } else {
        throw creditErr; // re-throw non-credit errors
      }
    }

    // ── HARD STOP — count missing ───────────────────────────────────────
    let coveredIdsFinal = new Set(allPrompts.map(p => p.id));
    let missing = segments.filter(s => !coveredIdsFinal.has(s.id));

    if (missing.length > 0) {
      console.error(`[generate-prompts] STOP FINAL: ${missing.length} segmentos sin prompt: [${missing.map(s => s.id).join(',')}]`);
    } else {
      console.log(`[generate-prompts] ${allPrompts.length}/${totalSegments} prompts generados OK`);
    }

    // ── Safety net: defaults + allowed types + duration limits ───────────
    const allowedSet = new Set(permitidos);
    allPrompts.forEach(p => {
      if (!p.tipo_recomendado) p.tipo_recomendado = 'imagen_ia';
      if (!p.razon) p.razon = '';
      if (!p.keyword) p.keyword = '';
      // Normalize zoom to valid motion types
      const VALID_ZOOMS = new Set(['ken_burns','zoom_in_rapido','zoom_out_rapido','zoom_punch','zoom_pulso','pan_izquierda','pan_derecha','zoom_dramatico','none']);
      if (!p.zoom || !VALID_ZOOMS.has(p.zoom)) {
        // Map legacy framing values to motion types
        const zoomRemap = { 'close-up': 'zoom_in_rapido', 'extreme-close-up': 'zoom_punch', 'wide': 'zoom_out_rapido', 'medium': 'ken_burns' };
        p.zoom = zoomRemap[p.zoom] || 'ken_burns';
      }

      // Correct types not allowed for this camera format
      if (!allowedSet.has(p.tipo_recomendado)) {
        console.warn(`[safety-net] seg ${p.id}: "${p.tipo_recomendado}" no permitido en ${fc} → "imagen_ia"`);
        p.tipo_recomendado = 'imagen_ia';
      }

      // Correct duration violations with smart fallback
      const seg = segments.find(s => s.id === p.id);
      if (seg) {
        const dur = seg.end - seg.start;
        const newTipo = safetyNetFallback(p.tipo_recomendado, dur, allowedSet);
        if (newTipo !== p.tipo_recomendado) {
          console.warn(`[safety-net] seg ${p.id}: ${p.tipo_recomendado} (max ${MAX_DURACIONES[p.tipo_recomendado] || 8}s) pero dura ${dur.toFixed(1)}s → "${newTipo}"`);
          p.tipo_recomendado = newTipo;
        }
      }
    });

    // ── Sort by ID to maintain order ────────────────────────────────────
    allPrompts.sort((a, b) => a.id - b.id);

    // ── Final diagnostic log ────────────────────────────────────────────
    const tipoDistrib = {};
    allPrompts.forEach(p => { tipoDistrib[p.tipo_recomendado] = (tipoDistrib[p.tipo_recomendado] || 0) + 1; });
    const uniquePrompts = new Set(allPrompts.map(p => (p.prompt || '').substring(0, 80)));

    console.log('\n── RESULTADO FINAL ──');
    console.log(`Prompts: ${allPrompts.length}/${totalSegments}${missing.length > 0 ? ` (${missing.length} faltantes)` : ' — COMPLETO'}`);
    console.log('Distribucion:', JSON.stringify(tipoDistrib));
    console.log(`Unicos: ${uniquePrompts.size}/${allPrompts.length}${uniquePrompts.size === allPrompts.length ? ' ✓' : ' ⚠ HAY DUPLICADOS'}`);
    console.log('Muestra:', allPrompts.slice(0, 3).map(p => ({ id: p.id, tipo: p.tipo_recomendado, prompt: (p.prompt || '').substring(0, 50) })));
    console.log('── FIN ──\n');

    res.json({
      prompts: allPrompts,
      recovered: missing.length > 0,
      creditExhausted,
      totalReceived: allPrompts.length,
      totalSegments
    });
  } catch (err) {
    console.error('[generate-prompts] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Images ────────────────────────────────────────────────────────────────────
app.post('/api/upload-images', imageUpload.array('images', 200), (req, res) => {
  const dir = path.join(__dirname, 'uploads/images');
  // When uploading a replacement, delete ALL existing files with the same base name
  // (any extension) so findMedia always picks the new file, not an old one
  const ALL_MEDIA_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.JPG', '.JPEG', '.PNG', '.WEBP', '.MP4'];
  for (const file of (req.files || [])) {
    const baseName = path.parse(file.filename).name; // e.g. "5"
    const uploadedExt = path.extname(file.filename).toLowerCase();
    for (const ext of ALL_MEDIA_EXTS) {
      if (ext.toLowerCase() === uploadedExt) continue; // don't delete the file we just uploaded
      const conflictPath = path.join(dir, `${baseName}${ext}`);
      if (fs.existsSync(conflictPath)) {
        fs.unlinkSync(conflictPath);
        console.log(`[upload-images] Deleted conflicting ${baseName}${ext} (replaced by ${file.filename})`);
      }
    }
    console.log(`[upload-images] Saved ${file.filename} for segment ${baseName}`);
  }
  res.json({ uploaded: req.files.map(f => f.filename) });
});

app.get('/api/images', (req, res) => {
  const dir = path.join(__dirname, 'uploads/images');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp|mp4)$/i.test(f))
    : [];
  res.json({ images: files });
});

app.delete('/api/images/clear', (req, res) => {
  const dir = path.join(__dirname, 'uploads/images');
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(f => {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    });
  }
  res.json({ success: true });
});

// ── Upload user video ─────────────────────────────────────────────────────────
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads/images'),
    filename: (req, file, cb) => cb(null, `_tmp_uservid_${Date.now()}${path.extname(file.originalname)}`)
  })
});

app.post('/api/upload-video', videoUpload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo de video' });

    const segmentId = req.body.segmentId;
    const segmentDuration = parseFloat(req.body.segmentDuration) || 10;
    const [width, height] = (req.body.resolution || '1920x1080').split('x').map(Number);

    if (!segmentId) return res.status(400).json({ error: 'segmentId requerido' });

    const dir = path.join(__dirname, 'uploads/images');
    const tmpPath = req.file.path;

    // Remove any existing media for this segment id
    const exts = ['.jpg', '.jpeg', '.png', '.webp', '.mp4'];
    for (const ext of exts) {
      const p = path.join(dir, `${segmentId}${ext}`);
      if (p !== tmpPath) try { fs.unlinkSync(p); } catch (_) {}
    }

    const outPath = path.join(dir, `${segmentId}.mp4`);

    const vf = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
    ].join(',');

    await runFFmpeg([
      '-stream_loop', '-1',
      '-i', ffmpegPath(tmpPath),
      '-t', String(segmentDuration),
      '-vf', vf,
      '-an',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      ffmpegPath(outPath)
    ]);

    // Clean up temp upload
    try { fs.unlinkSync(tmpPath); } catch (_) {}

    res.json({ success: true, filename: `${segmentId}.mp4` });
  } catch (err) {
    // Clean up temp on error
    if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {}
    console.error('[upload-video]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Pexels Videos ─────────────────────────────────────────────────────────────
app.get('/api/pexels/search', async (req, res) => {
  try {
    const key = process.env.PEXELS_API_KEY;
    if (!key) throw new Error('PEXELS_API_KEY no configurado');
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Parámetro q requerido' });
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = 9;

    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}&orientation=landscape`;
    const r = await fetch(url, { headers: { Authorization: key } });
    if (!r.ok) throw new Error(`Pexels API: ${r.status} ${r.statusText}`);
    const data = await r.json();

    const total = data.total_results || 0;
    const videos = (data.videos || [])
      .filter(v => v.width > v.height)
      .map(v => {
        const files = v.video_files || [];
        const hd = files.find(f => f.quality === 'hd' && f.width >= 1280);
        const sd = files.find(f => f.quality === 'sd');
        const best = hd || sd || files[0];
        return {
          id: v.id, width: v.width, height: v.height, duration: v.duration,
          image: v.image, user: v.user?.name || 'Unknown',
          videoUrl: best?.link || null, quality: best?.quality || 'unknown'
        };
      })
      .filter(v => v.videoUrl);

    res.json({ results: videos, page, per_page: perPage, total, total_pages: Math.ceil(total / perPage) });
  } catch (err) {
    console.error('[pexels/search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Pixabay Videos ─────────────────────────────────────────────────────────
app.get('/api/pixabay/search', async (req, res) => {
  try {
    const key = process.env.PIXABAY_API_KEY;
    if (!key) throw new Error('PIXABAY_API_KEY no configurado');
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Parámetro q requerido' });
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = 9;

    const url = `https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Pixabay API: ${r.status} ${r.statusText}`);
    const data = await r.json();

    const total = data.totalHits || 0;
    const videos = (data.hits || [])
      .filter(v => { const large = v.videos?.large; return large && large.width > large.height; })
      .map(v => {
        const large = v.videos.large; const small = v.videos.small; const tiny = v.videos.tiny;
        return {
          id: v.id, width: large.width, height: large.height, duration: v.duration,
          image: tiny?.thumbnail || small?.thumbnail || '', user: v.user || 'Unknown',
          videoUrl: large.url || small?.url || null, quality: 'hd'
        };
      })
      .filter(v => v.videoUrl);

    res.json({ results: videos, page, per_page: perPage, total, total_pages: Math.ceil(total / perPage) });
  } catch (err) {
    console.error('[pixabay/search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Coverr Videos ──────────────────────────────────────────────────────────
app.get('/api/coverr/search', async (req, res) => {
  try {
    const key = process.env.COVERR_API_KEY;
    if (!key) throw new Error('COVERR_API_KEY no configurado');
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Parámetro q requerido' });
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = 9;

    const url = `https://api.coverr.co/videos?query=${encodeURIComponent(query)}&urls=true&page_size=${perPage}&page=${page}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`Coverr API: ${r.status} ${r.statusText}`);
    const data = await r.json();

    const total = data.total || (data.videos || data.hits || []).length;
    const videos = (data.videos || data.hits || [])
      .filter(v => !v.is_vertical && v.max_width > v.max_height)
      .map(v => ({
        id: v.id || v.slug, width: v.max_width || 1920, height: v.max_height || 1080,
        duration: v.duration || 0, image: v.poster || v.thumbnail || '',
        user: v.creator?.name || 'Coverr',
        videoUrl: v.urls?.mp4_download || v.urls?.mp4 || null, quality: 'hd'
      }))
      .filter(v => v.videoUrl);

    res.json({ results: videos, page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) });
  } catch (err) {
    console.error('[coverr/search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Wikimedia Commons Search ──────────────────────────────────────────────
const WIKI_UA = 'VideoAutoStudio/1.0 (https://github.com/juanmarket/VideoAuto-Studio)';
const _wikiCache = new Map();         // key = "query|page" → { ts, data }
const WIKI_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let _wikiLastReq = 0;                 // timestamp of last outgoing request

async function wikiFetch(url, retries = 2) {
  // Rate-limit: ensure ≥1 s between requests
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - _wikiLastReq));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _wikiLastReq = Date.now();

  const r = await fetch(url, { headers: { 'User-Agent': WIKI_UA } });
  if (r.status === 429 && retries > 0) {
    console.warn(`[wikimedia] 429 rate-limited, retrying in 2 s (${retries} left)`);
    await new Promise(r => setTimeout(r, 2000));
    return wikiFetch(url, retries - 1);
  }
  if (!r.ok) throw new Error(`Wikimedia API: ${r.status} ${r.statusText}`);
  return r.json();
}

app.get('/api/wikimedia/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Parámetro q requerido' });
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = 9;
    const offset = (page - 1) * perPage;

    const type = (req.query.type || '').toLowerCase(); // 'image', 'video', or '' (both)

    // Check cache
    const cacheKey = `${query.toLowerCase().trim()}|${page}|${type}`;
    const cached = _wikiCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts < WIKI_CACHE_TTL)) {
      return res.json(cached.data);
    }

    // Get total count via list=search
    const countUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srnamespace=6&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json&origin=*`;
    const countData = await wikiFetch(countUrl);
    const totalHits = countData.query?.searchinfo?.totalhits || 0;

    // Fetch more than perPage to compensate for filtering
    const fetchLimit = perPage * 4;
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}&gsrlimit=${fetchLimit}&gsroffset=${offset}&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1920&format=json&origin=*`;
    const data = await wikiFetch(url);

    const pages = data.query?.pages || {};
    const allowedMime = type === 'image'
      ? ['image/jpeg', 'image/png', 'image/webp']
      : type === 'video'
        ? ['video/mp4', 'video/webm', 'video/ogg']
        : ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'];
    const allowedLicenses = [
      'public domain', 'cc0',
      'cc by 4.0', 'cc by 3.0', 'cc by 2.0',
      'cc by-sa 4.0', 'cc by-sa 3.0', 'cc by-sa 2.0'
    ];

    const results = Object.values(pages)
      .map(pg => {
        const info = pg.imageinfo?.[0];
        if (!info) return null;
        const mime = (info.mime || '').toLowerCase();
        if (!allowedMime.includes(mime)) return null;
        const ext = info.extmetadata || {};
        const licenseRaw = ext.LicenseShortName?.value || '';
        const licenseLower = licenseRaw.toLowerCase().trim();
        if (!allowedLicenses.some(al => licenseLower.includes(al))) return null;
        const isVideo = mime.startsWith('video/');
        const title = (pg.title || '').replace(/^File:/, '');
        const artist = ext.Artist?.value || '';
        const artistClean = artist.replace(/<[^>]*>/g, '').trim();
        return {
          id: pg.pageid, title, mime, isVideo,
          width: info.width || 0, height: info.height || 0,
          license: licenseRaw, artist: artistClean,
          descriptionUrl: info.descriptionurl || '',
          thumbUrl: info.thumburl || info.url || '',
          fullUrl: info.url || '',
          needsAttribution: licenseLower.includes('cc by')
        };
      })
      .filter(Boolean)
      .filter(r => r.width > r.height)
      .slice(0, perPage);

    const estTotal = Math.max(results.length, totalHits);
    const responseData = { results, page, per_page: perPage, total: estTotal, total_pages: Math.max(1, Math.ceil(estTotal / perPage)) };

    // Store in cache
    _wikiCache.set(cacheKey, { ts: Date.now(), data: responseData });

    res.json(responseData);
  } catch (err) {
    console.error('[wikimedia/search]', err.message);
    const isRateLimit = err.message.includes('429');
    res.status(isRateLimit ? 429 : 500).json({
      error: isRateLimit
        ? 'Wikimedia está limitando las peticiones. Espera unos segundos e intenta de nuevo.'
        : err.message
    });
  }
});

// ── Wikimedia Download (image or video) ───────────────────────────────────
app.post('/api/wikimedia/download', async (req, res) => {
  try {
    const { fileUrl, segmentId, segmentDuration, resolution, isVideo, attribution } = req.body;
    if (!fileUrl || !segmentId) return res.status(400).json({ error: 'fileUrl y segmentId requeridos' });

    const dir = path.join(__dirname, 'uploads/images');
    fs.mkdirSync(dir, { recursive: true });

    // Remove any existing media for this segment id
    const exts = ['.jpg', '.jpeg', '.png', '.webp', '.mp4'];
    for (const ext of exts) {
      const p = path.join(dir, `${segmentId}${ext}`);
      try { fs.unlinkSync(p); } catch (_) {}
    }

    // Download the file (with User-Agent for Wikimedia)
    const response = await fetch(fileUrl, { headers: { 'User-Agent': WIKI_UA } });
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    if (isVideo) {
      const tmpRaw = path.join(dir, `_tmp_wiki_${segmentId}.mp4`);
      fs.writeFileSync(tmpRaw, buffer);

      const [width, height] = (resolution || '1920x1080').split('x').map(Number);
      const dur = parseFloat(segmentDuration) || 10;
      const outPath = path.join(dir, `${segmentId}.mp4`);
      const vf = [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
      ].join(',');

      await runFFmpeg([
        '-stream_loop', '-1',
        '-i', ffmpegPath(tmpRaw),
        '-t', String(dur),
        '-vf', vf, '-an',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast',
        ffmpegPath(outPath)
      ]);
      try { fs.unlinkSync(tmpRaw); } catch (_) {}
      res.json({ success: true, filename: `${segmentId}.mp4` });
    } else {
      // Determine extension from URL or default to jpg
      const urlExt = path.extname(new URL(fileUrl).pathname).toLowerCase();
      const ext = ['.jpg', '.jpeg', '.png', '.webp'].includes(urlExt) ? urlExt : '.jpg';
      const outPath = path.join(dir, `${segmentId}${ext}`);
      fs.writeFileSync(outPath, buffer);
      res.json({ success: true, filename: `${segmentId}${ext}` });
    }

    // Save attribution data if provided
    if (attribution) {
      const creditsPath = path.join(__dirname, 'output', '_wikimedia_credits.json');
      let credits = {};
      try { credits = JSON.parse(fs.readFileSync(creditsPath, 'utf-8')); } catch (_) {}
      credits[String(segmentId)] = attribution;
      fs.writeFileSync(creditsPath, JSON.stringify(credits, null, 2));
    }
  } catch (err) {
    console.error('[wikimedia/download]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stock Video Download (generic — Pexels, Pixabay, Coverr) ──────────────
app.post('/api/stock/download-video', async (req, res) => {
  try {
    const { videoUrl, segmentId, segmentDuration, resolution } = req.body;
    if (!videoUrl || !segmentId) return res.status(400).json({ error: 'videoUrl y segmentId requeridos' });

    const dir = path.join(__dirname, 'uploads/images');
    fs.mkdirSync(dir, { recursive: true });

    // Remove any existing media for this segment id
    const exts = ['.jpg', '.jpeg', '.png', '.webp', '.mp4'];
    for (const ext of exts) {
      const p = path.join(dir, `${segmentId}${ext}`);
      try { fs.unlinkSync(p); } catch (_) {}
    }

    // Download the video
    const tmpRaw = path.join(dir, `_tmp_stock_${segmentId}.mp4`);
    const response = await fetch(videoUrl);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(tmpRaw, buffer);

    // Process with FFmpeg: trim/loop to segment duration, scale to resolution
    const [width, height] = (resolution || '1920x1080').split('x').map(Number);
    const dur = parseFloat(segmentDuration) || 10;
    const outPath = path.join(dir, `${segmentId}.mp4`);

    const vf = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
    ].join(',');

    await runFFmpeg([
      '-stream_loop', '-1',
      '-i', ffmpegPath(tmpRaw),
      '-t', String(dur),
      '-vf', vf,
      '-an',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      ffmpegPath(outPath)
    ]);

    // Clean up raw download
    try { fs.unlinkSync(tmpRaw); } catch (_) {}

    res.json({ success: true, filename: `${segmentId}.mp4` });
  } catch (err) {
    console.error('[stock/download]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Legacy Pexels download (keep for backward compatibility) ──────────────
app.post('/api/pexels/download-video', async (req, res) => {
  try {
    const { videoUrl, segmentId, segmentDuration, resolution } = req.body;
    if (!videoUrl || !segmentId) return res.status(400).json({ error: 'videoUrl y segmentId requeridos' });

    const dir = path.join(__dirname, 'uploads/images');
    fs.mkdirSync(dir, { recursive: true });

    // Remove any existing media for this segment id
    const exts = ['.jpg', '.jpeg', '.png', '.webp', '.mp4'];
    for (const ext of exts) {
      const p = path.join(dir, `${segmentId}${ext}`);
      try { fs.unlinkSync(p); } catch (_) {}
    }

    // Download the video from Pexels
    const tmpRaw = path.join(dir, `_tmp_pexels_${segmentId}.mp4`);
    const response = await fetch(videoUrl);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(tmpRaw, buffer);

    // Process with FFmpeg: trim/loop to segment duration, scale to resolution
    const [width, height] = (resolution || '1920x1080').split('x').map(Number);
    const dur = parseFloat(segmentDuration) || 10;
    const outPath = path.join(dir, `${segmentId}.mp4`);

    const vf = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
    ].join(',');

    await runFFmpeg([
      '-stream_loop', '-1',        // loop if shorter than duration
      '-i', ffmpegPath(tmpRaw),
      '-t', String(dur),
      '-vf', vf,
      '-an',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      ffmpegPath(outPath)
    ]);

    // Clean up raw download
    try { fs.unlinkSync(tmpRaw); } catch (_) {}

    res.json({ success: true, filename: `${segmentId}.mp4` });
  } catch (err) {
    console.error('[pexels/download]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SSE endpoint ──────────────────────────────────────────────────────────────
app.get('/api/export/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

// ── Audio clip download ───────────────────────────────────────────────────────
app.get('/api/audio-clip/:start/:end', async (req, res) => {
  try {
    const start = parseFloat(req.params.start);
    const end = parseFloat(req.params.end);
    const duration = end - start;

    if (isNaN(start) || isNaN(end) || duration <= 0) {
      return res.status(400).json({ error: 'Timestamps inválidos' });
    }

    const audioDir = path.join(__dirname, 'uploads', 'audio');
    if (!fs.existsSync(audioDir)) {
      return res.status(404).json({ error: 'No hay audio subido' });
    }

    const files = fs.readdirSync(audioDir)
      .filter(f => /\.(mp3|wav|m4a)$/i.test(f))
      .map(f => ({ name: f, time: fs.statSync(path.join(audioDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    if (!files.length) {
      return res.status(404).json({ error: 'No hay archivo de audio' });
    }

    const audioPath = path.join(audioDir, files[0].name);
    const tmpOutput = path.join(__dirname, 'output', `clip_${start.toFixed(1)}-${end.toFixed(1)}.mp3`);

    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-ss', start.toFixed(3),
        '-t', duration.toFixed(3),
        '-i', audioPath,
        '-c:a', 'libmp3lame',
        '-b:a', '192k',
        tmpOutput
      ];
      const proc = require('child_process').spawn('ffmpeg', args);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error('FFmpeg error ' + code)));
      proc.on('error', reject);
    });

    res.download(tmpOutput, `audio_seg_${start.toFixed(1)}-${end.toFixed(1)}.mp3`, () => {
      try { fs.unlinkSync(tmpOutput); } catch(e) {}
    });
  } catch (err) {
    console.error('[audio-clip]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Export ────────────────────────────────────────────────────────────────────
app.post('/api/export', (req, res) => {
  res.json({ started: true });
  runExport(req.body).catch(err => {
    console.error('[export]', err.message);
    sendSSE({ type: 'error', message: err.message });
  });
});

// ── Available xfade transitions for random pool ──────────────────────────────
const XFADE_TRANSITIONS = [
  'fade', 'fadeblack', 'fadewhite', 'fadegrays', 'distance', 'dissolve',
  'smoothleft', 'smoothright', 'smoothup', 'smoothdown',
  'circleopen', 'circleclose', 'vertopen', 'vertclose', 'horzopen',
  'diagtl', 'diagtr', 'diagbr', 'hblur'
];

async function runExport({ segments, resolution, fps, kenburns, transition, transitionDuration, audioPath, slotOverrides, profile, sfxEnabled, sfxVolume, cameraMotion, zoomMap }) {
  // Debug: log profile received from frontend
  const est = profile?.estilos || {};
  console.log('[export] Profile received:', JSON.stringify({
    id: profile?.id, nombre: profile?.nombre,
    fondo_tipo: est.fondo_tipo, fondo_video: est.fondo_video, fondo_imagen: est.fondo_imagen,
    glassmorphism: est.glassmorphism, overlay_color: est.overlay_color, overlay_opacidad: est.overlay_opacidad,
    anim_entrada: est.anim_entrada, anim_salida: est.anim_salida, anim_icono: est.anim_icono,
    color_texto: est.color_texto, fuente_principal: est.fuente_principal
  }, null, 2));
  const [width, height] = (resolution || '1920x1080').split('x').map(Number);
  const fpsNum = parseInt(fps) || 24;
  // Camera motion: 'none' | 'ken_burns' | 'dinamico'
  // Legacy support: if old kenburns boolean is sent, map it
  const motionMode = cameraMotion || (kenburns === true ? 'ken_burns' : 'none');
  const effectiveZoomMap = zoomMap || {};
  const xfadeDur = Math.max(0.1, Math.min(1.0, parseFloat(transitionDuration) || 0.3));
  console.log(`[export] Movimiento de cámara: ${motionMode}`);
  console.log(`[export] ZoomMap recibido: ${Object.keys(effectiveZoomMap).length} entries`);
  if (motionMode === 'dinamico') {
    const zoomSample = Object.entries(effectiveZoomMap).slice(0, 5).map(([id, z]) => `${id}:${z}`).join(', ');
    console.log(`[export] ZoomMap muestra: ${zoomSample}`);
  }
  const transType = transition || 'random';                        // 'none' | 'random' | named
  const useXfade = (transType !== 'none' && segments.length > 1);

  const tmpDir = path.join(__dirname, 'output', `tmp_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // ── Build per-pair transition list ────────────────────────────────────────
  const pairCount = segments.length - 1;
  let transitionList = [];
  if (useXfade) {
    if (transType === 'random') {
      // Random transitions with no consecutive repeats
      for (let i = 0; i < pairCount; i++) {
        let pick;
        do {
          pick = XFADE_TRANSITIONS[Math.floor(Math.random() * XFADE_TRANSITIONS.length)];
        } while (i > 0 && pick === transitionList[i - 1]);
        transitionList.push(pick);
      }
    } else {
      // Same named transition for every pair
      transitionList = Array(pairCount).fill(transType);
    }
    console.log(`[export] transitions: ${transType}, duration: ${xfadeDur}s, pairs: ${pairCount}`);
    if (transType === 'random') console.log(`[export] random sequence: [${transitionList.join(', ')}]`);
  }

  // ── Pre-calculate clip durations ──────────────────────────────────────────
  // When xfade is active, each clip except the last is extended by xfadeDur.
  // After xfade overlaps are subtracted the total video equals the audio length:
  //   totalVideo = sum(base + xfadeDur) + baseLast − xfadeDur*(N−1)
  //             = sum(base) + xfadeDur*(N−1) − xfadeDur*(N−1)
  //             = sum(base)  ← matches audio exactly
  let clipDurations = segments.map((s, i) => {
    const base = Math.max(0.1, s.end - s.start);
    const isLast = (i === segments.length - 1);
    return (useXfade && !isLast) ? base + xfadeDur : base;
  });

  const clips = [];
  const total = segments.length;

  // ── Gap detection: find missing time between segments ──────────────────────
  const realAudioDur = await getClipDuration(audioPath).catch(() => 0);
  const sumSegDur = segments.reduce((a, s) => a + Math.max(0.1, s.end - s.start), 0);
  const lastSegEnd = segments.length > 0 ? segments[segments.length - 1].end : 0;
  const gaps = [];
  for (let i = 1; i < segments.length; i++) {
    const gap = segments[i].start - segments[i - 1].end;
    if (gap > 0.05) { // ignore tiny floating-point gaps
      gaps.push({ between: `${i}→${i + 1}`, segIds: `${segments[i-1].id}→${segments[i].id}`, gap: gap.toFixed(3) });
    }
  }
  // Gap at start (before first segment)
  if (segments.length > 0 && segments[0].start > 0.05) {
    gaps.unshift({ between: 'start→1', segIds: `0→${segments[0].id}`, gap: segments[0].start.toFixed(3) });
  }
  // Gap at end (after last segment vs audio duration)
  if (realAudioDur > 0 && lastSegEnd < realAudioDur - 0.05) {
    gaps.push({ between: `${segments.length}→end`, segIds: `${segments[segments.length-1].id}→audio_end`, gap: (realAudioDur - lastSegEnd).toFixed(3) });
  }
  const totalGapTime = gaps.reduce((a, g) => a + parseFloat(g.gap), 0);

  console.log(`[export] ── Audio & segment analysis ──`);
  console.log(`[export]   Audio duration (ffprobe): ${realAudioDur.toFixed(3)}s`);
  console.log(`[export]   Sum of segment durations: ${sumSegDur.toFixed(3)}s`);
  console.log(`[export]   Last segment ends at: ${lastSegEnd.toFixed(3)}s`);
  console.log(`[export]   Difference (audio - segments sum): ${(realAudioDur - sumSegDur).toFixed(3)}s`);
  console.log(`[export]   Difference (audio - last seg end): ${(realAudioDur - lastSegEnd).toFixed(3)}s`);
  if (gaps.length > 0) {
    console.warn(`[export]   ⚠ ${gaps.length} gaps encontrados (total: ${totalGapTime.toFixed(3)}s):`);
    gaps.forEach(g => console.warn(`[export]     Gap ${g.between} (segs ${g.segIds}): ${g.gap}s`));
  } else {
    console.log(`[export]   ✅ Sin gaps entre segmentos`);
  }

  // ── Gap closing: extend segments to fill small gaps ─────────────────────────
  for (let i = 0; i < segments.length - 1; i++) {
    const gap = segments[i + 1].start - segments[i].end;
    if (gap > 0 && gap < 2) {
      console.log(`[export] Cerrando gap ${i}→${i + 1}: ${gap.toFixed(3)}s`);
      segments[i].end = segments[i + 1].start;
    }
  }
  if (segments.length > 0 && realAudioDur > 0) {
    const lastSeg = segments[segments.length - 1];
    if (realAudioDur - lastSeg.end > 0 && realAudioDur - lastSeg.end < 5) {
      console.log(`[export] Extendiendo último segmento de ${lastSeg.end.toFixed(3)}s a ${realAudioDur.toFixed(3)}s`);
      lastSeg.end = realAudioDur;
    }
  }

  // ── Recalculate clip durations after gap closing ──────────────────────────
  clipDurations = segments.map((s, i) => {
    const base = Math.max(0.1, s.end - s.start);
    const isLast = (i === segments.length - 1);
    return (useXfade && !isLast) ? base + xfadeDur : base;
  });

  // ── Step 1: create one clip per segment ────────────────────────────────────
  const overrides = slotOverrides || {};
  const cameraSegments = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const clipPath = path.join(tmpDir, `clip_${String(i).padStart(4, '0')}.mp4`);

    sendSSE({ type: 'progress', step: 'clip', current: i + 1, total, pct: Math.round((i / total) * 60) });

    const override = overrides[String(seg.id)];
    if (override && override.type && override.type.startsWith('texto_')) {
      console.log(`[export] Seg ${seg.id}: SLIDE override=`, JSON.stringify({ type: override.type, template: override.template, text: (override.text || '').substring(0, 60), dato: override.dato, cita: (override.cita || '').substring(0, 40), autor: override.autor, items: (override.items || '').substring(0, 60), chartData: (override.chartData || '').substring(0, 60), titulo: override.titulo }));
    } else {
      const media = findMedia(seg.id);
      console.log(`[export] Seg ${seg.id}: override=`, JSON.stringify(override || null), `mediaOnDisk=${media ? media.path : 'NOT FOUND'}, isVideo=${media?.isVideo || false}`);
    }

    const PLACEHOLDER_TYPES = {
      camara:                { color: '0x00b894', label: 'EN CAMARA' },
      contenido_relacionado: { color: '0xE67E22', label: 'CONTENIDO RELACIONADO' },
      motion_graphic:        { color: '0xE91E63', label: 'MOTION GRAPHIC' },
      grabacion_pantalla:    { color: '0x00BCD4', label: 'GRABACIÓN DE PANTALLA' },
      avatar:                { color: '0x059669', label: 'AVATAR / PERSONAJE' }
    };

    if (override && PLACEHOLDER_TYPES[override.type]) {
      const ph = PLACEHOLDER_TYPES[override.type];
      await createPlaceholderClip(clipPath, clipDurations[i], width, height, fpsNum, ph.color, ph.label);
      cameraSegments.push({ id: seg.id, start: seg.start, end: seg.end, text: seg.text, type: override.type });
    } else if (override && override.type && override.type.startsWith('texto_')) {
      const slideText = override.text || seg.text || 'Texto';
      let rendered = false;

      // Map override.type to template name
      const typeToTemplate = {
        texto_minimal: 'minimal',
        texto_impacto: 'impact',
        texto_cita: 'quote',
        texto_lista: 'list',
        texto_grafica: 'chart'
      };
      const template = typeToTemplate[override.type] || override.template || 'minimal';

      if (motionRender) {
        try {
          const tplFile = path.join(__dirname, 'templates', `slide-${template}.html`);
          if (fs.existsSync(tplFile)) {
            const replacements = motionRender.profileToReplacements(profile, override, __dirname);
            // For cita template, ensure CITA and TEXTO are set
            if (template === 'quote') {
              replacements.CITA = override.cita || slideText;
              replacements.AUTOR = override.autor || '';
            }
            if (template === 'list') {
              replacements.ITEMS = override.items || slideText;
              replacements.TITULO = override.titulo || '';
            }
            if (template === 'chart') {
              replacements.CHART_DATA = override.chartData || override.items || slideText;
              replacements.TITULO = override.titulo || '';
            }
            if (!replacements.TEXTO) replacements.TEXTO = slideText;
            if (!replacements.DATO) replacements.DATO = override.dato || slideText;
            if (!replacements.DESCRIPCION) replacements.DESCRIPCION = override.descripcion || '';

            const htmlContent = motionRender.buildSlideHTML(tplFile, replacements);
            console.log(`[export] Seg ${seg.id}: template=${template}, TEXTO="${(replacements.TEXTO || '').substring(0, 50)}", DATO="${replacements.DATO}", CITA="${(replacements.CITA || '').substring(0, 50)}", ITEMS="${(replacements.ITEMS || '').substring(0, 50)}", CHART_DATA="${(replacements.CHART_DATA || '').substring(0, 50)}", TITULO="${replacements.TITULO}", AUTOR="${replacements.AUTOR}"`);
            await motionRender.renderMotion({
              htmlContent,
              duration: clipDurations[i],
              width, height,
              fps: fpsNum,
              outputPath: clipPath
            });
            rendered = true;
            console.log(`[export] Segment ${seg.id}: motion-render (builtin/${template})`);
          }
        } catch (err) {
          console.warn(`[export] Motion render failed for seg ${seg.id}, fallback to FFmpeg:`, err.message);
        }
      }

      // Fallback to FFmpeg drawtext if motion render wasn't used or failed
      if (!rendered) {
        await createTextSlide(clipPath, clipDurations[i], width, height, fpsNum, slideText, override, profile);
      }
    } else {
      const media = findMedia(seg.id);
      if (!media) throw new Error(`Imagen/video ${seg.id} no encontrada en uploads/images/`);
      const fileExists = fs.existsSync(media.path);
      console.log(`[export] Seg ${seg.id}: usando ${path.basename(media.path)}, existe: ${fileExists}, isVideo: ${media.isVideo}`);

      if (media.isVideo) {
        await createClipFromVideo(media.path, clipPath, clipDurations[i], width, height, fpsNum);
      } else {
        // Determine zoom type for this segment
        let segZoom = 'none';
        if (motionMode === 'ken_burns') {
          segZoom = 'ken_burns';
        } else if (motionMode === 'dinamico') {
          segZoom = effectiveZoomMap[String(seg.id)] || 'ken_burns';
        }
        console.log(`[export] Seg ${seg.id}: zoom=${segZoom}, type=image, motion=${motionMode}`);
        await createClip(media.path, clipPath, clipDurations[i], width, height, fpsNum, segZoom);
      }
    }
    clips.push(clipPath);
  }

  // ── Verify actual clip durations via ffprobe ─────────────────────────────
  // FFmpeg may produce clips with slightly different durations than requested
  // due to frame quantization. Use actual durations for xfade offset calculation
  // to prevent cumulative drift.
  const actualDurations = [];
  let totalDriftAbs = 0;
  sendSSE({ type: 'progress', step: 'verify', pct: 62, message: 'Verificando duración de clips...' });
  for (let i = 0; i < clips.length; i++) {
    try {
      const actual = await getClipDuration(clips[i]);
      const expected = clipDurations[i];
      const drift = actual - expected;
      totalDriftAbs += Math.abs(drift);
      if (Math.abs(drift) > 0.05) {
        console.warn(`[export] ⚠ Clip ${i}: expected=${expected.toFixed(4)}s, actual=${actual.toFixed(4)}s, drift=${drift > 0 ? '+' : ''}${drift.toFixed(4)}s`);
      }
      actualDurations.push(actual);
    } catch (err) {
      console.warn(`[export] ffprobe failed for clip ${i}, using requested duration: ${err.message}`);
      actualDurations.push(clipDurations[i]);
    }
  }

  const totalExpected = clipDurations.reduce((a, b) => a + b, 0);
  const totalActual = actualDurations.reduce((a, b) => a + b, 0);
  const totalBaseDur = segments.reduce((a, s) => a + Math.max(0.1, s.end - s.start), 0);
  console.log(`[export] ── Duration summary ──`);
  console.log(`[export]   Segments: ${segments.length}, xfadeDur: ${xfadeDur}s, useXfade: ${useXfade}`);
  console.log(`[export]   Audio (sum of bases): ${totalBaseDur.toFixed(4)}s`);
  console.log(`[export]   Clips requested total: ${totalExpected.toFixed(4)}s`);
  console.log(`[export]   Clips actual total:    ${totalActual.toFixed(4)}s`);
  console.log(`[export]   Total abs drift across clips: ${totalDriftAbs.toFixed(4)}s`);
  if (useXfade) {
    const expectedVideoLen = totalActual - (segments.length - 1) * xfadeDur;
    console.log(`[export]   Expected video after xfade: ${expectedVideoLen.toFixed(4)}s (audio=${totalBaseDur.toFixed(4)}s, diff=${(expectedVideoLen - totalBaseDur).toFixed(4)}s)`);
  }

  // Write replacement segments file (camera + contenido_relacionado + motion_graphic)
  if (cameraSegments.length > 0) {
    const typeLabels = { camara: 'CAMARA', contenido_relacionado: 'CONTENIDO RELACIONADO', motion_graphic: 'MOTION GRAPHIC', grabacion_pantalla: 'GRABACION DE PANTALLA' };
    const replaceFile = path.join(__dirname, 'output', 'reemplazar_segments.txt');
    const lines = cameraSegments.map(s => {
      const fmt = sec => `${Math.floor(sec/60)}:${String(Math.floor(sec%60)).padStart(2,'0')}`;
      const label = typeLabels[s.type] || s.type;
      return `[${s.id}] ${fmt(s.start)} - ${fmt(s.end)} | ${label} | ${s.text}`;
    });
    fs.writeFileSync(replaceFile, lines.join('\n'), 'utf8');
    console.log(`[export] ${cameraSegments.length} replacement segments -> reemplazar_segments.txt`);
  }

  // ── Step 2: concatenate ────────────────────────────────────────────────────
  const joinedPath = path.join(tmpDir, 'joined.mp4');

  if (useXfade) {
    sendSSE({ type: 'progress', step: 'concat', pct: 65, message: 'Aplicando transiciones entre clips...' });
    // Use ACTUAL durations for offset calculation to avoid cumulative drift
    await concatenateWithXfade(clips, actualDurations, joinedPath, fpsNum, transitionList, xfadeDur);
  } else {
    sendSSE({ type: 'progress', step: 'concat', pct: 65, message: 'Concatenando clips...' });
    await concatenateClips(clips, joinedPath, tmpDir);
  }

  // Verify joined video duration
  try {
    const joinedDur = await getClipDuration(joinedPath);
    console.log(`[export]   Joined video actual: ${joinedDur.toFixed(4)}s (target=${totalBaseDur.toFixed(4)}s, diff=${(joinedDur - totalBaseDur).toFixed(4)}s)`);
    if (Math.abs(joinedDur - totalBaseDur) > 2.0) {
      console.error(`[export] ⚠⚠⚠ LARGE DRIFT DETECTED: video=${joinedDur.toFixed(2)}s vs audio=${totalBaseDur.toFixed(2)}s (${(joinedDur - totalBaseDur).toFixed(2)}s)`);
    }
  } catch (e) {
    console.warn(`[export] Could not verify joined video duration: ${e.message}`);
  }

  // ── Step 3: mix audio + SFX ────────────────────────────────────────────────
  sendSSE({ type: 'progress', step: 'audio', pct: 85, message: 'Mezclando audio...' });
  const outputPath = path.join(__dirname, 'output', 'output.mp4');

  // Build SFX timeline automatically from zoom types + transitions
  const sfxTimeline = [];
  if (sfxEnabled !== false) {
    const usedTimestamps = new Set(); // avoid duplicates at same time

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const override = overrides[String(seg.id)];
      const segZoom = (motionMode === 'dinamico')
        ? (effectiveZoomMap[String(seg.id)] || 'ken_burns')
        : (motionMode === 'ken_burns' ? 'ken_burns' : 'none');
      const segType = override?.type || '';
      const timeKey = seg.start.toFixed(2);

      // Zoom-based SFX (priority)
      let zoomSfx = null;
      if (segZoom === 'zoom_punch' || segZoom === 'zoom_in_rapido') {
        zoomSfx = SFX_FILES['wosh-2'];
      } else if (segZoom === 'zoom_dramatico') {
        zoomSfx = SFX_FILES['woshh-dramatico'];
      } else if (segZoom === 'zoom_out_rapido') {
        zoomSfx = SFX_FILES['wosh-1'];
      } else if ((segZoom === 'pan_izquierda' || segZoom === 'pan_derecha') && Math.random() < 0.3) {
        zoomSfx = SFX_FILES['wosh-1'];
      }

      // texto_impacto always gets dramatic whoosh
      if (segType === 'texto_impacto') {
        zoomSfx = SFX_FILES['woshh-dramatico'];
      }

      if (zoomSfx && fs.existsSync(zoomSfx)) {
        // Position SFX at transition START (xfade begins before the segment cut)
        const sfxOffset = (useXfade && i > 0) ? xfadeDur / 2 : 0;
        const sfxTime = Math.max(0, seg.start - sfxOffset);
        sfxTimeline.push({ file: zoomSfx, time: sfxTime });
        usedTimestamps.add(timeKey);
      }

      // Transition SFX (only if no zoom SFX at this timestamp)
      if (i > 0 && !usedTimestamps.has(timeKey) && Math.random() < 0.55) {
        const transFile = SFX_FILES['wosh-1'];
        if (fs.existsSync(transFile)) {
          // Align with transition start
          const sfxOffset = useXfade ? xfadeDur / 2 : 0.2;
          const t = Math.max(0, seg.start - sfxOffset);
          sfxTimeline.push({ file: transFile, time: t });
          usedTimestamps.add(timeKey);
        }
      }
    }
  }

  if (sfxTimeline.length > 0) {
    console.log(`[export] Mixing ${sfxTimeline.length} sound effects into audio`);
    const volDecimal = Math.max(0.1, Math.min(1.0, (sfxVolume || 40) / 100));
    console.log(`[export] SFX volume: ${(volDecimal * 100).toFixed(0)}%`);
    await mixAudioWithSFX(joinedPath, audioPath, sfxTimeline, outputPath, volDecimal);
  } else {
    await mixAudio(joinedPath, audioPath, outputPath);
  }

  // Generate Wikimedia credits file if any attributions exist
  try {
    const creditsJsonPath = path.join(__dirname, 'output', '_wikimedia_credits.json');
    if (fs.existsSync(creditsJsonPath)) {
      const credits = JSON.parse(fs.readFileSync(creditsJsonPath, 'utf-8'));
      const entries = Object.entries(credits);
      if (entries.length > 0) {
        const lines = [
          'CRÉDITOS — Imágenes/Videos de Wikimedia Commons',
          '================================================',
          ''
        ];
        for (const [segId, attr] of entries) {
          lines.push(`Segmento ${segId}:`);
          if (attr.title) lines.push(`  Título: ${attr.title}`);
          if (attr.artist) lines.push(`  Autor: ${attr.artist}`);
          if (attr.license) lines.push(`  Licencia: ${attr.license}`);
          if (attr.url) lines.push(`  Fuente: ${attr.url}`);
          lines.push('');
        }
        lines.push('Incluye estas atribuciones en la descripción de tu video.');
        fs.writeFileSync(path.join(__dirname, 'output', 'creditos.txt'), lines.join('\n'), 'utf-8');
        console.log(`[export] Generated creditos.txt with ${entries.length} Wikimedia attributions`);
      }
    }
  } catch (credErr) {
    console.error('[export] Error generating credits:', credErr.message);
  }

  sendSSE({ type: 'complete', pct: 100, message: '¡Exportación completada!' });
}

// Find image or video media for segment id. Returns {path, isVideo}.
function findMedia(id) {
  const dir = path.join(__dirname, 'uploads/images');
  // Check video first (takes priority if both exist)
  for (const ext of ['.mp4', '.MP4']) {
    const p = path.join(dir, `${id}${ext}`);
    if (fs.existsSync(p)) return { path: p, isVideo: true };
  }
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.JPG', '.JPEG', '.PNG', '.WEBP']) {
    const p = path.join(dir, `${id}${ext}`);
    if (fs.existsSync(p)) return { path: p, isVideo: false };
  }
  return null;
}

function ffmpegPath(p) {
  // Normalize to forward slashes for FFmpeg on Windows
  return path.resolve(p).replace(/\\/g, '/');
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      if (err.code === 'ENOENT') reject(new Error('FFmpeg no encontrado. Instálalo y agrégalo al PATH.'));
      else reject(err);
    });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg terminó con código ${code}:\n${stderr.slice(-800)}`));
    });
  });
}

// Get actual duration of a media file via ffprobe
function getClipDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (code === 0) resolve(parseFloat(out.trim()) || 0);
      else reject(new Error(`ffprobe failed for ${filePath}`));
    });
  });
}

async function createClip(imgPath, outPath, duration, width, height, fps, zoomType) {
  let vf;
  // Use round instead of ceil for more accurate duration; ensure at least 1 frame.
  // Then compute the exact duration from the frame count so -t and zoompan agree.
  const frames = Math.max(1, Math.round(duration * fps));
  const exactDuration = frames / fps;  // This is what the clip will actually be
  const w4 = width * 4;
  const h4 = height * 4;

  // Build zoompan formula based on zoom type
  function zpan(z, x, y) {
    return [
      `scale=${w4}:${h4}`,
      `zoompan=z='${z}':d=${frames}:x='${x}':y='${y}':s=${width}x${height}:fps=${fps}`
    ].join(',');
  }
  const cx = '(iw-iw/zoom)*0.5';
  const cy = '(ih-ih/zoom)*0.5';

  switch (zoomType) {
    case 'ken_burns':
      // Slow linear zoom 1.0→1.5
      vf = zpan(`1+0.5*on/${frames}`, cx, cy);
      break;

    case 'zoom_in_rapido': {
      // Fast zoom to 1.3x in 0.5s, hold
      const zf = Math.ceil(0.5 * fps);
      vf = zpan(`if(lt(on,${zf}),1+0.3*on/${zf},1.3)`, cx, cy);
      break;
    }
    case 'zoom_out_rapido': {
      // Start at 1.3x, zoom out to 1.0x in 0.5s
      const zf = Math.ceil(0.5 * fps);
      vf = zpan(`if(lt(on,${zf}),1.3-0.3*on/${zf},1.0)`, cx, cy);
      break;
    }
    case 'zoom_punch': {
      // Quick punch: 1.0→1.2 in 0.15s, 1.2→1.0 in 0.15s
      const pi = Math.ceil(0.15 * fps);
      const po = Math.ceil(0.3 * fps);
      vf = zpan(`if(lt(on,${pi}),1+0.2*on/${pi},if(lt(on,${po}),1.2-0.2*(on-${pi})/${pi},1.0))`, cx, cy);
      break;
    }
    case 'zoom_pulso':
      // Gentle breathing: 1.0→1.1→1.0 (sine wave)
      vf = zpan(`1+0.1*sin(on/${frames}*3.14159)`, cx, cy);
      break;

    case 'pan_izquierda':
      // Pan left: fixed zoom 1.15, x moves right→left
      vf = zpan('1.15', `(iw-iw/zoom)*on/${frames}`, cy);
      break;

    case 'pan_derecha':
      // Pan right: fixed zoom 1.15, x moves left→right
      vf = zpan('1.15', `(iw-iw/zoom)*(1-on/${frames})`, cy);
      break;

    case 'zoom_dramatico':
      // Slow dramatic zoom 1.0→1.8
      vf = zpan(`1+0.8*on/${frames}`, cx, cy);
      break;

    default:
      // 'none' — static image, no zoompan
      vf = [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        `fps=${fps}`
      ].join(',');
      break;
  }

  await runFFmpeg([
    '-loop', '1',
    '-i', ffmpegPath(imgPath),
    '-t', String(exactDuration),
    '-vf', vf,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'fast',
    '-tune', 'stillimage',
    ffmpegPath(outPath)
  ]);
}

// Creates a clip from a Pexels VIDEO file instead of a still image.
// If the source video is shorter than the target duration, it loops.
async function createClipFromVideo(videoPath, outPath, duration, width, height, fps) {
  // Snap duration to exact frame boundary
  const frames = Math.max(1, Math.round(duration * fps));
  const exactDur = frames / fps;
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${fps}`
  ].join(',');

  await runFFmpeg([
    '-stream_loop', '-1',           // loop indefinitely (trimmed by -t)
    '-i', ffmpegPath(videoPath),
    '-t', String(exactDur),
    '-vf', vf,
    '-an',                           // strip original audio from Pexels video
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'fast',
    ffmpegPath(outPath)
  ]);
}

// Creates a green placeholder clip with "EN CÁMARA" text (for segments the user will film)
async function createPlaceholderClip(outPath, duration, width, height, fps, bgColor, label) {
  // Snap duration to exact frame boundary for consistency
  const frames = Math.max(1, Math.round(duration * fps));
  const exactDur = frames / fps;
  const drawtext = `drawtext=text='${ffEscape(label)}':fontsize=${Math.round(height/10)}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:borderw=3:bordercolor=0x000000@0x40`;

  await runFFmpeg([
    '-f', 'lavfi',
    '-i', `color=c=${bgColor}:s=${width}x${height}:d=${exactDur}:r=${fps}`,
    '-vf', drawtext,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'fast',
    '-t', String(exactDur),
    ffmpegPath(outPath)
  ]);
}

// Escape special FFmpeg drawtext characters
function ffEscape(text) {
  return (text || String())
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, String.fromCharCode(39))
    .replace(/:/g, '\\:')
    .replace(/%/g, '%%')
    .substring(0, 200);
}

// Convert hex color (#rrggbb) to FFmpeg 0xRRGGBB format
function hexToFF(hex) {
  return '0x' + (hex || '#1a1a2e').replace('#', '');
}

// Creates a text slide using the active profile colors and template
async function createTextSlide(outPath, duration, width, height, fps, text, override, profile) {
  const est = profile?.estilos || {};
  const bgColor = hexToFF(est.fondo_color1 || '#1a1a2e');
  const txtColor = est.color_texto || 'white';
  const acento1 = est.color_acento1 || '#5b4cf5';
  const acento2 = est.color_acento2 || '#0da892';

  // Map override.type to template (new 8-type system)
  const typeToTpl = { texto_minimal: 'minimal', texto_impacto: 'impacto', texto_cita: 'cita', texto_lista: 'lista', texto_grafica: 'grafica' };
  const template = typeToTpl[override?.type] || override?.template || 'minimal';

  // Build drawtext filter(s) based on template
  let drawFilters = '';

  if (template === 'impacto') {
    // Large number/data + smaller description below
    const dato = ffEscape(override?.dato || text);
    const desc = ffEscape(override?.descripcion || '');
    const datoSize = Math.round(height / 5);
    const descSize = Math.round(height / 22);
    drawFilters = [
      `drawtext=text='${dato}':fontsize=${datoSize}:fontcolor=${acento1}:x=(w-text_w)/2:y=(h/2-text_h):borderw=3:bordercolor=0x000000`,
      desc ? `drawtext=text='${desc}':fontsize=${descSize}:fontcolor=${txtColor}:x=(w-text_w)/2:y=(h/2+${Math.round(datoSize*0.4)}):borderw=1:bordercolor=0x000000` : ''
    ].filter(Boolean).join(',');
  } else if (template === 'cita') {
    // Quote with attribution
    const cita = ffEscape(override?.cita || text);
    const autor = ffEscape(override?.autor || '');
    const citaSize = Math.round(height / 18);
    const autorSize = Math.round(height / 28);
    // Wrap with « »
    drawFilters = [
      `drawtext=text='\\«${cita}\\»':fontsize=${citaSize}:fontcolor=${txtColor}:x=(w-text_w)/2:y=(h/2-text_h):borderw=1:bordercolor=0x000000`,
      autor ? `drawtext=text='— ${autor}':fontsize=${autorSize}:fontcolor=${acento1}:x=(w-text_w)/2:y=(h/2+${Math.round(citaSize*0.8)}):borderw=1:bordercolor=0x000000` : ''
    ].filter(Boolean).join(',');
  } else if (template === 'lista') {
    // List items stacked vertically (up to 5)
    const items = (override?.items || text).split ? (override?.items || text).split('\n').filter(Boolean).slice(0, 5) : [text];
    const itemSize = Math.round(height / 22);
    const startY = Math.round(height * 0.2);
    drawFilters = items.map((item, idx) => {
      const safeItem = ffEscape(`• ${item.trim()}`);
      const y = startY + idx * Math.round(itemSize * 2);
      return `drawtext=text='${safeItem}':fontsize=${itemSize}:fontcolor=${txtColor}:x=(w*0.12):y=${y}:borderw=1:bordercolor=0x000000`;
    }).join(',');
  } else if (template === 'grafica') {
    // Bar chart: parse "label:value" lines, draw bars + labels
    const rawLines = (override?.chartData || override?.items || text || '').split('\n').filter(Boolean).slice(0, 5);
    const bars = rawLines.map(line => {
      const parts = line.split(':');
      return { label: (parts[0] || '').trim(), value: parseFloat(parts[1]) || 0 };
    }).filter(b => b.label);
    if (bars.length === 0) bars.push({ label: 'Dato', value: 100 });
    const maxVal = Math.max(...bars.map(b => b.value));
    const barW = Math.round(width * 0.12);
    const totalW = bars.length * barW + (bars.length - 1) * Math.round(barW * 0.5);
    const startX = Math.round((width - totalW) / 2);
    const barBottom = Math.round(height * 0.75);
    const maxBarH = Math.round(height * 0.4);
    const labelSize = Math.round(height / 30);
    const valSize = Math.round(height / 28);
    drawFilters = bars.map((b, idx) => {
      const barH = Math.round((b.value / maxVal) * maxBarH);
      const x = startX + idx * Math.round(barW * 1.5);
      const barColor = idx === 0 ? acento1 : acento2;
      const barTop = barBottom - barH;
      return [
        `drawbox=x=${x}:y=${barTop}:w=${barW}:h=${barH}:color=${hexToFF(barColor)}:t=fill`,
        `drawtext=text='${ffEscape(b.label)}':fontsize=${labelSize}:fontcolor=${txtColor}:x=${x + Math.round(barW/2)}-text_w/2:y=${barBottom + 10}:borderw=1:bordercolor=0x000000`,
        `drawtext=text='${ffEscape(String(b.value))}':fontsize=${valSize}:fontcolor=${hexToFF(barColor)}:x=${x + Math.round(barW/2)}-text_w/2:y=${barTop - valSize - 8}:borderw=1:bordercolor=0x000000`
      ].join(',');
    }).join(',');
    // Add title if present
    const title = override?.titulo || '';
    if (title) {
      drawFilters = `drawtext=text='${ffEscape(title)}':fontsize=${Math.round(height/18)}:fontcolor=${txtColor}:x=(w-text_w)/2:y=${Math.round(height*0.08)}:borderw=2:bordercolor=0x000000,` + drawFilters;
    }
  } else {
    // Minimal — centered text
    const safeText = ffEscape(text);
    const fontSize = Math.round(height / 16);
    drawFilters = `drawtext=text='${safeText}':fontsize=${fontSize}:fontcolor=${txtColor}:x=(w-text_w)/2:y=(h-text_h)/2:borderw=2:bordercolor=0x000000`;
  }

  // Snap duration to exact frame boundary
  const frames = Math.max(1, Math.round(duration * fps));
  const exactDur = frames / fps;

  await runFFmpeg([
    '-f', 'lavfi',
    '-i', `color=c=${bgColor}:s=${width}x${height}:d=${exactDur}:r=${fps}`,
    '-vf', drawFilters,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'fast',
    '-t', String(exactDur),
    ffmpegPath(outPath)
  ]);
}

async function concatenateClips(clips, outPath, tmpDir) {
  const listFile = path.join(tmpDir, 'filelist.txt');
  const content = clips.map(c => `file '${ffmpegPath(c)}'`).join('\n');
  fs.writeFileSync(listFile, content);

  await runFFmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', ffmpegPath(listFile),
    '-c', 'copy',
    ffmpegPath(outPath)
  ]);
}

// Chains all clips with xfade transitions (per-pair transition names).
// Receives ACTUAL clip durations (from ffprobe) which already include xfadeDur
// compensation for non-last clips. Uses running output-duration tracking to
// compute each xfade offset precisely, preventing cumulative drift.
async function concatenateWithXfade(clips, durations, outPath, fps, transitionList, xfadeDur) {
  const inputs = clips.flatMap(c => ['-i', ffmpegPath(c)]);

  // Build filter_complex chaining xfade between each consecutive pair.
  // Track the RUNNING output duration after each xfade to compute the next offset.
  // offset_i = runningOutputDuration - xfadeDur
  // (transition starts xfadeDur before the end of the current intermediate output)
  const filterParts = [];
  let runningOutputDuration = durations[0]; // after first clip, output = clip[0] duration
  let prevLabel = '[0:v]';

  for (let i = 0; i < clips.length - 1; i++) {
    // The offset is where in the current intermediate output the transition begins.
    // It must be xfadeDur before the end of the intermediate output.
    const offset = Math.max(0, runningOutputDuration - xfadeDur);
    const trans = transitionList[i] || 'fade';
    const outLabel = i === clips.length - 2 ? '[vout]' : `[x${i}]`;
    filterParts.push(
      `${prevLabel}[${i + 1}:v]xfade=transition=${trans}:duration=${xfadeDur}:offset=${offset.toFixed(4)}${outLabel}`
    );
    // After this xfade, the new output duration = offset + xfadeDur + next_clip - xfadeDur
    // = offset + durations[i+1]
    // Equivalently: runningOutputDuration + durations[i+1] - xfadeDur
    if (i + 1 < clips.length) {
      runningOutputDuration = runningOutputDuration + durations[i + 1] - xfadeDur;
    }
    prevLabel = outLabel;

    if (i < 5 || i >= clips.length - 3) {
      console.log(`[xfade] pair ${i}: offset=${offset.toFixed(4)}, trans=${trans}, runningDur=${runningOutputDuration.toFixed(4)}`);
    }
  }
  console.log(`[xfade] Final expected output duration: ${runningOutputDuration.toFixed(4)}s`);

  await runFFmpeg([
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'fast',
    '-r', String(fps),
    ffmpegPath(outPath)
  ]);
}

async function mixAudio(videoPath, audioPath, outPath) {
  await runFFmpeg([
    '-i', ffmpegPath(videoPath),
    '-i', ffmpegPath(audioPath),
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    ffmpegPath(outPath)
  ]);
}

async function mixAudioWithSFX(videoPath, audioPath, sfxTimeline, outPath, volDecimal) {
  const vol = volDecimal || 0.4;
  // Build FFmpeg command: video + main audio + each SFX file as input
  // Then use adelay to position each SFX at the right timestamp, amix to combine
  const inputs = ['-i', ffmpegPath(videoPath), '-i', ffmpegPath(audioPath)];
  const filterParts = [];
  const sfxLabels = [];

  for (let i = 0; i < sfxTimeline.length; i++) {
    const sfx = sfxTimeline[i];
    const inputIdx = i + 2; // 0=video, 1=audio, 2+=sfx files
    inputs.push('-i', ffmpegPath(sfx.file));
    const delayMs = Math.round(sfx.time * 1000);
    // Apply volume reduction + delay positioning
    filterParts.push(`[${inputIdx}]volume=${vol},adelay=${delayMs}|${delayMs}[sfx${i}]`);
    sfxLabels.push(`[sfx${i}]`);
  }

  // Mix main audio with all SFX streams
  const mixInputs = `[1]${sfxLabels.join('')}`;
  const totalStreams = 1 + sfxTimeline.length;
  filterParts.push(`${mixInputs}amix=inputs=${totalStreams}:duration=first:dropout_transition=0:normalize=0[aout]`);

  const filterComplex = filterParts.join(';');

  await runFFmpeg([
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    ffmpegPath(outPath)
  ]);
}

// ── Smart Segment (Dynamic AI Segmentation) ─────────────────────────────────
app.post('/api/smart-segment', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const { segments, audioDuration, analysisProvider, analysisModel, formatoCamara, tipoContenido } = req.body;
    if (!segments || !segments.length) return res.status(400).json({ error: 'No hay segmentos' });

    const totalDur = audioDuration || segments[segments.length - 1].end || 0;
    const fc = formatoCamara || 'con_camara';

    // Build format-specific rules for segmentation
    const smartPermitidos = TIPOS_PERMITIDOS[fc] || TIPOS_PERMITIDOS.con_camara;
    let smartFormatRules = '';
    if (fc === 'faceless' || fc === 'faceless_pro' || fc === 'faceless_pro_avatar') {
      smartFormatRules = `
=== REGLA ABSOLUTA — LEER ANTES QUE NADA ===
Este video es ${fc === 'faceless' ? 'FACELESS BASICO' : fc === 'faceless_pro_avatar' ? 'FACELESS PRO + PERSONAJE (avatar IA)' : 'FACELESS PRO'}. NO hay presentador${fc === 'faceless_pro_avatar' ? ' real, pero hay un AVATAR/PERSONAJE generado con IA' : ''}.
NINGUN segmento debe durar mas de 8 segundos. SIN EXCEPCIONES.
Si un fragmento de audio dura mas de 8 segundos, DIVIDELO en multiples segmentos de 3-7 segundos cada uno.
El ritmo visual rapido es OBLIGATORIO en formato faceless.
- 0% bloques LONG: PROHIBIDO en faceless. NUNCA crear bloques de 9s o mas.
- Si el contenido requiere duracion larga, dividir en 2-3 bloques consecutivos.
TIPOS PERMITIDOS: ${smartPermitidos.join(', ')}
NO recomendar tipos que no esten en esta lista.
` + (fc === 'faceless_pro' || fc === 'faceless_pro_avatar' ? `
DISTRIBUCION DE DURACION OBLIGATORIA PARA ${fc === 'faceless_pro_avatar' ? 'FACELESS PRO + PERSONAJE' : 'FACELESS PRO'}:

Debes generar aproximadamente:
- 40-50% bloques SHORT (0-5 segundos): frases cortas, datos puntuales, transiciones, momentos de impacto. Estos seran imagen_ia o texto_impacto.
- 40-50% bloques MEDIUM (5-8 segundos): ideas completas, explicaciones. Estos seran video_stock, motion_graphic, texto_cita, texto_lista, texto_grafica.
- 0% bloques LONG: PROHIBIDO en faceless.

Un video faceless pro NECESITA muchos cambios visuales rapidos. Si todo es MEDIUM (5-8s), el video se siente lento y monotono.

EJEMPLO de buen ritmo:
SHORT - MEDIUM - SHORT - SHORT - MEDIUM - SHORT - MEDIUM

EJEMPLO de mal ritmo (NO hagas esto):
MEDIUM - MEDIUM - MEDIUM - MEDIUM - MEDIUM - MEDIUM

NO AGRUPAR FRASES CORTAS INNECESARIAMENTE:
Si un segmento de Whisper dura 1-4 segundos y tiene sentido por si solo (es una oracion completa), dejalo como bloque SHORT individual. NO lo agrapes con otros.

Ejemplos de frases que DEBEN ser SHORT individuales:
- "Me voy a morir." (2s) → SHORT solo
- "No todavia." (1s) → SHORT solo
- "De hecho, puede ser lo contrario." (3s) → SHORT solo
- "Es puro miedo." (2s) → SHORT solo
- "No estas roto, estas despierto." (3s) → SHORT solo

Estas frases tienen impacto visual por si solas y NO deben perderse dentro de un bloque medium.
Cuando una frase dura 3-4 segundos, dejala como SHORT. Las frases cortas son PODEROSAS solas.
` : `
DISTRIBUCION PARA FACELESS BASICO:
- ~50% bloques SHORT (0-5s)
- ~50% bloques MEDIUM (5-8s)
- 0% bloques LONG
Alterna SHORT y MEDIUM. Si un segmento corto tiene sentido solo, dejalo como SHORT individual.
`) + `=== FIN REGLA ABSOLUTA ===
`;
    }

    const systemPrompt = `Eres un editor de video profesional. Tu tarea es agrupar segmentos de audio transcritos en bloques visuales logicos para un video.
${smartFormatRules}
REGLAS:
- Cada bloque agrupa 1 a 8 segmentos consecutivos del audio original.
- Asigna una duracion_tipo a cada bloque:
  * "short" (0-5 segundos, 1-2 segmentos): datos puntuales, transiciones, frases sueltas → para imagen_ia (max 6s), texto_impacto (max 7s)
  * "medium" (5-8 segundos, 3-4 segmentos): ideas completas, explicaciones breves → para video_stock (max 8s), motion_graphic (max 6s), texto_minimal (max 6s), texto_cita (max 6s), texto_lista (max 8s), texto_grafica (max 8s)
  * "long" (9+ segundos, 5-8 segmentos): escenas narrativas, descripciones extensas → SOLO para camara, grabacion_pantalla, contenido_relacionado, avatar (sin limite)
  - avatar: el personaje/avatar conecta con el espectador, puede durar hasta 10-12 segundos
- Los tiempos start/end de cada bloque DEBEN coincidir exactamente con los tiempos de los segmentos originales que agrupas (start del primer segmento, end del ultimo).
- El texto de cada bloque es la concatenacion de los textos de sus segmentos.
- NO dejes huecos ni superposiciones entre bloques.
- Varia los tipos para crear ritmo visual: no pongas mas de 3 "medium" seguidos, alterna.
- El audio total dura ${totalDur.toFixed(1)} segundos.

=== REGLAS DE CORTE OBLIGATORIAS ===

1. SIEMPRE cortar en pausas naturales del habla: puntos (.), signos de interrogacion (?), signos de exclamacion (!), o pausas largas entre oraciones.
2. NUNCA cortar a mitad de una oracion. Si una oracion dura 7 segundos pero el limite es 4-8s, dejarla completa en un solo segmento.
3. NUNCA dejar un segmento que empiece con minuscula o con una continuacion como "y", "pero", "porque", "que", "sin embargo", "ademas", "entonces", "o sea", "o", "e", "ni", "sino", "aunque", "pues". Eso significa que cortaste mal.
   En español, frases que empiezan con "Y", "Pero", "Porque", "O sea", "O", "Entonces", "Sin embargo", "Ademas" son CONTINUACIONES de la frase anterior. NO las separes en un bloque diferente. Incluyelas en el mismo bloque que la frase anterior.
4. Cada segmento debe tener SENTIDO COMPLETO por si solo, como si fuera un subtitulo independiente que cualquiera puede leer y entender.
5. Es PREFERIBLE un segmento de 9 segundos con una oracion completa que dos segmentos de 4 segundos cortados a la mitad.
6. Los limites de duracion son FLEXIBLES: pueden excederse hasta 1 segundo si eso evita cortar una oracion a la mitad.

=== REGLAS OBLIGATORIAS DE DURACION ===

Limites por tipo:
- imagen_ia: maximo 7 segundos (flexible hasta 8s si la oracion lo requiere)
- motion_graphic: maximo 6 segundos (flexible hasta 7s)
- texto_minimal: maximo 6 segundos (flexible hasta 7s)
- texto_cita: maximo 6 segundos (flexible hasta 7s)
- texto_impacto: maximo 7 segundos (flexible hasta 8s)
- video_stock: maximo 8 segundos (flexible hasta 9s)
- texto_lista: maximo 8 segundos (flexible hasta 9s)
- texto_grafica: maximo 8 segundos (flexible hasta 9s)
- camara, grabacion_pantalla, contenido_relacionado: sin limite

Si un bloque dura mas de 8 segundos, SOLO puede ser camara, grabacion_pantalla o contenido_relacionado.
Si un bloque dura mas de 7 segundos, NO puede ser texto_impacto.
Si un bloque dura mas de 7 segundos, NO puede ser imagen_ia, motion_graphic, texto_minimal ni texto_cita.
El ritmo visual rapido es CLAVE para retencion.
RECUERDA: la coherencia del texto es MAS IMPORTANTE que los limites exactos de duracion. Nunca sacrifiques el sentido de una oracion por ajustarte a un limite de tiempo.

Responde UNICAMENTE con JSON valido en este formato:
{"bloques":[{"id":1,"start":0.0,"end":5.2,"text":"texto concatenado...","duracion_tipo":"short","segmentos_originales":[1,2]},{"id":2,...}]}`;

    console.log(`[smart-segment] Formato camara: ${fc}`);

    const prov = analysisProvider || DEFAULT_ANALYSIS_PROVIDER;
    const mdl  = analysisModel    || DEFAULT_ANALYSIS_MODEL;
    console.log(`[smart-segment] Using ${prov}/${mdl} for ${segments.length} segments`);

    // ── DIAGNÓSTICO: System prompt de segmentación ──
    console.log('========== SYSTEM PROMPT SEGMENTACIÓN ==========');
    console.log(systemPrompt);
    console.log('========== FIN SYSTEM PROMPT SEGMENTACIÓN ==========');

    // ── Process segments in batches of 50 for reliable AI output ──
    const SEG_BATCH_SIZE = 50;
    const segBatches = [];
    for (let i = 0; i < segments.length; i += SEG_BATCH_SIZE) {
      segBatches.push(segments.slice(i, i + SEG_BATCH_SIZE));
    }

    console.log(`[smart-segment] ${segments.length} segmentos → ${segBatches.length} lotes de ≤${SEG_BATCH_SIZE}`);

    const allBloques = [];
    let totalInputTokens = 0, totalOutputTokens = 0;

    for (let bIdx = 0; bIdx < segBatches.length; bIdx++) {
      const batch = segBatches[bIdx];
      const batchList = batch.map(s => `[${s.id}] (${s.start.toFixed(1)}s-${s.end.toFixed(1)}s) ${s.text}`).join('\n');
      const batchStart = batch[0].start.toFixed(1);
      const batchEnd   = batch[batch.length - 1].end.toFixed(1);
      const userMsg = `Agrupa estos ${batch.length} segmentos de audio (${batchStart}s a ${batchEnd}s) en bloques visuales:\n\n${batchList}`;

      if (bIdx === 0) {
        console.log('========== USER PROMPT SEGMENTACIÓN (LOTE 1) ==========');
        console.log(userMsg);
        console.log('========== FIN USER PROMPT SEGMENTACIÓN ==========');
      }

      console.log(`[smart-segment] Lote ${bIdx + 1}/${segBatches.length}: ${batch.length} segmentos (${batchStart}s-${batchEnd}s)`);

      const result = await callAnalysisModel({
        systemPrompt,
        userMessage: userMsg,
        provider: prov,
        model: mdl
      });

      const raw = result.text;
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd <= jsonStart) {
        console.error(`[smart-segment] Lote ${bIdx + 1} no devolvió JSON válido — saltando`);
        // Fallback: use raw segments as individual blocks
        batch.forEach(s => {
          allBloques.push({ start: s.start, end: s.end, text: s.text, duracion_tipo: 'medium', segmentos_originales: [s.id] });
        });
        continue;
      }

      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      const batchBloques = parsed.bloques || [];
      console.log(`[smart-segment] Lote ${bIdx + 1}: ${batchBloques.length} bloques generados`);
      allBloques.push(...batchBloques);

      const usage = result.usage || {};
      totalInputTokens  += usage.input_tokens || 0;
      totalOutputTokens += usage.output_tokens || 0;

      // Delay between batches
      if (bIdx < segBatches.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const bloques = allBloques;
    if (!bloques.length) throw new Error('No se generaron bloques');

    // Convert bloques to segment format — recalculate duracion_tipo from ACTUAL duration
    const smartSegments = bloques.map((b, i) => {
      const dur = b.end - b.start;
      let durTipo;
      if (dur <= 4) durTipo = 'short';
      else if (dur <= 8) durTipo = 'medium';
      else durTipo = 'long';
      return {
        id: i + 1,
        start: parseFloat(b.start.toFixed(3)),
        end: parseFloat(b.end.toFixed(3)),
        text: b.text.trim(),
        duracion_tipo: durTipo,
        segmentos_originales: b.segmentos_originales || []
      };
    });

    // Cost varies by model — approximate
    const costPerInputM  = prov === 'openai' ? 0.15 : 0.25;
    const costPerOutputM = prov === 'openai' ? 0.60 : 1.25;
    const costEstimate = ((totalInputTokens * costPerInputM / 1e6) + (totalOutputTokens * costPerOutputM / 1e6)).toFixed(4);

    console.log(`[smart-segment] ${segments.length} raw -> ${smartSegments.length} smart blocks (${prov}/${mdl}, cost ~$${costEstimate})`);

    // ── Post-segmentation quality check: detect bad cuts ─────────────────
    const malCortes = [];
    const conjunciones = ['y ', 'pero ', 'porque ', 'que ', 'sin ', 'ni ', 'o ', 'e ', 'sino ', 'aunque ', 'pues ', 'entonces ', 'ademas ', 'además ', 'sin embargo ', 'también ', 'tambien ', 'pequeñito', 'pequeño', 'grande'];
    smartSegments.forEach((seg, i) => {
      const texto = (seg.text || '').trim();
      if (!texto) return;
      const firstChar = texto[0];
      const reasons = [];
      // Check starts with lowercase (excluding ¿ ¡ and numbers)
      if (firstChar === firstChar.toLowerCase() && firstChar !== firstChar.toUpperCase() && !/[¿¡0-9"'«]/.test(firstChar)) {
        reasons.push('empieza con minúscula');
      }
      // Check starts with conjunction
      const textoLower = texto.toLowerCase();
      const conj = conjunciones.find(c => textoLower.startsWith(c));
      if (conj) {
        reasons.push(`empieza con conjunción "${conj.trim()}"`);
      }
      if (reasons.length > 0) {
        malCortes.push({ id: seg.id, reasons, preview: texto.substring(0, 50) });
        console.warn(`⚠ [smart-segment] Seg ${seg.id} posible mal corte (${reasons.join(', ')}): "${texto.substring(0, 50)}..."`);
      }
    });
    if (malCortes.length > 0) {
      console.warn(`[smart-segment] ${malCortes.length}/${smartSegments.length} segmentos con posibles malos cortes`);
    } else {
      console.log(`[smart-segment] ✅ Calidad de corte OK — todos los segmentos inician correctamente`);
    }

    // ── Faceless safety net: subdivide any block > 8s ────────────────────
    let finalSegments = smartSegments;
    if (fc === 'faceless' || fc === 'faceless_pro' || fc === 'faceless_pro_avatar') {
      const MAX_FACELESS = 8;
      const subdivided = [];
      smartSegments.forEach(seg => {
        const dur = seg.end - seg.start;
        if (dur <= MAX_FACELESS) {
          subdivided.push(seg);
          return;
        }
        const partes = Math.ceil(dur / MAX_FACELESS);
        const durParte = dur / partes;
        const fullText = (seg.text || '').trim();
        const sentences = fullText.split(/(?<=[.!?])\s+/).filter(Boolean);
        let textChunks;
        if (sentences.length >= partes) {
          textChunks = [];
          const sentPerPart = Math.ceil(sentences.length / partes);
          for (let ci = 0; ci < partes; ci++) {
            textChunks.push(sentences.slice(ci * sentPerPart, (ci + 1) * sentPerPart).join(' ') || fullText);
          }
          while (textChunks.length > partes) { textChunks[textChunks.length - 2] += ' ' + textChunks.pop(); }
        } else {
          const words = fullText.split(/\s+/).filter(Boolean);
          const wordsPerPart = Math.ceil(words.length / partes);
          textChunks = [];
          for (let ci = 0; ci < partes; ci++) {
            textChunks.push(words.slice(ci * wordsPerPart, (ci + 1) * wordsPerPart).join(' ') || fullText);
          }
        }
        console.log(`[smart-segment] Subdividiendo bloque ${seg.id} (${dur.toFixed(1)}s) en ${partes} partes de ${durParte.toFixed(1)}s (faceless max ${MAX_FACELESS}s, ${sentences.length} oraciones)`);
        for (let i = 0; i < partes; i++) {
          const subStart = parseFloat((seg.start + i * durParte).toFixed(3));
          const subEnd   = parseFloat((seg.start + (i + 1) * durParte).toFixed(3));
          const subDur   = subEnd - subStart;
          subdivided.push({
            ...seg,
            id: 0,
            start: subStart,
            end: subEnd,
            text: textChunks[i] || fullText,
            duracion_tipo: subDur <= 4 ? 'short' : subDur <= 8 ? 'medium' : 'long',
            subdivided: true,
            originalId: seg.id
          });
        }
      });
      subdivided.forEach((s, i) => { s.id = i + 1; });
      if (subdivided.length !== smartSegments.length) {
        console.log(`[smart-segment] Faceless subdivision: ${smartSegments.length} → ${subdivided.length} segments`);
      }
      finalSegments = subdivided;
    }

    // ── DIAGNÓSTICO PASO 1b: Segmentación Inteligente ──────────────────────
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║      DIAGNÓSTICO PASO 1b — SEGMENTACIÓN INTELIGENTE     ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('Formato cámara:', fc);
    console.log('Tipo contenido:', tipoContenido || 'auto');
    console.log('Provider/Model:', prov + '/' + mdl);
    console.log('Segmentos entrada (Whisper agrupados):', segments.length);
    console.log('Segmentos IA (smart blocks):', smartSegments.length);
    console.log('Segmentos finales (post-subdivisión):', finalSegments.length);
    console.log('Segmentos agregados por subdivisión faceless:', finalSegments.length - smartSegments.length);
    console.log('--- Detalle de segmentos finales ---');
    finalSegments.forEach(s => {
      const dur = (s.end - s.start).toFixed(1);
      const sub = s.subdivided ? ' [SUBDIV]' : '';
      console.log(`  Seg ${s.id}: ${s.start.toFixed(1)}s-${s.end.toFixed(1)}s = ${dur}s (${s.duracion_tipo})${sub}`);
    });
    const smDuraciones = finalSegments.map(s => s.end - s.start);
    console.log('--- Estadísticas segmentos finales ---');
    console.log('  Duración mín:', Math.min(...smDuraciones).toFixed(1) + 's');
    console.log('  Duración máx:', Math.max(...smDuraciones).toFixed(1) + 's');
    console.log('  Duración promedio:', (smDuraciones.reduce((a, b) => a + b, 0) / smDuraciones.length).toFixed(1) + 's');
    console.log('  Segmentos > 8s:', smDuraciones.filter(d => d > 8).length);
    console.log('  Segmentos > 10s:', smDuraciones.filter(d => d > 10).length);
    const tipoCount = {};
    finalSegments.forEach(s => { tipoCount[s.duracion_tipo] = (tipoCount[s.duracion_tipo] || 0) + 1; });
    console.log('  Distribución duracion_tipo:', JSON.stringify(tipoCount));
    console.log('══════════════════════════════════════════════════════════\n');

    res.json({
      segments: finalSegments,
      originalCount: segments.length,
      smartCount: finalSegments.length,
      cost: costEstimate
    });
  } catch (err) {
    console.error('[smart-segment]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Download ──────────────────────────────────────────────────────────────────
app.get('/api/download', (req, res) => {
  const p = path.join(__dirname, 'output', 'output.mp4');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.download(p, 'VideoAuto_output.mp4');
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n🎬 VideoAuto Studio corriendo en http://localhost:${PORT}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`⚠️  Puerto ${PORT} ocupado. Liberando...`);
    try {
      require('child_process').execSync(
        process.platform === 'win32'
          ? `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${PORT} ^| findstr LISTENING') do taskkill /PID %a /F`
          : `lsof -ti:${PORT} | xargs kill -9`,
        { stdio: 'ignore' }
      );
    } catch (_) {}
    setTimeout(() => {
      app.listen(PORT, () => {
        console.log(`\n🎬 VideoAuto Studio corriendo en http://localhost:${PORT}\n`);
      });
    }, 1000);
  } else {
    console.error('Error al iniciar servidor:', err);
  }
});

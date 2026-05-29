# VideoAuto Studio — Documentación Técnica

> Documento de referencia para realizar cambios al sistema en el futuro.

---

## Arquitectura general

```
Browser (index.html)
    │
    │ HTTP / SSE
    ▼
Express (server.js, puerto 3000)
    ├── OpenAI API  ← Whisper transcription
    ├── Anthropic API  ← Claude prompt generation
    └── FFmpeg (spawn)  ← Video rendering
```

El backend es **stateless entre requests** excepto por dos variables globales:
- `sseClients[]` — lista de conexiones SSE activas
- No se guarda estado de sesión en memoria (el frontend es la fuente de verdad)

---

## Archivos del proyecto

| Archivo | Rol |
|---------|-----|
| `server.js` | Todo el backend: rutas, FFmpeg, APIs |
| `public/index.html` | Frontend completo (HTML + CSS + JS en un solo archivo) |
| `package.json` | Dependencias npm |
| `.env` | API keys (no versionar) |
| `uploads/audio/` | Audios subidos (temporal) |
| `uploads/images/` | Imágenes numeradas del usuario |
| `output/` | Video exportado + carpetas temporales de clips |

---

## Backend — server.js

### Constantes editables (top of file)

```js
const CLAUDE_MODEL = 'claude-sonnet-4-6';       // Cambiar versión de Claude aquí
const WHISPER_MODEL = 'gpt-4o-transcribe';       // Cambiar modelo de Whisper aquí
```

### Rutas API

#### `GET /api/keys`
Devuelve las keys actuales enmascaradas (`***xxxx`).

**Response:**
```json
{ "openai": "***4abc", "anthropic": "***5xyz" }
```

---

#### `POST /api/save-keys`
Guarda keys en memoria (`process.env`) y en el archivo `.env`.

**Body:**
```json
{ "openai_key": "sk-...", "anthropic_key": "sk-ant-..." }
```

**Lógica:** usa regex para hacer upsert de cada línea en `.env` (no borra otras variables).

---

#### `POST /api/transcribe`
Recibe un audio, lo transcribe con Whisper y agrupa los segmentos.

**Form-data:**
- `audio` — archivo (MP3, WAV, M4A)
- `language` — `"es"` | `"en"`
- `segmentsPerImage` — `"1"` | `"2"` | `"3"` | `"5"`

**Response:**
```json
{
  "segments": [
    { "id": 1, "start": 0.0, "end": 8.5, "text": "Texto del segmento..." }
  ],
  "audioPath": "uploads/audio/audio_1234567890.mp3",
  "duration": 120.3,
  "totalSegments": 12
}
```

**Para cambiar el modelo de transcripción:**
Editar `WHISPER_MODEL` en la parte superior de `server.js`.

**Para agregar más idiomas:**
1. Agregar `<option>` en el `<select id="sel-lang">` del HTML
2. El valor del option es el código ISO 639-1 (e.g., `"fr"` para francés)
3. No requiere cambios en el backend

---

#### `POST /api/generate-prompts`
Envía los segmentos a Claude y devuelve prompts de imagen.

**Body:**
```json
{
  "segments": [...],
  "systemPrompt": "You are an expert...",
  "style": "fotorrealista"
}
```

**Lógica:**
1. Reemplaza `{style}` en el systemPrompt con el estilo elegido
2. Construye el user message: `[1] texto\n[2] texto\n...`
3. Llama a `anthropic.messages.create()`
4. Extrae el JSON de la respuesta con regex `/\{[\s\S]*\}/`

**Response esperado de Claude** (el modelo debe devolver esto):
```json
{ "prompts": [{ "id": 1, "prompt": "A person standing..." }] }
```

**Para cambiar el modelo de Claude:**
Editar `CLAUDE_MODEL` en la parte superior de `server.js`.

**Para aumentar max_tokens:**
Buscar `max_tokens: 4096` en la ruta `/api/generate-prompts`.

---

#### `POST /api/upload-images`
Recibe imágenes y las guarda en `uploads/images/` con su nombre original.

**Importante:** el nombre del archivo determina a qué segmento pertenece.
`1.jpg` → segmento 1, `2.png` → segmento 2, etc.

---

#### `GET /api/images`
Lista los archivos en `uploads/images/` con extensiones `.jpg/.jpeg/.png/.webp`.

---

#### `DELETE /api/images/clear`
Elimina todos los archivos de `uploads/images/`.

---

#### `GET /api/export/progress`
Endpoint SSE (Server-Sent Events). El cliente abre esta conexión antes de iniciar el export.

**Eventos emitidos:**
```json
{ "type": "progress", "step": "clip", "current": 3, "total": 10, "pct": 30 }
{ "type": "progress", "step": "concat", "pct": 65, "message": "Concatenando..." }
{ "type": "progress", "step": "audio",  "pct": 85, "message": "Mezclando audio..." }
{ "type": "complete", "pct": 100, "message": "¡Completado!" }
{ "type": "error",    "message": "Descripción del error" }
```

---

#### `POST /api/export`
Inicia la exportación de forma asíncrona. Responde inmediatamente con `{ started: true }` y procesa en background.

**Body:**
```json
{
  "segments":   [{ "id": 1, "start": 0.0, "end": 8.5, "text": "..." }],
  "resolution": "1920x1080",
  "fps":        "24",
  "effect":     "none",
  "audioPath":  "uploads/audio/audio_123.mp3"
}
```

**Flujo interno (`runExport`):**
1. Por cada segmento → `createClip()` → clip MP4 individual
2. `concatenateClips()` → un solo MP4 sin audio usando concat demuxer
3. `mixAudio()` → mezcla video + audio original → `output/output.mp4`

---

#### `GET /api/download`
Descarga `output/output.mp4` como `VideoAuto_output.mp4`.

---

## FFmpeg — Pipeline de renderizado

### Función `createClip(imgPath, outPath, duration, width, height, fps, effect)`

**Sin efecto:**
```bash
ffmpeg -y \
  -loop 1 -i imagen.jpg \
  -t <duration> \
  -vf "scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2:color=black,fps=FPS" \
  -c:v libx264 -pix_fmt yuv420p -preset fast -tune stillimage \
  clip_0000.mp4
```

**Con Ken Burns:**
```bash
ffmpeg -y \
  -loop 1 -i imagen.jpg \
  -t <duration> \
  -vf "scale=W*2:H*2:force_original_aspect_ratio=increase,
       crop=W*2:H*2,
       zoompan=z='min(zoom+0.0012,1.4)':d=FRAMES:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=WxH,
       fps=FPS" \
  -c:v libx264 -pix_fmt yuv420p -preset fast \
  clip_0000.mp4
```

**Nota de rendimiento:** `zoompan` procesa frame a frame en CPU. Para videos largos (>50 segmentos), el efecto Ken Burns puede tardar varios minutos. Sin efecto es mucho más rápido.

### Función `concatenateClips()`
Genera un `filelist.txt` y usa el concat demuxer:
```bash
ffmpeg -y -f concat -safe 0 -i filelist.txt -c copy concatenated.mp4
```

### Función `mixAudio()`
```bash
ffmpeg -y -i video.mp4 -i audio.mp3 -c:v copy -c:a aac -b:a 192k -shortest output.mp4
```
`-shortest` corta el video al más corto entre video y audio.

---

## Frontend — index.html

### Estado de la aplicación (`state` object)

```js
const state = {
  currentStep: 1,
  audioFile: null,       // path del archivo en el servidor
  segments: [],          // [{id, start, end, text}] — fuente de verdad
  prompts: [],           // [{id, prompt}]
  selectedStyle: 'fotorrealista',
  exportOptions: { resolution: '1920x1080', fps: '24', effect: 'none' }
};
```

### Persistencia en localStorage
- `vas_system_prompt` — contenido del textarea de instrucciones

### Flujo SSE (export)
```
Frontend                          Backend
   │                                 │
   ├─ new EventSource('/api/export/progress') ──►│ sseClients.push(res)
   │                                 │
   ├─ POST /api/export ─────────────►│ res.json({started:true})
   │                                 │ runExport() ← async, no await
   │                                 │
   │◄── data: {type:"progress"} ─────┤ sendSSE() durante FFmpeg
   │◄── data: {type:"complete"} ─────┤ al terminar
   │                                 │
   └─ eventSource.close()            │
```

### Añadir un nuevo paso (wizard)
1. Agregar tab en `#wizard-nav`: `<div class="step-tab"><button class="step-btn" onclick="goToStep(5)">...`
2. Agregar panel: `<div class="step-panel" id="panel-5">...`
3. La función `goToStep(n)` ya maneja la lógica de activación/desactivación

### Añadir un nuevo estilo visual
En el HTML, agregar un botón dentro de `#style-picker`:
```html
<button class="style-btn" data-style="nombre del estilo">Nombre visible</button>
```
No requiere cambios en el backend.

### Añadir una nueva resolución
En `#res-group`, agregar:
```html
<button class="pill" data-val="3840x2160">4K</button>
```
El valor se pasa directamente a FFmpeg.

---

## Dependencias npm

| Paquete | Versión | Uso |
|---------|---------|-----|
| `express` | ^4.19 | Servidor HTTP |
| `multer` | ^1.4.5-lts.1 | Upload de archivos |
| `openai` | ^4.52 | Whisper API |
| `@anthropic-ai/sdk` | ^0.32 | Claude API |
| `dotenv` | ^16.4 | Variables de entorno |
| `nodemon` | ^3.1 (dev) | Recarga automática |

---

## Variables de entorno (.env)

| Variable | Descripción |
|----------|-------------|
| `OPENAI_API_KEY` | Key de OpenAI para Whisper |
| `ANTHROPIC_API_KEY` | Key de Anthropic para Claude |

El servidor crea `.env` automáticamente si no existe. Las keys también se pueden guardar desde la UI (botón "⚙ Configurar API Keys"), que hace un POST a `/api/save-keys`.

---

## Cambios comunes

### Cambiar el modelo de Claude
```js
// server.js, línea 8
const CLAUDE_MODEL = 'claude-opus-4-7';  // o cualquier otro
```

### Cambiar el modelo de Whisper
```js
// server.js, línea 9
const WHISPER_MODEL = 'whisper-1';
```

### Cambiar el puerto
```js
// server.js
const PORT = 4000;  // era 3000
```

### Añadir fade entre clips
En `concatenateClips()`, cambiar `-c copy` por un filtro xfade:
```js
// Requiere recodificar los clips, no se puede usar -c copy con xfade
// Usar -filter_complex "xfade=transition=fade:duration=0.5:offset=N"
```
Esta es una extensión no trivial que requiere calcular los offsets de cada clip.

### Soporte para texto/subtítulos (SRT)
Añadir un paso entre Paso 2 y Paso 3 que genere un archivo `.srt` a partir de los segmentos, y usar `ffmpeg -vf subtitles=output.srt` en el paso de mezcla.

### Cambiar calidad de exportación
En `createClip()`, modificar `-preset fast` por:
- `ultrafast` — más rápido, mayor tamaño
- `medium` — balance
- `slow` — mejor compresión, más tiempo

---

## Limitaciones conocidas

- **Un usuario a la vez:** Las variables globales `sseClients` y la carpeta `uploads/images/` son compartidas. No está diseñado para uso multi-usuario simultáneo.
- **Ken Burns es lento:** `zoompan` es un filtro CPU-intensivo. Para videos largos, considerar omitirlo o usar hardware encoding (`-c:v h264_nvenc`).
- **Sin limpieza automática:** Los archivos temporales en `output/tmp_*` no se eliminan automáticamente. Se pueden borrar manualmente.
- **Audio path hardcoded en export:** El path del audio viene del resultado de transcripción guardado en el estado del frontend. Si reinicias el servidor entre pasos, el path puede ser inválido.

# VideoAuto Studio — Contexto del Proyecto (v4)

## Qué es
App web local (Node.js + Express) para crear videos automatizados.
Flujo: Audio → Transcripción Whisper → Segmentación con Sonnet → Prompts con Haiku → Imágenes/Videos de stock + slides de texto → Exportar MP4 con FFmpeg + HyperFrames.

## Stack
- Backend: Node.js + Express + child_process.spawn (FFmpeg nativo)
- Frontend: HTML/CSS/JS vanilla, una sola página
- Multer para uploads, dotenv para API keys
- SSE para progreso de exportación en tiempo real
- localStorage para sesión persistente
- Puppeteer + GSAP para renderizar slides animados (HyperFrames motor interno)

## Repo
- GitHub público: https://github.com/juanmarket/VideoAuto-Studio
- Push con: git add . && git commit -m "mensaje" && git push

## Carpeta del proyecto
```
C:\Users\al\Desktop\Soft de video\
├── server.js
├── package.json
├── profiles.json
├── .env / .env.example
├── lib/
│   └── motion-render.js      # Motor HyperFrames (Puppeteer+GSAP→MP4)
├── templates/
│   ├── slide-minimal.html
│   ├── slide-impact.html
│   ├── slide-quote.html
│   ├── slide-list.html
│   └── slide-chart.html
├── brand/
│   └── backgrounds/
├── public/
│   ├── index.html
│   ├── logo.png
│   ├── deco-left.png (perrito)
│   └── deco-right.png (personaje)
├── sounds/
│   ├── wosh-1.mp3
│   ├── wosh-2.mp3
│   └── Woshh-Dramatico.mp3
├── uploads/
│   ├── audio/
│   └── images/
└── output/
```

## Setup local
- Puerto: 3000 (http://localhost:3000)
- .bat en escritorio para arrancar
- MisApps.bat arranca las 3 apps juntas (VideoAuto 3000, Mis Prompts 3500, Audio Enhancer 5050)

## APIs integradas
- **OpenAI Whisper** (whisper-1): transcripción verbose_json + timestamps
- **Anthropic Claude Sonnet** (claude-sonnet-4-20250514): SOLO para segmentación dinámica
- **Anthropic Claude Haiku** (claude-haiku-4-5-20251001): SIEMPRE para prompts (forzado, lotes de 5)
- **OpenAI GPT-4o mini**: opción alternativa para análisis
- **Pexels Videos**: búsqueda videos stock horizontales
- **Pixabay Videos**: segunda fuente
- **Coverr Videos**: tercera fuente
- **Wikimedia Commons**: imágenes y videos libres (API pública, sin key)

## Diseño visual de la app
Sistema editorial con paleta Paper/Ink/Yellow:
- Fondo: #F5F5F0 (Paper)
- Superficies: #EEEDE6 (Paper 2)
- Cards: #FFFFFF con borde #E3E2D8 (Line), radius 22-28px
- Acento: #FFE500 (Yellow) — SOLO en CTAs, hovers, checkboxes
- Texto: #0F0F0F (Ink), #2A2A28 (Ink 2), #8A8A82 (Muted)
- Fuentes: Inter (principal), Fraunces (editorial), Caveat (firma), JetBrains Mono (meta)
- Iconos: Tabler Icons (sin emojis)
- Sombras suaves < 0.08 alpha
- Motion: cubic-bezier(.2, .7, .2, 1), hover lift -2px/-4px

## Logo/Header
- Imagen del personaje (cabeza2.png) circular
- "Video" #111111 + "Auto" #FFE500 + " Studio" #111111 + "V1" en JetBrains Mono muted
- "by Juan Patinho ✦" en Caveat debajo

## Imágenes decorativas
- Perrito (deco-left.png) y personaje (deco-right.png)
- Posición fija, arrastrables con doble click
- Posición guardada en localStorage
- Visibles en todos los pasos

## Sistema de perfiles de canal
Cada perfil tiene:
- Fondo: color sólido, degradado, imagen, o video
- Overlay: color + opacidad
- Glassmorphism: blur, saturación, borde luminoso
- Texto: color sólido o degradado
- Colores acento 1 y 2
- Fuentes: principal + datos (Google Fonts)
- Tamaños: título, texto, dato grande
- Ícono decorativo: Tabler Icons con posición, tamaño, opacidad
- Animaciones: entrada (12 opciones), salida (5), ícono (4)
- Preview en vivo 16:9

## Selectores del Paso 1
- Idioma: español, inglés, auto
- Segmentos por imagen: 1, 2, 3, o Dinámico (IA decide)
- Formato de cámara: Con cámara, Faceless básico, Faceless Pro
- Tipo de contenido: Auto, Tutorial, Noticiero, Documental, Educativo, Entretenimiento, Opinión
- Modelo de análisis: Haiku, Sonnet, GPT-4o mini (Sonnet recomendado para segmentación)

## 11 tipos de contenido visual
1. imagen_ia (púrpura) — imagen generada con IA
2. video_stock (azul) — video de Pexels/Pixabay/Coverr
3. camara (verde) — usuario en cámara (placeholder)
4. contenido_relacionado (naranja oscuro) — fotos/videos reales (placeholder)
5. motion_graphic (magenta) — animación compleja (placeholder)
6. grabacion_pantalla (cyan) — screencast (placeholder)
7. texto_minimal (naranja) — frase corta
8. texto_impacto (rojo) — número/dato grande
9. texto_cita (amarillo) — quote con autor
10. texto_lista (cyan) — items enumerados
11. texto_grafica (rosa) — barras de datos

## Reglas de formato de cámara
- Faceless Pro: imagen_ia, video_stock, motion_graphic, texto_minimal, texto_impacto, texto_cita, texto_lista, texto_grafica, contenido_relacionado
- Faceless básico: imagen_ia, video_stock, texto_impacto, texto_minimal
- Con cámara: acepta todos los 11 tipos

## Duraciones máximas (maxDuraciones)
```
imagen_ia: 7s
video_stock: 8s
motion_graphic: 6s
texto_minimal: 6s
texto_impacto: 7s
texto_cita: 6s
texto_lista: 8s
texto_grafica: 8s
camara: 999 (sin límite)
grabacion_pantalla: 999
contenido_relacionado: 999
```

## Safety net con fallback inteligente
Cuando un segmento excede el max de su tipo, busca el siguiente tipo que acepte esa duración:
- ≤6s: mantener tipo o cambiar a imagen_ia
- ≤7s: cambiar a texto_impacto o imagen_ia
- ≤8s: cambiar a video_stock
- >8s: cambiar a contenido_relacionado (último recurso)
NUNCA defaultear directo a contenido_relacionado.

## Distribución ideal faceless pro
- imagen_ia: ~30%
- video_stock: ~25%
- texto_impacto: ~15%
- texto_cita: ~10%
- motion_graphic: ~10%
- texto_lista/gráfica: ~5%
- contenido_relacionado: ~5% (SOLO si hay hechos reales con nombres propios/fechas)
- NUNCA más de 2 seguidos del mismo tipo

## Contenido_relacionado — regla estricta
SOLO usar cuando hay: nombre propio real, evento con fecha, producto/marca, lugar específico.
NUNCA para conceptos abstractos, metáforas, introducciones, opiniones.
Si dudas: imagen_ia.

## Zooms dinámicos
9 tipos implementados con FFmpeg zoompan:
- ken_burns: zoom lento 1.0→1.5x (default)
- zoom_in_rapido: 1.0→1.3x en 0.5s
- zoom_out_rapido: 1.3→1.0x en 0.5s
- zoom_punch: ida y vuelta rápido a 1.2x
- zoom_pulso: respiración suave sin→out
- pan_izquierda/derecha: paneo horizontal
- zoom_dramatico: zoom lento 1.0→1.8x
- none: estático

Scale previo: width*4 x height*4 para evitar temblor.
Ken Burns usa crop progresivo en vez de zoompan para mayor suavidad.

## Efectos de sonido
3 archivos en /sounds/:
- wosh-1.mp3: transiciones normales
- wosh-2.mp3: zooms rápidos
- Woshh-Dramatico.mp3: momentos de impacto/drama

Asignación automática según zoom y tipo. Slider de volumen en Paso 4 (default 40%).
Audio original NO se modifica (normalize=0 en amix).

## Búsqueda de medios
5 fuentes con paginación (9 por página):
- Pexels, Pixabay, Coverr (video stock)
- Wikimedia Img, Wikimedia Vid (imágenes/videos libres)
Preview de video/imagen antes de seleccionar.
Wikimedia: rate limiting con delay 1s, cache 5min, User-Agent personalizado.

## Generación de prompts
- Modelo: Haiku SIEMPRE (forzado), independiente del selector
- Lotes de 5, secuenciales con 500ms delay
- Máximo 2 rondas de reintentos, luego para
- Si error "credit balance too low": para inmediatamente
- System prompt separado: textarea del usuario (CHARACTER + estilo) + instrucciones técnicas fijas del backend

## Segmentación dinámica
- Modelo: usa el selector de Paso 1 (Sonnet recomendado)
- Lotes de 50 segmentos Whisper
- Subdivisión post-segmentación como safety net (solo si > 8s)
- Reglas de corte: pausas naturales, oraciones completas, no cortar en conjunciones
- Distribución: 40-50% SHORT, 40-50% MEDIUM, LONG solo para contenido_relacionado

## Export (Paso 4)
- Resolución: 1920x1080, 1280x720, 854x480
- FPS: 24, 30
- Movimiento de cámara: Sin movimiento, Ken Burns, Zooms dinámicos
- 19 transiciones xfade + Aleatorio (default)
- Slider duración transición: 0.2s a 1.0s
- Efectos de sonido: checkbox + slider volumen
- Costo de APIs: tracking real del response
- Gaps entre segmentos se cierran automáticamente
- SFX posicionados en inicio de transición (start - transicionDuracion/2)

## Slides de texto (HyperFrames)
- Motor: Puppeteer + GSAP → frames PNG → FFmpeg MP4
- Templates: impact, minimal, quote (funcionan), list, chart (no verificados)
- Aplica estilos del perfil: fuentes, tamaños, colores, degradado, ícono, glassmorphism, fondo
- Card centrada ~70% del viewport
- Viewport de Puppeteer = resolución de export

## Bugs conocidos / pendientes
- Templates lista y gráfica no verificados en export
- Preview de animación en editor de perfiles no funciona
- Fuentes en editor de perfiles no cambian correctamente
- Animaciones GSAP en export no verificadas completamente
- Haiku para segmentación genera pocos shorts y gaps grandes — usar Sonnet siempre
- Detector de "malos cortes" demasiado estricto con conjunciones en español

## Sesión persistente (localStorage)
- Segmentos, prompts, recomendaciones, keywords, zooms
- Tipo asignado por usuario en cada slot
- Datos de slides (impacto, cita, lista, etc.)
- Formato de cámara y tipo de contenido
- Posición de imágenes decorativas
- Sistema prompt del usuario (CHARACTER)

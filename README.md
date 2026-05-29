# VideoAuto Studio

App web local para crear videos automatizados. Audio → Transcripción → IA → Imágenes/Videos → MP4

## Requisitos

- **Node.js** 18+
- **FFmpeg** en PATH
- API keys de:
  - OpenAI
  - Anthropic
  - Pexels
  - Pixabay
  - Coverr

## Instalación

```bash
npm install
cp .env.example .env
# Llenar las API keys en .env
```

## Uso

```bash
node server.js
```

Abrir [http://localhost:3000](http://localhost:3000)

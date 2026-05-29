// HyperFrames — Built-in motion render engine
// Renders HTML+GSAP to MP4 via Puppeteer frame capture + FFmpeg encoding

const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Render an HTML string (with GSAP animations) to an MP4 video.
 *
 * @param {Object} opts
 * @param {string} opts.htmlContent  Full HTML document string
 * @param {number} opts.duration     Duration in seconds
 * @param {number} opts.width        Video width (px)
 * @param {number} opts.height       Video height (px)
 * @param {number} opts.fps          Frames per second
 * @param {string} opts.outputPath   Absolute path for the output MP4
 * @returns {Promise<string>}        Resolves to outputPath on success
 */
async function renderMotion({ htmlContent, duration, width, height, fps, outputPath }) {
  const framesDir = path.join(os.tmpdir(), `hf_builtin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(framesDir, { recursive: true });

  let browser;
  try {
    // Launch Puppeteer with bundled Chromium (no executablePath)
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--allow-file-access-from-files',
        '--autoplay-policy=no-user-gesture-required',
        `--window-size=${width},${height}`
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    // Intercept GSAP immediately after it loads to pause the global timeline.
    // Without this, animations complete during page load and tweens get auto-removed,
    // making seek() unable to replay them.
    await page.evaluateOnNewDocument(() => {
      // Poll for gsap and pause it the instant it appears
      const _origDefProp = Object.defineProperty;
      let _gsapIntercepted = false;
      Object.defineProperty(window, 'gsap', {
        configurable: true,
        set(val) {
          _origDefProp.call(Object, window, 'gsap', { value: val, writable: true, configurable: true });
          if (val && val.globalTimeline && !_gsapIntercepted) {
            _gsapIntercepted = true;
            val.globalTimeline.pause(0);
          }
        },
        get() { return undefined; }
      });
    });

    // Save HTML to temp file and load via file:// so local resources (video/image backgrounds) resolve correctly
    const tmpHtmlPath = path.join(framesDir, '_slide.html');
    fs.writeFileSync(tmpHtmlPath, htmlContent, 'utf8');
    const fileUrl = 'file:///' + tmpHtmlPath.replace(/\\/g, '/');
    await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for video element to be ready (if any)
    const hasVideo = await page.evaluate(() => !!document.querySelector('video'));
    if (hasVideo) {
      // Log video src for debugging
      const videoSrc = await page.evaluate(() => {
        const v = document.querySelector('video');
        return v ? v.src : 'no video element';
      });
      console.log(`  [motion-render] Video src: ${videoSrc}`);

      try {
        await page.waitForFunction(() => {
          const v = document.querySelector('video');
          return v && v.readyState >= 2;
        }, { timeout: 15000 });
        console.log('  [motion-render] Video element loaded and ready');
      } catch (e) {
        // Log video state for debugging
        const videoState = await page.evaluate(() => {
          const v = document.querySelector('video');
          if (!v) return 'no video element';
          return `readyState=${v.readyState}, networkState=${v.networkState}, error=${v.error ? v.error.code + ':' + v.error.message : 'none'}, src=${v.src}`;
        });
        console.warn(`  [motion-render] Video load timeout: ${videoState}`);
      }
    }

    // Confirm GSAP is present and timeline is paused at 0 with tweens intact
    const hasGSAP = await page.evaluate(() => {
      if (window.gsap) {
        // Ensure it's paused at 0 (the interceptor should have done this)
        window.gsap.globalTimeline.pause(0);
        return true;
      }
      return false;
    });

    // Use round (not ceil) for frame-accurate duration matching across all clip types
    const totalFrames = Math.max(1, Math.round(duration * fps));
    const exactDuration = totalFrames / fps;
    console.log(`  [motion-render] ${totalFrames} frames @ ${fps}fps (${exactDuration.toFixed(4)}s), ${width}x${height}, GSAP: ${hasGSAP}`);

    // Capture each frame
    for (let f = 0; f < totalFrames; f++) {
      const t = f / fps;
      if (hasGSAP) {
        await page.evaluate((time) => {
          window.gsap.globalTimeline.seek(time, false);
        }, t);
      }

      // Sync video element to current time (for video backgrounds)
      if (hasVideo) {
        await page.evaluate((time) => {
          const v = document.querySelector('video');
          if (v) {
            v.pause();
            v.currentTime = time % (v.duration || 999);
          }
        }, t);
        // Brief wait for the video frame to render
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      }

      const framePath = path.join(framesDir, `f${String(f).padStart(5, '0')}.png`);
      await page.screenshot({ path: framePath, type: 'png' });

      if (f % (fps * 2) === 0 && f > 0) {
        console.log(`  [motion-render] ${f}/${totalFrames} frames captured...`);
      }
    }

    await page.close();
    console.log(`  [motion-render] ${totalFrames} frames captured. Encoding...`);

    // Encode with FFmpeg to MP4
    const inputPattern = path.join(framesDir, 'f%05d.png').replace(/\\/g, '/');
    const outPath = path.resolve(outputPath).replace(/\\/g, '/');

    await runFFmpegEncode([
      '-framerate', String(fps),
      '-i', inputPattern,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      '-tune', 'animation',
      outPath
    ]);

    console.log(`  [motion-render] Encoded to ${path.basename(outputPath)}`);
    return outputPath;

  } finally {
    if (browser) await browser.close().catch(() => {});
    // Clean up frames
    try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Load an HTML template, replace placeholders with profile/data values, return full HTML string.
 */
/**
 * Escape a string so it's safe inside a JS single-quoted literal.
 * Handles: backslash, single quote, newlines, carriage returns, template literals.
 */
function jsEscape(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/`/g, '\\`')
    .replace(/<\/script/gi, '<\\/script');
}

// Keys that contain user-entered text and may appear inside JS string literals in templates.
// These get JS-escaped when inside '...' or "..." contexts.
const JS_DATA_KEYS = new Set([
  'DATO', 'DESCRIPCION', 'TEXTO', 'ITEMS', 'AUTOR', 'CITA', 'CHART_DATA', 'TITULO'
]);

function buildSlideHTML(templatePath, replacements) {
  let html = fs.readFileSync(templatePath, 'utf8');

  for (const [key, value] of Object.entries(replacements)) {
    const placeholder = `{{${key}}}`;
    if (!html.includes(placeholder)) continue;

    const raw = value || '';

    if (JS_DATA_KEYS.has(key)) {
      // For user-data keys: use JS-escaped version inside <script> blocks, raw in HTML
      const escaped = jsEscape(raw);
      // Split HTML into script and non-script sections
      const parts = html.split(/(<script[\s\S]*?<\/script>)/gi);
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].toLowerCase().startsWith('<script')) {
          // Inside a script block — use JS-escaped value
          parts[i] = parts[i].split(placeholder).join(escaped);
        } else {
          // HTML context — use raw value (HTML-safe for text content)
          parts[i] = parts[i].split(placeholder).join(raw);
        }
      }
      html = parts.join('');
    } else {
      // Structural keys (fonts, colors, CSS, BG_HTML, ANIM_SCRIPT) — always raw
      html = html.split(placeholder).join(raw);
    }
  }

  return html;
}

/**
 * Build the replacement map from a profile + override data.
 */
/**
 * Build the inline <script> block with animation helper functions.
 * Templates call: animateEntry(tl, selector, delay) / animateExit(tl, selector, delay) / animateIcon(tl, selector, delay)
 */
function buildAnimScript(entrada, salida, icono) {
  return `
<script>
// ── Animation helpers (generated from profile) ──
// NOTE: Elements start with CSS opacity:0 to avoid flash.
// fromTo is used instead of from so the end-state is always opacity:1.
function animateEntry(tl, targets, delay) {
  delay = delay || 0;
  var entrada = '${entrada}';
  var els = typeof targets === 'string' ? document.querySelectorAll(targets) : [targets];
  els.forEach(function(el, i) {
    var d = delay + i * 0.12;
    switch(entrada) {
      case 'fadeUp':
        tl.fromTo(el, {y:40, opacity:0}, {y:0, opacity:1, duration:0.5, ease:'power3.out'}, d); break;
      case 'fadeDown':
        tl.fromTo(el, {y:-40, opacity:0}, {y:0, opacity:1, duration:0.5, ease:'power3.out'}, d); break;
      case 'fadeLeft':
        tl.fromTo(el, {x:-50, opacity:0}, {x:0, opacity:1, duration:0.5, ease:'power3.out'}, d); break;
      case 'fadeRight':
        tl.fromTo(el, {x:50, opacity:0}, {x:0, opacity:1, duration:0.5, ease:'power3.out'}, d); break;
      case 'slamIn':
        tl.fromTo(el, {scale:1.8, opacity:0}, {scale:1, opacity:1, duration:0.4, ease:'back.out(1.7)'}, d); break;
      case 'convergeUp':
        tl.fromTo(el, {y:gsap.utils.random(60,120), rotation:gsap.utils.random(-5,5), opacity:0}, {y:0, rotation:0, opacity:1, duration:0.6, ease:'power4.out'}, d); break;
      case 'expandCenter':
        tl.fromTo(el, {scaleX:0, scaleY:0, opacity:0}, {scaleX:1, scaleY:1, opacity:1, duration:0.5, ease:'elastic.out(1, 0.5)'}, d); break;
      case 'typewriter':
        gsap.set(el, {opacity:0});
        tl.to(el, {opacity:1, duration:0.08}, d); break;
      case 'blurIn':
        gsap.set(el, {opacity:0, filter:'blur(20px)'});
        tl.to(el, {opacity:1, filter:'blur(0px)', duration:0.6, ease:'power2.out'}, d); break;
      case 'splitReveal':
        gsap.set(el, {clipPath:'inset(50% 0)', opacity:1});
        tl.to(el, {clipPath:'inset(0% 0)', duration:0.5, ease:'power3.out'}, d); break;
      case 'bounceIn':
        tl.fromTo(el, {scale:0.3, opacity:0}, {scale:1, opacity:1, duration:0.6, ease:'bounce.out'}, d); break;
      case 'glitchIn':
        gsap.set(el, {opacity:0});
        tl.to(el, {opacity:1, duration:0.01}, d);
        tl.to(el, {x:function(){return gsap.utils.random(-3,3)}, textShadow:'2px 0 red, -2px 0 cyan', duration:0.05, repeat:6, yoyo:true}, d);
        tl.set(el, {x:0, textShadow:'none'}, d+0.35); break;
      default:
        tl.fromTo(el, {y:40, opacity:0}, {y:0, opacity:1, duration:0.5, ease:'power3.out'}, d);
    }
  });
}

function animateExit(tl, targets, delay) {
  var salida = '${salida}';
  if (salida === 'none') return;
  delay = delay || 0;
  var els = typeof targets === 'string' ? document.querySelectorAll(targets) : [targets];
  var props;
  switch(salida) {
    case 'fadeOut':  props = {opacity:0, y:-15, duration:0.35, ease:'power2.in'}; break;
    case 'fadeDown': props = {opacity:0, y:30, duration:0.35, ease:'power2.in'}; break;
    case 'scaleOut': props = {opacity:0, scale:0.8, duration:0.3, ease:'power2.in'}; break;
    case 'blurOut':  props = {opacity:0, filter:'blur(15px)', duration:0.4, ease:'power2.in'}; break;
    default:         props = {opacity:0, y:-15, duration:0.35, ease:'power2.in'};
  }
  els.forEach(function(el) { tl.to(el, props, delay); });
}

function animateIcon(tl, target, delay) {
  delay = delay || 0;
  var icono = '${icono}';
  var el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return;
  // Read the target opacity set by the icon setup code (defaults to 1)
  var targetOpac = parseFloat(el.style.opacity) || 1;
  switch(icono) {
    case 'popIn':
      tl.fromTo(el, {scale:0, opacity:0}, {scale:1, opacity:targetOpac, duration:0.4, ease:'elastic.out(1, 0.5)'}, delay); break;
    case 'spinIn':
      tl.fromTo(el, {rotation:180, opacity:0, scale:0.5}, {rotation:0, opacity:targetOpac, scale:1, duration:0.5, ease:'power3.out'}, delay); break;
    case 'dropIn':
      tl.fromTo(el, {y:-60, opacity:0}, {y:0, opacity:targetOpac, duration:0.4, ease:'bounce.out'}, delay); break;
    case 'fadeIn':
      tl.fromTo(el, {opacity:0}, {opacity:targetOpac, duration:0.4, ease:'power2.out'}, delay); break;
    default:
      tl.fromTo(el, {scale:0, opacity:0}, {scale:1, opacity:targetOpac, duration:0.4, ease:'elastic.out(1, 0.5)'}, delay);
  }
}
<\/script>`;
}

function profileToReplacements(profile, override, projectDir) {
  const est = profile?.estilos || {};
  const dir = est.fondo_direccion === 'vertical' ? 'to bottom'
            : est.fondo_direccion === 'horizontal' ? 'to right'
            : '135deg';

  // Determine background HTML based on fondo_tipo
  const fondoTipo = est.fondo_tipo || 'degradado';
  const isMedia = fondoTipo === 'imagen' || fondoTipo === 'video';
  let BG_HTML = '';
  let CONTENT_CARD_STYLE = '';

  if (isMedia) {
    const mediaPath = est.fondo_imagen || est.fondo_video || '';
    const absMedia = mediaPath && projectDir ? path.resolve(projectDir, mediaPath).replace(/\\/g, '/') : '';
    const overlayColor = est.overlay_color || '#000000';
    const overlayOpac = est.overlay_opacidad ?? 0.4;
    const r = parseInt(overlayColor.slice(1, 3), 16);
    const g = parseInt(overlayColor.slice(3, 5), 16);
    const b = parseInt(overlayColor.slice(5, 7), 16);
    const overlayRgba = `rgba(${r},${g},${b},${overlayOpac})`;

    if (fondoTipo === 'video' && absMedia) {
      BG_HTML = `<div style="position:absolute;inset:0;z-index:0"><video src="file:///${absMedia}" autoplay muted loop playsinline style="width:100%;height:100%;object-fit:cover"></video>`;
    } else if (absMedia) {
      BG_HTML = `<div style="position:absolute;inset:0;z-index:0"><img src="file:///${absMedia}" style="width:100%;height:100%;object-fit:cover" />`;
    }

    if (BG_HTML) {
      if (est.glassmorphism) {
        BG_HTML += '</div>';
        const blur = est.glass_blur || 20;
        const sat = est.glass_saturacion || 120;
        const border = est.glass_borde !== false ? 'border:1px solid rgba(255,255,255,0.1);' : '';
        CONTENT_CARD_STYLE = `background:${overlayRgba};backdrop-filter:blur(${blur}px) saturate(${sat}%);-webkit-backdrop-filter:blur(${blur}px) saturate(${sat}%);${border}border-radius:16px;padding:32px 40px;position:relative;z-index:1;`;
      } else {
        BG_HTML += `<div style="position:absolute;inset:0;background:${overlayRgba}"></div></div>`;
      }
    }
  }

  // Compute the body background CSS
  let BODY_BG;
  if (isMedia && BG_HTML) {
    BODY_BG = '#000';
  } else if (fondoTipo === 'degradado') {
    BODY_BG = `linear-gradient(${dir}, ${est.fondo_color1 || '#1a1a2e'}, ${est.fondo_color2 || '#16213e'})`;
  } else {
    BODY_BG = est.fondo_color1 || '#1a1a2e';
  }

  // Text gradient CSS (applied to dato + title, not to desc — matches preview)
  const txtGrad = est.texto_tipo === 'degradado';
  const txtDir = est.texto_direccion === 'vertical' ? 'to bottom'
               : est.texto_direccion === 'horizontal' ? 'to right'
               : '135deg';
  const TEXT_GRADIENT_CSS = txtGrad
    ? `background:linear-gradient(${txtDir}, ${est.color_texto || '#ffffff'}, ${est.texto_color2 || '#ffffff'});-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:transparent;`
    : '';

  // Icon properties
  const iconColor = est.icono_color || est.color_acento1 || '#5b4cf5';
  const iconSize = String(est.icono_tamano || 48);
  const iconOpac = String(est.icono_opacidad ?? 1.0);
  const iconPos = est.icono_posicion || 'arriba';

  return {
    FONDO_COLOR1: est.fondo_color1 || '#1a1a2e',
    FONDO_COLOR2: est.fondo_color2 || '#16213e',
    FONDO_DIRECCION: dir,
    FONDO_TIPO: fondoTipo,
    BODY_BG: BODY_BG,
    BG_HTML: BG_HTML,
    CONTENT_CARD_STYLE: CONTENT_CARD_STYLE,
    FUENTE_PRINCIPAL: est.fuente_principal || 'Syne',
    FUENTE_DATOS: est.fuente_datos || 'IBM Plex Mono',
    COLOR_TEXTO: est.color_texto || '#ffffff',
    COLOR_ACENTO1: est.color_acento1 || '#5b4cf5',
    COLOR_ACENTO2: est.color_acento2 || '#0da892',
    TAMANO_TITULO: String(est.tamano_titulo || 72),
    TAMANO_TEXTO: String(est.tamano_texto || 36),
    TAMANO_DATO: String(est.tamano_dato || 120),
    ICONO: est.icono_nombre || '',
    ICONO_COLOR: iconColor,
    ICONO_TAMANO: iconSize,
    ICONO_OPACIDAD: iconOpac,
    ICONO_POSICION: iconPos,
    TEXT_GRADIENT_CSS: TEXT_GRADIENT_CSS,
    ANIM_ENTRADA: est.anim_entrada || 'fadeUp',
    ANIM_SALIDA: est.anim_salida || 'fadeOut',
    ANIM_ICONO: est.anim_icono || 'popIn',
    ANIM_SCRIPT: buildAnimScript(est.anim_entrada || 'fadeUp', est.anim_salida || 'fadeOut', est.anim_icono || 'popIn'),
    DATO: override?.dato || '',
    DESCRIPCION: override?.descripcion || '',
    TEXTO: override?.text || '',
    ITEMS: override?.items || '',
    AUTOR: override?.autor || '',
    CITA: override?.cita || '',
    CHART_DATA: override?.chartData || '',
    TITULO: override?.titulo || ''
  };
}

function runFFmpegEncode(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      if (err.code === 'ENOENT') reject(new Error('FFmpeg no encontrado en PATH'));
      else reject(err);
    });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg encode failed (code ${code}): ${stderr.slice(-500)}`));
    });
  });
}

module.exports = { renderMotion, buildSlideHTML, profileToReplacements };

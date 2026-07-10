// Screen-watch streamer — runs headless inside the twox_web NUI.
//
// Video: FiveM "CfxTexture magic hook" (raw WebGL2) — binds the GAME render as
// a texture, drawn to a canvas, canvas.captureStream()-ed into WebRTC. SILENT,
// game-only. Audio: the player's MICROPHONE via getUserMedia (their own voice;
// nearby proximity voice lives in the native engine and isn't reachable here).
// Capture (video+mic) is built ONCE and shared to every viewer; it only runs
// while ≥1 admin is watching. Quality (resolution/fps/bitrate) is adjustable
// live, and we retry the hook if the first frames come back black.

(function () {
  const RES = (typeof GetParentResourceName === 'function') ? GetParentResourceName() : 'twox_web';

  // ── CfxTexture game capture (raw WebGL2) ──────────────────────────────────
  const VS = `attribute vec2 a_position; attribute vec2 a_texcoord; varying vec2 vUv;
    void main(){ gl_Position = vec4(a_position,0.0,1.0); vUv = a_texcoord; }`;
  const FS = `precision mediump float; varying vec2 vUv; uniform sampler2D external_texture;
    void main(){ gl_FragColor = texture2D(external_texture, vUv); }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    const log = gl.getShaderInfoLog(sh); if (log) console.error('[sw]', log);
    return sh;
  }

  class GameRender {
    constructor() {
      this.canvas = document.createElement('canvas');
      this.canvas.width = window.innerWidth;
      this.canvas.height = window.innerHeight;
      this.gl = this.canvas.getContext('webgl2', {
        antialias: false, depth: false, stencil: false, alpha: false,
        preserveDrawingBuffer: true, powerPreference: 'high-performance',
        desynchronized: true, failIfMajorPerformanceCaveat: false,
      });
      if (!this.gl) throw new Error('no webgl2');
      const gl = this.gl;

      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 255, 255]));
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      // FiveM "magic hook" — replaying this TEXTURE_WRAP_T sequence makes CEF
      // swap in the live game render for this texture.
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const vbuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const tbuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, tbuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      this.vbuf = vbuf; this.tbuf = tbuf;

      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      this.prog = prog;
      gl.useProgram(prog);
      gl.uniform1i(gl.getUniformLocation(prog, 'external_texture'), 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      const vloc = gl.getAttribLocation(prog, 'a_position');
      const tloc = gl.getAttribLocation(prog, 'a_texcoord');
      gl.bindBuffer(gl.ARRAY_BUFFER, vbuf); gl.vertexAttribPointer(vloc, 2, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(vloc);
      gl.bindBuffer(gl.ARRAY_BUFFER, tbuf); gl.vertexAttribPointer(tloc, 2, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(tloc);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);

      this.animated = false;
      this.out = document.createElement('canvas');
      this.outCtx = this.out.getContext('2d', { willReadFrequently: true });
      this.ow = 1280; this.oh = 720; this.interval = 1000 / 24;
    }

    resize(w, h) { if (w && h) { this.ow = w; this.oh = h; this.out.width = w; this.out.height = h; } }
    setFps(fps) { if (fps) this.interval = 1000 / fps; }

    renderToTarget(w, h, fps) {
      this.resize(w, h); this.setFps(fps);
      this.animated = true;
      let last = 0;
      const tick = (now) => {
        if (!this.animated) return;
        if (now - last >= this.interval) {
          last = now;
          this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
          this.outCtx.drawImage(this.canvas, 0, 0, this.ow, this.oh);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return this.out;
    }

    // Heuristic: a real game frame varies across sample points; a failed hook
    // is uniform black or the blue placeholder.
    looksLive() {
      try {
        const w = this.out.width, h = this.out.height;
        const pts = [[w >> 1, h >> 1], [w >> 2, h >> 2], [(w * 3) >> 2, (h * 3) >> 2], [8, 8]];
        let first = null, varied = false, nonBlack = 0;
        for (const [x, y] of pts) {
          const d = this.outCtx.getImageData(x, y, 1, 1).data;
          const lum = d[0] + d[1] + d[2];
          if (lum > 24) nonBlack++;
          if (first === null) first = lum; else if (Math.abs(lum - first) > 16) varied = true;
        }
        return nonBlack >= 2 && varied;
      } catch { return true; } // readback blocked → assume fine
    }

    stop() {
      this.animated = false;
      try {
        this.gl.deleteTexture(this.texture);
        this.gl.deleteBuffer(this.vbuf); this.gl.deleteBuffer(this.tbuf);
        this.gl.deleteProgram(this.prog);
      } catch {}
    }
  }

  // ── Capture + signaling ───────────────────────────────────────────────────
  const peers = new Map();   // session → RTCPeerConnection
  let render = null;
  let videoStream = null;
  let quality = { width: 1280, height: 720, fps: 15, bitrate: 800 }; // light default

  function up(payload) {
    fetch(`https://${RES}/swUp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }

  // ONE WebGL context, captured immediately (recreating contexts breaks the
  // magic hook + exhausts CEF's context limit). The black check is
  // NON-DESTRUCTIVE — we only report it; the viewer's retry does a clean
  // full-session restart (which recreates this once).
  function ensureVideo() {
    if (videoStream) return videoStream;
    render = new GameRender();
    const out = render.renderToTarget(quality.width, quality.height, quality.fps);
    videoStream = out.captureStream(quality.fps);
    return videoStream;
  }

  function stopCapture() {
    if (render) { try { render.stop(); } catch {} render = null; }
    if (videoStream) { try { videoStream.getTracks().forEach(t => t.stop()); } catch {} videoStream = null; }
  }

  function stopSession(session) {
    const pc = peers.get(session);
    if (pc) { try { pc.close(); } catch {} peers.delete(session); }
    if (peers.size === 0) stopCapture();
  }

  function setBitrate(pc, kbps) {
    if (!kbps) return;
    for (const s of pc.getSenders()) {
      if (s.track && s.track.kind === 'video') {
        const p = s.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = kbps * 1000;
        s.setParameters(p).catch(() => {});
      }
    }
  }

  async function start(session, iceServers) {
    if (peers.has(session)) return;
    const vs = ensureVideo();

    const pc = new RTCPeerConnection({ iceServers: iceServers || [] });
    peers.set(session, pc);
    vs.getVideoTracks().forEach(t => pc.addTrack(t, vs));
    pc.onicecandidate = (e) => { if (e.candidate) up({ session, kind: 'ice', data: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) stopSession(session);
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      setBitrate(pc, quality.bitrate);
      up({ session, kind: 'offer', data: { type: offer.type, sdp: offer.sdp } });
    } catch (e) { stopSession(session); up({ session, state: 'error' }); return; }

    // Non-destructive black check: report only (never recreate the context).
    setTimeout(() => {
      try { if (peers.has(session) && render && !render.looksLive()) up({ session, state: 'black' }); } catch {}
    }, 1800);
  }

  async function signal(session, kind, data) {
    const pc = peers.get(session);
    if (!pc) return;
    try {
      if (kind === 'answer') await pc.setRemoteDescription(new RTCSessionDescription(data));
      else if (kind === 'ice' && data) await pc.addIceCandidate(new RTCIceCandidate(data));
    } catch (e) { /* ignore late/dup candidates */ }
  }

  function applyQuality(q) {
    quality = { ...quality, ...q };
    if (render) { render.resize(quality.width, quality.height); render.setFps(quality.fps); }
    for (const pc of peers.values()) setBitrate(pc, quality.bitrate);
  }

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.channel !== 'sw' || !msg.payload) return;
    const p = msg.payload;
    if (p.action === 'start')        start(p.session, p.iceServers);
    else if (p.action === 'signal')  signal(p.session, p.kind, p.data);
    else if (p.action === 'stop')    stopSession(p.session);
    else if (p.action === 'quality') applyQuality(p);
  });
})();

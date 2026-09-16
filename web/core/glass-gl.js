/**
 * Glass rendered behind the controls, not instead of them.
 *
 * Libraries for this effect hand back a `<div>` with a canvas in it, losing the tab order,
 * the focus ring and the accessible name. This layer sits underneath: every control stays a
 * real `<button>`, and the layer never receives a pointer event.
 *
 * What it refracts is computed rather than captured: the shader derives rings and sweep from
 * the same numbers the radar uses, so there is no page snapshot and no texture upload.
 */

const MAX_SHAPES = 24;

/*
 * How often to look for work when there is none. Most of the time nothing is eligible, since
 * dialog and toolbar controls are excluded, so the idle case was a full-screen clear and a
 * DOM scan sixty times a second to draw nothing. At ten scans a second the glass still
 * arrives before the eye does.
 */
const IDLE_SCAN_MS = 100;

const VERT = `#version 300 es
in vec2 aQuad;
uniform vec4 uRect;      // x, y, w, h  in device pixels
uniform vec2 uViewport;
uniform float uPad;
out vec2 vPx;
void main() {
  vec2 halfSize = uRect.zw * 0.5 + uPad;
  vec2 mid = uRect.xy + uRect.zw * 0.5;
  vec2 px = mid + aQuad * halfSize;
  vPx = px;
  vec2 clip = (px / uViewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

in vec2 vPx;
out vec4 outColor;

uniform vec4 uRect;       // the control this quad belongs to
uniform float uRadius;
uniform vec2 uOrigin;     // where the radar radiates from
uniform float uGap;       // distance between rings
uniform float uPhase;     // 0..1, how far the current ring has travelled
uniform float uSweep;     // radians
uniform float uSeeking;
uniform vec3 uInk;        // the page behind
uniform vec3 uRing;
uniform vec3 uBeam;
uniform vec3 uTint;
uniform float uTintA;
uniform float uSpec;      // 0..1, how lit this control is right now
uniform vec2 uSpecAt;     // where the light is, in the control's own space

/*
 * How much of the shape this is.
 *
 * A button is a pane: the glass IS the control, so it is drawn edge to edge and uFace is 1.
 * A menu or a sheet is not: it already has a real blurred backdrop behind it, and the text
 * on it has to stay readable, so uFace is 0 and only the outer band is drawn. That band is
 * where glass does its work anyway: the middle of a pane shows you what is behind it, and the
 * edge is the part that bends. Painting the band over a panel that already has its own
 * material gives the panel the same edge a button has, and costs it nothing in legibility.
 */
uniform float uFace;      // 1 = the whole shape, 0 = the rim band only
uniform float uBand;      // how wide the bending edge is, in device pixels
uniform float uBend;      // how hard it bends there

/*
 * The lit edge: width, falloff, and how much light each side gets.
 *
 * A button can take a broad, strong shoulder because the glass is the whole control and there
 * is nothing underneath to disagree with. A panel cannot: the band is painted over a surface
 * that already has a colour, so anything more than a thin line reads as a frame drawn around
 * the panel rather than as light landing on its edge. Same shader, two settings.
 */
uniform vec4 uRim;        // x width px, y falloff power, z lit, w shadow

/** Rounded-rectangle distance. Negative inside, zero on the edge. */
float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

/*
 * What is behind the glass, computed rather than photographed.
 *
 * The same rings and the same sweep the radar draws, from the same origin and the same
 * clock, so the refracted band at a control's edge lines up with the rings running past it.
 */
vec3 backdrop(vec2 px) {
  vec2 d = px - uOrigin;
  float r = length(d);

  // Rings: a soft pulse every uGap, marching outward with uPhase.
  float t = fract(r / uGap - uPhase);
  float ring = smoothstep(0.5, 0.0, abs(t - 0.5) * 2.0);
  ring = pow(ring, 22.0);
  float falloff = 1.0 - clamp(r / (uGap * 9.0), 0.0, 1.0);
  ring *= 0.35 + 0.65 * falloff;

  // The sweep, and the brighter line at its leading edge.
  float a = atan(d.y, d.x);
  float delta = mod(a - uSweep + 6.2831853, 6.2831853);
  float wedge = smoothstep(1.1, 0.0, delta) * (0.1 + uSeeking * 0.35);
  float beam = smoothstep(0.045, 0.0, delta) * (0.25 + uSeeking * 0.5);

  return uInk + uRing * ring + uBeam * (wedge * 0.35 + beam);
}

void main() {
  vec2 halfSize = uRect.zw * 0.5;
  vec2 mid = uRect.xy + halfSize;
  vec2 p = vPx - mid;

  float d = sdRoundRect(p, halfSize, uRadius);
  if (d > 0.75) discard;                      // outside the control: nothing to draw

  // Coverage, so the edge is smooth rather than stepped.
  float cover = clamp(0.5 - d, 0.0, 1.0);

  /*
   * The normal of the surface, from the gradient of the distance field.
   *
   * This is the whole trick. In the middle of a pane the distance changes slowly and the
   * normal is almost nothing, so light passes straight through and the label stays legible.
   * Approaching the edge the field turns sharply, the normal grows, and the background bends
   * which is what a real edge does, and the reason a uniform blur never looks like glass.
   */
  vec2 e = vec2(1.0, 0.0);
  vec2 n = normalize(vec2(
    sdRoundRect(p + e.xy, halfSize, uRadius) - sdRoundRect(p - e.xy, halfSize, uRadius),
    sdRoundRect(p + e.yx, halfSize, uRadius) - sdRoundRect(p - e.yx, halfSize, uRadius)
  ) + 1e-6);

  // Only the outer band bends, and it bends harder the closer it gets.
  float edge = smoothstep(0.0, uBand, -d);    // 0 at the rim, 1 well inside
  float bend = pow(1.0 - edge, 2.2) * uBend;

  /*
   * Three samples at slightly different strengths, recombined per channel.
   *
   * Glass does not bend every wavelength by the same amount, so an edge splits white into
   * colour. That fringe is most of what separates a rendered pane from a blurred rectangle.
   */
  vec3 bent;
  bent.r = backdrop(vPx + n * bend * 0.86).r;
  bent.g = backdrop(vPx + n * bend * 1.00).g;
  bent.b = backdrop(vPx + n * bend * 1.16).b;

  // A cheap blur: a few taps along the normal, which is the direction detail smears anyway.
  vec3 soft = bent;
  soft += backdrop(vPx + n * (bend + 3.0));
  soft += backdrop(vPx - n * 3.0);
  soft /= 3.0;

  vec3 col = mix(soft, uTint, uTintA);

  // The rim: bright on the shoulder the light falls on, dark where the pane shows thickness.
  vec2 lightDir = normalize(vec2(-0.55, -0.83));
  float lit = clamp(dot(n, lightDir), 0.0, 1.0);
  float rim = pow(1.0 - smoothstep(0.0, uRim.x, -d), uRim.y);
  col += vec3(1.0) * rim * lit * uRim.z;
  col -= vec3(1.0) * rim * clamp(-dot(n, lightDir), 0.0, 1.0) * uRim.w;

  // And the specular that follows the pointer across the face.
  float spec = exp(-dot(p - uSpecAt, p - uSpecAt) / 2600.0) * uSpec;
  col += vec3(1.0) * spec * 0.24;

  /*
   * On a panel the band has to end without a seam.
   *
   * It fades to nothing well before the text starts, and fades fast: a linear ramp leaves
   * a visible grey wash halfway across the panel, where the shape it is drawn over already has
   * its own material and the two do not quite agree. Steeper than linear, the two meet where
   * both are almost nothing and there is no boundary to see.
   */
  float band = pow(1.0 - smoothstep(0.0, uBand, -d), 1.8);
  outColor = vec4(col, cover * mix(band, 1.0, uFace));
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('glass shader: ' + log);
  }
  return sh;
}

const rgb = (css) => {
  const m = /(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)/.exec(css || '');
  return m ? [+m[1] / 255, +m[2] / 255, +m[3] / 255] : [0, 0, 0];
};

const UNIFORMS = [
  'uRect', 'uViewport', 'uPad', 'uRadius', 'uOrigin', 'uGap', 'uPhase', 'uSweep', 'uSeeking',
  'uInk', 'uRing', 'uBeam', 'uTint', 'uTintA', 'uSpec', 'uSpecAt', 'uFace', 'uBand', 'uBend',
  'uRim',
];

/**
 * One canvas, one context, one program - and no opinion about where it sits.
 *
 * There are two of these. The first lies flat behind the whole page and draws the buttons.
 * The second follows whatever surface is open - a menu, a sheet - and draws that surface's
 * edge from inside it, because an element in the top layer cannot be drawn behind by anything
 * that is not also in the top layer. Same shader, same material, same light; only the paper
 * it is printed on differs.
 *
 * Everything is in the canvas's own pixels, so the caller says where the radar's origin falls
 * on *this* canvas and the pass needs to know nothing else about the page.
 */
class Pass {
  constructor(id) {
    this.ok = false;
    this.dpr = 1;

    const canvas = document.createElement('canvas');
    canvas.id = id;
    canvas.setAttribute('aria-hidden', 'true');
    this.canvas = canvas;

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
    });
    if (!gl) return; // no WebGL2: the CSS glass underneath is what everyone sees
    this.gl = gl;

    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error('glass link: ' + gl.getProgramInfoLog(prog));
      }
      this.prog = prog;
    } catch (err) {
      console.info('Gear Drop: glass layer unavailable -', err.message);
      return;
    }

    gl.useProgram(this.prog);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'aQuad');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    for (const name of UNIFORMS) this.u[name] = gl.getUniformLocation(this.prog, name);

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.ok = true;
  }

  /** Match the backing store to a CSS box. A no-op when it is already the right size. */
  size(w, h) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const pxW = Math.max(1, Math.round(w * dpr));
    const pxH = Math.max(1, Math.round(h * dpr));
    this.dpr = dpr;
    if (this.canvas.width === pxW && this.canvas.height === pxH) return;
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.gl?.viewport(0, 0, pxW, pxH);
  }

  /**
   * @param {object} st        the radar's live numbers
   * @param {number[]} origin  where the radar radiates from, in this canvas's CSS pixels
   * @param {object[]} shapes  what to draw
   * @param {object} colors
   */
  draw(st, origin, shapes, colors) {
    const gl = this.gl;
    if (!gl || !this.ok) return;
    const dpr = this.dpr;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!shapes.length) return;

    gl.useProgram(this.prog);
    gl.uniform2f(this.u.uViewport, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.uPad, 2 * dpr);
    gl.uniform2f(this.u.uOrigin, origin[0] * dpr, origin[1] * dpr);
    gl.uniform1f(this.u.uGap, (st.gap ?? 90) * dpr);
    gl.uniform1f(this.u.uPhase, st.phase ?? 0);
    gl.uniform1f(this.u.uSweep, st.sweep ?? 0);
    gl.uniform1f(this.u.uSeeking, st.seeking ?? 0);
    gl.uniform3fv(this.u.uInk, colors.ink);
    gl.uniform3fv(this.u.uRing, colors.ring);
    gl.uniform3fv(this.u.uBeam, colors.beam);

    for (const sh of shapes) {
      gl.uniform4f(
        this.u.uRect,
        sh.rect[0] * dpr, sh.rect[1] * dpr, sh.rect[2] * dpr, sh.rect[3] * dpr,
      );
      gl.uniform1f(this.u.uRadius, sh.radius * dpr);
      gl.uniform3fv(this.u.uTint, sh.tint);
      gl.uniform1f(this.u.uTintA, sh.tintA);
      gl.uniform1f(this.u.uSpec, sh.spec);
      gl.uniform1f(this.u.uFace, sh.face);
      gl.uniform1f(this.u.uBand, sh.band * dpr);
      gl.uniform1f(this.u.uBend, sh.bend * dpr);
      gl.uniform4f(this.u.uRim, sh.rim[0] * dpr, sh.rim[1], sh.rim[2], sh.rim[3]);
      gl.uniform2f(
        this.u.uSpecAt,
        (sh.specAt[0] - 0.5) * sh.rect[2] * dpr,
        (sh.specAt[1] - 0.5) * sh.rect[3] * dpr,
      );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  destroy() {
    this.canvas.remove();
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** The corner radius an element is actually drawing, clamped to what a rounded rect can be. */
function radiusOf(cs, w, h) {
  const r = parseFloat(cs.borderTopLeftRadius) || 0;
  return Math.min(r, Math.min(w, h) / 2);
}

export class GlassLayer {
  /**
   * @param {object} opts
   * @param {() => object} opts.readState  the radar's live state, so the two agree
   */
  constructor({ readState } = {}) {
    this.readState = readState || (() => ({}));
    this.scene = new Pass('glass-layer');
    this.ok = this.scene.ok;
    if (!this.ok) return;

    this.readColors();

    /*
     * The palette is read out of the stylesheet, so it has to be read again when the
     * stylesheet changes its mind.
     *
     * Every colour here - the page behind, the rings, the beam - comes from a custom property,
     * and switching themes rewrites all of them. Read once at boot, the glass would go on
     * drawing a black page under a white one: black panes in the toolbar of a light interface,
     * which is precisely how it looked. The theme lands as one class on the body, whether a
     * person chose it or the system did, so watching that class catches both.
     */
    this._theme = new MutationObserver(() => this.readColors());
    this._theme.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    this.resize();
    addEventListener('resize', () => this.resize(), { passive: true });
  }

  /** Attach behind everything the app draws, and start. */
  mount(parent = document.body) {
    if (!this.ok) return false;
    parent.prepend(this.scene.canvas);
    this._tick = this._tick.bind(this);
    this._raf = requestAnimationFrame(this._tick);
    return true;
  }

  readColors() {
    const cs = getComputedStyle(document.body);
    const read = (n, fallback) => {
      const v = cs.getPropertyValue(n).trim();
      return v ? rgb(v) : fallback;
    };
    this.colors = {
      ink: rgb(cs.backgroundColor) || [0, 0, 0],
      ring: read('--ring-rgb', [0.35, 0.35, 0.4]).map((c) => c * 0.35),
      beam: read('--accent-rgb', [0.04, 0.52, 1]),
      /*
       * The tint is a fill with white text on it, so it takes the darker of the two accents.
       *
       * These panes are what a primary button on the stage actually looks like - the CSS
       * background stands down while this layer is live - so the contrast of the label is
       * decided here, not in the stylesheet. At the bright systemBlue it measured 3.65:1.
       */
      tint: read('--accent-fill-rgb', [0.04, 0.42, 0.8]),
    };
  }

  resize() {
    this.scene.size(innerWidth, innerHeight);
  }

  /**
   * Which controls to put glass behind.
   *
   * Read from the DOM each frame rather than registered once: dialogs open, rows are
   * rebuilt, and a list that goes stale draws glass where a button no longer is. Bounded,
   * because a page that somehow had a hundred buttons should lose the effect, not the
   * frame rate.
   */
  collect() {
    const out = [];
    const nodes = document.querySelectorAll('.cta, .ghost-btn, .icon-btn');
    for (const el of nodes) {
      if (out.length >= MAX_SHAPES) break;
      if (!el.offsetParent && el.style.position !== 'fixed') continue;

      /*
       * Skip dialogs and menus: they render in the top layer, so a pane drawn for one of
       * their buttons lands under the scrim. Those keep the CSS material.
       *
       * `dialog`, not `dialog[open]`: a sheet drops `open` the moment it is told to close
       * and stays on screen for its fade. Matching on `[open]` drew panes during that window
       * which were then uncovered as button-shaped ghosts.
       */
      if (el.closest('dialog, .menu')) continue;

      /*
       * The toolbar opted out of the material entirely.
       *
       * Its buttons are bare tinted glyphs now, the way a navigation bar is on a phone, so a
       * pane drawn behind one would put back exactly the thing that was taken away - and it
       * would be worse than the CSS version was, because this one is lit and moving. The
       * check is on the element rather than on a list of ids so that a control added to the
       * toolbar later inherits the decision instead of quietly breaking it.
       */
      if (el.closest('header')) continue;

      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;

      const cs = getComputedStyle(el);
      const accent = el.classList.contains('cta') || el.classList.contains('on') ||
        el.getAttribute('aria-pressed') === 'true';
      out.push({
        rect: [r.left, r.top, r.width, r.height],
        radius: radiusOf(cs, r.width, r.height),
        tint: accent ? this.colors.tint : [0.55, 0.57, 0.62],
        tintA: accent ? 0.62 : 0.14,
        spec: el.matches(':hover') ? 1 : 0.35,
        specAt: [
          (parseFloat(el.style.getPropertyValue('--gx')) || 30) / 100,
          (parseFloat(el.style.getPropertyValue('--gy')) || 0) / 100,
        ],
        face: 1, // a button IS the glass, edge to edge
        band: 14,
        bend: 26,
        rim: [14, 5, 0.5, 0.16], // broad and strong: there is nothing underneath to argue with
      });
    }
    return out;
  }

  _tick() {
    this._raf = requestAnimationFrame(this._tick);
    if (document.hidden) return;

    /*
     * Read the radar every frame even when nothing will be drawn.
     *
     * It is arithmetic - it advances the mirrored phase and sweep from elapsed time - and it is
     * what keeps the rings inside a pane lined up with the rings on the page behind it. Letting
     * it lapse while idle would mean the first frame after a control appears carries whatever
     * drift accumulated while nobody was looking, and the glass would show a radar a little out
     * of step with the real one.
     */
    const st = this.readState() || {};

    const now = performance.now();
    if (this._idle && now - this._scanAt < IDLE_SCAN_MS) return;
    this._scanAt = now;

    const shapes = this.collect();
    // Already wiped on the frame the last shape went; there is nothing left to clear.
    if (!shapes.length && this._idle) return;
    this._idle = shapes.length === 0;

    this.scene.draw(
      st,
      [st.originX ?? innerWidth / 2, st.originY ?? innerHeight],
      shapes,
      this.colors,
    );
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this._theme?.disconnect();
    this.scene.destroy();
  }
}

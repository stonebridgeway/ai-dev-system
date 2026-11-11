/**
 * The Knowledge Galaxy's WebGL: stars as glowing points, links as lines.
 *
 * Browser code, inlined into the page with the rest of `src/galaxy/` by
 * `src/core/galaxy-page.mjs`. WebGL 1 and nothing else, so it runs wherever a
 * browser draws anything at all.
 *
 * Everything is drawn additively with no depth test: stars are light, so where
 * a constellation's stars overlap it glows brighter, and the order they are
 * drawn in does not matter.
 */

const POINT_VERTEX = `
attribute vec3 aPosition;
attribute vec3 aColor;
attribute float aSize;
attribute float aGlow;
uniform mat4 uView;
uniform mat4 uProjection;
uniform float uPixelScale;
uniform float uMaxSize;
varying vec3 vColor;
varying float vGlow;
void main() {
  vec4 viewPosition = uView * vec4(aPosition, 1.0);
  gl_Position = uProjection * viewPosition;
  float depth = max(-viewPosition.z, 0.001);
  float emphasis = aGlow > 1.0 ? 1.0 + (aGlow - 1.0) * 0.7 : 1.0;
  gl_PointSize = clamp(aSize * emphasis * uPixelScale / depth, 2.0, uMaxSize);
  vColor = aColor;
  vGlow = aGlow;
}`;

const POINT_FRAGMENT = `
precision mediump float;
varying vec3 vColor;
varying float vGlow;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float halo = exp(-r2 * 4.5);
  float core = smoothstep(0.22, 0.0, r2);
  vec3 color = mix(vColor, vec3(1.0), core * 0.55);
  // Additive blending: a dense constellation brightens where its stars
  // overlap, so each star alone stays dim enough not to burn the core white.
  float intensity = (halo * 0.6 + core * 0.45) * min(vGlow, 1.6);
  gl_FragColor = vec4(color * intensity, 1.0);
}`;

const LINE_VERTEX = `
attribute vec3 aPosition;
attribute vec4 aColor;
uniform mat4 uView;
uniform mat4 uProjection;
varying vec4 vColor;
void main() {
  gl_Position = uProjection * uView * vec4(aPosition, 1.0);
  vColor = aColor;
}`;

const LINE_FRAGMENT = `
precision mediump float;
varying vec4 vColor;
void main() { gl_FragColor = vec4(vColor.rgb * vColor.a, 1.0); }`;

function compile(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "shader failed");
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "link failed");
  return program;
}

function locations(gl, program, attributes, uniforms) {
  return {
    attributes: Object.fromEntries(attributes.map((name) => [name, gl.getAttribLocation(program, name)])),
    uniforms: Object.fromEntries(uniforms.map((name) => [name, gl.getUniformLocation(program, name)]))
  };
}

/**
 * Set up the scene on a canvas, or return null when the browser has no WebGL.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ positions: Float32Array, sizes: Float32Array }} stars - Fixed for the page's life.
 */
export function createStarRenderer(canvas, { positions, sizes }) {
  const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
  if (!gl) return null;
  const count = sizes.length;
  const points = { program: compile(gl, POINT_VERTEX, POINT_FRAGMENT) };
  Object.assign(points, locations(gl, points.program, ["aPosition", "aColor", "aSize", "aGlow"], ["uView", "uProjection", "uPixelScale", "uMaxSize"]));
  const lines = { program: compile(gl, LINE_VERTEX, LINE_FRAGMENT) };
  Object.assign(lines, locations(gl, lines.program, ["aPosition", "aColor"], ["uView", "uProjection"]));

  const upload = (handle, data, usage) => {
    const target = handle || gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, target);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    return target;
  };
  const buffers = {
    aPosition: upload(null, positions, gl.STATIC_DRAW),
    aSize: upload(null, sizes, gl.STATIC_DRAW),
    aColor: upload(null, new Float32Array(count * 3), gl.DYNAMIC_DRAW),
    aGlow: upload(null, new Float32Array(count).fill(1), gl.DYNAMIC_DRAW)
  };
  const lineSets = new Map();
  const maxPointSize = Math.min(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)?.[1] || 64, 72);

  const bind = (program, name, buffer, size) => {
    const location = program.attributes[name];
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    return location;
  };

  return {
    /** RGB per star, 0–1. */
    setColors(colors) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.aColor);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors);
    },
    /** Brightness per star: 1 normal, below 1 dimmed, above 1 highlighted and larger. */
    setGlow(glow) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.aGlow);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, glow);
    },
    /** A named set of line segments: xyz pairs, and rgba per vertex. */
    setLines(name, position, color) {
      const previous = lineSets.get(name);
      lineSets.set(name, {
        position: upload(previous?.position, position, gl.DYNAMIC_DRAW),
        color: upload(previous?.color, color, gl.DYNAMIC_DRAW),
        vertices: position.length / 3
      });
    },
    /**
     * @param {{ view: Float32Array, projection: Float32Array, pixelScale: number, lines: string[] }} frame
     */
    draw({ view, projection, pixelScale, lines: lineNames }) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.016, 0.02, 0.04, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      gl.useProgram(lines.program);
      gl.uniformMatrix4fv(lines.uniforms.uView, false, view);
      gl.uniformMatrix4fv(lines.uniforms.uProjection, false, projection);
      for (const name of lineNames) {
        const set = lineSets.get(name);
        if (!set?.vertices) continue;
        const used = [bind(lines, "aPosition", set.position, 3), bind(lines, "aColor", set.color, 4)];
        gl.drawArrays(gl.LINES, 0, set.vertices);
        for (const location of used) gl.disableVertexAttribArray(location);
      }

      gl.useProgram(points.program);
      gl.uniformMatrix4fv(points.uniforms.uView, false, view);
      gl.uniformMatrix4fv(points.uniforms.uProjection, false, projection);
      gl.uniform1f(points.uniforms.uPixelScale, pixelScale);
      gl.uniform1f(points.uniforms.uMaxSize, maxPointSize);
      const used = [
        bind(points, "aPosition", buffers.aPosition, 3),
        bind(points, "aColor", buffers.aColor, 3),
        bind(points, "aSize", buffers.aSize, 1),
        bind(points, "aGlow", buffers.aGlow, 1)
      ];
      gl.drawArrays(gl.POINTS, 0, count);
      for (const location of used) gl.disableVertexAttribArray(location);
    }
  };
}

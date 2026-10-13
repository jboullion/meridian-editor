// The original D3D client's room lighting, as GLSL, for the 3D preview.
//
// Ported from meridian-browser packages/render/src/lighting.ts (GPL-2.0, same
// authors), without its own additions (enhanced lighting, light sources). Keep
// the formulas in step:
//
// Brightness (clientd3d/draw3d.c GetLightPaletteIndex at distance FINENESS, as the
// D3D path uses fog for distance; d3drender.c *Extract):
//   sector light > 127 ("ambient" sectors):
//     row light  = min(255, 8 * viewerLight + ambient)
//     index      = trunc((rowLight + light - 192) * 64 / 256)
//     index      = (lightScale * index) >> 10                    (sun shading, if any)
//   sector light <= 127 (no ambient):
//     index      = trunc(min(255, 16 * viewerLight) * 64 / 256) + light / 2
//   index clamped to 0..63; grey = index * 239 / 64              (COLOR_AMBIENT = 239)
// Sun shading (walls and sloped planes; draw3d.c SetLightingInfo):
//   lightScale = ((n . sun) >> 10 + 1024) >> 1, then (1024 - shade) + lightScale * shade >> 10
// Fog (d3drender.c D3DRenderFogEndCalc): linear to black over view depth, ending at
//   no ambient:  16384 + light * 1024 + viewerLight * 64
//   ambient:     32768 + max(0, light - 192) * 1024 + viewerLight * 64 + ambient * 1024
//
// Pixels are palette indices (an R8 texture) looked up in the 256-colour palette;
// index 254 is transparent.
//
// Light maps (d3dlighting.c D3DRenderLMapPost*Add): each light source adds
//   radial(in-plane distance) * falloff(distance off the plane) * colour * texel,
// up to 32 sources (the client allows 150), the nearest the viewer.
//
// Editor additions: uGame 0 draws the flat light levels the preview used before
// (no ambient or viewer light), uPlaceholder draws a grey checker for faces with
// no texture, and aSelect tints the selected sectors.

export const lightingUniforms = () => ({
  uPalette: { value: null as unknown },
  uMap: { value: null as unknown },
  /** 1: the client's lighting; 0: flat sector light levels. */
  uGame: { value: 0 },
  uPlaceholder: { value: 0 },
  /** Player light, 0..255. */
  uViewerLight: { value: 0 },
  /** Room ambient light, 0..255. */
  uAmbient: { value: 0 },
  /** Sun direction (client x/y, unit) and shade amount (0..1024). */
  uSun: { value: [1, 0] as [number, number] },
  uShade: { value: 0 },
  uFog: { value: 0 },
  /** Client fine units per scene unit (the scene uses 1 unit = 1 grid square). */
  uFinePerUnit: { value: 1024 },
  /** Texture scroll offset (s, t). */
  uScroll: { value: [0, 0] as [number, number] },
  /** Light sources: xyz in client fine units, w = reach (DLIGHT_SCALE / 2), negative for a highlight light. */
  uLightPos: { value: new Float32Array(MAX_LIGHTS * 4) },
  /** Light colours, 0..1. */
  uLightColor: { value: new Float32Array(MAX_LIGHTS * 3) },
  uLightCount: { value: 0 },
});

export const MAX_LIGHTS = 32;

export const roomVertexShader = /* glsl */ `
in float aLight;
in vec3 aShade;
in float aSelect;
out vec2 vUv;
out float vLight;
out float vScale;
out float vDepth;
out float vSelect;
out vec3 vClient;
out vec2 vNormal2;
uniform vec2 uSun;
uniform float uShade;
uniform float uFinePerUnit;
uniform vec2 uScroll;

void main() {
  vUv = uv + uScroll;
  vLight = aLight;
  vSelect = aSelect;
  float scale = 1024.0;
  if (aShade.z > 0.5 && uShade > 0.0) {
    float ls = floor(dot(aShade.xy * 1024.0, uSun * 1024.0) / 1024.0);
    ls = floor((ls + 1024.0) / 2.0);
    ls = (1024.0 - uShade) + floor(ls * uShade / 1024.0);
    scale = clamp(ls, 0.0, 1024.0);
  }
  vScale = scale;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z * uFinePerUnit;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vClient = vec3(world.x, world.z, world.y) * uFinePerUnit; // scene (x, z up, y) -> client (x, y, z)
  vNormal2 = aShade.xy;
  gl_Position = projectionMatrix * mv;
}
`;

export const roomFragmentShader = /* glsl */ `
precision highp float;
in vec2 vUv;
in float vLight;
in float vScale;
in float vDepth;
in float vSelect;
in vec3 vClient;
in vec2 vNormal2;
out vec4 fragColor;
uniform vec4 uLightPos[32];
uniform vec3 uLightColor[32];
uniform int uLightCount;
uniform sampler2D uMap;
uniform sampler2D uPalette;
uniform float uGame;
uniform float uPlaceholder;
uniform float uViewerLight;
uniform float uAmbient;
uniform float uFog;

float lightIndex(float light, float scale) {
  float idx;
  if (light > 127.0) {
    float row = min(255.0, floor(8.0 * uViewerLight) + uAmbient);
    idx = trunc((row + light - 192.0) * 64.0 / 256.0);
    if (scale != 1024.0) idx = floor(scale * idx / 1024.0);
  } else {
    idx = floor(min(255.0, 16.0 * uViewerLight) * 64.0 / 256.0) + floor(light / 2.0);
  }
  return clamp(idx, 0.0, 63.0);
}

void main() {
  vec3 rgb;
  if (uPlaceholder > 0.5) {
    // A grey checker, eight texels a check, like a 64x64 texture.
    vec2 c = floor(vUv * 8.0);
    float on = mod(c.x + c.y, 2.0);
    rgb = mix(vec3(110.0, 110.0, 122.0), vec3(150.0, 150.0, 162.0), on) / 255.0;
  } else {
    float index = floor(texture(uMap, vUv).r * 255.0 + 0.5);
    if (index == 254.0) discard;
    rgb = texelFetch(uPalette, ivec2(int(index), 0), 0).rgb;
  }
  float light = floor(vLight + 0.5);
  float grey;
  float fog = 1.0;
  if (uGame > 0.5) {
    grey = floor(lightIndex(light, vScale) * 239.0 / 64.0) / 255.0;
    float fogEnd = light <= 127.0
      ? 16384.0 + light * 1024.0 + uViewerLight * 64.0
      : 32768.0 + max(0.0, light - 192.0) * 1024.0 + uViewerLight * 64.0 + uAmbient * 1024.0;
    if (uFog > 0.5) fog = clamp((fogEnd - vDepth) / fogEnd, 0.0, 1.0);
  } else {
    // The flat look: each sector's level, low seven bits, never quite black.
    grey = 0.3 + 0.7 * mod(light, 128.0) / 127.0;
  }
  // Light maps: only in the client's lighting.
  vec3 added = vec3(0.0);
  if (uGame > 0.5) {
    bool wall = length(vNormal2) > 0.5;
    bool xMajor = abs(vNormal2.x) > abs(vNormal2.y);
    for (int i = 0; i < 32; i++) {
      if (i >= uLightCount) break;
      vec3 d = vClient - uLightPos[i].xyz;
      float reach = abs(uLightPos[i].w);
      bool highlight = uLightPos[i].w < 0.0;
      float off, radial;
      if (!wall) { off = abs(d.z); radial = length(d.xy); }
      else if (xMajor) { off = abs(d.x); radial = length(d.yz); }
      else { off = abs(d.y); radial = length(d.xz); }
      // D3DRenderLMapPostFloorAdd: a highlight light (on the floor) has no falloff on floors, not ceilings
      float falloff = highlight && !wall && d.z < 64.0 ? 1.0 : max(0.0, 1.0 - off / reach);
      added += max(0.0, 1.0 - radial / reach) * falloff * uLightColor[i];
    }
  }
  vec3 c = min(vec3(1.0), rgb * grey + rgb * added) * fog;
  if (vSelect > 0.5) c = min(vec3(1.0), c * vec3(1.35, 0.95, 0.5) + vec3(0.08, 0.05, 0.0));
  fragColor = vec4(c, 1.0);
}
`;

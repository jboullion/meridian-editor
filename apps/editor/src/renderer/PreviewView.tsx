// 3D preview of the compiled room, textured the way the client draws it:
// geometry from the client's own wall/floor/ceiling extraction (preview/),
// grid textures from the texture library, scrolling and cycling animations.
// Faces with no texture show a checker. One grid square is one unit; client y
// runs along three's z.
//
// Lighting is the client's (preview/lighting.ts): palette textures lit by each
// sector's light, the room's ambient light and the player's light, with sun
// shading on walls and slopes, and fog while walking. The ambient light and the
// sun come from the room's Kod class at the chosen game hour (preview/gameLight.ts).
// "Flat" lighting shows each sector's light level instead.
//
// Walk mode puts the camera at a player's eyes, moved by the client's own rules
// (preview/walker.ts): WASD or the arrows, Shift to run, drag to look, Esc to stop.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FINENESS, type RooFile } from "@meridian-editor/roo";
import { compiled } from "./compiler.ts";
import { kodRoomLight, type KodRoomLight } from "./kod/kodRooms.ts";
import { dlightScale, isHighlight, lightColor } from "./kod/kodLights.ts";
import { currentKodRoom, kod, roomLights, useKod, useKodRoom } from "./kod/kodStore.ts";
import { gameLight, type GameLight } from "./preview/gameLight.ts";
import { lightingUniforms, MAX_LIGHTS, roomFragmentShader, roomVertexShader } from "./preview/lighting.ts";
import { toClientRoom, type Room } from "./preview/clientRoom.ts";
import { EYE_HEIGHT, floorBase, Walker } from "./preview/walker.ts";
import { stopWalk, useWalk, walk } from "./preview/walkStore.ts";
import { buildRoomGeometry, type Batch } from "./preview/roomGeometry.ts";
import { editor, selectOne, useEditor, type PreviewLight } from "./store.ts";
import { parseBgf, type Bgf } from "./textures/bgf.ts";
import { host as fileHost } from "./host.ts";
import { library, loadBgf, palette } from "./textures/library.ts";

interface BuiltMesh {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  batch: Batch;
  bgf: Bgf | null;
  /** Bitmaps to cycle through (first bitmap of each group), or just the first. */
  frames: THREE.Texture[];
  /** Per-vertex sector (0-based), in the mesh's vertex order. */
  sectors: Int32Array;
}

interface Built {
  file: RooFile;
  libraryVersion: number;
  group: THREE.Group;
  meshes: BuiltMesh[];
}

export function PreviewView(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x101216);
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(ORBIT_FOV, 1, 0.02, 2000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.screenSpacePanning = true;

    const textures = new Map<string, THREE.DataTexture>();
    const paletteTex = paletteTexture();
    let built: Built | null = null;
    let pending: RooFile | null = null;
    let fittedDoc: unknown = null;
    let seenSeq = editor.get().viewSeq;
    let highlighted = "-";
    let frame = 0;
    const start = performance.now();

    // Light sources from the room's Kod objects (D3DLMapsStaticGet).
    let sources: LightSource[] = [];
    let sourcesKey = "";
    let buildSeq = 0;
    /** How high each sprite's top is (client units above its feet), by .bgf name; null if it can't be read. */
    const spriteTops = new Map<string, number | null>();
    let spriteVersion = 0;
    const lightPos = new Float32Array(MAX_LIGHTS * 4);
    const lightRgb = new Float32Array(MAX_LIGHTS * 3);

    // Walk mode.
    const walker = new Walker();
    let clientRoom: Room | null = null;
    let seenStart = -1;
    let walking = false;
    let pitch = 0;
    let lastFrame = performance.now();
    const held = new Set<string>();

    const textureFor = (id: number, bgf: Bgf, bitmap: number): THREE.DataTexture => {
      const key = `${id}:${bitmap}`;
      let t = textures.get(key);
      if (!t) {
        t = bitmapTexture(bgf, bitmap);
        textures.set(key, t);
      }
      return t;
    };

    const disposeBuilt = (): void => {
      if (!built) return;
      scene.remove(built.group);
      for (const m of built.meshes) {
        m.mesh.geometry.dispose();
        m.mesh.material.dispose();
      }
      built = null;
    };

    /** Load the textures a room uses, then build it (unless a newer compile came in). */
    const prepare = async (file: RooFile, libraryVersion: number): Promise<void> => {
      const ids = new Set<number>();
      for (const s of file.sidedefs) [s.normal, s.above, s.below].forEach((t) => t && ids.add(t));
      for (const s of file.sectors) [s.floorTexture, s.ceilingTexture].forEach((t) => t && ids.add(t));
      const bgfs = new Map<number, Bgf>();
      await Promise.all(
        [...ids].map(async (id) => {
          const b = await loadBgf(id);
          if (b && b.bitmaps.length) bgfs.set(id, b);
        }),
      );
      if (pending !== file) return;
      pending = null;
      build(file, libraryVersion, bgfs);
    };

    const build = (file: RooFile, libraryVersion: number, bgfs: Map<number, Bgf>): void => {
      disposeBuilt();
      const room = toClientRoom(file);
      clientRoom = room;
      buildSeq++;
      // Edits while walking: keep walking where we are, in the new room.
      walker.room = room;
      const batches = buildRoomGeometry(room, (id) => {
        const b = bgfs.get(id);
        const bmp = b?.bitmaps[0];
        // Unknown textures draw as the checker too, at the placeholder's size.
        return bmp ? { width: bmp.width, height: bmp.height, shrink: b!.shrink } : { width: 64, height: 64, shrink: 1 };
      });
      const group = new THREE.Group();
      const meshes: BuiltMesh[] = [];
      for (const batch of batches.values()) {
        const n = batch.positions.length / 3;
        if (n === 0) continue;
        const pos = new Float32Array(n * 3);
        const uv = new Float32Array(n * 2);
        const light = new Float32Array(n);
        const shade = new Float32Array(n * 3);
        const sectors = new Int32Array(n);
        for (let i = 0; i < n; i++) {
          // Swapping y and z mirrors the room, so each triangle's winding is reversed too.
          const src = i - (i % 3) + [0, 2, 1][i % 3]!;
          pos[i * 3] = batch.positions[src * 3]! / FINENESS;
          pos[i * 3 + 1] = batch.positions[src * 3 + 2]! / FINENESS;
          pos[i * 3 + 2] = batch.positions[src * 3 + 1]! / FINENESS;
          uv[i * 2] = batch.uvs[src * 2]!;
          uv[i * 2 + 1] = batch.uvs[src * 2 + 1]!;
          light[i] = batch.lights[src]!;
          for (let k = 0; k < 3; k++) shade[i * 3 + k] = batch.shade[src * 3 + k]!;
          sectors[i] = batch.sectors[src]!;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
        g.setAttribute("aLight", new THREE.BufferAttribute(light, 1));
        g.setAttribute("aShade", new THREE.BufferAttribute(shade, 3));
        g.setAttribute("aSelect", new THREE.BufferAttribute(new Float32Array(n), 1));
        g.computeBoundingSphere();

        const bgf = bgfs.get(batch.textureId) ?? null;
        let frames: THREE.Texture[] = [paletteTex];
        if (bgf) {
          const groupBitmap = (gi: number): number => (bgf.groups.length ? (bgf.groups[gi % bgf.groups.length]![0] ?? 0) : 0);
          const bitmaps = batch.animation?.kind === "cycle" && bgf.groups.length > 1 ? bgf.groups.map((_, gi) => groupBitmap(gi)) : [0];
          frames = bitmaps.map((b) => textureFor(batch.textureId, bgf, b));
        }
        const uniforms = lightingUniforms();
        uniforms.uMap.value = frames[0];
        uniforms.uPalette.value = paletteTex;
        uniforms.uPlaceholder.value = bgf ? 0 : 1;
        const material = new THREE.ShaderMaterial({
          glslVersion: THREE.GLSL3,
          uniforms,
          vertexShader: roomVertexShader,
          fragmentShader: roomFragmentShader,
          side: THREE.FrontSide,
        });
        const mesh = new THREE.Mesh(g, material);
        group.add(mesh);
        meshes.push({ mesh, batch, bgf, frames, sectors });
      }
      scene.add(group);
      built = { file, libraryVersion, group, meshes };
      highlighted = "-";
      if (fittedDoc !== editor.get().doc) {
        fitCamera(file);
        fittedDoc = editor.get().doc;
      }
    };

    const fitCamera = (file: RooFile): void => {
      const w = file.width / FINENESS;
      const h = file.height / FINENESS;
      const size = Math.max(w, h, 4);
      controls.target.set(w / 2, 0, h / 2);
      // Far enough back and up that the whole room box fits at 60° FOV.
      camera.position.set(w / 2, size * 1.05, h / 2 + size * 0.85);
      controls.update();
    };

    const refresh = (): void => {
      const result = compiled.get().result;
      const version = library.get().version;
      if (!result) return;
      if (built && built.file === result.file && built.libraryVersion === version) return;
      if (pending === result.file) return;
      if (built && built.libraryVersion !== version) {
        for (const t of textures.values()) t.dispose();
        textures.clear();
      }
      pending = result.file;
      void prepare(result.file, version);
    };

    const highlight = (): void => {
      if (!built) return;
      const sel = editor.get().selection;
      const sectors = sel?.kind === "sector" ? new Set(sel.indices) : null;
      const key = sectors ? [...sectors].join(",") : "";
      if (key === highlighted) return;
      highlighted = key;
      for (const m of built.meshes) {
        const sel = m.mesh.geometry.getAttribute("aSelect") as THREE.BufferAttribute;
        const arr = sel.array as Float32Array;
        for (let i = 0; i < m.sectors.length; i++) arr[i] = sectors?.has(m.sectors[i]!) ? 1 : 0;
        sel.needsUpdate = true;
      }
    };

    /** Texture animation (roomanim.c timing; scroll steps as d3drender.c applies them). */
    const animate = (timeMs: number): void => {
      if (!built) return;
      for (const m of built.meshes) {
        const a = m.batch.animation;
        if (!a || !m.bgf) continue;
        const steps = Math.floor(timeMs / a.periodMs);
        if (a.kind === "cycle") {
          m.mesh.material.uniforms.uMap!.value = m.frames[steps % m.frames.length]!;
          continue;
        }
        const bmp = m.bgf.bitmaps[0]!;
        let s: number;
        let t: number;
        if (a.surface === "wall") {
          const sign = a.backwards ? -1 : 1;
          t = (sign * steps * a.dx * m.bgf.shrink) / bmp.height;
          s = (-sign * steps * a.dy * m.bgf.shrink) / bmp.width;
        } else {
          s = (steps * a.dx) / FINENESS;
          t = (-steps * a.dy) / FINENESS;
        }
        // u is s, v is t.
        m.mesh.material.uniforms.uScroll!.value = [s - Math.floor(s), t - Math.floor(t)];
      }
    };

    /**
     * The room's light sources at the hour: where each object stands, its light at
     * the top of its sprite (objectsView: ground + sprite top), its size and colour.
     */
    const updateSources = (hour: number): void => {
      const k = kod.get();
      const key = `${buildSeq}|${hour}|${spriteVersion}|${currentKodRoom().room?.path ?? ""}|${k.index ? 1 : 0}|${editor.get().room?.things.map((t) => `${t.x},${t.y}`).join(";")}`;
      if (key === sourcesKey || !clientRoom) return;
      sourcesKey = key;
      const room = clientRoom;
      sources = roomLights(hour).flatMap(({ object: o, light }) => {
        const x = (o.col - 1) * FINENESS + o.fineCol * 16;
        const y = (o.row - 1) * FINENESS + o.fineRow * 16;
        const ground = floorBase(room, x, y);
        if (ground === null) return [];
        let top = 0;
        if (light.icon) {
          const t = spriteTops.get(light.icon);
          if (t === undefined) {
            spriteTops.set(light.icon, null);
            void fileHost
              .readResource(light.icon)
              .then(parseBgf)
              .then((bgf) => {
                const b = bgf.bitmaps[bgf.groups[0]?.[0] ?? 0];
                spriteTops.set(light.icon!, b ? (16 * b.height) / bgf.shrink - b.yOffset * 4 : 0);
                spriteVersion++;
              })
              .catch(() => {});
          } else if (t !== null) top = t;
        }
        const highlight = isHighlight(light.flags);
        const c = lightColor(light.color);
        return [{ x, y, z: ground + top, scale: dlightScale(light.intensity) * (highlight ? 0.1 : 1), r: c.r, g: c.g, b: c.b, highlight }];
      });
    };

    /** The light uniforms: the client's lighting from the room's Kod at the game hour, or flat. */
    const applyLight = (l: PreviewLight): void => {
      if (!built) return;
      const g = l.mode === "game" ? currentGameLight(l) : null;
      const a = g ? (g.sunAngle * 2 * Math.PI) / 4096 : 0;
      let count = 0;
      if (g && l.sources) {
        updateSources(l.hour);
        // The 32 nearest the viewer.
        const vx = camera.position.x * FINENESS;
        const vy = camera.position.z * FINENESS;
        const near = sources.length > MAX_LIGHTS ? [...sources].sort((p, q) => Math.hypot(p.x - vx, p.y - vy) - Math.hypot(q.x - vx, q.y - vy)) : sources;
        for (const s of near.slice(0, MAX_LIGHTS)) {
          lightPos.set([s.x, s.y, s.z, (s.highlight ? -1 : 1) * (s.scale / 2)], count * 4);
          lightRgb.set([s.r / 255, s.g / 255, s.b / 255], count * 3);
          count++;
        }
      }
      for (const m of built.meshes) {
        const u = m.mesh.material.uniforms;
        u.uGame!.value = g ? 1 : 0;
        u.uLightCount!.value = count;
        u.uLightPos!.value = lightPos;
        u.uLightColor!.value = lightRgb;
        if (!g) continue;
        u.uAmbient!.value = g.ambient;
        u.uViewerLight!.value = g.viewerLight;
        u.uSun!.value = [Math.cos(a), Math.sin(a)];
        u.uShade!.value = Math.floor((g.shade * FINENESS) / 64);
        u.uFog!.value = walking && l.fog ? 1 : 0;
      }
    };

    const resize = (): void => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      setFov();
    };

    /** The client's field of view while walking (50 degrees across, 32 up, whichever fits); 60 to orbit. */
    const setFov = (): void => {
      const deg = Math.PI / 180;
      const clientAspect = Math.tan((CLIENT_FOV.horizontal / 2) * deg) / Math.tan((CLIENT_FOV.vertical / 2) * deg);
      camera.fov = !walking
        ? ORBIT_FOV
        : camera.aspect >= clientAspect
          ? CLIENT_FOV.vertical
          : (2 * Math.atan(Math.tan((CLIENT_FOV.horizontal / 2) * deg) / camera.aspect)) / deg;
      camera.updateProjectionMatrix();
    };

    /** Where to start walking: the request, else the Kod arrival square, else the middle of the first sector. */
    const beginWalk = (at: { x: number; y: number } | null): void => {
      const room = clientRoom!;
      walker.room = room;
      const inside = (p: { x: number; y: number } | null): p is { x: number; y: number } => !!p && walker.floorBase(p.x, p.y) !== null;
      const t = currentKodRoom().room?.teleport;
      const arrival = t ? { x: (t.col - 1) * FINENESS + t.fineCol * 16, y: (t.row - 1) * FINENESS + t.fineRow * 16 } : null;
      const leaf = room.nodes.find((n) => n.type === "leaf" && n.sector && n.points.length);
      const middle =
        leaf && leaf.type === "leaf"
          ? { x: leaf.points.reduce((s, p) => s + p.x, 0) / leaf.points.length, y: leaf.points.reduce((s, p) => s + p.y, 0) / leaf.points.length }
          : null;
      const p = [at, arrival, middle].find(inside);
      if (!p) {
        stopWalk();
        editor.set({ message: { text: "Nowhere to stand: walk mode needs a sector inside the room box.", kind: "error" } });
        return;
      }
      walker.place(Math.round(p.x), Math.round(p.y));
      pitch = 0;
      walking = true;
      controls.enabled = false;
      held.clear();
      setFov();
    };

    const endWalk = (): void => {
      walking = false;
      controls.enabled = true;
      setFov();
      // Orbit about a point just ahead of where we stood.
      const ahead = new THREE.Vector3();
      camera.getWorldDirection(ahead);
      controls.target.copy(camera.position).addScaledVector(ahead, 3);
      controls.update();
    };

    const stepWalk = (dt: number): void => {
      const on = (...codes: string[]): number => (codes.some((c) => held.has(c)) ? 1 : 0);
      const run = on("ShiftLeft", "ShiftRight") === 1;
      walker.turnKeys(on("ArrowRight") - on("ArrowLeft"), run, dt);
      pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch + ((on("PageUp") - on("PageDown")) * PITCH_RATE * dt) / 1000));
      if (held.has("Home")) pitch = 0;
      walker.update({ forward: on("KeyW", "ArrowUp") - on("KeyS", "ArrowDown"), strafe: on("KeyD") - on("KeyA"), run }, dt);
      camera.position.set(walker.x / FINENESS, (walker.z + EYE_HEIGHT + walker.bounce) / FINENESS, walker.y / FINENESS);
      const a = (walker.angle * 2 * Math.PI) / 4096;
      // Client (cos a, sin a) along x, y is the scene's X, Z.
      camera.rotation.set(pitch, Math.atan2(-Math.cos(a), -Math.sin(a)), 0, "YXZ");
      const s = walk.get();
      if (s.x !== walker.x || s.y !== walker.y || s.z !== walker.z || s.angle !== walker.angle) walk.set({ x: walker.x, y: walker.y, z: walker.z, angle: walker.angle });
    };

    const WALK_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight", "PageUp", "PageDown", "Home", "Escape"]);
    const onKey = (e: KeyboardEvent): void => {
      if (!walking || !WALK_KEYS.has(e.code) || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      // Walk keys don't reach the editor's shortcuts (S, D, A ...) while walking.
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "keydown" && e.code === "Escape") stopWalk();
      else if (e.type === "keydown") held.add(e.code);
      else held.delete(e.code);
    };
    const onBlur = (): void => held.clear();

    const loop = (): void => {
      frame = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(100, now - lastFrame);
      lastFrame = now;
      refresh();
      const w = walk.get();
      if (w.active && clientRoom) {
        if (w.startSeq !== seenStart) {
          seenStart = w.startSeq;
          beginWalk(w.start);
        }
        if (walking) stepWalk(dt);
      } else if (walking) endWalk();
      highlight();
      const s = editor.get();
      if (built) for (const m of built.meshes) m.mesh.visible = !m.batch.ceiling || s.ceilings || walking;
      if (s.viewSeq !== seenSeq) {
        seenSeq = s.viewSeq;
        if (s.viewRequest?.kind === "fit" && built) fitCamera(built.file);
      }
      animate(performance.now() - start);
      applyLight(s.light);
      if (!walking) controls.update();
      renderer.render(scene, camera);
    };

    // Click a surface to select its sector; while walking, drag to look around.
    const raycaster = new THREE.Raycaster();
    let downAt: [number, number] | null = null;
    let lookFrom: [number, number] | null = null;
    const onDown = (e: PointerEvent): void => {
      downAt = [e.clientX, e.clientY];
      if (walking) {
        lookFrom = [e.clientX, e.clientY];
        renderer.domElement.setPointerCapture(e.pointerId);
      }
    };
    const onLook = (e: PointerEvent): void => {
      if (!walking || !lookFrom) return;
      walker.turnBy((e.clientX - lookFrom[0]) * 4);
      pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch - (e.clientY - lookFrom[1]) * 0.004));
      lookFrom = [e.clientX, e.clientY];
    };
    const onUp = (e: PointerEvent): void => {
      lookFrom = null;
      if (!downAt || !built || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
      const r = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const visible = built.meshes.filter((m) => m.mesh.visible);
      const hit = raycaster.intersectObjects(visible.map((m) => m.mesh))[0];
      const owner = hit && visible.find((m) => m.mesh === hit.object);
      const sector = owner && hit.face ? owner.sectors[hit.face.a] : undefined;
      if (sector !== undefined && sector >= 0) selectOne({ kind: "sector", index: sector });
    };

    const observer = new ResizeObserver(resize);
    observer.observe(host);
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("pointermove", onLook);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onBlur);
    resize();
    loop();

    // Development only: a look at what was built, for tests.
    if (import.meta.env.DEV) {
      Object.assign(window, {
        __preview: () =>
          built && {
            meshes: built.meshes.length,
            textured: built.meshes.filter((m) => m.bgf).length,
            animated: built.meshes.filter((m) => m.batch.animation && m.bgf).length,
            triangles: built.meshes.reduce((n, m) => n + m.sectors.length / 3, 0),
          },
      });
    }

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onBlur);
      controls.dispose();
      pending = null;
      disposeBuilt();
      for (const t of textures.values()) t.dispose();
      paletteTex.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div ref={hostRef} className="preview-host" aria-label="3D preview">
      <WalkHud />
      <LightHud />
    </div>
  );
}

interface LightSource {
  /** Client fine units. */
  x: number;
  y: number;
  z: number;
  /** DLIGHT_SCALE: full width; it reaches half. */
  scale: number;
  r: number;
  g: number;
  b: number;
  highlight: boolean;
}

const ORBIT_FOV = 60;
/** The D3D client's view (ORIGINAL_FOV in meridian-browser's roomScene.ts). */
const CLIENT_FOV = { horizontal: 180 / 3.6, vertical: 180 / 5.6 };
const PITCH_RATE = 1.2;
const MAX_PITCH = 1.2;

/** Where the walker is, and the keys, over the 3D view while walking. */
function WalkHud(): React.JSX.Element | null {
  const active = useWalk((s) => s.active);
  const x = useWalk((s) => s.x);
  const y = useWalk((s) => s.y);
  const z = useWalk((s) => s.z);
  if (!active) return null;
  return (
    <div className="walk-hud">
      <strong>Walking</strong> · Kod row {1 + Math.floor(y / FINENESS)}, col {1 + Math.floor(x / FINENESS)} · floor {Math.round(z / 16)}
      <span className="hint"> · WASD or arrows, Shift runs, drag to look, PgUp/PgDn, Esc stops</span>
    </div>
  );
}

/** The open room's Kod light settings (Room's defaults when no class is found). */
function currentKodLight(): KodRoomLight | null {
  const index = kod.get().index;
  const k = currentKodRoom().room;
  return index && k ? kodRoomLight(index, k) : null;
}

const ROOM_DEFAULT_LIGHT: KodRoomLight = {
  baseLight: 255,
  outsideFactor: 10,
  directionalPercent: 0,
  sources: { baseLight: "LIGHT_MAX (Room's default)", outsideFactor: "OUTDOORS_COMPLETE (Room's default)", directionalPercent: "0 (Room's default)" },
};

function currentGameLight(l: PreviewLight): GameLight {
  return gameLight(l.hour, currentKodLight() ?? ROOM_DEFAULT_LIGHT, l.playerLight);
}

/** What the game lighting is made of, under the 3D view. */
function LightHud(): React.JSX.Element | null {
  const light = useEditor((s) => s.light);
  const k = useKodRoom().room;
  const kodError = useKod((s) => s.error);
  if (light.mode !== "game") return null;
  const kl = currentKodLight();
  const g = currentGameLight(light);
  const sources = kl ?? ROOM_DEFAULT_LIGHT;
  return (
    <div
      className="light-hud"
      title={`Base light ${sources.sources.baseLight}\nOutdoors ${sources.sources.outsideFactor}\nDirectional ${sources.sources.directionalPercent}\nBrightness ${g.brightness}, sun height ${g.sunHeight}`}
    >
      {String(light.hour).padStart(2, "0")}:00 · ambient {g.ambient} · sun shading {g.shade} · player light {g.viewerLight}
      {light.sources && ` · ${roomLights(light.hour).length} light sources`}
      <span className="hint"> · {k ? `from ${k.className}` : `Room's defaults: ${kodError ?? "no Kod class uses this room"}`}</span>
    </div>
  );
}

/** The palette as a 256 × 1 texture, looked up by the room shader. */
function paletteTexture(): THREE.DataTexture {
  const pal = palette();
  const rgba = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    rgba[i * 4] = pal[i * 3]!;
    rgba[i * 4 + 1] = pal[i * 3 + 1]!;
    rgba[i * 4 + 2] = pal[i * 3 + 2]!;
    rgba[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(rgba, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** One bitmap of a .bgf as an 8-bit palette-index texture, as stored (the geometry's s/t already allow for the transposed grid textures). */
function bitmapTexture(bgf: Bgf, index: number): THREE.DataTexture {
  const bmp = bgf.bitmaps[index] ?? bgf.bitmaps[0]!;
  const tex = new THREE.DataTexture(bmp.pixels, bmp.width, bmp.height, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  // Rows are tightly packed, whatever the width.
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

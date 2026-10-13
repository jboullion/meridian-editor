// Which Kod objects a room places give light, and what light: what the server
// would send in each object's SendLightingInformation (flags, intensity, colour),
// worked out from the Kod source.
//
//   Flickerer (object/passive/flikerer.kod) and its classes (Candle, Brazier, Lamp,
//   DynamicLight ...): viLightFlags, piLightIntensity and viLightColor, the class's
//   own or inherited; Create(&Class, #iIntensity=..., #iColor=..., #iFlags=...)
//   overrides them (Flickerer and DynamicLight constructors).
//   Lamp switches itself off from 11:00 to 17:00 unless the room is indoors
//   (piOutside_factor = OUTDOORS_NONE): lamp.kod SetSwitchOnTime.
//   OrnamentalObject (ornobj.kod): the types that set pbFlicker give a fire light of
//   intensity 20.
//   Classes whose SendLightingInformation always sends the same light (Sign: a
//   white highlight light; news globes) give that.
//
// Other lights depend on the game's state (spells on monsters, the Tos fountain,
// mana nodes) and aren't shown.

import { evalKodInt, type KodObject, type KodSourceFile } from "./kodRooms.ts";

interface LightClass {
  name: string;
  parent: string;
  path: string;
  /** Light properties as written. */
  flags?: string;
  intensity?: string;
  color?: string;
  /** The sprite (vrIcon's resource), a .bgf file name. */
  icon?: string;
  /** SendLightingInformation's light when it's always the same: flags, intensity and colour as written. */
  fixed?: [string, string, string];
}

export interface KodLightIndex {
  /** By lower-case class name (Kod doesn't care about case). */
  classes: Map<string, LightClass>;
  /** Ornament types (upper case, OO_LANTERN) that flicker, with their sprite. */
  ornaments: Map<string, { flicker: boolean; icon?: string }>;
}

export interface ObjectLight {
  flags: number;
  /** 0..255 */
  intensity: number;
  /** 15-bit 5:5:5 colour */
  color: number;
  /** The sprite, for how high the light sits; null when unknown. */
  icon: string | null;
}

/** include/proto.h LIGHT_FLAG_* */
export const LIGHT_FLAG = { ON: 0x1, DYNAMIC: 0x2, WAVERING: 0x4, HIGHLIGHT: 0x8 } as const;
const ORNAMENT_LIGHT = { flags: LIGHT_FLAG.ON, intensity: 20, color: 0x7f06 }; // ornobj.kod: LIGHT_FLAG_ON, 20, LIGHT_FIRE

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));
}

/** The text of a section ("classvars:" up to the next section). */
function section(src: string, name: string): string {
  const start = src.search(new RegExp(`^\\s*${name}:`, "m"));
  if (start < 0) return "";
  const rest = src.slice(start).replace(new RegExp(`^\\s*${name}:`), "");
  const end = rest.search(/^\s*(constants|resources|classvars|properties|messages):/m);
  return end >= 0 ? rest.slice(0, end) : rest;
}

const prop = (text: string, name: string): string | undefined => new RegExp(`^\\s*${name}\\s*=\\s*([^\\r\\n]+)`, "mi").exec(text)?.[1]?.trim();

export function buildLightIndex(files: readonly KodSourceFile[]): KodLightIndex {
  const classes = new Map<string, LightClass>();
  const ornaments = new Map<string, { flicker: boolean; icon?: string }>();
  for (const f of files) {
    const src = strip(f.text);
    const header = /^\s*(\w+)\s+is\s+(\w+)/m.exec(src);
    if (!header) continue;
    const resources = new Map<string, string>();
    for (const m of section(src, "resources").matchAll(/^\s*(\w+)\s*=\s*([\w-]+\.bgf)\b/gim)) resources.set(m[1]!.toLowerCase(), m[2]!.toLowerCase());
    // Light properties live in classvars or properties.
    const vars = section(src, "classvars") + "\n" + section(src, "properties");
    const iconRes = prop(vars, "vrIcon");
    // SendLightingInformation() { AddPacket(2,flags); AddPacket(1,intensity); AddPacket(2,colour); return; }
    const send = /SendLightingInformation\s*\(\s*\)\s*\{/i.exec(src);
    let fixed: LightClass["fixed"];
    if (send) {
      const body = src.slice(send.index + send[0].length, src.indexOf("}", send.index + send[0].length));
      const packets = [...body.matchAll(/AddPacket\s*\(\s*\d\s*,\s*([^;]+?)\)\s*;/gi)].map((p) => p[1]!.trim());
      // Only when nothing decides it: no conditions, no properties.
      if (packets.length === 3 && !/\bif\b|\bpropagate\b/i.test(body) && !packets.some((p) => /\b(pi|vi|pb)\w+/.test(p))) fixed = packets as [string, string, string];
    }
    classes.set(header[1]!.toLowerCase(), {
      name: header[1]!,
      parent: header[2]!,
      path: f.path,
      flags: prop(vars, "viLightFlags"),
      intensity: prop(vars, "piLightIntensity"),
      color: prop(vars, "viLightColor"),
      icon: iconRes ? resources.get(iconRes.toLowerCase()) : undefined,
      fixed,
    });
    // ornobj.kod: case OO_X: ... vrIcon = oo_x_icon; ... pbFlicker = TRUE; break;
    if (header[1]!.toLowerCase() === "ornamentalobject") {
      for (const m of src.matchAll(/case\s+(OO_\w+)\s*:([\s\S]*?)\bbreak\s*;/gi)) {
        const body = m[2]!;
        const icon = /vrIcon\s*=\s*(\w+)/i.exec(body)?.[1];
        ornaments.set(m[1]!.toUpperCase(), { flicker: /pbFlicker\s*=\s*TRUE/i.test(body), icon: icon ? resources.get(icon.toLowerCase()) : undefined });
      }
    }
  }
  return { classes, ornaments };
}

/** A Create argument, #name=value, from the args text. */
const arg = (args: string | undefined, name: string): string | undefined => (args ? new RegExp(`#${name}\\s*=\\s*([^,#)]+)`, "i").exec(args)?.[1]?.trim() : undefined);

/**
 * The light a placed object gives, or null. `hour` and `outsideFactor` decide
 * whether lamps are lit.
 */
export function objectLight(index: KodLightIndex, constants: ReadonlyMap<string, number>, o: KodObject, hour: number, outsideFactor: number): ObjectLight | null {
  const val = (expr: string | undefined): number | null => (expr === undefined ? null : evalKodInt(expr, constants));

  // Ornaments: placed by type in a list, or Create(&OrnamentalObject,#type=OO_X).
  const ornamentType = /^OO_/i.test(o.what) ? o.what : o.what.toLowerCase() === "ornamentalobject" ? arg(o.args, "type") : undefined;
  if (ornamentType) {
    const t = index.ornaments.get(ornamentType.toUpperCase());
    return t?.flicker ? { ...ORNAMENT_LIGHT, icon: t.icon ?? null } : null;
  }

  // Up the class chain: is it a Flickerer, and what does it set?
  let flags: string | undefined;
  let intensity: string | undefined;
  let color: string | undefined;
  let icon: string | undefined;
  let flickerer = false;
  let lamp = false;
  let fixed: LightClass["fixed"];
  const seen = new Set<string>();
  for (let name: string | undefined = o.what.toLowerCase(); name && !seen.has(name); name = index.classes.get(name)?.parent.toLowerCase()) {
    seen.add(name);
    const c = index.classes.get(name);
    if (!c) break;
    flags ??= c.flags;
    intensity ??= c.intensity;
    color ??= c.color;
    icon ??= c.icon;
    if (name === "lamp") lamp = true;
    if (name === "flickerer") flickerer = true;
    // The nearest SendLightingInformation decides; a flickerer's reads its properties.
    if (!flickerer && fixed === undefined && c.fixed) fixed = c.fixed;
  }
  if (fixed && !flickerer) {
    const [f, i, c] = fixed.map((e) => val(e.replace(/^\((.*)\)$/, "$1")));
    if (f === null || i === null || c === null || !i || !c) return null;
    return { flags: f, intensity: Math.max(0, Math.min(255, i)), color: c, icon: icon ?? null };
  }
  if (!flickerer) return null;
  if (lamp && outsideFactor !== 0 && hour >= 11 && hour <= 17) return null;
  const f = val(arg(o.args, "iFlags")) ?? val(flags) ?? LIGHT_FLAG.ON;
  const i = val(arg(o.args, "iIntensity")) ?? val(intensity) ?? 255;
  const c = val(arg(o.args, "iColor")) ?? val(color) ?? 0;
  // The client skips lights without a colour or an intensity.
  if (!c || !i) return null;
  return { flags: f | LIGHT_FLAG.ON, intensity: Math.max(0, Math.min(255, i)), color: c, icon: icon ?? null };
}

/** d3dlighting.h DLIGHT_SCALE: the light's full width; it reaches half of it. */
export const dlightScale = (intensity: number): number => (intensity * 14000) / 255 + 4000;

/** 15-bit 5:5:5 colour as 0..255 channels (d3dlighting.c D3DLightingColorCalc). */
export function lightColor(c: number): { r: number; g: number; b: number } {
  return {
    r: Math.trunc((((c >> 10) & 31) * 255) / 31),
    g: Math.trunc((((c >> 5) & 31) * 255) / 31),
    b: Math.trunc(((c & 31) * 255) / 31),
  };
}

/** A highlight light (signs) is a tenth the size and doesn't fall off on floors; only dynamic ones keep the flag (D3DLMapsStaticGet). */
export const isHighlight = (flags: number): boolean => (flags & LIGHT_FLAG.HIGHLIGHT) !== 0 && (flags & LIGHT_FLAG.DYNAMIC) !== 0;

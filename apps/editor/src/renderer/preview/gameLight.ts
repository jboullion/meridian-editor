// The light the server gives a room at a game hour, worked out the way its Kod
// does, so the preview can show a room as players see it:
//   brightness   system.kod NewGameHour: from the hour shifted by 2, 15..75
//   ambient      room.kod GetRoomLight: piBaseLight + piOutside_factor * (brightness - 50) / 4, 0..255
//                (BP_PLAYER / BP_LIGHT_AMBIENT)
//   sun          sun.kod NewGameHour: angle ((hour + 19) % 24) * 130 (east 0, west 2048),
//                height 420 - 7 (hour - 13)², at least -200
//   shading      room.kod RecalculateDirectionalLight: piDirectional_percent * height / 420 * 64 / 100,
//                0..64 (BP_LIGHT_SHADING)
// Kod integers divide like C, truncating towards zero.

import type { KodRoomLight } from "../kod/kodRooms.ts";

export interface GameLight {
  /** 0..255, the room's ambient light. */
  ambient: number;
  /** 0..255, the player's own light (piLight: 5 unless a spell or item changes it). */
  viewerLight: number;
  /** Client angle units (4096 a circle). */
  sunAngle: number;
  /** Sun shading intensity, 0..64. */
  shade: number;
  brightness: number;
  sunHeight: number;
}

export const PLAYER_LIGHT = 5;

const div = (a: number, b: number): number => Math.trunc(a / b);
const bound = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function gameBrightness(hour: number): number {
  const lightHour = (hour - 2) % 24; // C remainder: -2 and -1 at midnight and 1 am
  return bound(lightHour <= 12 ? div(lightHour * 100, 12) : div((24 - lightHour) * 100, 12), 15, 75);
}

export function gameLight(hour: number, room: KodRoomLight, viewerLight = PLAYER_LIGHT): GameLight {
  const brightness = gameBrightness(hour);
  const ambient = bound(room.baseLight + div(room.outsideFactor * (brightness - 50), 4), 0, 255);
  const sunAngle = ((hour + 19) % 24) * 130;
  const sunHeight = Math.max(-200, 420 - 7 * (hour - 13) * (hour - 13));
  const shade = bound(div(div(room.directionalPercent * sunHeight, 420) * 64, 100), 0, 64);
  return { ambient, viewerLight, sunAngle, shade, brightness, sunHeight };
}

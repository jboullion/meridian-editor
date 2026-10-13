import { describe, expect, it } from "vitest";
import { buildKodIndex, evalKodInt, kodCandidates, kodRoomLight, parseConstants } from "../kod/kodRooms.ts";
import { gameBrightness, gameLight } from "./gameLight.ts";

const KHD = `
   LIGHT_MIN = 0
   LIGHT_VERY_DARK = 84
   LIGHT_NICE = 164
   LIGHT_MAX = 255
   OUTDOORS_COMPLETE = 10
   OUTDOORS_SOME = 5
   DIRECTIONAL_PERCENT_OUTDOORS = 50
   RID_TEST = 77
`;

describe("the server's light at a game hour", () => {
  it("follows system.kod's brightness curve", () => {
    expect([0, 1, 8, 11, 14, 17, 20, 23].map(gameBrightness)).toEqual([15, 15, 50, 75, 75, 75, 50, 25]);
  });

  it("works out ambient, sun and shading like room.kod and sun.kod", () => {
    const room = { baseLight: 164, outsideFactor: 8, directionalPercent: 50, sources: { baseLight: "", outsideFactor: "", directionalPercent: "" } };
    // Noon: brightness 75, so 164 + 8 * 25 / 4; the sun 413 high, shading 50 * 413 / 420 * 64 / 100.
    expect(gameLight(12, room)).toEqual({ ambient: 214, viewerLight: 5, sunAngle: 7 * 130, shade: 31, brightness: 75, sunHeight: 413 });
    // 1 am: brightness 15, so 164 + 8 * -35 / 4; the sun below the horizon, no shading.
    expect(gameLight(1, room)).toMatchObject({ ambient: 94, shade: 0, sunHeight: -200 });
    // Clamped to 0..255.
    expect(gameLight(12, { ...room, baseLight: 255, outsideFactor: 10 }).ambient).toBe(255);
  });
});

describe("Kod light settings", () => {
  const constants = parseConstants(KHD);

  it("evaluates constant expressions as Kod does", () => {
    expect(evalKodInt("LIGHT_NICE", constants)).toBe(164);
    expect(evalKodInt("(LIGHT_VERY_DARK + LIGHT_MIN)/2", constants)).toBe(42);
    expect(evalKodInt("LIGHT_VERY_DARK / 2", constants)).toBe(42);
    expect(evalKodInt("-7 / 2", constants)).toBe(-3);
    expect(evalKodInt("piBaseLight + 3", constants)).toBeNull();
    expect(evalKodInt("Send(poBaseRoom,@GetBaseLight);", constants)).toBeNull();
  });

  it("inherits from parent classes, then Room's defaults", () => {
    const outdoor = `
OutdoorRoom is Room
properties:
   piOutside_factor = OUTDOORS_SOME
   piDirectional_percent = DIRECTIONAL_PERCENT_OUTDOORS
messages:
   Brighten() { piBaseLight = piBaseLight + 10; return; }
end`;
    const field = `
Field is OutdoorRoom
resources:
   room_field = field.roo
properties:
   prRoom = room_field
   piRoom_num = RID_TEST
   piBaseLight = LIGHT_NICE  // pleasant
end`;
    const index = buildKodIndex("", [{ path: "room/outdoor.kod", text: outdoor }, { path: "room/field.kod", text: field }], KHD);
    const k = kodCandidates(index, "field.room.json", 0)[0]!;
    const light = kodRoomLight(index, k);
    expect(light).toMatchObject({ baseLight: 164, outsideFactor: 5, directionalPercent: 50 });
    expect(light.sources.baseLight).toBe("LIGHT_NICE (room/field.kod:8)");
    expect(light.sources.outsideFactor).toBe("OUTDOORS_SOME (room/outdoor.kod:4)");
    // A file's own constants (feyforst.kod: BASE_LIGHT = LIGHT_NICE).
    const local = buildKodIndex(
      "",
      [{ path: "room/forest.kod", text: "Forest is Room\nconstants:\n   include blakston.khd\n   BASE_LIGHT = LIGHT_NICE - 4\nresources:\n   room_f = forest.roo\nproperties:\n   piBaseLight = BASE_LIGHT\nend" }],
      KHD,
    );
    expect(kodRoomLight(local, kodCandidates(local, "forest", 0)[0]!).baseLight).toBe(160);
    // A class setting nothing gets Room's values.
    const bare = buildKodIndex("", [{ path: "room/bare.kod", text: "Bare is Room\nresources:\n   room_bare = bare.roo\nend" }], KHD);
    expect(kodRoomLight(bare, kodCandidates(bare, "bare", 0)[0]!)).toMatchObject({ baseLight: 255, outsideFactor: 10, directionalPercent: 0 });
  });
});

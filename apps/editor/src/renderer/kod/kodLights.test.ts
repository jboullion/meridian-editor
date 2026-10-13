import { describe, expect, it } from "vitest";
import { buildLightIndex, dlightScale, isHighlight, lightColor, objectLight } from "./kodLights.ts";
import { parseConstants, parseKodRoom } from "./kodRooms.ts";

const KHD = `
   LIGHT_FLAG_ON   = 0x0001
   LIGHT_FLAG_DYNAMIC = 0x0002
   LIGHT_FLAG_WAVERING = 0x0004
   LIGHT_FLAG_HIGHLIGHT = 0x0008
   LIGHT_BWHITE  = 0x7FFF
   LIGHT_FIRE      = 0x7F06
   LIGHT_NEWSGLOBE = 0x3DFF
   OO_LANTERN = 12
`;

const FILES = [
  {
    path: "object/passive/flikerer.kod",
    text: `Flickerer is PassiveObject
properties:
   viLightFlags = LIGHT_FLAG_ON
   viLightColor = LIGHT_FIRE
   piLightIntensity = 255
messages:
   SendLightingInformation()
   {
      AddPacket(2,viLightFlags);
      AddPacket(1,piLightIntensity * pbIsLit);
      AddPacket(2,viLightColor);
      return;
   }
end`,
  },
  {
    path: "object/passive/flikerer/candle.kod",
    text: `Candle is Flickerer
resources:
   candle_icon = candle.bgf
classvars:
   vrIcon = candle_icon
   viLightFlags = LIGHT_FLAG_ON | LIGHT_FLAG_WAVERING
properties:
   piLightIntensity = 5
end`,
  },
  {
    path: "object/passive/flikerer/dynlight.kod",
    text: `DynamicLight is Flickerer
resources:
   DynamicLight_icon = blank.bgf
properties:
   vrIcon = DynamicLight_icon
   viLightColor = LIGHT_BWHITE
end`,
  },
  { path: "object/passive/flikerer/lamp.kod", text: "Lamp is Flickerer\nproperties:\n   piLightIntensity = 50\nend" },
  {
    path: "object/passive/sign.kod",
    text: `Sign is PassiveObject
resources:
   sign_icon_rsc = sign.bgf
classvars:
   vrIcon = sign_icon_rsc
messages:
   SendLightingInformation()
   {
      AddPacket(2,(LIGHT_FLAG_ON | LIGHT_FLAG_DYNAMIC | LIGHT_FLAG_HIGHLIGHT));
      AddPacket(1,255);
      AddPacket(2,LIGHT_BWHITE);
      return;
   }
end`,
  },
  {
    path: "object/passive/ornobj.kod",
    text: `OrnamentalObject is PassiveObject
resources:
   oo_lantern_icon = lantern.bgf
   oo_quiver_icon = quiver.bgf
messages:
   Constructor(type = 0)
   {
      switch (type)
      {
      case OO_QUIVER:
         vrIcon = oo_quiver_icon;
         break;
      case OO_LANTERN:
         vrIcon = oo_lantern_icon;
         pbFlicker = TRUE;
         break;
      }
   }
end`,
  },
];

const ROOM = `Hut is Room
resources:
   room_hut = hut.roo
properties:
   prRoom = room_hut
messages:
   CreateStandardObjects()
   {
      local oObj;
      lObjs = [ [6,2,32,56,OO_quiver], [3,3,OO_lantern] ];
      send(self,@NewHold,#what=Create(&Candle),#new_row=2,#new_col=4,#fine_row=56,#fine_col=40);
      send(self,@NewHold,#what=Create(&DynamicLight,#iColor=LIGHT_FIRE,#iIntensity=30),#new_row=4,#new_col=7);
      send(self,@NewHold,#what=Create(&Lamp),#new_row=5,#new_col=5);
      oObj = Create(&Sign,#desc=hut_sign);
      Send(self,@NewHold,#what=oObj,#new_row=4,#new_col=5);
      send(self,@NewHold,#what=Create(&Table),#new_row=1,#new_col=1);
   }
end`;

describe("Kod light sources", () => {
  const constants = parseConstants(KHD);
  const index = buildLightIndex(FILES);
  const room = parseKodRoom({ path: "room/hut.kod", text: ROOM }, new Map())!;
  const lit = (hour: number, outside: number): string[] =>
    room.objects.flatMap((o) => {
      const l = objectLight(index, constants, o, hour, outside);
      return l ? [`${o.what}@${o.row},${o.col} i${l.intensity} c${l.color.toString(16)} f${l.flags} ${l.icon}`] : [];
    });

  it("gives each placed light what the server would send", () => {
    expect(lit(20, 5)).toEqual([
      // Class properties, inherited where the class doesn't set them.
      "Candle@2,4 i5 c7f06 f5 candle.bgf",
      // Create arguments override them.
      "DynamicLight@4,7 i30 c7f06 f1 blank.bgf",
      "Lamp@5,5 i50 c7f06 f1 null",
      // A fixed SendLightingInformation, found through the local variable it was created into.
      "Sign@4,5 i255 c7fff f11 sign.bgf",
      // Ornaments that flicker; the quiver and the table give no light.
      "OO_lantern@3,3 i20 c7f06 f1 lantern.bgf",
    ]);
  });

  it("switches lamps off by day outdoors, as lamp.kod does", () => {
    expect(lit(14, 5).some((l) => l.startsWith("Lamp"))).toBe(false);
    expect(lit(14, 0).some((l) => l.startsWith("Lamp"))).toBe(true); // indoors: always on
  });

  it("sizes and colours lights like the client", () => {
    expect(dlightScale(255)).toBe(18000);
    expect(lightColor(0x7f06)).toEqual({ r: 255, g: 197, b: 49 }); // LIGHT_FIRE
    expect(isHighlight(11)).toBe(true);
    expect(isHighlight(9)).toBe(false); // a static light drops the highlight flag
  });
});

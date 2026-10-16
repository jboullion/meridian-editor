# Room basics

Meridian rooms are built like Doom levels: a flat floor plan of lines, where each closed area has its own floor and ceiling height. This chapter covers the parts of a room and the words the editor uses for them.

## The parts of a room

| Part | What it is | Mode |
|---|---|---|
| **Vertex** | A point on the floor plan. | Vertices (V) |
| **Linedef** | A line between two vertices: a wall, or the edge between two areas. | Linedefs (L) |
| **Side** | One face of a linedef. Each linedef has a **front side (+)** and a **back side (−)**, and each side belongs to a sector. | Edited with the linedef |
| **Sector** | A closed area of the floor plan, with one floor height, ceiling height, light level and floor and ceiling texture. | Sectors (S) |
| **Thing** | A marked point. Every room has two: the **room box corners**. | Things (T) |

### Linedefs and sides

- A **one-sided** linedef has only a front side. It's a solid wall, seen from its front sector. The map draws it white.
- A **two-sided** linedef has a sector on each side, like the edge of a raised platform or a doorway. The map draws it grey, or green when it's **Passable**: players can walk through it.
- A linedef with **no sides** is drawn red. It's usually left over from an edit, and the checks flag it.

In Linedefs mode, a small tick in the middle of each linedef points to its front side.

Each side has three textures:
- **Normal**: the main wall texture. On a two-sided linedef it's drawn across the opening, so it's usually left empty there, unless you want a see-through texture such as a fence.
- **Below**: the face under the opening, where the floor on the other side is higher (the edge of a step or platform).
- **Above**: the face over the opening, where the ceiling on the other side is lower (the top of a doorway).

### Sectors

Each sector has:
- **Floor height** and **Ceiling height**;
- **Floor texture** and **Ceiling texture** (texture 0 means none; a sector with no ceiling texture is open to the sky);
- **Light**: 0–127 ignores the room's ambient light, and 128–255 adds to it;
- a **Server ID**, so the room's Kod can change the sector later (open a door, change its light).

A sector doesn't have to be one shape. Everything with sides facing the same sector number belongs to it, so one sector can be several separate areas.

### The room box

The first two things are the **room box corners**. They set:
- the room's size;
- where its **Kod rows and columns** start. Kod places exits, monsters and objects by row and column, counted from the room box's top-left corner.

Moving a corner moves every Kod placement in the room. See [Kod placements](10-kod-placements.md).

## Units

- One grid square of 64 units is one **Kod square** (one row or column). The grid's darker lines mark every 64 units.
- Heights use the same units. A player is 48 units tall and can step up 24 units at most. A step higher than 24 blocks them, and so does a gap under a ceiling lower than 48.
- The status bar shows the cursor's position, with its Kod row and column.

## Targets

The editor compiles rooms for one of two servers. Pick the target in the toolbar:

| Target | Server | Output |
|---|---|---|
| **104 (Shards)** | Server 104, which Meridian Shards runs | ROO version 15 |
| **Original** | The original server (Meridian 59 on Steam) | ROO version 13, with the server's movement grids |

The 104 target is stricter:
- the room must have **exactly two things** (the room box corners);
- floor and ceiling heights must be 0 or more;
- **No horizontal tile** and translucency are original-server features.

The inspector warns about these when the target is 104, and the room won't compile until they're fixed.

## Room source and compiled room

- The **room source** (`<name>.room.json`) is what the editor opens and saves. It's text, so changes show up clearly in version control.
- The **compiled room** (`<name>.roo`) is what the server and the client load. The editor compiles it on every change to check it, and writes it when you **Export .roo**. You can import a `.roo` too (see [Files](05-files.md#import-a-roo)).
- The **Room ID** (in the inspector when nothing is selected) is the number the server's Kod uses for this room.

---

Previous: [The editor window](02-the-window.md) · Next: [Tutorial: your first room](04-tutorial-first-room.md)

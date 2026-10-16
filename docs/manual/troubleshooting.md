# Troubleshooting

## Windows warns that the app is unrecognised

The installer isn't code-signed yet, so SmartScreen warns the first time. Choose **More info**, then **Run anyway**. Signed builds are planned.

## Everything in the 3D preview is a grey checker

A grey checker means a face has no texture. If every face shows one, the editor hasn't found the texture library:
- Check that the Meridian 59 (104) client is installed. The editor reads `%LOCALAPPDATA%\Meridian-104\resource`.
- Or set **Textures folder** in **File → Preferences…** to a folder of `grdNNNNN.bgf` files.
- Then choose **Tools → Reload Texture Library**.

**Textures** in the toolbar shows how many textures were found and which folder they came from.

If only some faces are grey, those faces have texture 0. Run **Check missing textures** to list them. Steps and platform edges need a **Below** texture; doorways need an **Above** texture.

## A texture shows as missing

**Check texture names** lists textures that aren't in the library. The number may be a typo, or the texture may come from another client version.

## The Kod tab says "none"

- **No Kod folder set:** set **Kod folder** in Preferences to the Shards server's `server/src/kod`. See [Getting started](01-getting-started.md#kod-optional).
- **No class uses this room:** the editor looks for a Kod class that names the room's `.roo` file, or its room ID. New rooms don't have one until someone writes it.
- **The Kod changed:** choose **Reload** in the Kod tab.

## I can't walk through an opening or up a step

Walk mode stops you where the game would. Check:
- **The step's height.** A player can step up 24 units at most. Use a step in between, or a slope.
- **The headroom.** A player needs 48 units between floor and ceiling.
- **Passable.** The linedef must be two-sided with **Passable** ticked on its sides. Lines the editor draws are passable unless Preferences says otherwise. Older rooms and roomedit-drawn lines may not be.
- **The room's edge.** You can't walk outside every sector.

## The room won't compile

The compile chip is red and the **Compile** tab lists the errors. For the 104 target, the usual causes are:
- more than two things;
- a negative height;
- an original-only wall flag.

See [Checks and export](11-checks-and-export.md#compiling-as-you-work). Switching the **Target** to Original shows whether the room is fine for the original server.

## A sector isn't closed, or a shape didn't make a sector

**Check sectors are closed** lists the vertices and linedefs where a sector's outline breaks. Click a result to see it. Usual causes:
- **A line that doesn't quite meet another.** Drag its end vertex onto the other vertex, and the two merge.
- **A side facing the wrong sector.** Fix its **Sector** in the inspector.

## Kod placements are in the wrong place after an edit

Kod positions count from the room box corners. If you moved a corner, or moved walls away from where the Kod expects floor, run **Check Kod placements**. Moving the corner back puts everything back.

## I lost changes

- The editor asks before closing a room with unsaved changes. **Save •** in the toolbar and a ● in the title mean there are some.
- **Undo** (Ctrl+Z) goes back through the last 200 changes since the room was opened.

## Where the editor keeps its settings

- **Rooms folder** and **export folder:** `settings.json` in `%APPDATA%\Meridian Room Editor` (Windows).
- **Preferences:** kept by the editor in the same data folder.

To start fresh, close the editor and delete that folder.

---

Previous: [Keyboard shortcuts](keyboard-shortcuts.md) · [Contents](README.md)

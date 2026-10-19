# Kod placements

A Meridian room is two things:
- the **room file** (`.roo`): the floor plan, heights, textures and lighting. This is what the editor builds.
- the room's **Kod class** on the server: exits, monster generators, objects, sounds, and the room's light settings. Builders write it as Kod source.

The editor reads the Kod, so you can see where it puts things while you change the room around them. It can also change the class's exits and locked doors (see [Changing exits and locked doors](#changing-exits-and-locked-doors)); everything else is edited in the `.kod` file. This needs a Kod folder (see [Getting started](01-getting-started.md#kod-optional)).

## On the map

**K** shows or hides the Kod placements on the map.

![The Raza inn with its Kod placements: two locked doors, an exit, the arrival square, objects and the reach of its lights](images/kod-map.png)

| Mark | What it is |
|---|---|
| Green square | An exit, labelled with where it goes. |
| Red square with a cross | A locked door. |
| Dashed green bar outside the room box | An edge exit: walking off that side of the room leads to another room. |
| Orange dot | A monster generator. |
| Blue diamond | An object placed by the room (`NewHold` or an ornament list). |
| Purple dot | A looping sound. |
| Yellow star | The arrival square, where players appear. |
| Dashed circle | How far a light reaches, in the light's colour, at the 3D preview's hour. |

Labels appear when you zoom in far enough. The status bar names what's on the square under the mouse.

## The Kod tab

The **Kod** tab in the bottom panel lists the room's class and everything it places.

![The Kod tab for Raza](images/kod-panel.png)

- The first line gives the class name, its file, its room ID and the `.roo` it uses.
- Edge exits are listed under it.
- The rest is grouped: exits, monster generators, objects, sounds and the arrival square. Each entry gives its Kod row and column. Click one to centre the map on it; clicking an exit also picks it for the inspector.
- **Show on map (K)** shows or hides the marks.
- **Check placements** runs the Kod placement check (below).
- **Reload** reads the Kod again after you've changed it.

The editor finds the class by the room's `.roo` name, or by its room ID. When several classes use the same `.roo` (Tos has a few), a menu lets you pick one.

## Changing exits and locked doors

An exit takes players who step on its square to another room. A locked door stops them there with a message, such as Marion's crypt gate ("This gate was put in place to keep citizens safe…"). Both are lines in the class's `CreateStandardExits`:

```
plExits = Cons([ 31, 43, RID_MAR_SMITHY, 11, 4, ROTATE_NONE ],plExits);
plExits = Cons([ 70, 13, ROOM_LOCKED_DOOR, marion_gate_warning ],plExits);
```

To pick one, click its label on the map, in any mode. Clicking its square also picks it when nothing else in the current mode is there, as in **Things** mode. The picked square gets an orange outline and the inspector shows it:
- **What it is:** a locked door, or an exit to another room.
- **Row** and **Column:** its square.
- For a locked door, **Message**: a resource name from the class, or empty for the server's "the door is locked".
- For an exit, **To room** (an `RID_` constant from `blakston.khd`, or a room number), **At row** and **At column** (where players arrive), and **Turn**.

You can also:
- drag the square to another square;
- double-click it, or press **Enter**, for the same fields in a dialog;
- press **Del**, or use the inspector's **Delete**, to remove it;
- right-click a square and choose **Add Kod exit or locked door here…** to add one.

Each change is one undo step, and the toolbar shows the room as unsaved. Only that exit's line of the `.kod` file changes. Two exits can't share a square.

**Save** writes the `.kod` file along with the room. If the file changed on disk since the editor read it, the Kod isn't saved; **Reload** on the Kod tab, then make the change again.

For a Shards room with install on save on, saving then asks to load the Kod change. The server builds the Kod (about half a minute) and runs `reload system`, which saves the game and reloads all the Kod; players stay connected. Then the room makes its exits again. If you say no, the change is saved, but the server keeps the old exits until the Kod is reloaded.

The `.kod` files are in shards-server, so commit the change there with the room.

## Checking placements

**Check Kod placements** (also part of **Run all checks**, F9) flags placements that are:
- outside the room box;
- on a square with no floor.

The usual cause is a moved room box corner, or walls moved away from where the Kod expects floor. Click a result to see the spot.

## Copy a Kod position

To place something new in Kod, right-click the spot on the map and choose **Copy Kod position here**. The editor copies the arguments Kod's `NewHold` takes, for example:

```
#new_row=12,#new_col=7,#fine_row=32,#fine_col=16
```

Paste them into the room's Kod class. The inspector also shows the Kod row and column of a selected vertex or thing, and the status bar shows the mouse's.

## Kod rows and columns

- Kod counts rows down and columns across from the room box's top-left corner, starting at 1.
- Each row and column is one 64-unit square, and fine positions divide a square into 64.

This is why the room box matters. If you move a corner, every Kod position in the room shifts with it.

## New rooms and Kod

A new room has no Kod class, so the Kod tab says **none**, nothing shows on the map, and the 3D preview uses the default lighting. For the room to be in the game:
- someone writes a Kod class for it, naming its `.roo` file and its room ID;
- the compiled `.roo` and the class go on the server.

Whoever runs your server will know how. For a local Shards server, the project's [README](../../README.md#testing-rooms-in-shards) describes the tools that install and walk a test room.

---

Previous: [3D preview and walking](09-3d-preview-and-walking.md) · Next: [Checks and export](11-checks-and-export.md)

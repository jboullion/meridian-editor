// What each editor command (apps/editor/src/renderer/commands.tsx) is for an
// agent: the tools that do it, or why it has none. test/coverage.test.ts fails
// when a command is added without an entry here, so agents keep up with the UI.

/** `planned` names tools not built yet. */
export type Coverage = { tools: string[] } | { ui: string } | { planned: string };

const t = (...tools: string[]): Coverage => ({ tools });
const ui = (why: string): Coverage => ({ ui: why });

export const COMMAND_COVERAGE: Record<string, Coverage> = {
  // File
  "file.new": t("new_room"),
  "file.open": t("open_room", "list_rooms"),
  "file.openFolder": ui("The server's --rooms option (or EDITOR_ROOMS_DIR) picks the rooms folder"),
  "file.save": t("save_room"),
  "file.saveAs": t("save_room"),
  "file.export": t("export_roo", "compile"),

  // Edit
  "edit.undo": t("undo"),
  "edit.redo": t("redo"),
  "edit.copy": t("duplicate_items"),
  "edit.cut": t("duplicate_items", "delete_items"),
  "edit.paste": t("duplicate_items"),
  "edit.duplicate": t("duplicate_items"),
  "edit.delete": t("delete_items"),
  "edit.selectAll": t("select", "find_items"),
  "edit.deselect": t("select"),
  "edit.rotateScale": t("rotate_scale"),
  "edit.mirrorH": t("mirror"),
  "edit.mirrorV": t("mirror"),
  "edit.preferences": t("get_prefs", "set_prefs"),

  // Modes and tools: edit tools name the kind they act on and draw directly; set_view switches the editor's mode.
  "mode.thing": t("set_view"),
  "mode.vertex": t("set_view"),
  "mode.linedef": t("set_view"),
  "mode.sector": t("set_view"),
  "mode.prev": t("set_view"),
  "mode.next": t("set_view"),
  "tool.select": ui("Tools take indices"),
  "tool.draw": t("draw_path"),
  "tool.rectangle": t("draw_shape"),
  "tool.polygon": t("draw_shape"),
  "tool.circle": t("draw_shape"),
  "tool.torch": t("add_torch"),
  "tool.thing": t("add_thing"),

  // View
  "view.2d": t("set_view"),
  "view.3d": t("set_view", "render_3d"),
  "view.split": t("set_view"),
  "view.fit": t("set_view", "render_map"),
  "view.center": t("select", "set_view"),
  "view.gridNext": t("set_display"),
  "view.gridPrev": t("set_display"),
  "view.zoomIn": t("set_view", "render_map"),
  "view.zoomOut": t("set_view", "render_map"),
  "view.walk": t("walk", "walk_live"),
  "view.walkHere": t("walk", "walk_live"),
  "view.lighting": t("set_lighting", "render_3d"),
  "view.flatLight": t("set_lighting"),
  "view.kod": t("set_display", "render_map"),
  "view.kodReload": t("kod_reload"),
  "view.kodPosition": t("convert_coords"),
  "view.toggleGrid": t("set_display"),
  "view.toggleSnap": t("set_display", "draw_path", "draw_shape"),
  "view.palette": ui("Every tool is listed to the agent already"),

  // Vertices
  "vertex.link": t("link_vertices"),
  "vertex.add": t("add_vertex"),
  "vertex.linkClosed": t("link_vertices"),
  "vertex.deleteJoin": t("delete_vertex_join"),
  "vertex.merge": t("merge_vertices"),
  "vertex.splitSector": t("connect_vertices"),

  // Linedefs
  "linedef.split": t("split_linedefs"),
  "linedef.splitSector": t("split_linedefs_and_sector"),
  "linedef.deleteJoin": t("delete_linedefs_join_sectors"),
  "linedef.flip": t("flip_linedefs"),
  "linedef.swap": t("flip_linedefs"),
  "linedef.makeSector": t("make_sector_from_linedefs"),
  "linedef.alignY": t("align_textures_y"),
  "linedef.alignX": t("align_textures_x"),

  // Sectors
  "sector.merge": t("merge_sectors"),
  "sector.door": t("make_door"),
  "sector.lift": t("make_lift"),
  "sector.distFloor": t("distribute_heights"),
  "sector.distCeiling": t("distribute_heights"),
  "sector.freeId": t("free_server_id"),
  "sector.floorSlope": t("add_slope", "set_slope"),
  "sector.ceilingSlope": t("add_slope", "set_slope"),

  // Kod exits: the agent writes only the open room's own Kod (rooms/new/<room>.kod), never the server's
  "kod.editExit": t("kod_set_exit"),
  "kod.deleteExit": t("kod_remove_exit"),
  "kod.addExit": t("kod_add_exit"),

  // Search
  "search.find": t("find_items", "set_properties"),
  "search.jump": t("get_items", "describe_sector", "describe_linedef"),
  "search.next": t("get_items"),
  "search.prev": t("get_items"),

  // Check
  "check.stats": t("room_summary", "compile"),
  "check.sectors": t("run_checks"),
  "check.crossrefs": t("run_checks"),
  "check.textures": t("run_checks"),
  "check.textureNames": t("run_checks"),
  "check.kod": t("run_checks"),
  "check.all": t("run_checks", "fix_issue"),

  // Textures
  "textures.browse": t("list_textures", "view_textures", "textures_in_use"),
  "textures.reload": t("list_textures"),
};

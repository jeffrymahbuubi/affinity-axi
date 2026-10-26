// `fill`: the wording of the failure notes that tell the user which Affinity document is theirs to deal with.

import { basename, join } from "node:path";

const BIN = "affinity-axi";

/** The row note when the record's target .af is open in Affinity: nothing is loaded, the run may go on. */
export const targetOpenNote = (key: string): string => `${key}.af is open in Affinity; close it (doc save + doc close) or pick another --out-dir`;

/**
 * The fatal note when saving the filled copy fails. The open document is the filled template, not the
 * record's file: saving it over the template (File > Save) would destroy the template.
 */
export function saveFailNote(error: string, key: string, template: string, uuid: string, outDir: string): string {
  const title = basename(template).replace(/\.af$/i, "");
  return `${error}; the filled copy is still open as '${title}' (not saved). Do not save it over the template: doc save ${uuid.slice(0, 8)} ${join(outDir, `${key}.af`)} once the file is closed, or close it in Affinity with Don't Save`;
}

/** The help line (one per run) that keeps a left-open copy and closes it. */
export function leftOpenHelp(uuid: string, key: string, outDir: string): string {
  const id = uuid.slice(0, 8);
  return `${BIN} doc save ${id} ${join(outDir, "_failed", `${key}.af`)} && ${BIN} doc close ${id}   # keep a left-open copy, then close it`;
}

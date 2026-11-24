// `doc close`: one document (clean, or --discard for one affinity-axi created) and `--mine`, which
// closes every open document this tool created from the current folder. Ownership comes from the ledger.

import type { Parsed } from "../cli/args.js";
import { readOwned, pruneOwned, scopeOf } from "../affinity/owned.js";
import { APP_INFO, LIST_DOCUMENTS } from "../affinity/scripts.js";
import { shown } from "../affinity/paths.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitKV, emitList, print } from "../output/toon.js";
import type { AffinityClient, ConnectFn, DocInfo } from "../mcp/types.js";
import { DOC_CLOSE, resolveDoc, runDocScript, urlFlag } from "./doc.js";
import { discardDoc } from "./finish.js";
import { callJson } from "./run.js";

const BIN = "affinity-axi";
const STILL_OPEN = "check Affinity for an open dialog and answer it by hand; do not re-run blindly";

export async function runClose(parsed: Parsed, connect: ConnectFn): Promise<number> {
  const ref = parsed.positionals[0];
  const mine = parsed.flags["mine"] === true;
  const discard = parsed.flags["discard"] === true;
  if (ref === undefined && !mine) {
    throw new UsageError("give a document or --mine", `e.g. ${BIN} doc close 70E876CB, or ${BIN} doc close --mine`);
  }
  if (ref !== undefined && mine) {
    throw new UsageError("<doc> and --mine cannot be combined", "--mine closes every document affinity-axi created from this folder");
  }
  const client = await connect({ url: urlFlag(parsed) });
  try {
    return mine ? await closeMine(client, discard) : await closeOne(client, ref!, discard);
  } finally {
    client.close();
  }
}

async function closeOne(client: AffinityClient, ref: string, discard: boolean): Promise<number> {
  const doc = await resolveDoc(client, ref);
  const uuid = doc.uuid;
  const uuid8 = uuid.slice(0, 8);
  const owned = readOwned().has(uuid.toUpperCase());
  const refuse = (): never => {
    throw new AxiError(
      `document ${uuid} (${doc.title}) has unsaved changes; closing it would open a save prompt that hangs Affinity`,
      `the SDK cannot discard a document: run '${BIN} doc save ${uuid8} <path-under-Desktop>.af' first, then close it` +
        (owned ? `; or '${BIN} doc close ${uuid8} --discard' to drop it (affinity-axi created it)` : ""),
    );
  };
  if (doc.dirty && !discard) refuse();
  if (doc.dirty && discard) {
    if (!owned) {
      throw new AxiError(
        `document ${uuid} (${doc.title}) was not created by affinity-axi, so --discard will not drop it`,
        `save it with '${BIN} doc save ${uuid8} <path-under-Desktop>.af', or close it in Affinity with Don't Save`,
      );
    }
    const app = await callJson<{ desktop: string }>(client, APP_INFO, "reading Affinity app info");
    const r = await discardDoc(client, app.desktop, uuid);
    if (r.status === "failed") throw new AxiError(r.message, STILL_OPEN);
    if (r.status === "missing") throw new UsageError(`no open document matches "${ref}"`, `run '${BIN}' to list open documents`);
    const pairs: Array<[string, unknown]> = [["closed", uuid]];
    if (r.status === "discarded") {
      pairs.push(["discarded", true]);
      if (r.leftover) pairs.push(["leftover", shown(r.leftover)]);
    }
    const lines = [emitKV(pairs)];
    if (r.status === "discarded" && r.leftover) lines.push(helpBlock([`delete ${shown(r.leftover)}: the throwaway copy could not be removed`]));
    print(lines.join("\n"));
    return 0;
  }
  const out = await runDocScript<{ status: string }>(client, DOC_CLOSE(uuid), "closing the document");
  if (out.status === "dirty") refuse();
  if (out.status === "missing") throw new UsageError(`no open document matches "${ref}"`, `run '${BIN}' to list open documents`);
  if (out.status !== "closed") throw new AxiError(`document ${uuid} is still open after close`, STILL_OPEN);
  print(emitKV([["closed", uuid]]));
  return 0;
}

async function closeMine(client: AffinityClient, discard: boolean): Promise<number> {
  const listing = await callJson<{ current: string | null; documents: DocInfo[] }>(client, LIST_DOCUMENTS, "listing documents");
  const ledger = readOwned();
  const scope = scopeOf();
  const ownedOpen = listing.documents.filter((d) => ledger.has(d.uuid.toUpperCase()));
  const targets = ownedOpen.filter((d) => ledger.get(d.uuid.toUpperCase())!.scope === scope);
  const others = ownedOpen.length - targets.length;
  const closed: Array<Record<string, unknown>> = [];
  const kept: Array<Record<string, unknown>> = [];
  const gone = new Set<string>();
  let failed = false;
  let keptUnsaved = false;
  let desktop: string | undefined;
  const keepUnsaved = (id8: string): void => {
    keptUnsaved = true;
    kept.push({ doc: id8, why: `unsaved; doc save it, or doc close ${id8} --discard` });
  };
  for (const d of targets) {
    const id8 = d.uuid.slice(0, 8);
    const key = d.uuid.toUpperCase();
    try {
      if (!d.dirty) {
        const out = await runDocScript<{ status: string }>(client, DOC_CLOSE(d.uuid), "closing the document");
        if (out.status === "closed" || out.status === "missing") {
          closed.push({ doc: id8, how: "closed" });
          gone.add(key);
        } else if (out.status === "dirty") {
          keepUnsaved(id8);
        } else {
          failed = true;
          kept.push({ doc: id8, why: `still open after close (${out.status})` });
        }
      } else if (ledger.get(key)!.scratch || discard) {
        desktop ??= (await callJson<{ desktop: string }>(client, APP_INFO, "reading Affinity app info")).desktop;
        const r = await discardDoc(client, desktop, d.uuid);
        if (r.status === "failed") {
          failed = true;
          kept.push({ doc: id8, why: r.message });
        } else {
          closed.push({ doc: id8, how: r.status === "discarded" ? "discarded" : "closed" });
          gone.add(key);
        }
      } else {
        keepUnsaved(id8);
      }
    } catch (err) {
      if (!(err instanceof AxiError)) throw err;
      failed = true;
      kept.push({ doc: id8, why: err.message });
    }
  }
  pruneOwned(listing.documents.map((d) => d.uuid).filter((u) => !gone.has(u.toUpperCase())));
  const out: string[] = [];
  if (targets.length === 0) out.push("note: no open document was created by affinity-axi from this folder");
  else out.push(emitList("closed", closed, ["doc", "how"]));
  if (kept.length > 0) out.push(emitList("kept", kept, ["doc", "why"]));
  if (others > 0) out.push(`others: ${others}   # created from other folders; close them by id`);
  if (keptUnsaved && !discard) out.push(helpBlock([`${BIN} doc close --mine --discard   # also drop the unsaved ones`]));
  print(out.join("\n"));
  return failed ? 1 : 0;
}

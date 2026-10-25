// Shared types for the examples registry, gallery and help output samples.
// Frozen: units import these and never redefine them. registry.ts exports
// `EXAMPLES: readonly Example[]`, `examplesFor(command)` and
// `outputSample(command, max = 6)` (the latter is used by src/cli/help.ts).

export type Need = "affinity" | "document" | "exiftool" | "fonts";

export interface Example {
  /** Folder name under examples/. */
  id: string;
  /** Command path: "render", "doc open", "helpers:axiText", ... */
  feature: string;
  title: string;
  /** One line, for lists and the README. */
  summary: string;
  /** Shell lines; $DOC = demo doc uuid8, $OUT = examples/<id>/, $BIN = affinity-axi. */
  commands: string[];
  /** File under examples/<id>/ run by one of the commands. */
  script?: string;
  /** Normalised sample lines that must appear in order in output.txt. */
  output: string[];
  /** Files under examples/<id>/ produced by the commands. */
  images: string[];
  needs: Need[];
  /** Feature not merged yet; examples:check skips it. */
  pending?: boolean;
}

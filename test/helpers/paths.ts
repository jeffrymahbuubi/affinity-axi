import { sep } from "node:path";

// Test-only: turns native separators into "/" so a POSIX documentation sample can be compared on Windows.
export const slash = (s: string): string => (sep === "\\" ? s.replaceAll("\\", "/") : s);

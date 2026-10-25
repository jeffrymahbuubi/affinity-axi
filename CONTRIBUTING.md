# Contributing

Thanks for helping with affinity-axi. This is a small project, so the rules
are short.

## Requirements

- macOS with Affinity 3.3.1 or newer, with its MCP server switched on
- Node 20 or newer

## Setup and checks

```sh
npm install
npm test                # builds first, then runs offline against the fake server
npm run guide:check     # the generated agent guide must be up to date
npm run examples:check  # every example must still pass
```

`npm run smoke:live` drives the real Affinity app. Run it only when Affinity
is open; it is not part of `npm test`. If you change a command, run
`npm run guide:gen` and `npm run examples:gen`, then commit the results.

## Rules

- Keep every file under 500 lines.
- Keep the tree publishable: no vendor or model names and no personal paths
  such as a home directory. `test/public-tree.test.ts` scans every tracked
  file and fails on a slip. Write "any coding agent" if you must refer to one.
- Scripts must never close a document that has unsaved changes. Save first or
  leave the document open.
- Validate input at the boundary (command arguments, files you read).
- Do not commit secrets, credentials or `.env` files.
- Write commit messages in plain prose, with no attribution trailers.

## Pull request checklist

- [ ] `npm test` passes
- [ ] `npm run guide:check` and `npm run examples:check` pass
- [ ] New behavior has a test; offline tests use the fake server
- [ ] If it touches the live path, you ran `npm run smoke:live` and say so
- [ ] No new file over 500 lines, no forbidden terms

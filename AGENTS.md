# LineStage Agent Guide

## Overview

LineStage is a small VS Code extension for staging and unstaging selected
lines or complete files with Git. Its implementation is concentrated in
`src/extension.ts`; `package.json` defines the commands.

The extension does not use the VS Code Git extension API. It invokes the
`git` executable directly through Node's `child_process.spawn`.

## Extension entry points

`package.json` points the extension entry point at `./out/extension.js`.
TypeScript source lives in `src/extension.ts` and is compiled to `out/`.

The extension activates lazily when one of these commands is invoked:

- `linestage.stageLines`
- `linestage.unstageLines`
- `linestage.stageFile`
- `linestage.unstageFile`

`activate(context)` registers all four commands and stores their disposable
registrations in `context.subscriptions`. `deactivate()` is intentionally
empty because the extension creates no persistent watchers or other resources.

## Command behavior

### Stage Lines

`linestage.stageLines`:

1. Reads the active editor's file.
2. Finds the Git repository root with:

   ```text
   git rev-parse --show-toplevel
   ```

3. Converts editor selections into 1-based line numbers.
4. For an untracked file, runs `git add -N -- file` first. This creates an
   intent-to-add entry so the file appears in `git diff`.
5. Gets the unstaged diff with:

   ```text
   git diff --no-ext-diff --no-color --full-index --unified=1 -- file
   ```

6. Filters the diff to selected changes.
7. Applies the result to the index:

   ```text
   git apply --cached --whitespace=nowarn -
   ```

### Unstage Lines

`linestage.unstageLines` follows the same process, but reads the cached diff:

```text
git diff --cached --no-ext-diff --no-color --full-index --unified=1 -- file
```

It reverses the selected patch when applying it:

```text
git apply --cached --whitespace=nowarn -R -
```

This changes the index without modifying the working tree.

When the staged file is a newly added file, the extension uses a different
path. Reversing a filtered `new file` patch does not work after the complete
file is already in the index. Instead, LineStage reads the staged blob,
removes the selected lines, creates a normal index-to-index patch, and applies
that patch forward to the index.

### Stage File

`linestage.stageFile` accepts a file URI when invoked programmatically, or
falls back to the active editor file:

```text
git add -- file
```

If the file is already absent from both the index and working tree, staging is
treated as a successful no-op. This makes staging an already staged deletion
safe to repeat.

### Unstage File

`linestage.unstageFile` accepts a file URI when invoked programmatically, or
falls back to the active editor file:

```text
git reset -- file
```

This removes the file's staged changes from the index while leaving its
working-tree contents untouched. It also removes an intent-to-add entry,
returning an otherwise untracked file to the normal untracked state.

## Selection handling

`selectedLines(editor)` returns a `Set` of 1-based line numbers.

- An empty selection contributes the line containing its cursor.
- A non-empty selection includes every line from its start through its end.
- If a non-empty selection ends at column zero on a later line, that final
  line is excluded.
- Multiple selections and cursors are merged into one set.

## Patch filtering

`filterPatch(diff, selected)` parses Git's unified diff format and retains
selected changes. Diffs are generated with one context line so replacement
patches remain applicable to the index.

For additions, a line is retained only when its new-file line number is
selected. Deletions are retained when the selected line number matches the
current new-file position. For deletions at the end of a hunk, the preceding
visible line is also accepted because the deleted line has no new-file line
number. Hunk headers are recalculated after filtering.

The filtering is not a complete arbitrary-line patch editor. It is primarily
hunk-oriented:

- Context lines in a selected hunk are retained.
- Unselected lines in a replacement hunk are converted to context so adjacent
  selected and unselected changes remain independent.
- Closely adjacent changes can be grouped into one Git hunk and may therefore
  require careful line pairing.

For tracked-file unstaging, LineStage derives the desired index contents from
the selected cached changes and applies a direct current-index-to-desired-index
patch. This is necessary when selected and unselected staged changes share a
hunk.

When changing this logic, test additions, deletions, replacements, adjacent
changes, end-of-file changes, empty files, untracked files, and fully staged
new files being partially unstaged.

## Repository and path handling

When workspace folders are available, the extension checks each workspace
folder for a Git repository during activation and caches the resulting
repository root. Commands reuse that cached root and reject target files
outside the validated repository.

When no workspace is open, the first command derives the repository root from
the directory containing its target file with:

```text
git rev-parse --show-toplevel
```

That root is cached for the rest of the extension session. Later commands
must target files within the same repository. If the initial lookup fails, it
is retried on a later command.

The absolute target path is converted to a repository-relative POSIX path.
Git path arguments are placed after `--` to prevent path interpretation as an
option.

`file:` URIs and Git-backed read-only editor documents for deleted files are
accepted. Other non-file editor documents, such as virtual documents, are
rejected.

## Errors and UI refresh

Git failures are converted to `Error` objects using stderr when available.
Command handlers display failures with `showErrorMessage`.

Successful staging and unstaging operations do not display notifications.
When no selected lines match a requested line operation, the extension
displays “No changed lines match the current selection.”

## Development commands

Install dependencies and compile:

```sh
npm install
npm run compile
```

Watch for TypeScript changes:

```sh
npm run watch
```

Build the VSIX:

```sh
npm run package
```

Run the integration tests:

```sh
npm test
```

The package command compiles the extension, creates a VSIX, and moves it to
`dist/`.

## Change guidelines

- Preserve the direct Git invocation model unless there is a strong reason to
  adopt another API.
- Keep repository-relative paths after Git's `--` separator.
- Ensure new Git operations preserve the working tree unless the command
  explicitly intends to modify it.
- Update `package.json`, `README.md`, and this file when adding or changing
  commands.
- Prefer small, focused changes because the extension's behavior is centered
  in one source file.
- Add tests or a reproducible manual verification procedure for patch parsing
  changes. Tests use Node's built-in test runner and temporary Git
  repositories. The command matrix covers all four commands against
  untracked, fully staged, partially staged, and unstaged files.

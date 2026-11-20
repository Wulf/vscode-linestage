# LineStage

Stage or unstage selected lines and complete files with Git from VS Code. This overcomes some limitations from VSCode's built-in commands that are supposed to do similar things.

VS Code commands:

- `LineStage: Stage Lines` (command ID: `linestage.stageLines`)
- `LineStage: Unstage Lines` (command ID: `linestage.unstageLines`)
- `LineStage: Stage File` (command ID: `linestage.stageFile`)
- `LineStage: Unstage File` (command ID: `linestage.unstageFile`)

`Stage Lines` and `Unstage Lines` operate on all selected lines, including multi-cursor selections. With no selection, they operate on the line containing each cursor.

The file commands operate on the active editor file. They also accept a file URI when invoked programmatically. Unstaging an intent-to-add-only file removes the index entry and returns it to the ordinary untracked state.

## Install (pre-built)

On macOS, Linux, Git Bash, or WSL:

```sh
curl -fsSL https://raw.githubusercontent.com/Wulf/vscode-linestage/main/scripts/install-vsix.sh | bash
```

## Install (from source)

```sh
npm install
npm run package

code --install-extension dist/linestage-X.X.X.vsix
```

## Publishing

1. Bump the version in `package.json`.
2. Run `npm run package`.
3. Push the new `.vsix` to `main`; it will be available in `dist/` for download.

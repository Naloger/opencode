# OpenCode Windows CLI Build & Rebuild

This guide covers the standalone Windows CLI build for OpenCode.

## What was verified

The current build flow works on Windows after:

- installing workspace dependencies
- installing the `packages/app` dependencies so `vite` is available locally
- building the standalone CLI from `packages/opencode`

The verified output path on Windows x64 is:

```text
packages/opencode/dist/opencode-windows-x64/bin/opencode
```

## Prerequisites

From the repo root:

```powershell
bun install
```

If the embedded web UI build reports `bun: command not found: vite`, install the app package dependencies too:

```powershell
Push-Location "C:\CalismaAlani\CodingJS\OpenCode\opencode\packages\app"
bun install
Pop-Location
```

## Build

From `packages/opencode`:

```powershell
Push-Location "C:\CalismaAlani\CodingJS\OpenCode\opencode\packages\opencode"
bun run build --single --skip-install
Pop-Location
```

### Notes

- `--single` builds only the current platform.
- `--skip-install` skips the extra package installs inside `script/build.ts`.
- If you want the script to also refresh those package installs, omit `--skip-install`.
- On Windows x64, the standalone binary is produced under `dist/opencode-windows-x64/bin/`.

## Rebuild

To rebuild from scratch, remove the previous `dist/` directory first:

```powershell
Remove-Item -Recurse -Force "C:\CalismaAlani\CodingJS\OpenCode\opencode\packages\opencode\dist"
```

Then run the build again:

```powershell
Push-Location "C:\CalismaAlani\CodingJS\OpenCode\opencode\packages\opencode"
bun run build --single --skip-install
Pop-Location
```

## Verify

After the build finishes, check the binary version:

```powershell
"C:\CalismaAlani\CodingJS\OpenCode\opencode\packages\opencode\dist\opencode-windows-x64\bin\opencode" --version
```

## Troubleshooting

### `bun: command not found: vite`

Run `bun install` inside `packages/app` and try the build again.

### `Cannot find module '@opencode-ai/script'`

Run `bun install` from the repo root so workspace packages are linked correctly.

### Build still re-runs package installs

Use `--skip-install` for the faster local loop once dependencies are already present.


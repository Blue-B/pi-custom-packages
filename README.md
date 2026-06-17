# pi-custom-packages

> Custom [pi coding agent](https://github.com/earendil-works/pi-mono) extensions tailored for WSL2 + Windows environments.

A collection of pi extensions and packages that bridge WSL-hosted AI agents with the Windows desktop — screen capture, image paste, and more.

## Packages

| Package | Description |
|---------|-------------|
| **[pi-paster](./packages/pi-paster)** | Turns pasted, drag-dropped, or clipboard-provided image paths into first-class image attachments. |
| **[pi-winshot](./packages/pi-winshot)** | Capture and edit the Windows host screen from a WSL-hosted pi agent — full screen, region, window (even occluded), crop, resize, and privacy masking. |

## Install

```bash
# From the repo root, install a specific package
pi install ./packages/pi-paster
pi install ./packages/pi-winshot

# Or from GitHub directly
pi install https://github.com/Blue-B/pi-custom-packages/tree/main/packages/pi-paster
pi install https://github.com/Blue-B/pi-custom-packages/tree/main/packages/pi-winshot
```

After install, run `/reload` in pi to activate.

## Requirements

- pi coding agent ≥ 0.70
- WSL2 (for pi-winshot; pi-paster works anywhere)
- Windows 10/11 host (pi-winshot only)

## Why a monorepo?

These extensions were built iteratively alongside day-to-day pi usage in a WSL2 environment, solving real problems as they arose — from 4K screenshot overflow to clipboard image attachment. Bundling them together makes maintenance easier and lets them share conventions.

## License

MIT — each package carries its own LICENSE file.

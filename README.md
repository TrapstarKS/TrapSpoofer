<p align="center">
  <img src="./src-tauri/icons/128x128.png" width="128" height="128" alt="TrapSpoofer">
</p>

<h1 align="center">TrapSpoofer</h1>

<p align="center">
  Desktop tool for spoofing (re-uploading and replacing) Roblox assets.
  <br>
  Scan, preview, re-upload and swap animations, sounds, images and meshes across an entire place — no instance-by-instance editing.
</p>

<p align="center">
  <kbd>Animations</kbd>&nbsp;&nbsp;
  <kbd>Sounds</kbd>&nbsp;&nbsp;
  <kbd>Images</kbd>&nbsp;&nbsp;
  <kbd>Meshes</kbd>&nbsp;&nbsp;
  <kbd>.rbxl / .rbxm files</kbd>&nbsp;&nbsp;
  <kbd>MCP (AI)</kbd>
</p>

<p align="center">
  <sub>Tauri 2 · Rust · React 19 · Luau</sub>
</p>

<p align="center">
  <a href="https://github.com/TrapstarKS/TrapSpoofer/releases/latest"><strong>Download</strong></a>
  ·
  <a href="https://github.com/TrapstarKS/TrapSpoofer/issues/new/choose">Report a bug</a>
</p>

<br>

---

> **Disclaimer.** TrapSpoofer is a tool for working with Roblox assets. Only use it with content you have the right to use. You are responsible for complying with the Roblox Terms of Use and third-party rights.

TrapSpoofer is a heavily reworked fork of [ISpooferMotion V2](https://github.com/ISpooferMotion/ISpooferMotion-V2), focused on three things: a **simple, guided interface**, a **file mode** that works without Studio open, and **AI integration through MCP**.

---

## What it does

The app connects to Roblox Studio through a companion Luau plugin. Choose the target window in the Studio status menu, including when several windows have the same Place ID. Scans, progress and replacements stay attached to that window. The plugin works in the background; its panel opens only when you click its toolbar button.

<table>
  <tr>
    <td width="25%" valign="top">
      <strong>Guided flow</strong><br><br>
      <sub>One clear path: Source → Review → Upload → Apply. No hidden menus.</sub>
    </td>
    <td width="25%" valign="top">
      <strong>File mode</strong><br><br>
      <sub>Open a <code>.rbxl</code>/<code>.rbxlx</code>/<code>.rbxm</code>/<code>.rbxmx</code>, spoof it and save a new copy — Studio doesn't need to be open.</sub>
    </td>
    <td width="25%" valign="top">
      <strong>MCP server</strong><br><br>
      <sub>Let AI assistants (Claude Code, Claude Desktop, Cursor) scan, spoof and apply for you.</sub>
    </td>
    <td width="25%" valign="top">
      <strong>Accounts &amp; groups</strong><br><br>
      <sub>Manage multiple Roblox accounts and Open Cloud keys, with credentials stored by the operating system.</sub>
    </td>
  </tr>
</table>

Also included: ownership detection (skips assets you already own), pause / resume / retry of failed uploads, spoof history, auto-updates, English and Portuguese (BR) UI, and zero telemetry.

---

## Install

Grab the latest version from the [releases page](https://github.com/TrapstarKS/TrapSpoofer/releases/latest).

| Platform              | Package                            |
| --------------------- | ---------------------------------- |
| Windows               | `TrapSpoofer_x.x.x_x64-setup.exe`  |
| macOS (Apple Silicon) | `TrapSpoofer_x.x.x_aarch64.dmg`    |
| Linux                 | `TrapSpoofer_x.x.x_amd64.AppImage` |

The Roblox Studio plugin (`TrapSpoofer.rbxmx`) ships with every release. The app installs and keeps it in sync in your local Studio plugin folders automatically when it starts.

> [!NOTE]
> Windows Defender and other antivirus software may flag unsigned builds. TrapSpoofer has no commercial code-signing certificate. You can verify it by building from source.

---

## Quick start

1. **Accounts** — the app can automatically import the accounts signed in to Roblox Studio on this computer. Each session is validated before it becomes a profile. Uploads can use this session, including for a selected group where the account has asset creation permission. An Open Cloud API key remains optional; when provided, the app uses that key for supported uploads.
2. **Source** — select a connected Studio window and scan it, open a `.rbxl`/`.rbxm` file, or paste IDs.
3. **Review** — pick the assets to spoof (assets you already own are flagged).
4. **Upload** — hit _Start spoof_. Each asset is downloaded and re-uploaded.
5. **Apply** — the new IDs are pushed into Studio (or into a new file, in file mode). Save your place.

**Studio accounts:** Automatic connection is enabled in Settings → General. The app checks Studio's saved sessions on startup, imports valid accounts without duplicates, and signs in with the current Studio account when no valid profile is already selected. An existing profile and its upload group stay selected. Accounts → Import Studio accounts repeats detection after adding or reconnecting an account in Studio. Expired or rejected sessions are skipped, and cookies are saved in the system credential store rather than displayed in the interface. Manual cookie entry remains available.

Asset owners are cached on disk for seven days, up to 50,000 entries. Successful uploads immediately add the new asset's creator to the cache. Repeated runs reuse that information, while failed owner lookups remain eligible for retry. Clear it through the existing cache controls in Settings.

**Native animation clips:** Settings → Upload behavior lets you update the Animation ID normally, replace the Animation with its editable KeyframeSequence/CurveAnimation, or add that native clip as its parent while retaining the Animation. The Studio plugin downloads the original clip through AnimationClipProvider, preserves its keyframes/curves and playback metadata, and leaves the original instance intact if loading fails. The clip format is preserved, not converted. Normal ID replacement is the default. Game code that expects an Animation at the original path must be adapted when using either native clip mode. File mode continues to update IDs only.

**Updates:** Settings → General → Updates controls automatic checking and downloading. The app checks on startup and every six hours, with retries after failures. A downloaded update waits for you to choose **Install and restart**; installation is blocked while scans, uploads or replacements are active. Update the bundled plugin and reopen Studio when moving to a release with the new window-selection protocol.

---

## AI integration (MCP)

TrapSpoofer runs a local [MCP](https://modelcontextprotocol.io) server so an AI assistant can drive the app: `get_status`, `scan_studio`, `scan_file`, `list_assets`, `spoof_assets`, `get_job`, `push_to_studio`, `replace_ids`, `write_spoofed_file`, and more. The **AI / MCP** tab in the app shows the URL, status and copy-ready config snippets.

- **Claude Code:** `claude mcp add --transport http trapspoofer http://127.0.0.1:14380/mcp`
- **Claude Desktop / Cursor (stdio):**
  ```json
  {
    "mcpServers": {
      "trapspoofer": { "command": "C:/path/to/TrapSpoofer.exe", "args": ["--mcp"] }
    }
  }
  ```

The server only accepts local connections and can be turned off in Settings.

---

## Development

### Requirements

| Requirement   | Version        |
| ------------- | -------------- |
| Rust          | Current stable |
| Bun           | 1.x or newer   |
| Node.js       | 20 or newer    |
| Tauri         | 2.x            |
| Roblox Studio | Current        |

On Linux, Tauri also needs: `libwebkit2gtk-4.1-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`.

### Run

```bash
git clone https://github.com/TrapstarKS/TrapSpoofer.git
cd TrapSpoofer

bun install
bun run tauri:dev
```

<details>
<summary><strong>Useful commands</strong></summary>

<br>

| Command                | Description                                  |
| ---------------------- | -------------------------------------------- |
| `bun run tauri:dev`    | Start the desktop app in development mode    |
| `bun run check`        | Run the full validation suite                |
| `bun run build:plugin` | Build the Studio plugin into `dist-plugin/`  |
| `bun run format`       | Format TypeScript, Rust and Luau             |
| `bun run test`         | Run the frontend tests (Vitest)              |
| `bun run rust:test`    | Run the Rust tests                           |
| `bun run bump [patch]` | Bump the version everywhere before a release |

</details>

### Releasing

`bun run bump` → commit → push to `main`. CI builds Windows, macOS and Linux in parallel and publishes the release (with `latest.json` for the auto-updater) whenever the version is new. Publication requires successful checks, successful builds and signed updater artifacts for every required platform. Run `node --test scripts/updater-manifest.node.mjs` to validate the manifest generator.

---

## Project layout

```text
TrapSpoofer/
├── src/            React/TypeScript UI (services/, stores/, mcp/, components/)
├── src-tauri/      Rust/Tauri backend, Studio bridge and MCP server
├── plugin/         Roblox Studio Luau plugin
├── scripts/        Build and release scripts
└── .github/        CI and templates
```

---

## Credits & license

Based on **ISpooferMotion V2** by IncredibroXP. TrapSpoofer is licensed under the **GNU General Public License v3.0 or later** — see [`LICENSE`](LICENSE).

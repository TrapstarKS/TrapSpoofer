---
name: luau-best-practices
description: Luau conventions for TrapSpoofer's bundled Roblox Studio plugin.
---

# TrapSpoofer Luau conventions

Read this file before changing plugin Luau, including tests and generated sources.

- Keep source modules under `plugin/src` and compose them with the existing `--#include` system. Reuse shared helpers; do not duplicate mesh replacement or scanner logic in the entry point.
- Follow `plugin/stylua.toml`: tabs, double quoted strings, a 100 character line width, and Unix newlines.
- Use camelCase for locals and functions, uppercase snake case for shared constants, and Roblox's existing casing for engine members.
- Type function parameters and returns and reuse the `Record` and `Patch` types when applicable. Match neighboring code instead of imposing another project's conventions.
- Keep validation at HTTP/patch boundaries and reject malformed actions, properties, tokens, and stale expected values before mutation.
- Use `pcall` around engine operations that may fail because of permissions, unsupported properties, destroyed instances, HTTP, or asset loading. Keep pure transformations and normal control flow outside `pcall`.
- Preserve instance identity and existing mesh retry/error behavior by using `applyMeshPartInPlace`.
- Add a focused test for new parsing, coercion, or patch behavior. Build the plugin from source and run the relevant include-expanded tests. Do not hand edit generated bundles.
- Keep comments limited to useful explanations and existing include/linter directives. Avoid unrelated cleanup or style rewrites.

# TrapSpoofer native validation — 2026-09-30

## Real publishing without API keys

The interrupted run completed two real uploads using Roblox session authentication. Both requests explicitly supplied an empty `apiKey`. The records were recovered rather than uploading duplicate fixtures.

| Destination | Created asset     | Confirmed creator                        | Created at (UTC) | Persisted job                          |
| ----------- | ----------------- | ---------------------------------------- | ---------------- | -------------------------------------- |
| Personal    | `131230578082744` | User `7115839742`, Trapsstar01           | 15:42:37         | `1aa163bd-1ecb-4f68-b189-5df840a9cff9` |
| Group       | `115781711351052` | Group `902424143`, Laplace Entertainment | 15:45:38         | `4d995030-4482-4444-9e27-06272a311625` |

The personal fixture was a CurveAnimation created for validation. The group job downloaded and republished that new asset. Independent MarketplaceService lookups in Studio confirmed both asset IDs, animation type and creator records. Owner-cache queries using an empty cookie returned the correct owners after process restart. Persisted jobs retained their successful new-ID mappings. Home displayed three jobs, two uploads and two mappings; the earlier filtered item did not increase the uploaded count.

## Real Studio windows with the same Place ID

Two real Studio datamodels and running plugins shared Place ID `99247734135326`. One was the existing test place; the other was a disposable local copy assigned that ID with `DataModel:SetPlaceId`. This exercised a positive-ID collision between real sessions, not two independent Team Create connections to the same published place.

| Window        | Bridge session                         | Concurrent scan                        | Patch operation                        |
| ------------- | -------------------------------------- | -------------------------------------- | -------------------------------------- |
| A, Place2     | `2ec930de-87c7-4670-b1d1-5f7b00f58cc5` | `3236f864-5c97-41ab-9d28-476fd075347d` | `e081cc3a-2936-4963-8563-8ca504a4bb47` |
| B, local copy | `066f4568-d210-429b-bbf5-d513100f578c` | `e0f2f94e-3af2-4e3f-9a26-2c8cbabad604` | `45b01604-44d4-47a3-af6c-958e92e7facf` |

Concurrent scans returned only their requested window/path. Concurrent patches changed A's `CurveReplace` to `115781711351052` and B's `CurveParent` to `507766951`. The corresponding objects in the other window and the shared control remained unchanged. Both completion events carried the correct session and operation IDs and reported zero failed patches. A premature patch while scanning was correctly rejected as busy. Both plugin panels remained closed.

The v3.1.3 fix captures job origin before asynchronous preparation; its focused regression covers switching the selected window during that preparation. The live collision test above covers scan, patch and result isolation. These observations do not claim exhaustive proof over every possible timing.

## Native clips

Saved native outputs from the real plugin runs were decoded and loaded again through Studio's SerializationService:

| Output                                  | Class            | Verified properties                                                                               |
| --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| Replace output, asset `131230578082744` | CurveAnimation   | X curve has 3 keys; value at 0.5 seconds is 0.25; Loop true; Priority Action; container false     |
| Parent output, asset `115781711351052`  | CurveAnimation   | Same keys, sample, Loop and Priority; container true; nested Animation references the group asset |
| Keyframe control, asset `507766951`     | KeyframeSequence | 49 keyframes; Loop true; Priority Core                                                            |

The reload checks used the saved plugin outputs, not newly generated expected objects. The public KeyframeSequence also loaded directly from AnimationClipProvider during this continuation.

## Current authentication limitation

During the continuation, the saved Trapsstar01 session returned HTTP 401 and Studio no longer exposed that account as an importable valid session. Solaris (`1928053099`) was still detected and validated. Fresh private-asset loads for the two created assets were consequently refused by Studio. Their creation, ownership, earlier native output and persisted caches were verified independently above. Trapsstar01 must be signed in again in Studio before further private downloads or publishing through that profile.

## Startup correction in v3.1.4

A retained native stack showed plugin synchronization stalled inside filesystem rename. The splash now has an eight-second fallback, while the backend returns after a six-second synchronization deadline. The actual filesystem task retains exclusive synchronization ownership until it finishes; another caller receives a prompt busy result instead of waiting or racing late writes. The operating-system operation itself is not cancelled by the timeout.

Focused checks cover successful and failed startup, unresolved synchronization, late completion, mutual exclusion and retry after actual completion. Typecheck, targeted frontend lint, Rust Clippy and production frontend/plugin builds were also checked. Release CI remains responsible for all platform builds and updater artifacts.

Detailed local evidence is retained under `node_modules/.cache/validation/`, including `e2e-before-restart.json`, `e2e-after-restart.json`, `final-published-result.json`, `final-dual-status.json`, `final-A-result.json`, `final-B-result.json` and `final-reloaded-clips.json`. These local fixtures and raw runtime evidence are intentionally excluded from release artifacts.

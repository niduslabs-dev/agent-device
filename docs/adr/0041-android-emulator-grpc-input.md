# ADR 0041: Android emulator input over gRPC

## Status

Accepted.
This record owns how input reaches a local Android emulator.
Physical devices, provider-backed devices, snapshots, text entry, and fill keep the routes ADR 0002 describes.

## Rules at a glance

- On a local emulator, taps, long presses, one-finger swipes and scrolls, and the back, home, enter, and app-switch keys go to the emulator's gRPC endpoint (`EmulatorController.sendMouse` and `sendKey`).
- The endpoint comes from the emulator's registration file (`pid_<pid>.ini`): the one live file whose `port.serial` is the serial's console port. The emulator console (`adb emu avd name`) must name the same AVD.
- A provider-scoped device never uses this route.
- A point is placed on the panel with the display rotation and extent of the capture that produced the point. The turned-back extent must be the whole panel. Without such a capture, pointer input keeps the helper route.
- The route answers `unavailable` only when it provably sent nothing: no endpoint, no placement, a connection that never opened, or a gRPC refusal before a handler ran (`UNAUTHENTICATED`, `PERMISSION_DENIED`, `UNIMPLEMENTED`). Only then does the request take the helper or adb route.
- Any other failure is `dispatched: 'unknown'` with `details.reason: 'android_emulator_grpc_input_failed'`, and it never falls back. A pointer failure after the touch down sends the lift again.
- The bearer token never appears in a log, a diagnostic, an error, or a serialized endpoint.
- `AGENT_DEVICE_ANDROID_EMULATOR_GRPC=0` turns the route off.

## Context

The helper injects input through `UiAutomation` inside an instrumentation process, one adb-forwarded socket round trip per event.
On `dev_android36`, a `press @ref` took about 90 ms of daemon time and a `back` about 65 ms.
Android Studio drives its embedded emulator through the emulator's own gRPC server on loopback, which schedules each event on the emulator's main loop in about a millisecond.

## Decision

Add the gRPC endpoint as the first input route for a local emulator, ahead of the helper, behind the fallback rule above.

The emulator delivers mouse events to the guest's virtual touchscreen, in the panel's natural orientation.
Every point agent-device holds is in the display's current rotation.
The helper therefore also reports `displayRotation` beside `displayWidth` and `displayHeight`, and a capture whose two display reads disagree on any of the three reports none.
The platform keeps the latest record per device.
Opening or closing an app and changing the orientation forget it.

The client speaks unary gRPC with `node:http2` and hand-written protobuf for three messages.
The repository keeps runtime dependencies minimal, and no gRPC or protobuf package is bundled.

## Consequences

- The gRPC call returns when the emulator has scheduled the event, before the guest has dispatched it.
  The helper's synchronous injection returned after dispatch.
  The next capture's Android freshness recovery (`session-snapshot-freshness.ts`) owns a tree that is still the pre-action tree, exactly as it already does for keys.
  Settle and verify semantics are otherwise unchanged.
- Event times come from the guest's arrival clock, not from planned timestamps.
  Swipe velocity depends on host pacing, and loopback jitter can change a fling.
- A raw-coordinate press after an app rotated itself without a capture uses the earlier rotation.
  A ref press has the same exposure on every route, because the ref's bounds came from that capture.
- Multi-touch gestures, hardware buttons other than the four keys, TV remote keys, text, and fill keep their existing routes.

## Rejected alternatives

- `@grpc/grpc-js` with generated or loaded protobuf: a runtime dependency and a larger install for three unary calls.
- `streamInputEvent`: one long-lived call avoids per-event setup, but a stream gives no per-event acknowledgement to disclose a partial gesture against.
- `TouchEvent` instead of `MouseEvent`: needs explicit slot pressure and expiry handling. Android Studio uses `MouseEvent` for one finger.
- Reading the rotation at dispatch time (`dumpsys display` or a helper call): costs the round trip this route removes.
- The emulator's own `Image.rotation`: it follows the virtual sensor, not the guest display, so it is wrong after `rotate` sets `user_rotation`.

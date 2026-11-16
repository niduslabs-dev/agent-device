# ADR 0040: Post-gesture baseline distrust by producer freshness

## Status

Accepted.
This record owns when post-gesture stabilization distrusts a quiet pair that still equals the pre-gesture tree.
The quiet-window loop, the no-effect claim (#1600), and the rebase on a surface change (#1569) are unchanged.

## Rules at a glance

- After a scroll, swipe, or swipe `gesture` on a mobile session, the next capture runs the quiet-window loop: it returns only when two consecutive reads agree, or when its budget expires.
- On Apple, the marker stores the pre-gesture tree as a `pre-action` baseline.
- A quiet pair that still equals that baseline is distrusted until the cap of 3.5 s only when a read in the pair comes from a producer whose `postGestureRead` fact is `unproven`.
- A quiet pair whose two reads both come from a `live` producer settles at once. It is reported as `no-effect` when full-surface corroboration agrees.
- `packages/contracts/src/snapshot-producers.ts` holds the `postGestureRead` fact for every producer. Today only `simulator-ax-bridge` and `android-uiautomator` are `live`. A capture without a producer, or with one the host does not list, is `unproven`.

## Context

#1542 added the distrust cap because XCTest does not resync its accessibility tree after a synthesized touch.
Two runner reads can agree with each other and still show the pre-gesture screen while the app has moved.
The cap held the loop for up to 3.5 s whenever a quiet pair matched the baseline.

Since ADR 0004, local Simulator captures come from the host AX bridge, which reads the app's accessibility tree on every call.
A scroll at a list edge moves nothing, so its quiet pair matches the baseline, and every such scroll paid the whole cap.
On 2026-11-16 this cost about 3.3 s on the next snapshot, selector press, or batch step in 3 of 6 CLI loops, and it doubled a 5-step batch from 3.8 s to 7 s.

## Decision

The distrust exemption is a producer fact, not a platform or backend check.
`decidePostGestureStabilityVerdict` in `packages/capture-kit/src/post-gesture-stability.ts` accepts a baseline match at once when the quiet reading is `live`.
The loop marks the quiet reading `live` only when both reads of the pair are `live`, because one cached read is enough to fake a quiet pair.
The daemon adapter reads the fact from each capture's producer (`snapshotPostGestureReadFreshness` in `packages/daemon/src/core/interaction-surface-signature.ts`).

The guarantee that the loop exists for stays: no caller acts on a tree that is still moving.
A moving list gives reads that differ from each other, so it never forms a quiet pair, whatever its producer.
Only the second, XCTest-specific guard (a stale tree that holds still) is relaxed, and only for producers that cannot serve one.

### Amendment: iOS Simulator scroll through the digitizer

A controlled iOS `scroll` on a local Simulator in the default device set no longer drags through XCTest.
The runner resolves the frame, the keyboard band, and the plan as before, and answers the planned drag in `hostScrollDrag` instead of sending it (`scrollDispatch: host`).
The host sends it through the Simulator's digitizer helper (ADR 0005) as one finger, a sample every frame, eased out with the runner's cubic, over `IOS_HOST_SCROLL_DURATION_MS` (300 ms) unless the caller names a duration, then rests 48 ms before the lift. A 200 ms drag was rejected: on Settings, a scroll down then up from the top came back to the top 0 times in 5 at 200 ms and 5 times in 5 at 300 ms.
The helper answers after a barrier behind the lift, so every move has reached the guest's HID service when the scroll returns.
Inertial scrolls (`scroll top` and `bottom`), other windows than a portrait one at the screen origin, and other devices keep the runner drag. A digitizer that sent nothing returns the scroll to the runner.

This decision is unchanged by the route: the next capture still runs the quiet-window loop, and the gesture marker does not depend on who sent the drag.
The finger comes to rest before it lifts, so the content stops where it stops. A 2026-11-17 Settings run read the same positions 1 s and 2 s after each scroll, at rest and right after a `back`.
The open gap below shrinks for this route: the drag's moves reach the app while the host is still sending them, so motion starts before the command returns.

## Rejected alternatives

- **Skip the wait when the scroll reports no movement.** The iOS runner's scroll reports no movement fact, and adding one means a runner change with its own device matrix. A content-offset fact also cannot see a list that ignores synthesized scrolls, which is the #1600 case. The producer fact covers the measured cost without a runner change.
- **Exempt the whole `xctest` backend when the bridge is the usual route.** A bridge refusal falls back to the runner for one capture or one app generation (ADR 0038), so the backend alone does not say which reader served the pair.
- **Shorten the cap for every producer.** The cap is the only defence against the stale runner read, and a shorter cap would bring back #1542 on runner captures.

## Consequences

- An iOS Simulator scroll that moved nothing costs one quiet pair (about two captures) instead of the 3.5 s cap, and still reports `no-effect`.
- Runner, Appium, and Revyl captures keep the cap.
- The fact is a claim about a producer. A new producer starts `unproven`, and a producer becomes `live` only after a device run shows that a baseline match after a real gesture cannot occur.
- Open gaps:
  - The bridge fact rests on the 2026-11-16 benchmark and the bridge's per-call read. A device run must confirm that a bridge read taken right after a moving scroll never equals the pre-scroll tree.
  - If a synthesized gesture returns before the app starts to move, a `live` pair could read the pre-gesture screen as at rest. The quiet window spans one 200 ms poll, so this needs a gesture whose motion starts more than about 200 ms after the runner returns.

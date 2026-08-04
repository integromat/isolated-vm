## Unreleased
- **Breaking:** `isolate.setBufferPrototype()` now registers the Node `Buffer` prototype **per
context** instead of per isolate. Previously an isolate had a single prototype slot, so only the
last registration in an isolate was effective and all contexts had to share one `Buffer` object.
Every context that wants `Buffer` round-tripping must now call `setBufferPrototype()` itself; a
context that doesn't copies typed arrays out as plain `Uint8Array`. This lets each context own an
isolated `Buffer`, removing the cross-context mutation surface of a shared one.
- `setBufferPrototype()` now throws if called from outside the isolate it belongs to.

## v4.3.0
- v8 inspector API fixed in nodejs v16.x
- `release` method added to `Module`

## v4.2.0
- `accessors` option added to `reference.get()`

## v4.1.0
- Support for nodejs v16.x
- `onCatastrophicError` added
- Fix for `null` error thrown from callback

## v4.0.0
- `Callback` class addeed.
- When possible, `reference.get()` will return a function delegate instead of a `Reference`.
- `reference.get()` will no longer return inherited properties by default.
- `result` property on `eval` and `evalClosure` has been removed. The result is now just the return
value.
- All `isolated-vm` class prototypes, and most instances are frozen.
- `isolate.cpuTime` and `isolate.wallTime` now return bigints.
- Proxies and accessors are no longer tolerated via `reference.get`, and related functions.

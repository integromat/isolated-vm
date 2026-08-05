## Unreleased
- **Breaking:** `isolate.setBufferPrototype()` now registers the Node `Buffer` prototype **per
  context** instead of per isolate. Previously an isolate had a single prototype slot, so only the
  last registration in an isolate was effective and all contexts had to share one `Buffer` object.
  Every context that wants `Buffer` round-tripping must now call `setBufferPrototype()` itself; a
  context that doesn't call it copies typed arrays out as plain `Uint8Array`. This lets each context own an
  isolated `Buffer`, removing the cross-context mutation surface of a shared one.
- `setBufferPrototype()` now throws if called from outside the isolate it belongs to.
- **Breaking:** user JavaScript can no longer run while a value is copied. `ExternalCopy::Copy`
  installs a `DisallowJavascriptExecutionScope`, so getters, setters and proxy traps are never
  invoked during serialization. This closes the window where a getter could detach or resize an
  `ArrayBuffer` that had already been written into the copy, and where an interceptor on the
  `transferList` array could hand back buffers chosen after the fact.
- **Breaking:** accessor properties on a copied object are now rejected with a `TypeError` naming the
  offending property, instead of being silently dropped from the copy. Assign a plain value if the
  property should be transferred.
- A blocked transfer now throws a `TypeError` explaining that reading the value would run user code.
  Previously the caller received v8's bare `"illegal access"` string with no indication of what went
  wrong. Genuine `DataCloneError`s pass through unchanged, and a rejected copy no longer leaves a
  pending exception behind to poison later operations.
- Own properties of a view are now *defined* on the copy rather than assigned to it. Assigning ran a
  setter inherited by the destination — user code executing mid-copy, which aborted the process under
  the transfer's `DisallowJavascriptExecutionScope` (and silently swallowed the property without it).
  Any code that could reach `Object.prototype` in either isolate could trigger the abort.
- Fixed a crash when a copied object carried a symbol-keyed accessor. Formatting the property name
  for the error message stringified the key, which yields a null pointer for a symbol.
- The accessor check now reads the property descriptor's own `get`/`set`. It walked the prototype
  chain, so an `Object.prototype.get` left behind by other code made every plain data property look
  like an accessor and rejected the copy.
- Accessors *inherited* by a copied value are still ignored rather than rejected: only own properties
  are copied, so an inherited accessor is never read. Rejecting them would fail every typed array,
  since `parent`, `offset`, `buffer`, `byteLength`, `byteOffset` and `length` are all prototype
  accessors.
- `GetObjectOwnProperties()` no longer aborts the process when property enumeration fails (for
  example while the isolate is terminating); it raises instead.

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

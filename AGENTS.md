# isolated-vm — Agent Context

## What

`@integromat/isolated-vm` is a Make-internal fork of the [`isolated-vm`](https://github.com/laverdet/isolated-vm) npm package. It is a native Node.js C++ addon that exposes V8's `Isolate` interface, enabling fully isolated JavaScript sandboxes with separate heaps, memory limits, and security boundaries. The fork is published as `@integromat/isolated-vm` and is currently at v4.8.3 (forked from upstream v4.3.0).

**Tech stack:** C++17 native addon · Direct V8 API (not NAN/NAPI) · node-gyp build · prebuildify for binary distribution · Node.js >=16 <21.

## Why

The package lets Make run untrusted user code in secure, memory-limited V8 isolates completely separated from the host Node.js process. Each isolate has its own heap; data crossing isolate boundaries must be explicitly serialized or transferred.

## Architecture

### JS Layer

`isolated-vm.js` is a single-line shim: `module.exports = require('node-gyp-build')(__dirname).ivm`. The entire public API (all classes and constructors) is native C++. TypeScript types are declared in `isolated-vm.d.ts` as `namespace IsolatedVM`.

### C++ Source Layout

- `src/module/` — JS-visible handle classes: `IsolateHandle`, `ContextHandle`, `ScriptHandle`, `ModuleHandle`, `ReferenceHandle`, `ExternalCopyHandle`, `Callback`, `NativeModuleHandle`, `LibraryHandle`
- `src/isolate/` — core runtime: `IsolateEnvironment`, `IsolateHolder`, `Executor`, `Scheduler` hierarchy, `ThreePhaseTask`, `ClassHandle`, `RemoteHandle`
- `src/external_copy/` — cross-isolate value serialization (`ExternalCopy` subclasses, structured clone)
- `src/lib/` — primitives: `thread_pool_t`, `timer`, `lockable_t`, `covariant_t`
- `src/isolated_vm.h` — narrow public C++ API for embedding (exposes `IsolateHolder`, `RemoteHandle`, `Runnable`)
- `vendor/v8_inspector/` — vendored Node.js-version-specific inspector headers for v16/v18/v20

### Binding Mechanism

**Direct V8 API** (no NAN/NAPI). `ClassHandle` (`src/isolate/class_handle.h`) is the base for all JS-exposed objects:
- Creates `v8::FunctionTemplate` with `InternalFieldCount(1)` to store a raw native pointer
- `Wrap()` stores the `ClassHandle*` in `InternalField[0]` and sets a weak GC callback
- `Unwrap<T>()` reads `InternalField[0]` and `dynamic_cast<T*>`
- All class prototypes and instances are frozen with `SetIntegrityLevel(kFrozen)` unless opted out

`IsolateSpecific<T>` (`src/isolate/specific.h`) is a per-isolate analogue of `thread_local` — stores data in `IsolateEnvironment::specifics` (a `std::vector<v8::Eternal<v8::Data>>`) keyed by an atomically assigned global index. Used to cache `FunctionTemplate`s per-isolate.

### Isolate Lifecycle

`IsolateEnvironment` (`src/isolate/environment.h`) owns the raw `v8::Isolate*`, scheduler, executor, and memory tracking. Held via `IsolateHolder` (`src/isolate/holder.h`) which wraps it in a `lockable_t<shared_ptr<IsolateEnvironment>>`.

Two factory paths:
- `IsolateEnvironment::New(v8::Isolate*, v8::Context)` — wraps the existing Node.js default isolate; uses `UvScheduler`
- `IsolateEnvironment::New(memory_limit_mb, snapshot, ...)` — creates a fresh V8 isolate with `LimitedAllocator`; uses `IsolatedScheduler`

### Scheduler Architecture

```
Scheduler (base: mutex + 4 task queues: tasks, handle_tasks, interrupts, sync_interrupts)
  └── LockedScheduler
        ├── UvScheduler   — default Node.js isolate, wakes via uv_async_send
        └── IsolatedScheduler — user isolates, dispatches to thread_pool_t
```

`thread_pool_t` (`src/lib/thread_pool.h`) is fixed-size (`hardware_concurrency + 1`). Thread affinity (`affinity_t`) tracks which pool threads are associated with each isolate.

`covariant_t` (`src/lib/covariant.h`) is a tagged-union/aligned-storage that holds one of several types sharing a base class — used so `IsolateEnvironment` stores the scheduler inline without heap allocation.

### Three-Phase Task Protocol

All cross-isolate operations use `ThreePhaseTask` (`src/isolate/three_phase_task.h`):

| Phase | Runs in | Purpose |
|-------|---------|---------|
| Phase 1 (constructor) | Calling isolate | Serialize data out |
| Phase 2 (`Phase2()`) | Target isolate | Do work, serialize results |
| Phase 3 (`Phase3()`) | Calling isolate | Deserialize results, resolve promise |

`ThreePhaseTask::Run<async, T>()` dispatches on 4 modes: full async (returns promise), fire-and-forget (ignored), fully sync (acquires `Executor::Lock` directly), and sync+async (suspends caller thread while default isolate handles async work).

### Thread Safety

- `v8::Locker` — enforces single-threaded V8 isolate access. `Executor::Lock` RAII-wraps: `v8::Locker → v8::Isolate::Scope → v8::HandleScope`.
- `lockable_t<T>` (`src/lib/lockable.h`) — bundles a resource with a mutex (and optionally a condition variable). Used for `IsolateHolder::isolate`, `AsyncWait::state`, and the global `default_isolates` map.
- `Executor` (`src/isolate/executor.h`) tracks the current environment via `thread_local Executor* current_executor`. `Executor::Scope` sets this on entry.
- `Scheduler::AsyncWait` — parks the calling thread while waiting for cross-isolate async results; uses a waitable `lockable_t<bool>`.

### Method Naming Convention

Every native operation exposes up to three variants:
- `method()` — async, returns `Promise<T>`
- `methodSync()` — synchronous, blocks calling thread
- `methodIgnored()` — fire-and-forget, returns `undefined`, swallows exceptions

`applySyncPromise` is special: only callable on default-isolate functions from a non-default thread; the calling isolate suspends while the promise resolves on the default thread.

### ExternalCopy / Serialization

`ExternalCopy` subclasses (`src/external_copy/`) serialize V8 values out of one isolate for materialization in another. Key subclasses: `ExternalCopyArrayBuffer` (detaches backing store), `ExternalCopySharedArrayBuffer` (shares backing store), `ExternalCopyError`. `CopyIntoCheckHeap()` calls `IsolateEnvironment::HeapCheck` before materializing to enforce memory limits. Global external size tracked atomically via `TotalExternalSize()`.

The `nortti` static library target in `binding.gyp` compiles `serializer_nortti.cc` and `allocator_nortti.cc` without RTTI to avoid ODR conflicts with V8's own RTTI-less objects.

## Build

```sh
npm run rebuild        # full native build (node-gyp rebuild --release -j max)
npm run prebuild       # prebuildify (generates platform-specific binaries)
```

**`binding.gyp`** defines 3 targets: `isolated_vm` (the `.node` addon, C++17, exceptions+RTTI enabled), `nortti` (static lib without RTTI, non-Windows only), and `action_after_build` (copies `.node` to `out/`).

## Testing

```sh
node test.js
```

`test.js` spawns each `tests/*.js` file as a subprocess (always with `--no-node-snapshot`). A test passes iff: stdout == `'pass\n'`, stderr is empty, exit code is 0. Tests signal pass via `console.log('pass')`. Assertions use Node's built-in `assert`. To add node flags, place `// node-args: --flag` on line 1 of the test file.

## Make Fork Specifics

- Package name `@integromat/isolated-vm`; published to npm via `secrets.NPM_TOKEN`
- CI matrix includes `make-ubuntu24-arm64-2c` (Make internal self-hosted ARM64 runner)
- `validate-pr.yml` and `CODEOWNERS` are autogenerated from `integromat/mono` repo; CODEOWNERS assigns `@integromat/build-run-backend`
- Key fork fix: exception propagation from `Phase2Runner` to calling isolate (`three_phase_task.cc`, commits #9/#10)
- `devDependencies` includes `"isolated-vm": "."` — tests `require('isolated-vm')` which resolves to the local package via `NODE_PATH=__dirname`

## When in Plan Mode
- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- Interview user in detail (for Claude: use the AskUserQuestionTool) about literally anything: technical implementation, UI & UX, concerns, tradeoffs, etc. but make sure the questions are not obvious. Be very in-depth and continue interviewing the user continually until it's complete. Use the answers to create a detailed spec.
- Make assumptions explicit: When you must proceed under uncertainty, list assumptions up front and continue.

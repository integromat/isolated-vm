const ivm = require('isolated-vm');

// Regression test: a parent major GC must never run a child's weak callbacks with the parent
// environment current.
//
// `MarkSweepCompactPrologue` propagates the parent's major GC to idle children. It used to do that by
// calling `MemoryPressureNotification(kCritical)` on the child directly. A sync call into a child keeps
// `Executor::Lock` (a `v8::Locker`) on the child up on this thread, so a host callback invoked from the
// child's script runs inside that lock with the parent environment current. If the callback allocates
// enough to trigger a parent major GC right there, V8 collects the child inline. Every weak callback in
// the child then runs while `Executor::GetCurrentEnvironment()` is the parent, so `RemoveWeakCallback`
// lands on node's environment where it is a silent no-op — the entry stays in the child's
// `weak_persistents` even though the holder was freed.
//
// Symptoms on a broken build, all from the same corruption (timing picks one):
//   std::logic_error "Weak callback already added"  — allocator reused the freed holder's address (ABA)
//   Check failed: node->IsInUse()                  — teardown loop resets an already-freed handle
//   SIGSEGV
//
// The callback here only allocates on the node heap — it doesn't touch the child at all. That's the
// point: holding a child's lock while allocating in the host is enough, which is ordinary embedder
// behaviour. tests/reentrant-reference-set.js covers the reentrant-mutator variant.

const ISOLATES = 40;
const CONTEXTS = 25;
const CALLBACKS = 8; // garbage `ExternalHolder`s to leave in each child
const HOST_ALLOCATIONS = 20000; // node-heap allocations per callback, to force parent major GCs

for (let i = 0; i < ISOLATES; i++) {
	const isolate = new ivm.Isolate({ memoryLimit: 128 });
	for (let c = 0; c < CONTEXTS; c++) {
		const context = isolate.createContextSync();
		const jail = context.global;

		// Each of these is an `ExternalHolder` registered in the child's `weak_persistents`.
		for (let k = 0; k < CALLBACKS; k++) {
			jail.setSync(`fn${k}`, (a, b) => a + b);
		}

		// Allocates only on the node heap, while the child's `v8::Locker` is held on this thread.
		jail.setSync('churn', () => {
			const sink = [];
			for (let n = 0; n < HOST_ALLOCATIONS; n++) {
				sink.push({ n, s: 'x' + n });
			}
			return sink.length;
		});

		// Drop the callbacks so the child has collectable holders, then hand control to the host.
		context.evalSync(`
			for (let k = 0; k < ${CALLBACKS}; k++) delete globalThis['fn' + k];
			churn();
		`);
		context.release();
	}
	isolate.dispose();
}

console.log('pass');

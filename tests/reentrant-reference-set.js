const ivm = require('isolated-vm');

// Regression test: calling a `Reference` mutator from inside a host callback while the target isolate
// is on the stack must not corrupt per-environment weak-callback bookkeeping.
//
// This is the shape that first exposed the bug: `jail.setSync` re-enters the child isolate from a host
// callback the child is currently executing. The reentrancy itself is legal and is not what broke —
// what broke was `MarkSweepCompactPrologue` calling `MemoryPressureNotification` on an idle child from
// the parent's GC prologue. Reentrant `setSync` churns child external memory hard enough to make the
// parent GC land there reliably. See tests/parent-gc-weak-callback-env.js for the full mechanism.
//
// Crashes within ~625 contexts on a broken build, so the scale below has healthy margin.

const ISOLATES = 60;
const CONTEXTS = 25;

for (let i = 0; i < ISOLATES; i++) {
	const isolate = new ivm.Isolate({ memoryLimit: 128 });
	for (let c = 0; c < CONTEXTS; c++) {
		const context = isolate.createContextSync();
		const jail = context.global;

		// A host callback that writes back into the same context while that context is on the stack.
		jail.setSync('rebind', () => {
			jail.setSync(`bound${c}`, (a, b) => a + b);
		});

		context.evalSync('rebind()');
		context.release();
	}
	isolate.dispose();
}

console.log('pass');

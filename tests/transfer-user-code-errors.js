'use strict';
// Blocked user code during transfer must surface as a real Error. v8 signals a violation of
// `DisallowJavascriptExecutionScope` by throwing the bare string "illegal access", which gives the
// caller nothing to work with, so it is translated on the way out.
const ivm = require('isolated-vm');
const assert = require('assert');

const isolate = new ivm.Isolate();
const context = isolate.createContextSync();
const jail = context.global;

function assertBlocked(fn, label) {
	assert.throws(fn, err => {
		assert(err instanceof Error, `${label}: expected an Error, got ${typeof err} ${err}`);
		assert(err instanceof TypeError, `${label}: expected a TypeError, got ${err.constructor.name}`);
		assert(/user code/.test(err.message), `${label}: unhelpful message ${JSON.stringify(err.message)}`);
		return true;
	});
}

// A getter anywhere in the graph is user code.
assertBlocked(() => {
	let fired = false;
	jail.setSync('withGetter', { get prop() { fired = true; return 1; } }, { copy: true });
	assert.strictEqual(fired, false);
}, 'object getter');

// An interceptor on `transferList` could hand back a different buffer per read.
assertBlocked(() => {
	const view = new Uint8Array(new ArrayBuffer(8));
	const { buffer } = view;
	const transferList = [ buffer ];
	Object.defineProperty(transferList, 0, {
		enumerable: true,
		get() { return buffer; },
	});
	new ivm.ExternalCopy({ view }, { transferList });
}, 'transferList interceptor');

// Pre-existing errors keep their own messages rather than being swallowed by the translation.
{
	assert.throws(
		() => new ivm.ExternalCopy({ a: 1 }, { transferList: [ {} ] }),
		/Non-ArrayBuffer passed in `transferList`/);

	// Genuine DataCloneErrors are rethrown untouched.
	assert.throws(() => jail.setSync('fn', { fn() {} }, { copy: true }), /could not be cloned/);
	assert.throws(
		() => jail.setSync('proxy', { inner: new Proxy({ a: 1 }, {}) }, { copy: true }),
		/could not be cloned/);
}

// Ordinary values are unaffected.
{
	jail.setSync('plain', { a: 1, b: [ 2, 3 ] }, { copy: true });
	assert.deepStrictEqual(jail.getSync('plain', { copy: true }), { a: 1, b: [ 2, 3 ] });
}

isolate.dispose();
console.log('pass');

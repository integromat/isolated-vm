'use strict';
// Own properties of a view are copied one by one by `CopyObjectProperties`. The lookups it performs
// must not consult a prototype chain and its error paths must not assume string keys, otherwise
// ordinary user code -- a symbol key, a polluted `Object.prototype` -- takes the process down or
// produces a bogus diagnostic.
const ivm = require('isolated-vm');
const assert = require('assert');

const isolate = new ivm.Isolate();
const context = isolate.createContextSync();
const jail = context.global;

// A symbol-keyed accessor is rejected like any other accessor. Formatting the key must not assume it
// stringifies: `String::Utf8Value` yields a null pointer for a symbol.
{
	const buf = Buffer.from('hi');
	Object.defineProperty(buf, Symbol('lazySym'), {
		enumerable: true,
		get() { return 'accessor-value'; },
	});

	assert.throws(() => jail.setSync('symGetter', buf, { copy: true }), err => {
		assert(err instanceof TypeError, `expected TypeError, got ${err}`);
		assert(/accessor/.test(err.message), `message should explain the cause: ${err.message}`);
		assert(/lazySym/.test(err.message), `message should name the property: ${err.message}`);
		return true;
	});
}

// Symbol-keyed data properties are dropped by structured clone, but they must not derail the copy.
{
	const buf = Buffer.from('hi');
	buf[Symbol('dataSym')] = 'data-only';
	buf.plain = 'kept';

	jail.setSync('symData', buf, { copy: true });
	assert.strictEqual(jail.getSync('symData', { copy: true }).plain, 'kept');
}

// The accessor check reads the descriptor's own `get`/`set`. A `get` inherited from a polluted
// `Object.prototype` must not make every data property look like an accessor.
{
	const buf = Buffer.from('hi');
	buf.plain = 'kept';

	Object.prototype.get = 1;
	Object.prototype.set = 1;
	try {
		jail.setSync('polluted', buf, { copy: true });
	} finally {
		delete Object.prototype.get;
		delete Object.prototype.set;
	}

	assert.strictEqual(jail.getSync('polluted', { copy: true }).plain, 'kept');
}

// Properties are defined on the copy, not assigned to it. A setter inherited by the destination view
// must not be invoked -- it is user code running mid-copy, and under the transfer's
// `DisallowJavascriptExecutionScope` invoking it aborts the process.
{
	context.evalSync(`
		globalThis.setterRan = false;
		Object.defineProperty(Object.prototype, 'plain', {
			configurable: true,
			set(value) { globalThis.setterRan = value; },
		});
	`);

	const buf = Buffer.from('hi');
	buf.plain = 'payload';
	jail.setSync('inheritedSetter', buf, { copy: true });

	assert.strictEqual(context.evalSync('globalThis.setterRan'), false, 'setter must not run during copy');
	assert.strictEqual(context.evalSync('inheritedSetter.plain'), 'payload');
	assert.strictEqual(
		context.evalSync('String(Object.getOwnPropertyDescriptor(inheritedSetter, "plain").value)'),
		'payload', 'value must land as an own data property');
	context.evalSync(`delete Object.prototype.plain`);
}

// Same guarantee copying in the other direction, where the host owns the polluted prototype.
{
	let setterRan = false;
	Object.defineProperty(Object.prototype, 'tag', {
		configurable: true,
		set(value) { setterRan = value; },
	});
	try {
		context.evalSync(`globalThis.make = () => { const view = new Uint8Array([ 1, 2 ]); view.tag = 'payload'; return view; }`);
		const make = jail.getSync('make', { reference: true });
		const copy = make.applySync(undefined, [], { result: { copy: true } });

		assert.strictEqual(setterRan, false, 'setter must not run during copy');
		assert.strictEqual(Object.getOwnPropertyDescriptor(copy, 'tag').value, 'payload');
	} finally {
		delete Object.prototype.tag;
	}
}

isolate.dispose();
console.log('pass');

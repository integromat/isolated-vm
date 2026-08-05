'use strict';
// User code may not run while a value is being serialized for transfer. Own properties on Buffer and
// typed-array views are copied by `CopyObjectProperties`, so an accessor there must be reported
// rather than silently dropped from the copy.
const ivm = require('isolated-vm');
const assert = require('assert');

const isolate = new ivm.Isolate();
const context = isolate.createContextSync();
const jail = context.global;

// Plain data properties still round-trip, alongside the buffer payload.
{
	const buf = Buffer.from('hi');
	buf.plain = 'kept';
	buf.count = 3;

	jail.setSync('withData', buf, { copy: true });
	const copy = jail.getSync('withData', { copy: true });

	assert.strictEqual(copy.plain, 'kept');
	assert.strictEqual(copy.count, 3);
	assert.strictEqual(copy.length, 2);
	assert.deepStrictEqual([ ...copy.subarray(0, 2) ], [ 104, 105 ]);
}

// A getter on a Buffer is rejected by name instead of vanishing from the copy.
{
	let fired = false;
	const buf = Buffer.from('hi');
	Object.defineProperty(buf, 'lazy', {
		enumerable: true,
		get() { fired = true; return 'accessor-value'; },
	});

	assert.throws(() => jail.setSync('withGetter', buf, { copy: true }), err => {
		assert(err instanceof TypeError, `expected TypeError, got ${err}`);
		assert(/lazy/.test(err.message), `message should name the property: ${err.message}`);
		assert(/accessor/.test(err.message), `message should explain the cause: ${err.message}`);
		return true;
	});
	assert.strictEqual(fired, false, 'getter must not run during transfer');
}

// Setter-only accessors are rejected too — they are equally un-copyable.
{
	const buf = Buffer.from('hi');
	Object.defineProperty(buf, 'writeOnly', {
		enumerable: true,
		set(_value) {},
	});

	assert.throws(() => jail.setSync('withSetter', buf, { copy: true }), TypeError);
}

// Same guarantee for a non-Buffer typed array.
{
	let fired = false;
	const view = new Uint16Array([ 1, 2, 3 ]);
	Object.defineProperty(view, 'tag', {
		enumerable: true,
		get() { fired = true; return 'tag-value'; },
	});

	assert.throws(() => jail.setSync('taGetter', view, { copy: true }), err => {
		assert(err instanceof TypeError, `expected TypeError, got ${err}`);
		assert(/tag/.test(err.message), `message should name the property: ${err.message}`);
		return true;
	});
	assert.strictEqual(fired, false, 'getter must not run during transfer');
}

// A rejected copy must not leave a pending exception that poisons later transfers.
{
	jail.setSync('after', { ok: 1 }, { copy: true });
	assert.deepStrictEqual(jail.getSync('after', { copy: true }), { ok: 1 });
}

isolate.dispose();
console.log('pass');

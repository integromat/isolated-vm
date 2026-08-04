'use strict';
// Buffer prototype registration is per *context*, not per isolate. Several contexts in one
// isolate can each register their own `Buffer` and round-trip simultaneously.
const ivm = require('isolated-vm');
const assert = require('assert');

const bytes = [ 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08 ];
const hostBuffer = Buffer.from(bytes);

/**
 * Creates a context with its own `Buffer` class registered as the context's buffer prototype.
 *
 * @param {ivm.Isolate} isolate Isolate to create the context in.
 * @param {string} tag Marker stored on the context's `Buffer` so cross-context bleed is visible.
 * @returns {ivm.Context} The context, with `Buffer` installed on its global.
 */
function makeRegisteredContext(isolate, tag) {
	const context = isolate.createContextSync();
	context.evalClosureSync(`
		class Buffer extends Uint8Array {
			static isBuffer(value) { return value instanceof Buffer }
		}
		Buffer.tag = ${JSON.stringify(tag)};
		globalThis.Buffer = Buffer;
		$0.setBufferPrototype(Buffer.prototype);
	`, [ isolate ]);
	return context;
}

/**
 * Round-trips a host Buffer through a context and asserts recognition in both directions.
 *
 * @param {ivm.Context} context Context to send the buffer through.
 * @param {string} tag Expected `Buffer.tag` of the context that received the buffer.
 */
function assertRoundTrips(context, tag) {
	const jail = context.global;
	jail.setSync('buffer', hostBuffer, { copy: true });

	// host -> sandbox: stamped with *this* context's Buffer.prototype
	const inSandbox = context.evalClosureSync(`
		return {
			isBuffer: Buffer.isBuffer(buffer),
			ctor: buffer.constructor.name,
			tag: buffer.constructor.tag,
			bytes: Array.from(buffer),
		}
	`, [], { result: { copy: true } });
	assert.strictEqual(inSandbox.isBuffer, true);
	assert.strictEqual(inSandbox.ctor, 'Buffer');
	assert.strictEqual(inSandbox.tag, tag);
	assert.deepStrictEqual(inSandbox.bytes, bytes);

	// sandbox -> host: recognized as a real Node Buffer
	const roundTripped = jail.getSync('buffer', { copy: true });
	assert(roundTripped !== hostBuffer);
	assert(Buffer.isBuffer(roundTripped));
	assert.deepStrictEqual(roundTripped, hostBuffer);

	// a Buffer created *inside* the context also comes out as a real Node Buffer
	const madeInside = context.evalClosureSync(
		'return Buffer.from ? Buffer.from(buffer) : new Buffer(buffer)',
		[], { result: { copy: true } });
	assert(Buffer.isBuffer(madeInside));
	assert.deepStrictEqual(Array.from(madeInside), bytes);
}

// 1. Two registered contexts round-trip independently and simultaneously.
{
	const isolate = new ivm.Isolate();
	const a = makeRegisteredContext(isolate, 'A');
	const b = makeRegisteredContext(isolate, 'B');

	// Interleaved, so registering B cannot be "last writer wins" over A.
	assertRoundTrips(a, 'A');
	assertRoundTrips(b, 'B');
	assertRoundTrips(a, 'A');
	assertRoundTrips(b, 'B');

	// The two Buffers are genuinely distinct objects.
	a.global.setSync('otherBuffer', b.global.getSync('Buffer', { reference: true }));
	const shared = a.evalClosureSync('return otherBuffer.deref() === Buffer', [], { result: { copy: true } });
	assert.strictEqual(shared, false);

	isolate.dispose();
}

// 2. Isolation: poisoning one context's Buffer does not affect the other.
{
	const isolate = new ivm.Isolate();
	const a = makeRegisteredContext(isolate, 'A');
	const b = makeRegisteredContext(isolate, 'B');

	a.evalClosureSync(`
		Buffer.poisoned = true;
		Buffer.from = () => { throw new Error('hijacked') };
		Buffer.prototype.toString = () => 'stolen';
		Buffer.prototype.poisonedProp = 42;
	`);

	const bState = b.evalClosureSync(`
		const buf = new Buffer(1);
		return {
			poisoned: Buffer.poisoned === true,
			fromWorks: (() => { try { Buffer.from([ 1 ]); return true } catch { return false } })(),
			toString: buf.toString(),
			poisonedProp: buf.poisonedProp,
		}
	`, [], { result: { copy: true } });
	assert.strictEqual(bState.poisoned, false);
	assert.strictEqual(bState.fromWorks, true);
	assert.notStrictEqual(bState.toString, 'stolen');
	assert.strictEqual(bState.poisonedProp, undefined);

	// A is poisoned but still round-trips: registration keys off prototype identity, which
	// property mutation does not change.
	b.global.setSync('buffer', hostBuffer, { copy: true });
	assert.strictEqual(
		b.evalClosureSync('return Buffer.isBuffer(buffer)', [], { result: { copy: true } }),
		true);
	a.global.setSync('buffer', hostBuffer, { copy: true });
	assert.strictEqual(
		a.evalClosureSync('return Buffer.isBuffer(buffer) && buffer.toString() === "stolen"', [], { result: { copy: true } }),
		true);

	isolate.dispose();
}

// 3. An unregistered context in the same isolate as a registered one copies plain typed arrays.
{
	const isolate = new ivm.Isolate();
	const registered = makeRegisteredContext(isolate, 'A');
	const plain = isolate.createContextSync();

	plain.global.setSync('buffer', hostBuffer, { copy: true });
	const inPlain = plain.evalClosureSync(`
		return {
			isUint8Array: buffer instanceof Uint8Array,
			ctor: buffer.constructor.name,
			hasBuffer: typeof globalThis.Buffer,
		}
	`, [], { result: { copy: true } });
	assert.strictEqual(inPlain.isUint8Array, true);
	assert.strictEqual(inPlain.ctor, 'Uint8Array');
	assert.strictEqual(inPlain.hasBuffer, 'undefined');

	const outOfPlain = plain.global.getSync('buffer', { copy: true });
	assert(outOfPlain instanceof Uint8Array);
	assert(!Buffer.isBuffer(outOfPlain));

	// ...and the registered sibling is unharmed.
	assertRoundTrips(registered, 'A');

	isolate.dispose();
}

// 4. Cross-isolate host round-trip still works (guards the default-isolate init path).
{
	const isolate = new ivm.Isolate();
	const context = makeRegisteredContext(isolate, 'A');
	context.evalClosureSync('globalThis.echo = value => value');
	const echo = context.global.getSync('echo', { reference: true });
	const result = echo.applySync(undefined, [ hostBuffer ], {
		arguments: { copy: true },
		result: { copy: true },
	});
	assert(Buffer.isBuffer(result));
	assert.deepStrictEqual(result, hostBuffer);
	isolate.dispose();
}

// 5. Many contexts created, registered and released — no leak, no crash.
{
	const isolate = new ivm.Isolate({ memoryLimit: 32 });
	for (let ii = 0; ii < 200; ++ii) {
		const context = makeRegisteredContext(isolate, `ctx${ii}`);
		context.global.setSync('buffer', hostBuffer, { copy: true });
		assert.strictEqual(
			context.evalClosureSync('return Buffer.isBuffer(buffer)', [], { result: { copy: true } }),
			true);
		assert(Buffer.isBuffer(context.global.getSync('buffer', { copy: true })));
		context.release();
	}
	// Survivors of the churn still work.
	const last = makeRegisteredContext(isolate, 'last');
	assertRoundTrips(last, 'last');
	isolate.dispose();
}

console.log('pass');

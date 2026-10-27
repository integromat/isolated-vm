'use strict';
const assert = require('node:assert/strict');
const ivm = require('isolated-vm');

/** Copy through the same serialization boundary used by implicit copies. */
function copy(value, options) {
	return new ivm.ExternalCopy(value, options).copy();
}

/** Make secret-filled storage with two overlapping views and a disjoint DataView. */
function fixture() {
	const buffer = new ArrayBuffer(32);
	new Uint8Array(buffer).fill(0x73);
	return {
		buffer,
		a: new Uint8Array(buffer, 4, 8),
		b: new Uint16Array(buffer, 8, 4),
		c: new DataView(buffer, 20, 4),
	};
}

/** Assert that only the union of the original view ranges survived. */
function assertSanitized(buffer) {
	assert.deepEqual(Array.from(new Uint8Array(buffer)), Array.from({ length: 32 }, (_, i) =>
		(i >= 4 && i < 16) || (i >= 20 && i < 24) ? 0x73 : 0));
}

{
	const { buffer, a, b, c } = fixture();
	const result = copy({ a, b, c });
	assert.equal(result.a.buffer, result.b.buffer);
	assert.equal(result.a.buffer, result.c.buffer);
	assert.equal(result.a.byteOffset, 4);
	assert.equal(result.b.byteOffset, 8);
	assert.equal(result.c.byteOffset, 20);
	assertSanitized(result.a.buffer);
	result.b[0] = 0;
	assert.equal(result.a[4], 0);
	assert(new Uint8Array(buffer).every(byte => byte === 0x73));
}

// Explicit exposure works regardless of serialization order and container edges.
for (const before of [true, false]) {
	for (const wrap of [value => value, value => [value], value => new Map([[value, 1]]),
		value => new Map([[1, value]]), value => new Set([value]), value => {
			const error = new Error('cause', { cause: value });
			void error.stack; // Existing serialization rejects lazy stacks that would run user code.
			return error;
		}]) {
		const { buffer, a } = fixture();
		const graph = before ? { explicit: wrap(buffer), a } : { a, explicit: wrap(buffer) };
		const result = copy(graph);
		assert(new Uint8Array(result.a.buffer).every(byte => byte === 0x73));
	}
}

// Custom view properties are explicit graph edges, including shadowed intrinsic names.
for (const name of ['extra', 'buffer']) {
	const { buffer, a } = fixture();
	Object.defineProperty(a, name, { value: buffer, enumerable: true });
	const result = copy(a);
	assert(new Uint8Array(result[name]).every(byte => byte === 0x73));
}

// Other supported clone types and native transferable wrappers can accompany views.
{
	const { a } = fixture();
	const reference = new ivm.Reference({ value: 42 });
	const result = copy({ a, values: [new Date(), /test/g, Object(true), Object(1), Object('x'), Object(1n)], reference });
	assert.equal(result.reference.getSync('value'), 42);
	assert.equal(result.a.buffer.byteLength, 32);
	assert.equal(new Uint8Array(result.a.buffer)[0], 0);
	result.reference.release();
	reference.release();
}

// Cycles and repeated references do not cause recursion or lose exposure information.
{
	const { buffer, a } = fixture();
	const graph = { a, other: a };
	graph.self = graph;
	graph.map = new Map([[graph, new Set([buffer])]]);
	const result = copy(graph);
	assert.equal(result.self, result);
	assert.equal(result.a, result.other);
	assert.equal([...result.map.get(result)][0], result.a.buffer);
	assert(new Uint8Array(result.a.buffer).every(byte => byte === 0x73));
}

// All supported view types use byte ranges, not element counts.
for (const View of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
	Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView]) {
	const buffer = new ArrayBuffer(32);
	new Uint8Array(buffer).fill(0x73);
	const view = View === DataView ? new View(buffer, 8, 16) : new View(buffer, 8, 16 / View.BYTES_PER_ELEMENT);
	const result = copy(view);
	assert.equal(result.constructor, View);
	assert.equal(result.byteOffset, 8);
	assert.deepEqual(Array.from(new Uint8Array(result.buffer)), Array.from({ length: 32 }, (_, i) =>
		i >= 8 && i < 24 ? 0x73 : 0));
}

// Zero-length views authorize no bytes; full views authorize all bytes.
for (const length of [0, 32]) {
	const buffer = new ArrayBuffer(32);
	new Uint8Array(buffer).fill(0x73);
	const result = copy(new Uint8Array(buffer, 0, length));
	assert(new Uint8Array(result.buffer).every(byte => byte === (length ? 0x73 : 0)));
}

// Reusable ExternalCopy storage is not sanitized or mutated by receiver writes.
for (const transfer of [false, true]) {
	const { buffer, a, b, c } = fixture();
	const external = new ivm.ExternalCopy({ a, b, c }, transfer ? { transferList: [buffer] } : undefined);
	if (transfer) assert.equal(buffer.byteLength, 0);
	const first = external.copy();
	assertSanitized(first.a.buffer);
	new Uint8Array(first.a.buffer).fill(0);
	const second = external.copy();
	assertSanitized(second.a.buffer);
	const consumed = external.copy({ transferIn: true });
	assertSanitized(consumed.a.buffer);
}

// Sanitizing transferIn charges only the final backing store to the receiver.
{
	const receiver = new ivm.Isolate({ memoryLimit: 16 });
	try {
		const target = receiver.createContextSync();
		const buffer = new ArrayBuffer(10 * 1024 * 1024);
		new Uint8Array(buffer).fill(0x73);
		const external = new ivm.ExternalCopy({ view: new Uint8Array(buffer, 4, 8) },
			{ transferList: [buffer] });
		target.global.setSync('result', external.copyInto({ transferIn: true }));
		assert.equal(target.evalSync(`result.view.byteOffset === 4 &&
			result.view.buffer.byteLength === 10 * 1024 * 1024 &&
			new Uint8Array(result.view.buffer).every((byte, i) =>
				byte === (i >= 4 && i < 12 ? 0x73 : 0))`), true);
		assert.throws(() => external.copy(), /Array buffer is invalid/);
	} finally {
		receiver.dispose();
	}
}

// Shared backing stores remain shared and must never be zeroed.
{
	const buffer = new SharedArrayBuffer(32);
	new Uint8Array(buffer).fill(0x73);
	const result = copy(new Uint8Array(buffer, 4, 8));
	assert(new Uint8Array(result.buffer).every(byte => byte === 0x73));
	result[0] = 42;
	assert.equal(new Uint8Array(buffer)[4], 42);
}

const isolate = new ivm.Isolate();
const context = isolate.createContextSync();
const jail = context.global;

// Small pooled Buffers must not expose the rest of the Node pool on implicit copy paths.
const pooled = Buffer.from('x');
assert(pooled.buffer.byteLength > pooled.byteLength);
const check = `view => {
	const bytes = new Uint8Array(view.buffer);
	return view[0] === 120 && bytes.every((byte, i) => i === view.byteOffset ? byte === 120 : byte === 0);
}`;
context.evalSync(`globalThis.check = (${check})`);
jail.setSync('top', pooled, { copy: true });
jail.setSync('nested', { list: [pooled] }, { copy: true });
assert.equal(context.evalSync('check(top) && check(nested.list[0])'), true);
jail.setSync('giveBuffer', () => pooled);
assert.equal(context.evalSync('check(giveBuffer())'), true);
assert.equal(context.evalClosureSync(`return (${check})($0)`, [pooled], { arguments: { copy: true } }), true);

// SerializedVector must be finalized after ALL arguments, not one argument at a time.
{
	jail.setSync('checkArguments', (view, buffer) =>
		view.buffer === buffer && new Uint8Array(buffer).every(byte => byte === 0x73));
	assert.equal(context.evalSync(`
		const argumentBuffer = new ArrayBuffer(32);
		new Uint8Array(argumentBuffer).fill(0x73);
		checkArguments(new Uint8Array(argumentBuffer, 4, 8), argumentBuffer);
	`), true);
}

// Reverse-direction implicit copies are sanitized too.
{
	const result = context.evalSync(`(() => {
		const buffer = new ArrayBuffer(32);
		new Uint8Array(buffer).fill(0x73);
		return { view: new Uint8Array(buffer, 8, 8) };
	})()`, { copy: true });
	assert.deepEqual(Array.from(new Uint8Array(result.view.buffer)), Array.from({ length: 32 }, (_, i) =>
		i >= 8 && i < 16 ? 0x73 : 0));
}

// Receiver prototype pollution cannot invoke getters while auditing descriptor data.
context.evalSync(`
	Object.defineProperty(Object.prototype, 'value', { __proto__: null, get() { throw Error('must not run'); }, configurable: true });
	Object.defineProperty(Object.prototype, 'get', { __proto__: null, get() { throw Error('must not run'); }, configurable: true });
`);
jail.setSync('polluted', { view: pooled }, { copy: true });
assert.equal(context.evalSync('check(polluted.view)'), true);
context.evalSync('delete Object.prototype.value; delete Object.prototype.get');

// Constructor-name pollution cannot make plain records look unsupported.
context.evalSync(`
	Object.prototype.constructor = function Foo() {};
	Object.prototype[Symbol.toStringTag] = 'Foo';
`);
jail.setSync('renamed', { view: pooled }, { copy: true });
assert.equal(context.evalSync('check(renamed.view)'), true);
context.evalSync('Object.prototype.constructor = Object; delete Object.prototype[Symbol.toStringTag]');

// Live objects returned by derefInto() are never audited or zeroed.
{
	const storage = new ArrayBuffer(32);
	new Uint8Array(storage).fill(0x73);
	const live = new Uint8Array(storage, 4, 1);
	const ref = new ivm.Reference({ live });
	jail.setSync('liveRef', ref);
	jail.setSync('receive', (view, held) => held.live === live && view.byteLength === 1);
	assert.equal(context.evalSync('receive(new Uint8Array(1), liveRef.derefInto())'), true);
	assert(new Uint8Array(storage).every(byte => byte === 0x73));
}

// Audit failures throw without exposing results, and transferIn storage survives them.
{
	const buffer = new ArrayBuffer(8);
	const view = new Uint8Array(buffer);
	const external = new ivm.ExternalCopy({ view, wide: new Array((1 << 20) + 1).fill(0) },
		{ transferList: [buffer] });
	assert.throws(() => external.copy({ transferIn: true }), /graph limit exceeded/);
	assert.throws(() => external.copy(), /graph limit exceeded/);
	external.release();
}

isolate.dispose();
console.log('pass');

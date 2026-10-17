import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context as api_context, propagation, trace } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { beforeEach, describe, expect, test, vitest } from 'vitest'
import { AsyncLocalStorageContextManager } from '../../src/context'
import { Initialiser, setConfig } from '../../src/config'
import { OTEL_CARRIER_KEY, instrumentBindingStub } from '../../src/instrumentation/do'
import { instrumentEnv } from '../../src/instrumentation/env'
import { InstrumentedDurableObject, createDoMethodHandler } from '../../src/instrumentation/do-class'
import type { ResolvedTraceConfig } from '../../src/types'

const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider()
provider.addSpanProcessor(new SimpleSpanProcessor(exporter))
provider.register({
	contextManager: new AsyncLocalStorageContextManager(),
})
propagation.setGlobalPropagator(new W3CTraceContextPropagator())

// not entirely accurate, but enough to satisfy the code under test
const config = {
	handlers: { fetch: { acceptTraceContext: true } },
} as unknown as ResolvedTraceConfig

const initialiser: Initialiser = () => config

function withConfig<T>(fn: () => T): T {
	return api_context.with(setConfig(config), fn)
}

type RpcMethods = Record<string, (...args: unknown[]) => unknown>

function createStub(methods: RpcMethods): DurableObjectStub {
	const stub = {
		id: { toString: () => 'do-id-1', name: 'testing' },
		...methods,
	}
	return stub as unknown as DurableObjectStub
}

function asRpcMethods(stub: DurableObjectStub): Record<string, (...args: unknown[]) => Promise<unknown>> {
	return stub as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
}

type TestDOInstance = {
	env: Record<string, unknown>
	ctx: { waitUntil: (promise: Promise<unknown>) => void }
	metadata: Record<string, unknown>
	_logger: Record<string, unknown>
	greet: (...args: unknown[]) => Promise<string>
}

function createInstrumentedDO(): { instance: TestDOInstance; received: unknown[][] } {
	const received: unknown[][] = []
	class TestDO {
		env: Record<string, unknown> = {}
		ctx = { waitUntil: () => undefined }
		metadata: Record<string, unknown> = {}
		_logger: Record<string, unknown> = {}
		async greet(...args: unknown[]): Promise<string> {
			received.push(args)
			return `Hello ${String(args[0])}`
		}
	}
	const decorator = createDoMethodHandler(initialiser)
	const descriptor = Object.getOwnPropertyDescriptor(TestDO.prototype, 'greet')!
	decorator(TestDO.prototype, 'greet', descriptor)
	Object.defineProperty(TestDO.prototype, 'greet', descriptor)
	return { instance: new TestDO() as unknown as TestDOInstance, received }
}

function createRpcHarness() {
	const server = createInstrumentedDO()
	let stubArgs: unknown[] = []
	const stub = createStub({
		greet: (...args: unknown[]) => {
			stubArgs = args
			// Simulate the Durable Object hop: the DO's user code runs in a fresh context.
			return api_context.with(ROOT_CONTEXT, () => server.instance.greet(...args))
		},
	})
	const wrapped = asRpcMethods(instrumentBindingStub(stub, 'TestDO'))
	return { wrapped, server, getStubArgs: () => stubArgs }
}

beforeEach(() => {
	exporter.reset()
	vitest.restoreAllMocks()
	vitest.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('DO RPC client span', () => {
	test('emits a CLIENT span and parents the server span to it', async () => {
		const { wrapped, server, getStubArgs } = createRpcHarness()

		const result = await withConfig(() => wrapped['greet']!('world'))
		expect(result).toBe('Hello world')

		const spans = exporter.getFinishedSpans()
		const client = spans.find((span) => span.name === 'DO RPC client TestDO.greet')
		const serverSpan = spans.find((span) => span.name === 'DO RPC TestDO.greet')

		expect(client).toBeDefined()
		expect(client?.kind).toBe(SpanKind.CLIENT)
		expect(client?.attributes).toMatchObject({
			'do.namespace': 'TestDO',
			'do.id': 'do-id-1',
			'do.id.name': 'testing',
			'rpc.method': 'greet',
		})

		expect(serverSpan).toBeDefined()
		expect(serverSpan?.kind).toBe(SpanKind.SERVER)
		expect(serverSpan?.parentSpanId).toBe(client?.spanContext().spanId)

		// The carrier travels as a trailing argument, but never reaches user code.
		expect(getStubArgs()).toHaveLength(2)
		expect((getStubArgs()[1] as Record<string, unknown>)[OTEL_CARRIER_KEY]).toBeDefined()
		expect(server.received).toEqual([['world']])
	})

	test('parents each call on a warm instance to its own caller', async () => {
		const { wrapped } = createRpcHarness()
		const tracer = trace.getTracer('test')

		await tracer.startActiveSpan('root one', (span) =>
			withConfig(() => wrapped['greet']!('one')).finally(() => span.end()),
		)
		await tracer.startActiveSpan('root two', (span) =>
			withConfig(() => wrapped['greet']!('two')).finally(() => span.end()),
		)

		const spans = exporter.getFinishedSpans()
		const clients = spans.filter((span) => span.name === 'DO RPC client TestDO.greet')
		const servers = spans.filter((span) => span.name === 'DO RPC TestDO.greet')

		expect(clients).toHaveLength(2)
		expect(servers).toHaveLength(2)
		expect(clients[0]?.spanContext().traceId).not.toBe(clients[1]?.spanContext().traceId)
		expect(servers.map((span) => span.parentSpanId)).toEqual(clients.map((span) => span.spanContext().spanId))
	})

	test('records exceptions and sets ERROR status when the call throws', async () => {
		const error = new Error('boom')
		const stub = createStub({
			fail: () => {
				throw error
			},
		})
		const wrapped = asRpcMethods(instrumentBindingStub(stub, 'TestDO'))

		await expect(withConfig(() => wrapped['fail']!())).rejects.toBe(error)

		const client = exporter.getFinishedSpans().find((span) => span.name === 'DO RPC client TestDO.fail')
		expect(client?.status.code).toBe(SpanStatusCode.ERROR)
		expect(client?.events.some((event) => event.name === 'exception')).toBe(true)
	})

	test('getInstance returns a stub whose RPC calls are traced', async () => {
		const stub = createStub({ greet: () => 'hi', _setOpts: async () => undefined })
		const namespace = {
			idFromName: () => ({ toString: () => 'do-id-1', name: 'testing' }),
			get: () => stub,
		}
		const getInstance = InstrumentedDurableObject.getInstance as unknown as (
			namespace: unknown,
			key: string,
		) => Promise<DurableObjectStub>
		const wrapped = await getInstance.call({ name: 'UserDo' }, namespace, 'testing')

		await withConfig(() => asRpcMethods(wrapped)['greet']!())

		const span = exporter.getFinishedSpans().find((candidate) => candidate.name === 'DO RPC client UserDo.greet')
		expect(span).toBeDefined()
		expect(span?.attributes['do.namespace']).toBe('UserDo')
	})

	test('strips the carrier from underscore-prefixed methods', async () => {
		const received: unknown[][] = []
		class TestDO {
			env: Record<string, unknown> = {}
			ctx = { waitUntil: () => undefined }
			metadata: Record<string, unknown> = {}
			_logger: Record<string, unknown> = {}
			async _internal(...args: unknown[]): Promise<string> {
				received.push(args)
				return 'ok'
			}
		}
		const decorator = createDoMethodHandler(initialiser)
		const descriptor = Object.getOwnPropertyDescriptor(TestDO.prototype, '_internal')!
		decorator(TestDO.prototype, '_internal', descriptor)
		Object.defineProperty(TestDO.prototype, '_internal', descriptor)

		const marker = { [OTEL_CARRIER_KEY]: { traceparent: '00-abc-def-01' } }
		const result = await (new TestDO() as unknown as { _internal: (...args: unknown[]) => Promise<string> })._internal(
			'value',
			marker,
		)

		expect(result).toBe('ok')
		expect(received).toEqual([['value']])
	})

	test('keeps instrumenting stub.fetch through instrumentClientFetch', async () => {
		const fetchFn = vitest.fn(async () => new Response('ok'))
		const stub = createStub({ fetch: fetchFn })
		const wrapped = instrumentBindingStub(stub, 'TestDO')

		const response = await withConfig(() => (wrapped as unknown as DurableObjectStub).fetch('https://example.com'))
		expect(await response.text()).toBe('ok')

		const spans = exporter.getFinishedSpans()
		expect(spans.some((span) => span.name === 'Durable Object TestDO')).toBe(true)
		expect(spans.some((span) => span.name === 'DO RPC client TestDO.fetch')).toBe(false)
	})
})

describe('instrumentEnv', () => {
	test('instruments DO namespaces and leaves other bindings alone', async () => {
		const stub = createStub({ greet: () => 'hi' })
		const namespace = {
			idFromName: (name: string) => ({ toString: () => name, name }),
			get: () => stub,
			newUniqueId: () => ({ toString: () => 'unique' }),
		}
		const serviceBinding = new Proxy(
			{ fetch: async () => new Response('') },
			{
				get(target, prop) {
					if (prop === 'fetch') return Reflect.get(target, prop)
					return () => undefined
				},
			},
		)
		const env = instrumentEnv({ USER_DO: namespace, SERVICE: serviceBinding, RAW_STUB: stub })

		expect(env['USER_DO']).not.toBe(namespace)
		expect(env['RAW_STUB']).toBe(stub)

		const instrumentedNamespace = env['USER_DO'] as unknown as DurableObjectNamespace
		const doStub = instrumentedNamespace.get(namespace.idFromName('testing') as unknown as DurableObjectId)
		await withConfig(() => asRpcMethods(doStub)['greet']!())
		expect(exporter.getFinishedSpans().some((span) => span.name === 'DO RPC client USER_DO.greet')).toBe(true)

		const service = env['SERVICE'] as unknown as Record<string, (() => Promise<unknown>) | undefined>
		await service['someMethod']?.()
		const spans = exporter.getFinishedSpans()
		expect(spans.some((span) => span.name.startsWith('DO RPC client SERVICE'))).toBe(false)
	})
})

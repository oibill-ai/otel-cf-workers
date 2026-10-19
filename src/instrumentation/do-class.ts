import { Initialiser, setConfig } from '../config'
import { propagation, context as api_context, trace, SpanOptions, SpanKind, Exception } from '@opentelemetry/api'
import { instrumentEnv } from './env'
import { exportSpans, proxyExecutionContext } from './common'
import { getParentContextFromMetadata } from './entrypoint'
import { Logger } from '../types'
import { extractOtelCarrier, instrumentBindingStub, instrumentState } from './do'
import { DurableObject } from 'cloudflare:workers'
import { ATTR_FAAS_TRIGGER } from '@opentelemetry/semantic-conventions/incubating'

const traceIdSymbol = Symbol('traceId')

export abstract class InstrumentedDurableObject<Env extends Record<string, unknown>> extends DurableObject<Env> {
	private _logger: Logger
	private _instrumentedCtx: DurableObjectState
	protected _instrumentedEnv: Env

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this._instrumentedCtx = instrumentState(ctx)
		// @ts-expect-error we just need binding
		this._instrumentedEnv = instrumentEnv(env)
		this._logger = new Logger()
	}

	static async getInstance<T extends InstrumentedDurableObject<Record<string, unknown>>>(
		doNamespace: DurableObjectNamespace<T>,
		key: string,
	): Promise<DurableObjectStub<T>> {
		if (!key) {
			throw new Error('DO identifier cannot be null or undefined.')
		}
		const id: DurableObjectId = doNamespace.idFromName(key)
		return instrumentBindingStub(doNamespace.get(id), this.name) as DurableObjectStub<T>
	}

	protected _getCurrentTraceContext(): Record<string, unknown> {
		const metadata: Record<string, unknown> = {}
		propagation.inject(api_context.active(), metadata, {
			set: (h, k, v) => (h[k] = typeof v === 'string' ? v : String(v)),
		})
		return metadata
	}

	protected get logger() {
		return this._logger
	}

	protected get storage() {
		return this._instrumentedCtx.storage
	}
}

export function createDoMethodHandler(initialiser: Initialiser): MethodDecorator {
	// @ts-expect-error type checking
	const decorator: MethodDecorator = <Target extends InstrumentedDurableObject>(
		target: Target,
		propertyKey: string,
		descriptor: PropertyDescriptor,
	) => {
		const original = descriptor.value
		descriptor.value = async function (...args: unknown[]) {
			const originalRef = this as Target
			const { args: callArgs, carrier } = extractOtelCarrier(args)
			if (propertyKey.startsWith('_')) {
				return await original.apply(originalRef, callArgs)
			}
			const orig_env = originalRef['env']
			const orig_ctx = originalRef['ctx']
			const config = initialiser(orig_env as Record<string, unknown>, this)
			const { tracker } = proxyExecutionContext(orig_ctx)
			const context = setConfig(config)

			try {
				const executeEntrypointHandler = (): Promise<unknown> => {
					const spanContext = carrier ? getParentContextFromMetadata(carrier) : api_context.active()
					if (!carrier) {
						console.warn(
							`[otel-cf-workers] DO RPC ${target.constructor.name}.${propertyKey} was called without a trace carrier. ` +
								'The caller is not instrumented, so this call starts a new trace.',
						)
					}
					const tracer = trace.getTracer('doClassHandler')
					const options: SpanOptions = {
						attributes: {
							[ATTR_FAAS_TRIGGER]: 'do-rpc',
							'rpc.function.name': propertyKey,
							...(carrier ? {} : { 'otel.do.unwrapped_caller': true }),
						},
						kind: SpanKind.SERVER,
					}
					const promise = tracer.startActiveSpan(
						`DO RPC ${target.constructor.name}.${propertyKey}`,
						options,
						spanContext,
						async (span) => {
							originalRef['_logger']['rootSpan'] = span
							const traceId = span.spanContext().traceId
							api_context.active().setValue(traceIdSymbol, traceId)
							try {
								const result = await original.apply(originalRef, callArgs)
								span.end()
								return result
							} catch (error) {
								span.recordException(error as Exception)
								span.end()
								throw error
							}
						},
					)
					return promise
				}
				return await api_context.with(context, executeEntrypointHandler)
			} catch (error) {
				throw error
			} finally {
				orig_ctx.waitUntil(exportSpans(tracker))
			}
		}
		return descriptor
	}
	return decorator
}

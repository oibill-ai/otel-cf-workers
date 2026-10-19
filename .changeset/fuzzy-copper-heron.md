---
'@microlabs/otel-cf-workers': major
---

Remove the per-instance Durable Object trace fallback. `_setOpts`, the `metadata` getter/setter and `getParentContextFromDO` are gone; trace context reaches a DO only through the per-call `{ __otel_carrier }` argument added by wrapped stubs, and `getInstance` no longer makes an RPC round-trip. Calls from unwrapped stubs still run, but start a new trace and are tagged `otel.do.unwrapped_caller`.

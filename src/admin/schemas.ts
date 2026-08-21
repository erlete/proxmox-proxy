import { Type, type Static } from '@sinclair/typebox'

export const ErrorReply = Type.Object({ message: Type.String() })

export const LoginBody = Type.Object({
  username: Type.String({ minLength: 1 }),
  password: Type.String({ minLength: 1 }),
})

export const MeReply = Type.Object({ username: Type.String() })

export const VmidRangeSchema = Type.Tuple([
  Type.Integer({ minimum: 100 }),
  Type.Integer({ minimum: 100 }),
])

export const KeySchema = Type.Object({
  name: Type.String(),
  vmidRanges: Type.Array(VmidRangeSchema),
  comment: Type.String(),
  enabled: Type.Boolean(),
  createdAt: Type.Integer(),
  rotatedAt: Type.Union([Type.Integer(), Type.Null()]),
  lastUsedAt: Type.Union([Type.Integer(), Type.Null()]),
  prevValidUntil: Type.Union([Type.Integer(), Type.Null()]),
})

export const KeyListReply = Type.Object({ keys: Type.Array(KeySchema) })

export const CreateKeyBody = Type.Object({
  name: Type.String({ minLength: 2, maxLength: 63, pattern: '^[a-z0-9][a-z0-9-]+$' }),
  vmidRanges: Type.Array(VmidRangeSchema, { minItems: 1 }),
  comment: Type.Optional(Type.String({ maxLength: 300 })),
})

export const RotateKeyBody = Type.Object({
  graceHours: Type.Optional(Type.Number({ minimum: 0, maximum: 168 })),
})

export const TokenReply = Type.Object({
  name: Type.String(),
  /** Full PVEAPIToken value: shown exactly once, never stored in clear. */
  token: Type.String(),
})

export const RunningSchema = Type.Object({
  id: Type.Integer(),
  keyName: Type.String(),
  vmid: Type.Union([Type.Integer(), Type.Null()]),
  node: Type.Union([Type.String(), Type.Null()]),
  upid: Type.Union([Type.String(), Type.Null()]),
  grantedAt: Type.Integer(),
  taskStartedAt: Type.Union([Type.Integer(), Type.Null()]),
})

export const WaitingSchema = Type.Object({
  id: Type.Integer(),
  keyName: Type.String(),
  vmid: Type.Union([Type.Integer(), Type.Null()]),
  enqueuedAt: Type.Integer(),
})

export const QueueClassSchema = Type.Object({
  name: Type.String(),
  cap: Type.Integer(),
  /** Contended cluster load of this class running outside the proxy. */
  outOfBand: Type.Integer(),
  /** cap minus outOfBand, clamped at zero: the slots the proxy will grant. */
  effectiveCap: Type.Integer(),
  running: Type.Array(RunningSchema),
  waiting: Type.Array(WaitingSchema),
})

export const QueuesReply = Type.Object({ classes: Type.Array(QueueClassSchema) })

export const OperationSchema = Type.Object({
  id: Type.Integer(),
  ts: Type.Integer(),
  keyName: Type.String(),
  method: Type.String(),
  path: Type.String(),
  opClass: Type.Union([Type.String(), Type.Null()]),
  vmid: Type.Union([Type.Integer(), Type.Null()]),
  status: Type.Union([Type.Integer(), Type.Null()]),
  queueMs: Type.Union([Type.Integer(), Type.Null()]),
  durationMs: Type.Union([Type.Integer(), Type.Null()]),
  taskMs: Type.Union([Type.Integer(), Type.Null()]),
  upid: Type.Union([Type.String(), Type.Null()]),
  note: Type.Union([Type.String(), Type.Null()]),
})

export const OperationsQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  opClass: Type.Optional(Type.String()),
  key: Type.Optional(Type.String()),
})

export const OperationsReply = Type.Object({ rows: Type.Array(OperationSchema) })

export const StatusReply = Type.Object({
  version: Type.String(),
  startedAt: Type.Integer(),
  uptimeMs: Type.Integer(),
  singleton: Type.Object({
    enabled: Type.Boolean(),
    held: Type.Boolean(),
    instanceId: Type.String(),
  }),
  upstream: Type.Object({
    ok: Type.Boolean(),
    version: Type.Union([Type.String(), Type.Null()]),
    checkedAt: Type.Integer(),
    error: Type.Union([Type.String(), Type.Null()]),
  }),
  admission: Type.Array(
    Type.Object({
      name: Type.String(),
      cap: Type.Integer(),
      outOfBand: Type.Integer(),
      effectiveCap: Type.Integer(),
      active: Type.Integer(),
      waiting: Type.Integer(),
    }),
  ),
})

export const HealthReply = Type.Object({
  status: Type.String(),
  upstreamOk: Type.Boolean(),
  singletonHeld: Type.Boolean(),
})

export const SettingsSchema = Type.Object({
  cloneCap: Type.Integer({ minimum: 0, maximum: 64 }),
  deleteCap: Type.Integer({ minimum: 0, maximum: 64 }),
  suspendCap: Type.Integer({ minimum: 0, maximum: 64 }),
  maxQueue: Type.Integer({ minimum: 0, maximum: 1000 }),
  maxHoldMs: Type.Integer({ minimum: 1000, maximum: 120000 }),
  taskPollMs: Type.Integer({ minimum: 250, maximum: 60000 }),
  taskTimeoutMs: Type.Integer({ minimum: 10000, maximum: 86400000 }),
  opsRingMax: Type.Integer({ minimum: 100, maximum: 1000000 }),
  sessionTtlHours: Type.Integer({ minimum: 1, maximum: 168 }),
  publicWsUrl: Type.String({ maxLength: 200 }),
})

export const SettingsPatch = Type.Partial(SettingsSchema)

export const SettingsReply = Type.Object({
  settings: SettingsSchema,
  defaults: SettingsSchema,
})

export const TaskStopBody = Type.Object({
  /** Full UPID of the running task to stop; the node is parsed from it. */
  upid: Type.String({ minLength: 1 }),
})

export const TaskStopReply = Type.Object({
  upid: Type.String(),
  node: Type.String(),
  stopped: Type.Boolean(),
})

export const InventoryVmSchema = Type.Object({
  vmid: Type.Integer(),
  node: Type.String(),
  name: Type.String(),
  status: Type.String(),
  type: Type.String(),
})

export const InventoryAppSchema = Type.Object({
  name: Type.String(),
  vmidRanges: Type.Array(VmidRangeSchema),
  vms: Type.Array(InventoryVmSchema),
})

export const InventoryReply = Type.Object({
  /** VMs grouped by the app whose key ranges own their VMID. */
  apps: Type.Array(InventoryAppSchema),
  /** Live VMs that fall outside every key range: manual or orphaned. */
  unassigned: Type.Array(InventoryVmSchema),
  upstreamOk: Type.Boolean(),
})

export type Key = Static<typeof KeySchema>
export type Operation = Static<typeof OperationSchema>
export type Queues = Static<typeof QueuesReply>
export type StatusBody = Static<typeof StatusReply>

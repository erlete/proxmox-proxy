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
  /**
   * Explicit consent to share a VMID range with another live key (the same
   * logical service from several environments). Without it, an overlap is
   * refused: accidental sharing lets one platform destroy another's machines.
   */
  allowSharedRange: Type.Optional(Type.Boolean()),
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

export const ConsoleNodeSchema = Type.Object({
  node: Type.String(),
  /** Live consoles (running vncproxy-family tasks) on the node. */
  count: Type.Integer(),
})

export const QueuesReply = Type.Object({
  /** Manual admission priority order (app names); empty = round-robin. */
  priorityApps: Type.Array(Type.String()),
  /** Stream guard: serialized, paced heavy ops on nodes with live consoles. */
  streamProtect: Type.Boolean(),
  streamPacingMs: Type.Integer(),
  consoles: Type.Array(ConsoleNodeSchema),
  classes: Type.Array(QueueClassSchema),
})

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
  /** Stream guard state: live consoles per node, and whether it is enabled. */
  streamProtect: Type.Boolean(),
  consoles: Type.Array(ConsoleNodeSchema),
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
  /** Serialize and pace heavy ops on nodes with live consoles. */
  streamProtect: Type.Boolean(),
  /** Minimum gap between heavy-op starts on a guarded node (ms). */
  streamPacingMs: Type.Integer({ minimum: 0, maximum: 30000 }),
  /** Rotating local snapshot interval (hours). */
  autoBackupIntervalHours: Type.Integer({ minimum: 1, maximum: 168 }),
  /** Snapshots retained in <dataDir>/backups; 0 disables auto backups. */
  autoBackupKeep: Type.Integer({ minimum: 0, maximum: 60 }),
  publicWsUrl: Type.String({ maxLength: 200 }),
  /** App name -> admission priority value (higher wins); 0 omitted. */
  appPriority: Type.Record(Type.String(), Type.Integer()),
  /** VMID ranges no app key may include (enforced when keys are created). */
  reserved: Type.Array(VmidRangeSchema, { maxItems: 128 }),
  /** VLAN tag range the proxy leases from for linked-clone groups; null = off. */
  linkedVlanRange: Type.Union([
    Type.Null(),
    Type.Tuple([
      Type.Integer({ minimum: 1, maximum: 4094 }),
      Type.Integer({ minimum: 1, maximum: 4094 }),
    ]),
  ]),
})

export const SettingsPatch = Type.Partial(SettingsSchema)

export const SettingsReply = Type.Object({
  settings: SettingsSchema,
  defaults: SettingsSchema,
})

export const RestoreReply = Type.Object({
  /** True when a restart was requested; the staged backup applies at boot. */
  restarting: Type.Boolean(),
})

export const BackupTokenStatusReply = Type.Object({
  /** Whether a backup pull token is configured (its value is never shown). */
  configured: Type.Boolean(),
})

export const BackupTokenReply = Type.Object({
  /** Full pull token: shown exactly once, only its hash is stored. */
  token: Type.String(),
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
  /** A template has no power state: it is shown as a template, not stopped. */
  template: Type.Boolean(),
  /** True when the VMID falls in a reserved range: off-limits to every app. */
  reserved: Type.Boolean(),
})

export const InventoryAppSchema = Type.Object({
  name: Type.String(),
  vmidRanges: Type.Array(VmidRangeSchema),
  vms: Type.Array(InventoryVmSchema),
})

export const VlanLeaseSchema = Type.Object({
  vlan: Type.Integer(),
  vmids: Type.Array(Type.Integer()),
  keyName: Type.String(),
  node: Type.String(),
  createdAt: Type.Integer(),
})

export const LeasesReply = Type.Object({ leases: Type.Array(VlanLeaseSchema) })

export const InventoryReply = Type.Object({
  /** Live VMs in a reserved range: off-limits to every app, shown on top. */
  reserved: Type.Array(InventoryVmSchema),
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

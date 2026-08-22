# Guía de consumo del proxy (para aplicaciones)

Este documento es el **contrato** entre `proxmox-proxy` y cualquier aplicación que lo consuma. Describe qué ve una app, qué puede y qué no puede hacer, cómo se conecta y qué comportamientos debe esperar. Es la referencia que una app (por ejemplo la plataforma CTF) debe implementar para hablar con el cluster **solo** a través del proxy.

El proxy es agnóstico del dominio de la app: no sabe qué es un reto, un usuario ni una sesión. Solo conoce claves, rangos de VMID y tráfico de la API de Proxmox.

## 1. Conexión: dos variables y `whoami`

Una app necesita exactamente dos datos de conexión:

```
PROXMOX_PROXY_ENDPOINT = https://<host-del-proxy>       # base del proxy
PROXMOX_PROXY_KEY      = PVEAPIToken=svc-proxy@pve!mi-app=<secreto>
```

La clave tiene el formato estándar de token de Proxmox, así que cualquier SDK la envía sin tocar código: se manda en la cabecera `Authorization` tal cual. La app apunta su cliente Proxmox a `PROXMOX_PROXY_ENDPOINT` en lugar de a `pveproxy:8006`.

Todo lo demás (los rangos asignados, la base de websockets, los caps, el rango de VLAN de clonación enlazada, las capacidades disponibles) se descubre en arranque con:

```
GET /proxy/whoami
Authorization: <PROXMOX_PROXY_KEY>

200 OK
{
  "name": "mi-app",
  "vmidRanges": [[1100000, 1100999]],
  "websocketBase": "https://nodo.cluster:8006",
  "admission": { "clone": 15, "delete": 4, "suspend": 2 },
  "linkedVlanRange": [1000, 1099],           // null si la clonación enlazada está desactivada
  "features": {
    "consoleSession": true,
    "linkedClone": true,
    "proxyAssignsNewid": true
  }
}
```

La app **no** deriva rangos de ninguna convención propia (no hay CCPP ni cálculo de bandas): el rango efectivo es `vmidRanges` tal como lo devuelve `whoami`.

## 2. Qué ve una app: opacidad total

El proxy es **opaco** respecto a todo lo que no pertenezca a la clave. Las lecturas de lista se filtran al rango de la clave antes de devolverlas:

| Endpoint | Qué devuelve a través del proxy |
| --- | --- |
| `GET /api2/json/cluster/resources` | Solo las VMs cuyo VMID cae en los rangos de la clave (mas filas de infraestructura sin VMID: nodos, almacenamiento, pools). |
| `GET /api2/json/nodes/{node}/qemu` y `.../lxc` | Solo los guests en rango. |
| `GET /api2/json/nodes/{node}/tasks` | Solo las tareas cuyo VMID esta en rango. |
| `GET .../qemu/{vmid}/...` (lectura concreta) | 200 si el VMID esta en rango; **403** si esta fuera. |

Consecuencia para la app: **no debe intentar descubrir ni contabilizar VMs, plantillas o tareas ajenas.** No las verá. Todo lo que necesita para operar (sus VMs, sus plantillas, sus tareas) sí lo ve, ya recortado a lo suyo.

## 3. Qué puede hacer una app

Operaciones normales de ciclo de vida, siempre con el VMID en el path y dentro de su rango: `status/start|stop|suspend|resume|reset|shutdown`, `config` (GET/PUT), `status/current`, `DELETE`, lectura de `config`, snapshots, etc. Pasan por el proxy tal cual (las pesadas, con admisión; ver seccion 5).

Ademas, tres operaciones con contrato propio:

### 3.1 Clonar una VM: el proxy asigna el `newid`

La app **no elige el VMID nuevo**. Manda el clone **sin** `newid`; el proxy elige el id libre mas bajo dentro del rango de la clave (evitando VMs y plantillas existentes y reservas en vuelo) y lo inyecta.

```
POST /api2/json/nodes/{node}/qemu/{templateVmid}/clone
Authorization: <key>
Content-Type: application/x-www-form-urlencoded

full=0&name=reto-abc          # SIN newid

200 OK
{ "data": "UPID:nodo:...:qmclone:1100137:root@pam:" }
```

El VMID creado se lee del **UPID** devuelto (campo `id` del UPID de `qmclone`; en el ejemplo, `1100137`). La app debe parsear el UPID para conocer su VM, y crear su registro interno **después** de recibir el UPID, no antes.

- Si la app manda un `newid`, debe estar en rango o se rechaza con 403 (pero el modo recomendado es no mandarlo).
- Si el rango de la clave esta agotado, el proxy responde **507**.

### 3.2 Clonación enlazada de un grupo (operacion especial)

La operacion mas comun entre plataformas: clonar 2 o mas plantillas como **clones enlazados** que comparten una **VLAN aislada** para formar un pod que se comunica entre si. El proxy lo hace en una sola llamada: clona todas, les asigna un VLAN libre del rango configurado, reescribe el `net0` de cada clon con ese tag y devuelve todo ya configurado.

```
POST /proxy/linked-clone
Authorization: <key>
Content-Type: application/json

{
  "node": "liga",
  "clones": [
    { "template": 1100001, "name": "atacante" },
    { "template": 1100002, "name": "defensor" }
  ]
  // "vlan": 1050   // opcional: forzar un tag concreto (debe estar libre y en rango); omitir para autoasignar
}

200 OK
{
  "vlan": 1050,
  "clones": [
    { "template": 1100001, "vmid": 1100140, "upid": "UPID:...:qmclone:1100140:..." },
    { "template": 1100002, "vmid": 1100141, "upid": "UPID:...:qmclone:1100141:..." }
  ]
}
```

Comportamiento:

- Cada plantilla debe estar en el rango de la clave y ser realmente una plantilla (`template=1`); si no, 400/403/404 antes de crear nada.
- `full` por clon es opcional (por defecto `0`, enlazado). El grupo comparte **un** VLAN.
- La operacion es **atomica**: si falla a mitad, el proxy borra los clones ya creados y libera el VLAN, y devuelve el error.
- Cada clon consume un slot de admision de la clase `clone`. La llamada es **sincrona** y puede tardar (clona, espera la tarea, retagea) varios segundos por clon.
- **Liberacion del VLAN**: no hay que llamar a nada. Cuando la app borra las VMs del pod, el proxy libera el VLAN automaticamente (un reaper detecta que ninguna VM del lease existe ya). El rango de VLAN utilizable lo define el operador en Settings (`linkedVlanRange`) y se ve en `whoami`.

### 3.3 Consola VNC

```
POST /proxy/console-session
Authorization: <key>
{ "node": "liga", "vmid": 1100140 }

200 OK
{ "port": "5901", "ticket": "...", "cookie": "...", "expiresAt": 0, "websocketBase": "https://nodo:8006" }
```

El proxy acuña las credenciales del websocket VNC con una identidad dedicada (`VM.Console`). La app abre el websocket **directo contra el nodo** (`websocketBase`), no contra el proxy: el stream nunca cruza el proxy. Por eso un reinicio del proxy no corta consolas. El VMID debe estar en rango.

## 4. Qué NO puede hacer una app

- **Identidad y ACLs** (`/access/...`): 403 siempre. Usuarios, roles, tokens y permisos los gestiona el proxy, no se tocan a traves de el.
- **Salirse de su rango**: cualquier operacion sobre un VMID fuera de `vmidRanges` se rechaza con 403 (lectura o escritura).
- **Ver nada de fuera**: las listas vienen filtradas (seccion 2). No hay forma de enumerar recursos ajenos.
- **Tocar plantillas**: una plantilla (`template=1`) es de **solo lectura** a traves del proxy. Se puede leer y clonar **desde** ella, pero **no** borrarla ni modificar su config; cualquier escritura o DELETE sobre una plantilla devuelve 403. Las plantillas **no se borran nunca**.
- **Websockets por el proxy**: cualquier upgrade a websocket contra el proxy responde 501. El VNC va directo al nodo (seccion 3.3).
- **Elegir su propio VMID o VLAN** en clonacion: los asigna el proxy (secciones 3.1 y 3.2).

## 5. Comportamientos esperados (codigos y admision)

Las operaciones pesadas (clone, delete, suspend) pasan por control de admision. El slot se retiene hasta que la **tarea** de Proxmox termina, no hasta que responde el HTTP.

| Codigo | Significado | Que debe hacer la app |
| --- | --- | --- |
| `200` | OK. En clone/heavy, el cuerpo trae el UPID de la tarea. | Seguir la tarea por su UPID si necesita el resultado. |
| `403` | Fuera de rango, plantilla protegida, o `/access`. | No reintentar: es un limite duro. |
| `429` | Cola llena o no hubo slot dentro del presupuesto de espera. Trae `Retry-After`. | Reintentar tras `Retry-After`. |
| `503` | Admision no disponible (fallo interno **fail-closed**) o el proxy no es la autoridad del cluster ahora mismo. Trae `Retry-After`. | Reintentar tras `Retry-After`. |
| `507` | Rango de VMID de la clave agotado. | No hay ids libres: es un problema de capacidad/configuracion. |
| `502` | El cluster fallo aguas arriba. | Reintentar con backoff. |

La app debe tratar 429/503 como **transitorios con reintento** (respetando `Retry-After`) y 403/507 como **definitivos**.

## 6. Configuracion del sistema (operador)

Reglas que el operador debe respetar al configurar el proxy para una app:

- **Rango de la clave = plantillas + clones.** El rango asignado a una app debe contener **tanto sus plantillas como el espacio para sus clones**. El proxy autoriza el clone por el VMID de la plantilla (origen), asi que si la plantilla queda fuera del rango, el clone se rechaza. Regla dura: plantillas y clones de una app viven siempre dentro del rango de esa app.
- **Reservados = configuracion.** Los rangos/VMIDs reservados (Settings) son una restriccion de configuracion: el proxy **no permite** crear una clave cuyo rango solape un reservado, ni añadir un reservado que solape el rango de una clave existente. No es un chequeo por operacion (el propio scoping de la clave ya impide operar fuera). Los reservados se ven en el inventario.
- **Rango de VLAN de clonacion enlazada** (`linkedVlanRange` en Settings): el pool de tags 802.1q del que el proxy arrienda un VLAN por grupo. Debe **no colisionar** con los tags por defecto que ya llevan las VMs. Vacio = clonacion enlazada desactivada.
- **Caps de admision** (clone/delete/suspend) y colas: se ajustan en caliente desde Settings.

## 7. Migracion desde acceso directo al cluster

Una app que hoy habla directo con Proxmox y pasa a consumir el proxy debe **quitar** (queda obsoleto en modo proxy):

- Toda derivacion de rangos por convencion propia (p. ej. codigos CCPP): el rango lo da `whoami`.
- El **allocator de VMID propio** y el escaneo de `cluster/resources` para elegir id libre: lo asigna el proxy (se lee del UPID). Ver 3.1.
- El **bootstrap de acceso** (crear usuario de servicio, roles, ACLs, pools; emitir/rotar tokens) y las **credenciales root**: el proxy ya trae una clave pre-aprovisionada.
- La **deduplicacion de VLAN** leyendo configuraciones ajenas: el proxy asigna y libera los VLAN de los grupos enlazados. Ver 3.2.
- Cualquier logica propia de proteccion de plantillas o de rangos reservados: la impone el proxy.

Y debe **conservar/ajustar**:

- Parsear el **UPID** del clone para conocer el VMID creado, y crear su registro interno despues de recibirlo.
- Usar `POST /proxy/linked-clone` para pods enlazados en vez de clonar y retaguear a mano.
- Tratar los codigos de la seccion 5 (reintento en 429/503).
- Abrir el VNC directo al nodo con lo que devuelve `/proxy/console-session`.

# proxmox-proxy

Punto de entrada único y neutral para las aplicaciones que comparten un cluster Proxmox VE. El proxy habla la API de Proxmox tal cual (cualquier SDK estándar funciona sin cambios), autentica a cada aplicación con una clave propia, limita su alcance a rangos de VMID y encola las operaciones pesadas para que ninguna aplicación pueda acaparar la I/O del cluster.

Es agnóstico de las aplicaciones que lo consumen: no conoce su dominio, solo su tráfico.

## Arquitectura

Dos planos en un solo proceso y un **único puerto**: la propia app multiplexa por path, sin proxy inverso delante. Escucha en `DEPLOY_HOST:DEPLOY_PORT` (por defecto solo loopback, `127.0.0.1:8000`); el TLS, el dominio y la VPN son cosa del perímetro, que va delante.

```
apps ─────(path /api2/*, /proxy/*)──> proxy :8000  (plano de datos: API Proxmox verbatim)
operador ─(resto de paths)──────────> proxy :8000  (plano de gestión: panel + API admin)
proxy ──https──> pveproxy :8006 (cuenta de servicio única)
apps ──wss──> pveproxy :8006 (solo websockets VNC, directos por diseño)
```

- **Plano de datos** (`/api2/...`): passthrough en streaming. Las operaciones pesadas (clone, delete, suspend) pasan por admisión; el resto fluye sin retención. El slot de admisión se retiene hasta que la **tarea** de Proxmox termina, no hasta que responde el HTTP, porque el coste real del cluster es la tarea.
- **Plano nativo** (`/proxy/whoami`, `/proxy/health`, `/proxy/console-session`): descubrimiento, identidad y consolas. Una app solo necesita `PROXMOX_PROXY_ENDPOINT` y `PROXMOX_PROXY_KEY`; sus rangos y la URL de websockets se consultan en `whoami`. `POST /proxy/console-session {node, vmid}` acuña las credenciales del websocket VNC (vncticket + cookie de una identidad dedicada con solo `VM.Console`), de modo que la app abre la consola directa contra el nodo sin poseer ninguna credencial de Proxmox; requiere configurar `PROXMOX_CONSOLE_USERNAME/PASSWORD`.
- **Plano de gestión** (`/api/...` + panel): claves, colas en vivo (SSE), historial de operaciones y estado. API tipada con OpenAPI en `/api/openapi.json`; el cliente del panel se genera de ese documento.
- **Singleton por cluster**: solo puede existir un proxy por cluster. El lock es un marcador con heartbeat en el comentario de un pool reservado de Proxmox; una segunda instancia se niega a arrancar mientras el marcador esté fresco y toma el relevo si caduca.
- **Configuración en dos niveles**: el `.env` solo lleva lo de arranque (upstream, credenciales, red, singleton). Todo lo operable en caliente (caps de admisión, colas, TTL de sesión, URL de websockets, tamaño del historial) se gestiona desde el panel (Settings), se persiste en SQLite y se aplica sin reiniciar.
- **Estado mínimo**: SQLite (claves emitidas, settings y un ring acotado de operaciones). Las colas viven en memoria; tras un reinicio el estado real se reconstruye del propio cluster.

## Claves de API

Las claves tienen el formato estándar de token de Proxmox, por lo que los clientes existentes las envían sin tocar código:

```
PVEAPIToken=svc-proxy@pve!nombre-app=secreto
```

- Se crean, rotan y revocan desde el panel (o la API admin). El secreto se guarda hasheado y se muestra una sola vez.
- La rotación admite una ventana de gracia en la que el secreto anterior sigue siendo válido (migración sin corte).
- Cada clave lleva sus rangos de VMID: todo lo que quede fuera se rechaza con 403.

## Política de autorización (v0)

1. Los endpoints de identidad (`/access/...`) se deniegan siempre: la identidad la gestiona el proxy.
2. Las lecturas pasan; una lectura sobre un VMID fuera de rango se deniega.
3. Las escrituras exigen un VMID en el path (o en el UPID de una tarea) dentro de los rangos de la clave. Escrituras sin VMID se deniegan.
4. En un clone, el `newid` del cuerpo tambien debe estar dentro de los rangos.
5. Los websockets no se proxyfican (501): el VNC va directo al nodo, y un reinicio del proxy nunca corta consolas.

## Despliegue

Se despliega desde una imagen publicada en `ghcr.io/dlt-code/proxmox-proxy`; no hace falta el código fuente en el host, solo `compose.yml` y un `.env`, ambos adjuntos como assets a cada release:

```bash
gh release download -R DLT-Code/proxmox-proxy -p compose.yml -p env.example
cp env.example .env         # 2 variables obligatorias: upstream y token de servicio
docker login ghcr.io        # la imagen es privada (token con read:packages)
docker compose up -d
docker compose logs proxy   # primera arrancada: imprime la password del panel UNA vez
```

Actualizar a la última versión publicada:

```bash
docker compose pull && docker compose up -d
```

`PROXY_IMAGE_TAG` en el `.env` fija una versión concreta (`PROXY_IMAGE_TAG=0.3.0`) en vez del `latest` móvil. Todo lo demás se autogenera y persiste (password del panel, secreto de sesión) o tiene un default razonable; ver la sección avanzada comentada de [.env.example](.env.example). La password del panel puede fijarse con `ADMIN_PASSWORD` o, mejor, `ADMIN_PASSWORD_HASH` (`npm run hash-password -- 'mi-password'`).

Escucha en `DEPLOY_HOST:DEPLOY_PORT` (por defecto `127.0.0.1:8000`, solo local). El panel vive en la raíz de ese mismo puerto; las apps apuntan su cliente Proxmox a él con su clave (los paths `/api2/*` y `/proxy/*` van al plano de datos, el resto al panel). Los ajustes de runtime se tocan desde el panel, no desde el `.env`.

La cuenta de servicio del proxy en Proxmox necesita: `VM.*` sobre las VMs custodiadas, `Sys.Audit`, y `Pool.Allocate` sobre `/pool` (el lock singleton vive en un pool). Tras desplegar el proxy, cierra `pveproxy:8006` por firewall a todo lo que no sea el host del proxy y la red de administración; deja abierto el camino directo de los websockets VNC a los nodos, porque las consolas no pasan por el proxy.

Variables: ver [.env.example](.env.example), cada una documentada en el propio fichero.

## Desarrollo

```bash
npm install && npm install --prefix panel
npm run dev                      # proxy con recarga (tsx watch), edge en :8000
npm run dev --prefix panel       # panel Vite con proxy de /api a :8000
npm test                         # unit + e2e contra un pveproxy falso
npm run openapi                  # regenerar panel/openapi.json y los tipos del panel
```

`SINGLETON_DISABLED=true` permite desarrollar sin cluster. La suite e2e levanta el proxy completo contra un Proxmox simulado y cubre auth, scopes, admisión y seguimiento de tareas.

## Hoja de ruta

Ya implementado: admisión **fail-closed** ante fallo interno o pérdida del lock; **backstop** que descuenta de los caps la carga del cluster que no pasa por el proxy (las consolas `vncproxy` se excluyen a propósito); **equidad max-min por aplicación** (round-robin work-conserving) con **prioridad manual** por tiers configurable en caliente; **botón rojo** (parar una tarea en curso) e **inventario por aplicación** en el panel.

Pendiente:

- **Migración del resto de plataformas** detrás del proxy (portar el modo de token pre-aprovisionado, o un shim de `/access` en el proxy).
- **Política hold-vs-429 por clave**: hoy es global (la petición espera hasta `maxHoldMs` y luego 429).
- `node:sqlite` es experimental en Node 24; el acceso está aislado en `src/db.ts` para poder migrar a `better-sqlite3` con un cambio local si hiciera falta.

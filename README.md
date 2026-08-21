# proxmox-proxy

Punto de entrada único y neutral para las aplicaciones que comparten un cluster Proxmox VE. El proxy habla la API de Proxmox tal cual (cualquier SDK estándar funciona sin cambios), autentica a cada aplicación con una clave propia, limita su alcance a rangos de VMID y encola las operaciones pesadas para que ninguna aplicación pueda acaparar la I/O del cluster.

Es agnóstico de las aplicaciones que lo consumen: no conoce su dominio, solo su tráfico.

## Arquitectura

Dos planos en un solo proceso, con Caddy delante como único contenedor expuesto:

```
apps ──https──> Caddy :443  ──> proxy :8080  (plano de datos: API Proxmox verbatim)
operador ──https──> Caddy :8443 ──> proxy :8081  (plano de gestión: panel + API admin)
proxy ──https──> pveproxy :8006 (cuenta de servicio única)
apps ──wss──> pveproxy :8006 (solo websockets VNC, directos por diseño)
```

- **Plano de datos** (`/api2/...`): passthrough en streaming. Las operaciones pesadas (clone, delete, suspend) pasan por admisión; el resto fluye sin retención. El slot de admisión se retiene hasta que la **tarea** de Proxmox termina, no hasta que responde el HTTP, porque el coste real del cluster es la tarea.
- **Plano nativo** (`/proxy/whoami`, `/proxy/health`): descubrimiento e identidad. Una app solo necesita `PROXMOX_PROXY_ENDPOINT` y `PROXMOX_PROXY_KEY`; sus rangos y la URL de websockets se consultan en `whoami`.
- **Plano de gestión** (`/api/...` + panel): claves, colas en vivo (SSE), historial de operaciones y estado. API tipada con OpenAPI en `/api/openapi.json`; el cliente del panel se genera de ese documento.
- **Singleton por cluster**: solo puede existir un proxy por cluster. El lock es un marcador con heartbeat en el comentario de un pool reservado de Proxmox; una segunda instancia se niega a arrancar mientras el marcador esté fresco y toma el relevo si caduca.
- **Estado mínimo**: SQLite (claves emitidas y un ring acotado de operaciones). Las colas viven en memoria; tras un reinicio el estado real se reconstruye del propio cluster.

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

```bash
cp .env.example .env      # solo 2 variables obligatorias: upstream y token de servicio
docker compose up -d --build
docker compose logs proxy # primera arrancada: imprime la password del panel UNA vez
```

Todo lo demás se autogenera y persiste (password del panel, secreto de sesión) o tiene un default razonable; ver la seccion avanzada comentada de [.env.example](.env.example). La password del panel puede fijarse con `ADMIN_PASSWORD` o, mejor, `ADMIN_PASSWORD_HASH` (`npm run hash-password -- 'mi-password'`).

Panel en `https://<host>:8443` (allowlist de IPs vía `PANEL_ALLOWLIST`). Las apps apuntan su cliente Proxmox a `https://<PROXY_DOMAIN>` con su clave.

La cuenta de servicio del proxy en Proxmox necesita: `VM.*` sobre las VMs custodiadas, `Sys.Audit`, y `Pool.Allocate` sobre `/pool` (el lock singleton vive en un pool). Tras desplegar el proxy, cierra pveproxy:8006 por firewall a todo lo que no sea el host del proxy (y la red de administración): la disciplina deja de ser voluntaria.

Variables: ver [.env.example](.env.example), cada una documentada en el propio fichero.

## Desarrollo

```bash
npm install && npm install --prefix panel
npm run dev                      # proxy con recarga (tsx watch)
npm run dev --prefix panel       # panel Vite con proxy a :8081
npm test                         # unit + e2e contra un pveproxy falso
npm run openapi                  # regenerar panel/openapi.json y los tipos del panel
```

`SINGLETON_DISABLED=true` permite desarrollar sin cluster. La suite e2e levanta el proxy completo contra un Proxmox simulado y cubre auth, scopes, admisión y seguimiento de tareas.

## Límites conocidos de v0 y hoja de ruta

- **Carga fuera de banda**: la web UI de Proxmox, `qm` por SSH y los backups no pasan por el proxy. Pendiente: sondear el task list del cluster como backstop de admisión.
- **Fail-open vs fail-closed** ante fallo interno de la admisión: decisión pendiente (sesgo previsto: fail-open con log ruidoso).
- **Carriles por aplicación** con equidad (round-robin / token bucket) y política hold-vs-429 por clave: v0 usa colas FIFO por clase de operación.
- **console-session** (`POST /proxy/console-session`): acuñar la credencial del websocket VNC para que las apps no necesiten ninguna credencial de Proxmox.
- **Botón rojo**: parar una tarea en curso desde el panel.
- **Inventario por aplicación**: la vista del cluster por rangos que la UI de Proxmox no puede dar.
- **Config en caliente** desde el panel (caps, colas) con auditoría.
- `node:sqlite` es experimental en Node 24; el acceso está aislado en `src/db.ts` para poder migrar a `better-sqlite3` con un cambio local si hiciera falta.

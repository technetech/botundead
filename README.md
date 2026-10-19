# Undeadbot

Panel privado de **1 a 10 agentes** de paper trading para Undeadwallet, con estrategia, conexión API, posiciones y actividad persistentes por agente. Conserva la interfaz oscura y verde original. Requiere Node.js 22 o posterior.

Cada instalación tiene sus propios datos: clonar el repositorio crea un espacio inicial vacío, no copia cuentas, claves ni el historial privado de otra instalación. Los nuevos agentes empiezan desactivados y en `dry-run`. No hace falta una API key para abrir el panel y preparar agentes.

## Guías de despliegue

- [Local: Node.js o aplicación y PostgreSQL con Docker](#guía-1-despliegue-local).
- [Railway: actualizar nuestro servicio actual o crear uno nuevo](#guía-2-despliegue-en-railway).
- [Vercel: PostgreSQL y ejecución programada](#guía-3-despliegue-en-vercel).

**Nuestro despliegue actual está en Railway.** Para esta actualización, conservar el servicio, sus variables y el volumen existente. Las otras guías permiten crear instalaciones independientes; no implican trasladar el bot actual.


## Guía 1: despliegue local

Requisitos: Git y Node.js 22 o posterior. Docker solo es necesario si eliges la opción con PostgreSQL.

### Opción A: Node.js y almacenamiento local automático

En Windows / PowerShell, desde la carpeta donde quieras descargar el proyecto:

```powershell
git clone https://github.com/technetech/botundead.git
Set-Location botundead
npm.cmd ci
Copy-Item .env.example .env
```

En macOS / Linux:

```sh
git clone https://github.com/technetech/botundead.git
cd botundead
npm ci
cp .env.example .env
```

1. Editar `.env` y configurar `DASHBOARD_PASSWORD` con al menos 12 caracteres. Mantener `DATA_DIR=./data` y dejar `DATABASE_URL` vacío para usar almacenamiento local. No hace falta una API key para iniciar el panel.
2. Ejecutar `npm.cmd start` en PowerShell o `npm start` en macOS / Linux. Mantener ese proceso activo para ejecutar las estrategias; cerrar la terminal detiene el motor.
3. Abrir [http://localhost:3000](http://localhost:3000). Entrar con usuario **admin** y la contraseña elegida.
4. Abrir la primera tarjeta o crear otro agente. En **Conexiones API**, guardar una clave de Undeadwallet, o configurar `AGENT_N_UNDEAD_API_KEY` en `.env` y reiniciar. En **Estrategia**, guardar los parámetros y activar el agente. Probar primero en modo **Prueba**.
5. Confirmar en **Resumen e historial** que la cuenta tiene una fecha de consulta y no hay errores. El siguiente ciclo solo puede ejecutarse si el motor ya estaba activo antes de su apertura.

El almacenamiento se crea automáticamente en `DATA_DIR`. No hay que instalar un servidor de base de datos para esta opción: `data/workspace.json` contiene agentes, identidades, posiciones, pausas, conexiones cifradas e historial. `data/credentials.key` guarda la clave de cifrado local cuando no se configura `CREDENTIALS_KEY`. Respaldar ambos y conservar `data/` al actualizar.

**Para probar mientras nuestro bot sigue en Railway**, dejar los agentes locales desactivados o usar otras API keys. No activar la misma cuenta simultáneamente en local y Railway con almacenamientos separados.

### Opción B: aplicación y PostgreSQL con Docker Compose

1. Clonar el repositorio y copiar `.env.example` a `.env` como en la opción anterior.
2. Configurar `DASHBOARD_PASSWORD`, `POSTGRES_PASSWORD` (alfanumérica, nueva y aleatoria) y `CREDENTIALS_KEY` en `.env`. Generar esta última con:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

3. Levantar aplicación y base de datos:

```sh
docker compose up --build -d
docker compose logs -f app
```

4. Abrir [http://localhost:3000](http://localhost:3000) y configurar los agentes como en la opción A. Compose espera a que PostgreSQL esté disponible y crea automáticamente la tabla y el primer agente.
5. Para detener los servicios conservando el historial, usar `docker compose down`. Para actualizar, descargar los cambios y ejecutar otra vez `docker compose up --build -d`.

El volumen `postgres-data` conserva PostgreSQL entre reinicios. **No usar `docker compose down -v` si se quiere conservar el historial.** Para una migración desde almacenamiento local, conservar también `./data` y su misma clave de cifrado; ver [Actualizar la instalación anterior](#actualizar-la-instalación-anterior).


## Guía 2: despliegue en Railway

**Railway es nuestro despliegue actual.** Para actualizarlo, usar el servicio y el volumen existentes; no crear otro bot con la misma API key. La nueva interfaz no obliga a cambiar a PostgreSQL.

### Actualizar nuestro servicio existente sin perder el historial

1. Antes del despliegue, hacer un respaldo del volumen y verificar que `DATA_DIR=/data` apunta al volumen persistente actual. Conservar `state.json`, `bot-id` y, si ya existen, `workspace.json` y `credentials.key`. No cambiar identidades ni eliminar pausas para actualizar la interfaz.
2. Mantener `UNDEAD_API_KEY`, `DASHBOARD_PASSWORD` y `BOT_MODE` con sus valores actuales. El primer agente reconoce la variable heredada `UNDEAD_API_KEY`. Conservar una sola réplica y la ejecución continua, sin suspensión.
3. Subir esta versión a la rama conectada al servicio. Si Railway tiene despliegues automáticos, el push inicia un deploy; si están desactivados, desplegar el último commit desde el servicio. Verificar que termine el proceso anterior antes de que arranque el nuevo; `railway.json` conserva `overlapSeconds=0` y el margen de cierre.
4. Al primer arranque, si todavía no existe un workspace, el código importa `/data/state.json` y `/data/bot-id` al **Agente principal**, conservando posiciones, ciclos, IDs y pausas. El modo se importa desde `BOT_MODE`. El archivo antiguo queda como respaldo; el estado vigente pasa a `/data/workspace.json`.
5. Entrar al **mismo dominio de Railway** con usuario `admin` y la contraseña actual. Verificar la primera tarjeta, el modo del agente, los IDs de posiciones y el historial importado. Una pausa previa seguirá visible y debe conciliarse; actualizar no la elimina.
6. Abrir **Conexiones API** y confirmar que el origen es **Variable de entorno**. Para el segundo agente y siguientes, usar claves independientes desde el panel o `AGENT_2_UNDEAD_API_KEY`, …, `AGENT_10_UNDEAD_API_KEY`. Los agentes nuevos empiezan desactivados y en prueba.
7. Revisar los logs de inicio, la fecha de la última consulta y el próximo ciclo. `/health` solo confirma que responde el proceso HTTP; no demuestra que la API esté conectada ni que se hayan enviado órdenes. Mantener los respaldos y conservar el volumen en los próximos deploys.

Si se usa almacenamiento por archivos y se guardan claves desde el panel, el cifrado local se genera en `/data/credentials.key`. Respaldarlo junto con el workspace. No añadir `DATABASE_URL` durante una actualización normal: cambiar de almacenamiento debe hacerse con una migración planificada.

### Crear una instalación nueva en Railway

1. Crear un proyecto/servicio conectado a [este repositorio](https://github.com/technetech/botundead). El `Dockerfile` instala las dependencias y `railway.json` configura el arranque y el healthcheck `/health`.
2. Elegir **una** opción de persistencia:
   - **Volumen**: montar un volumen persistente en `/data`, configurar `DATA_DIR=/data` y dejar `DATABASE_URL` sin definir. El almacenamiento se crea dentro de ese volumen.
   - **PostgreSQL**: agregar PostgreSQL al proyecto y configurar en la app `DATABASE_URL=${{Postgres.DATABASE_URL}}`, sustituyendo `Postgres` por el nombre real del servicio de base de datos. Usar conexión directa o pooling de sesión. La tabla se crea al iniciar; no hace falta un volumen adicional para el historial de la app.
3. Configurar las variables de la app:

| Variable | Valor / uso |
| --- | --- |
| `DASHBOARD_PASSWORD` | Contraseña nueva de al menos 12 caracteres; usuario `admin`. |
| `DATA_DIR` | `/data` si se usa el volumen. |
| `DATABASE_URL` | Referencia a PostgreSQL solo si se elige esa opción. |
| `CREDENTIALS_KEY` | 64 caracteres hexadecimales para guardar APIs en PostgreSQL; conservar entre deploys. Generar con el comando de la guía local. |
| `UNDEAD_API_KEY` o `AGENT_N_UNDEAD_API_KEY` | Opcionales al iniciar; también se pueden guardar las APIs desde el panel. |
| `PORT` | Usar el puerto asignado por Railway; la app lo lee automáticamente. |

4. Mantener un único worker continuo, sin suspensión. No configurar un cron: el proceso comprueba por sí mismo si hay acciones debidas cada cinco segundos.
5. Desplegar y generar un dominio público HTTPS en la configuración de red del servicio, apuntando al puerto de la app.
6. Abrir el dominio con usuario `admin`, configurar una estrategia y conectar su API. Activar primero el modo de prueba y revisar la conexión antes de cambiar a automático con saldo virtual.

En una instalación nueva aparece un agente vacío. El historial pertenece a esa instalación y persiste en su volumen o PostgreSQL; clonar el código no copia las cuentas de nuestro servicio actual.

[PostgreSQL en Railway](https://docs.railway.com/databases/postgresql) · [Volúmenes persistentes](https://docs.railway.com/volumes).


## Guía 3: despliegue en Vercel

La aplicación incluye `api/index.js` y `vercel.json`. **Vercel requiere PostgreSQL externo**: el código crea las tablas, pero la instancia de base de datos debe aprovisionarse y conectarse al proyecto. Sus archivos temporales no sirven para conservar el historial.

### Preparar PostgreSQL y las variables

1. Crear una base PostgreSQL dedicada a esta instalación y obtener una conexión **directa o con pooling de sesión**. No usar PgBouncer en modo transaction: el motor usa un advisory lock de sesión para serializar ejecuciones y guardar cada intención antes de enviar una orden.
2. Generar una `CREDENTIALS_KEY` de 64 caracteres hexadecimales con el comando de la guía local. Generar también un `CRON_SECRET` aleatorio independiente. Conservar ambos fuera de Git.
3. Si se quiere trasladar el bot actual de Railway, **migrar primero sus datos a la base vacía y detener el worker anterior antes de activar el cron**; seguir [Actualizar la instalación anterior](#actualizar-la-instalación-anterior). Para otra instalación independiente, usar otras claves API y otra base de datos.

### Importar y desplegar el repositorio

1. En Vercel, importar [technetech/botundead](https://github.com/technetech/botundead). Elegir el preset **Other**, Node.js 22 o posterior, raíz del repositorio, sin comando de build ni output directory personalizado.
2. Agregar las variables al entorno **Production** del proyecto:

| Variable | Obligatoria | Uso |
| --- | --- | --- |
| `DATABASE_URL` | Sí | Conexión PostgreSQL directa o con pooling de sesión. |
| `DASHBOARD_PASSWORD` | Sí | Al menos 12 caracteres; usuario del panel: `admin`. |
| `CREDENTIALS_KEY` | Para APIs guardadas desde el panel | Clave de cifrado de 64 caracteres hexadecimales; conservar en redeploys. |
| `CRON_SECRET` | Sí para operar por cron | Secreto independiente que protege `/api/cron`. |
| `AGENT_N_UNDEAD_API_KEY` | No | API por espacio; también se puede introducir desde el panel. |

3. Configurar la ejecución programada **antes de desplegar**:
   - **Plan con cron cada minuto**: conservar el bloque `crons` incluido en `vercel.json`. Vercel invocará `GET /api/cron` cada minuto con `Authorization: Bearer CRON_SECRET`.
   - **Hobby**: su cron solo admite frecuencia diaria. Quitar únicamente el bloque `crons` de `vercel.json` y configurar un programador externo para llamar cada minuto a `https://TU-DOMINIO/api/cron`, método `GET`, con el encabezado `Authorization: Bearer TU_CRON_SECRET`. Conservar `functions` y `rewrites`.
4. Desplegar. La primera solicitud inicializa la tabla y el primer agente en PostgreSQL. Si se cambian variables después, hacer un nuevo deploy para aplicarlas.
5. Abrir el dominio con usuario `admin`, entrar en una tarjeta y guardar su estrategia y API. Mantener el agente en prueba mientras se valida que el cron está funcionando.
6. Verificar en los logs de Vercel que `/api/cron` recibe llamadas, que responde correctamente y que la tarjeta muestra una fecha de consulta reciente. La actualización visual cada cinco segundos **no ejecuta las estrategias**: el motor depende del cron aun cuando nadie abra el panel.

Los cron de Vercel se ejecutan sobre el despliegue de producción. No reutilizar las claves de producción en previews ni habilitar otro programador para la misma instalación.

Vercel no garantiza puntualidad exacta del cron. Una llamada fuera de la ventana de entrada de 60 segundos omite el ciclo; no se abren órdenes atrasadas. La configuración limita la función a 300 segundos, sujeto al plan. Una interrupción puede dejar una intención pendiente que exige conciliación. Para nuestro bot continuo seguimos usando **Railway**.

[Programación y límites de cron](https://vercel.com/docs/cron-jobs/usage-and-pricing) · [Autenticación y gestión](https://vercel.com/docs/cron-jobs/manage-cron-jobs).


## Agentes y estrategia

La entrada muestra una tarjeta por agente y una tarjeta **Nuevo agente** hasta completar los 10 espacios. Cada tarjeta abre:

- **Resumen e historial**: saldo de la cuenta conectada, posiciones propias, próxima entrada, PnL disponible y registro de acciones. Incluye actividad anterior al último reinicio y permite mostrar más registros y filtrar posiciones.
- **Estrategia**: nombre, prompt inicial, símbolos, margen por activo, apalancamiento, dirección long/short, modo de prueba/automático y activación.
- **Conexiones API**: conexión de Undeadwallet y alta o sustitución de la clave, con indicación de su origen.

El prompt es documentación de la estrategia; **no se interpreta con IA ni ejecuta código**. Las órdenes usan los parámetros estructurados. El motor conserva los horarios existentes: cada dos horas a las `00:25, 02:25, …, 22:25`, con cierre 90 minutos después, en `America/Monterrey`. Las posiciones anteriores conservan el horario que ya tenían registrado. Los símbolos, márgenes y apalancamientos también deben ser admitidos por el proveedor; su rechazo pausa ese agente.

La API usa saldo **virtual USDG**, sin claves privadas ni transacciones on-chain. `dry-run` consulta y registra decisiones sin abrir ni cerrar posiciones; `live` opera con saldo virtual. El motor no tiene stop-loss ni take-profit. El panel no ofrece una apertura manual inmediata.

## Claves API

Cada agente necesita una API key independiente. Se rechaza reutilizar una key entre espacios. Se puede configurar desde el panel, desde `.env` o desde variables de Vercel/Railway:

```dotenv
AGENT_1_UNDEAD_API_KEY=...
AGENT_2_UNDEAD_API_KEY=...
# Hasta AGENT_10_UNDEAD_API_KEY.
```

El primer espacio también admite la variable heredada `UNDEAD_API_KEY`. Prioridad: variable `AGENT_N_UNDEAD_API_KEY`, después `UNDEAD_API_KEY` para el primer agente, después clave cifrada del panel. Las variables de entorno nunca se copian al documento persistente. El navegador recibe únicamente origen y estado de configuración, nunca la clave guardada.

Las claves del panel se cifran con AES-256-GCM. PostgreSQL requiere `CREDENTIALS_KEY` para guardarlas o leerlas. Conservar esta clave al cambiar de servidor, restaurar un respaldo o desplegar de nuevo. No subir `.env`, `data/` ni secretos al repositorio. Usar HTTPS en despliegues públicos.

## Actualizar la instalación anterior

Detener la instancia anterior y respaldar el volumen. Al iniciar con un workspace vacío, se importa `DATA_DIR/state.json` al primer agente **una sola vez** y se conserva `bot-id`, IDs de posiciones, ciclos y pausas. El modo se toma de `BOT_MODE` y se conserva la activación si existe `UNDEAD_API_KEY`. No se borra ni modifica el archivo antiguo: desde la migración, el estado vigente es `workspace.json` o PostgreSQL.

Para migrar directamente a PostgreSQL, configurar `DATABASE_URL` y montar temporalmente el volumen anterior en `DATA_DIR` durante el primer inicio. No abrir antes una instalación vacía en esa base: la importación solo ocurre si no existe ya un workspace. Para pasar a Vercel, hacer primero esta importación desde un proceso local/Railway conectado a la base de destino y luego detenerlo antes de activar el cron. No ejecutar dos instalaciones con las mismas claves sobre almacenamientos distintos.

No se puede recuperar actividad de sesiones anteriores que la versión antigua nunca guardó. Las posiciones históricas existentes sí se conservan.

Si ya se usa esta versión en local, al conectar una base PostgreSQL vacía se importa primero el `workspace.json` completo de `DATA_DIR`, conservando todos sus agentes e historial. Si las APIs del panel usaban `data/credentials.key`, configurar ese mismo valor como `CREDENTIALS_KEY` en el destino antes de importar. Una base con datos existentes nunca se sobrescribe con archivos locales. Detener siempre el worker de origen antes de iniciar el de destino.

## Persistencia y recuperación

Los archivos usan escritura con fsync y reemplazo atómico. PostgreSQL serializa operaciones con un advisory lock y confirma cada intención **antes** de enviar una orden; no engloba órdenes de red en una transacción que pudiera revertir esa intención. El estado y la actividad quedan separados por agente. Los IDs e intenciones impiden repetir aperturas en reinicios o invocaciones concurrentes.

Un rechazo o una respuesta incierta pausa de forma persistente al agente afectado, incluidos sus cierres. No se reenvían órdenes inciertas. Los otros agentes mantienen su propio estado. El panel muestra el motivo. Las lecturas de cuenta fallidas conservan los datos anteriores y su fecha; no se reintentan hasta restablecer el monitor mediante `resume` o guardar una configuración sin posiciones pendientes. Heartbeats y versión tienen sus propios intervalos.

Procedimiento de recuperación:

1. Detener el worker o desactivar el cron y hacer un respaldo del workspace/base de datos.
2. Revisar el estado del espacio con `AGENT_SLOT=N npm run status` (en PowerShell: `$env:AGENT_SLOT='N'; npm.cmd run status`). Comparar las notas `undeadbot:FECHAT10:25:SIMBOLO:direccion` y los IDs con la cuenta real.
3. Conciliar exclusivamente `agents[].state` del agente afectado en `workspace.json` o en el documento de `undeadbot_workspace`. Para una apertura `pending`, si existe inequívocamente la posición, registrar el ID y `status: "opened"` en el ciclo y conservar su posición en `positions`. Si nunca se abrió y está confirmado, marcar la entrada como `rejected`, conservando el ciclo. Para un cierre `closing`, verificar si ya cerró (`closed`) o si sigue abierta y no se ejecutó el cierre (`open`). Conservar fechas, IDs y `closeSeconds`. Si no hay certeza, dejar pausado.
4. Corregir la causa y ejecutar `npm run resume` con `AGENT_SLOT` seleccionado. Se niega si quedan aperturas `pending` o posiciones `closing`. No cambia los ciclos ni borra posiciones. Reiniciar el worker o reactivar el cron; las entradas ya registradas no se repiten y se procesan cierres vencidos.

El archivo `process.lock` impide iniciar dos procesos con el mismo directorio local. Si queda huérfano tras un apagado forzado, verificar que no siga activo ningún proceso antes de retirarlo. Nunca borrar el workspace, la identidad o el historial para resolver un bloqueo. No volver al binario anterior usando su `state.json` desactualizado después de operar con esta versión.

## Validación

```sh
npm test
npm run lint
```

Las pruebas cubren estrategia original, API simulada, historial, migración, cifrado, prioridad de variables, máximo de agentes, configuración por agente, aislamiento, reinicios, persistencia previa a órdenes, autenticación y CSRF. No envían operaciones a cuentas reales.

Para ejecutar la prueba de integración PostgreSQL, configurar `TEST_DATABASE_URL` apuntando a una base **desechable**: esa prueba modifica sus agentes. GitHub Actions levanta PostgreSQL 17 y ejecuta también esta prueba. Sin esa variable se omite únicamente la integración PostgreSQL.

La integración conserva el contrato de Undeadwallet API 1.17: `X-Asset-Key`, identidad estable `X-Bot-Id`, `/learn` antes de operar, `/heartbeat` sin body y comprobación periódica de `/version`. No se ha verificado contra una cuenta autenticada real como parte de esta modificación.

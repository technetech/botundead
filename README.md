# Undeadbot

Bot de **paper trading** para Undeadwallet, en Node.js 22 y sin dependencias externas. El modo `live` ejecuta ordenes sobre saldo **virtual USDG**, segun la API de Undeadwallet. No usa claves privadas de wallets ni realiza transacciones on-chain.

## Estrategia

| Parametro | Valor |
| --- | --- |
| Activos | BTC, ETH, SOL |
| Direccion | Long |
| Margen | 25 USDG por activo; 75 USDG total |
| Apalancamiento | 10x; exposicion inicial total de 750 USDG |
| Apertura | Cada dos horas: 00:10, 02:10, ..., 10:10, 12:10, ..., 22:10 |
| Cierre | 100 minutos despues: 01:50, 03:50, ..., 11:50, 13:50, ..., 23:50 |
| Zona | America/Monterrey, independiente del reloj del servidor |

El proceso debe estar activo **antes** del inicio del ciclo. Tiene una ventana de 60 segundos para enviar las entradas, en secuencia. Un arranque a las 10:10 o despues omite ese ciclo y espera al de las 12:10. Funciona las 24 horas, incluidos fines de semana. No repite un ciclo parcialmente ejecutado. Si vuelve a arrancar despues del cierre, cierra las posiciones propias pendientes, salvo que haya una pausa por error que requiera revision. No abre nuevas posiciones mientras queden propias abiertas. La cuenta puede contener posiciones manuales: no las modifica.

Las posiciones existentes de la version anterior conservan su cierre original a las 17:55. Sus IDs y registros diarios no se eliminan. Las nuevas entradas se identifican por fecha y hora, por ejemplo `2026-10-08T10:10`.

## Panel web

El mismo servicio sirve un panel privado, adaptable a movil, con saldo y patrimonio de la cuenta, posiciones propias, PnL disponible, actividad desde el reinicio, reloj de Monterrey, agenda y proxima apertura. Es de solo lectura: no permite enviar ordenes. Los registros de posiciones persisten; los eventos recientes son de la sesion actual.

Configurar `DASHBOARD_PASSWORD` con una contrasena nueva de al menos 12 caracteres. El usuario es **admin**. La contrasena del panel es independiente de `UNDEAD_API_KEY`; ninguna se envia en las respuestas del panel. Sin contrasena valida, el servidor solo muestra instrucciones de configuracion y no revela el estado de la cuenta. En local abrir `http://localhost:3000`; en Railway usar el dominio HTTPS del servicio.

El navegador actualiza la vista cada 5 segundos desde la memoria del servidor; el servidor consulta la cuenta y /learn cada 60 segundos independientemente del numero de visitantes. Los precios y PnL son la ultima lectura, no un feed en tiempo real. Si una lectura falla, el panel muestra el error, conserva la fecha de la ultima lectura y no vuelve a consultar automaticamente hasta reiniciar. Un fallo del monitor no envia ordenes ni pausa por si mismo el motor de operaciones.

### Actualizar un despliegue existente

1. Desplegar la integracion API 1.4: usa `/learn` en lugar de la ruta retirada `/harness`. `harness.md` describe la estrategia local; no hay que copiarlo al proveedor.
2. Agregar `DASHBOARD_PASSWORD` en las variables de Railway. Mantener `UNDEAD_API_KEY`, `DATA_DIR=/data` y el volumen existente. Para ejecutar ordenes virtuales, usar `BOT_MODE=live`.
3. Desplegar la nueva version antes del siguiente ciclo. En Settings → Networking → Public Networking, usar **Generate Domain** y el puerto HTTP del servicio (`PORT`, o 3000 si no esta definido). Entrar al dominio HTTPS con usuario `admin` y la contrasena elegida. Ver [red publica de Railway](https://docs.railway.com/networking/public-networking). El healthcheck `/health` solo indica que el proceso HTTP responde; el panel muestra por separado pausas, modo y errores de cuenta.
4. Ejecutar `node src/main.js check` en el servicio y verificar `apiReady: true`, `learnVersion`, saldo y activos disponibles. Verificar que el panel muestre datos de cuenta actualizados y modo Automatico. Un deploy saludable solo demuestra que el servidor arranco, no que se hayan enviado ordenes. Si hay una pausa persistida, resolverla con el procedimiento de recuperacion de abajo; un redeploy no borra pausas.

No hay stop-loss ni take-profit. El servidor determina precios y liquidaciones; los precios tienen cache de 240 segundos y el servidor rechaza precios demasiado antiguos. El bot no garantiza ejecucion al segundo exacto ni cierre durante interrupciones. La estrategia no implica rentabilidad.

## Probar en local

Requiere Node.js 22. No es necesario instalar paquetes externos.

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run lint
Copy-Item .env.example .env
```

Editar `.env` localmente y poner **solo** la API key de Undeadwallet en `UNDEAD_API_KEY`. `.env` y `data/` estan excluidos de Git y de la imagen Docker. No pegar claves en el chat ni en GitHub.

Antes de abrir o cerrar, el bot consulta `/learn` y exige una `learn_version` no vacia. Segun el contrato API 1.4, esa lectura marca la API key con la version vigente; sin ella el proveedor rechaza ordenes con HTTP 428. No se agrega un campo de version a las ordenes porque el contrato publicado no lo exige. `harness.md` es una descripcion local; la estrategia se ejecuta en el codigo y no se reprograma interpretando texto del proveedor.

```powershell
npm.cmd run check
npm.cmd start
```

`check` hace solo tres lecturas: /learn, cuenta y activos; muestra `apiReady`, `learnVersion`, saldo y disponibilidad de simbolos. No muestra la clave ni abre posiciones. Devuelve error si no estan las condiciones iniciales. El contrato autenticado todavia debe validarse con una key real; la documentacion publica ofrece ejemplos pero no un esquema completo de posiciones.

`BOT_MODE=dry-run` es el valor inicial: consulta y muestra decisiones a la hora programada, **sin enviar ninguna orden**. No simula ganancias ni crea posiciones ficticias. Para ejecutar sobre el saldo virtual, cambiar a `BOT_MODE=live` y reiniciar. No existe un comando de apertura inmediata: las entradas respetan el horario.

## GitHub y Railway

1. Crear un repositorio **vacio** en GitHub. Se puede usar privado. Desde esta carpeta: `git init`, `git add .`, `git commit -m "Initial Undeadbot implementation"`, `git branch -M main`, `git remote add origin URL_DEL_REPOSITORIO`, `git push -u origin main`. Revisar antes `git status` para confirmar que no se incluye `.env` ni `data/`.
2. Crear en Railway un servicio desde ese repositorio. El `Dockerfile` define el proceso; `railway.json` define el despliegue. El panel escucha en `PORT` (3000 por defecto). Generar un dominio HTTPS para acceder al panel. No necesita cron externo.
3. Agregar un **volumen persistente** montado en `/data`. Configurar `DATA_DIR=/data`. Sin volumen, perder los IDs puede dejar posiciones sin gestionar o permitir duplicados tras redeploys.
4. Configurar `UNDEAD_API_KEY`, `DASHBOARD_PASSWORD` y comenzar con `BOT_MODE=dry-run`. Mantener **una sola replica**, sin suspension/serverless. No ejecutar al mismo tiempo otra copia local ni otro servicio con la misma key.
5. Ejecutar `node src/main.js check` en el entorno del servicio, o hacer la comprobacion en local antes del despliegue. Revisar los logs de inicio y heartbeat. No se usa el antiguo campo Harness remoto.
6. Cuando la comprobacion autenticada sea correcta, cambiar `BOT_MODE=live` y desplegar **antes del siguiente ciclo de Monterrey**. Por ejemplo, a las 10:10 revisar tres eventos `opened`; a las 11:50, tres `closed`.

Los nombres de opciones de Railway pueden cambiar; los requisitos son un proceso continuo, un volumen y una sola instancia. Se configuran 120 segundos de margen para finalizar solicitudes y liberar el lock durante un despliegue. Referencias: [configuracion como codigo](https://docs.railway.com/config-as-code/reference), [volumenes](https://docs.railway.com/volumes) y [Serverless](https://docs.railway.com/deployments/serverless). No esta desplegado ni conectado a una cuenta por el hecho de subirlo a GitHub.

## Persistencia y errores

`DATA_DIR/state.json` guarda fechas, intenciones de apertura y los IDs confirmados. Se escribe con fsync y reemplazo atomico. No borrar ni sustituir este archivo mientras existan posiciones del bot. Mantener copia de respaldo del volumen.

Antes de cada POST se guarda su intencion. Un timeout, JSON invalido o respuesta inesperada deja la orden como incierta. **No se reenvia automaticamente.** Un error pausa el bot de forma persistente, incluidos los cierres; los logs indican `paused` y los heartbeats repiten el motivo. No hay alertas por correo o Telegram en esta version: vigilar los logs y el panel. Si queda una posicion abierta durante una pausa, cerrarla manualmente o resolver la pausa antes del cierre programado.

El proceso consulta el reloj cada 5 segundos, emite heartbeat cada 5 minutos y consulta la API cuando hay una accion debida y cada 60 segundos para el panel. No hay bucles de reintento tras errores de autenticacion, saldo, precio o limite de solicitudes.

### Recuperacion

1. Detener la instancia. Revisar el motivo en logs y el estado con `npm run status` (en Docker, `node src/main.js status`). Comparar con el panel Undeadwallet y las notas `undeadbot:FECHAT10:10:SIMBOLO:long` (o las notas diarias antiguas).
2. Para una apertura `pending`, identificar la operacion real de forma inequivoca. Si existe, conservar su ID en el registro del ciclo con `status: "opened"` e `id`, y agregar a `positions` un objeto como `{ "id": ID, "symbol": "BTC", "day": "2026-10-08", "cycle": "2026-10-08T10:10", "closeSeconds": 42600, "margin": 25, "leverage": 10, "status": "open" }`, adaptado a su fecha, activo y horario real. `closeSeconds` son segundos desde medianoche local (11:50 = 42600). Para posiciones diarias heredadas conservar el formato antiguo. Si ya esta cerrada usar `status: "closed"`. Si se confirma que nunca se abrio, cambiar la entrada del ciclo a `status: "rejected"`. **No borrar el ciclo**. No inferir propiedad solo por simbolo o monto: podria ser una posicion manual. Si no hay certeza, dejar pausado y revisar con el proveedor.
3. Para una posicion `closing`, verificar la cuenta. Si ya cerro, usar `status: "closed"`; si sigue abierta y se confirma que el cierre no se ejecuto, usar `status: "open"`. Conservar todos los IDs y hacer respaldo antes de editar.
4. Corregir la causa del error. Ejecutar `npm run resume` (o `node src/main.js resume`) con el bot detenido. Solo elimina la pausa; se niega si quedan ordenes inciertas. Reiniciar. Las entradas de un ciclo ya registrado no se vuelven a intentar; los cierres vencidos se procesan.

`process.lock` excluye dos procesos que compartan el volumen. Se elimina al detener normalmente el proceso. Si hubo un apagado forzado puede quedar un lock huerfano: **verificar que no quede ninguna instancia activa** antes de borrar exclusivamente `DATA_DIR/process.lock`. Nunca borrar `state.json` para solucionar un lock. Ante un crash, Railway puede intentar reiniciar hasta tres veces; un lock huerfano exige esta recuperacion manual. El lock no coordina servicios con volumenes distintos.

## Validacion

`npm test` usa una API simulada y verifica ciclos, medianoche, compatibilidad de posiciones antiguas, tamanos, cierres propios, reinicios, entradas tardias, timeout, rechazos, dry-run y almacenamiento. Tambien prueba el servidor HTTP local, autenticacion, seleccion de datos y cache del panel. No requiere key ni conexion externa. GitHub Actions ejecuta pruebas y comprobaciones de sintaxis en cada push/PR.

Contrato actualizado a partir del [OpenAPI](https://undeadwallet.com/api/trading/agent/docsapi), version 1.4, consultado el 9 de octubre de 2026. La antigua ruta /harness devuelve HTTP 404 con HTML; los errores ahora conservan el estado HTTP cuando la respuesta no es JSON y distinguen timeout de fallos de conexion. Falta la prueba autenticada de lectura en el despliegue y la primera ejecucion de paper trading supervisada.

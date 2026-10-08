# Undeadbot

Bot de **paper trading** para Undeadwallet, en Node.js 22 y sin dependencias externas. El modo `live` ejecuta ordenes sobre saldo **virtual USDG**, segun la API de Undeadwallet. No usa claves privadas de wallets ni realiza transacciones on-chain.

## Estrategia

| Parametro | Valor |
| --- | --- |
| Activos | BTC, ETH, SOL |
| Direccion | Long |
| Margen | 100 USDG por activo; 300 USDG total |
| Apalancamiento | 3x; exposicion inicial total de 900 USDG |
| Apertura | Todos los dias a las 08:50 |
| Cierre | 17:55 del mismo dia |
| Zona | America/Monterrey, independiente del reloj del servidor |

El proceso debe estar activo **antes** de las 08:50. Tiene una ventana de 60 segundos para enviar las entradas, en secuencia. Un arranque a las 08:50 o despues omite las entradas del dia. No repite un dia parcialmente ejecutado. Si vuelve a arrancar despues del cierre o al dia siguiente, cierra las posiciones propias pendientes, salvo que haya una pausa por error que requiera revision. No abre nuevas posiciones mientras queden propias abiertas. La cuenta puede contener posiciones manuales: no las modifica.

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

Antes de operar, copiar el contenido completo de `harness.md` al campo Harness del panel Agent de Undeadwallet. La API exige leerlo. El bot verifica coincidencia con ese archivo antes de abrir (tolera finales de linea Windows y espacios externos). Si las reglas cambian, pausa las entradas; la estrategia del codigo no se reprograma interpretando texto.

```powershell
npm.cmd run check
npm.cmd start
```

`check` hace solo tres lecturas: harness, cuenta y activos; muestra si las reglas coinciden, saldo y disponibilidad de simbolos. No muestra la clave ni abre posiciones. Devuelve error si no estan las condiciones iniciales. El contrato autenticado todavia debe validarse con una key real; la documentacion publica ofrece ejemplos pero no un esquema completo de posiciones.

`BOT_MODE=dry-run` es el valor inicial: consulta y muestra decisiones a la hora programada, **sin enviar ninguna orden**. No simula ganancias ni crea posiciones ficticias. Para ejecutar sobre el saldo virtual, cambiar a `BOT_MODE=live` y reiniciar. No existe un comando de apertura inmediata: las entradas respetan el horario.

## GitHub y Railway

1. Crear un repositorio **vacio** en GitHub. Se puede usar privado. Desde esta carpeta: `git init`, `git add .`, `git commit -m "Initial Undeadbot implementation"`, `git branch -M main`, `git remote add origin URL_DEL_REPOSITORIO`, `git push -u origin main`. Revisar antes `git status` para confirmar que no se incluye `.env` ni `data/`.
2. Crear en Railway un servicio desde ese repositorio. El `Dockerfile` define el proceso; `railway.json` define el despliegue. No necesita dominio publico, puerto HTTP ni cron externo.
3. Agregar un **volumen persistente** montado en `/data`. Configurar `DATA_DIR=/data`. Sin volumen, perder los IDs puede dejar posiciones sin gestionar o permitir duplicados tras redeploys.
4. Configurar `UNDEAD_API_KEY` y comenzar con `BOT_MODE=dry-run`. Mantener **una sola replica**, sin suspension/serverless. No ejecutar al mismo tiempo otra copia local ni otro servicio con la misma key.
5. Copiar `harness.md` al panel Agent. Ejecutar `node src/main.js check` en el entorno del servicio, o hacer la comprobacion en local antes del despliegue. Revisar los logs de inicio y heartbeat.
6. Cuando la comprobacion autenticada sea correcta, cambiar `BOT_MODE=live` y desplegar **antes de las 08:50 de Monterrey**. A las 08:50 revisar tres eventos `opened`; a las 17:55, tres `closed`.

Los nombres de opciones de Railway pueden cambiar; los requisitos son un proceso continuo, un volumen y una sola instancia. Se configuran 120 segundos de margen para finalizar solicitudes y liberar el lock durante un despliegue. Referencias: [configuracion como codigo](https://docs.railway.com/config-as-code/reference), [volumenes](https://docs.railway.com/volumes) y [Serverless](https://docs.railway.com/deployments/serverless). No esta desplegado ni conectado a una cuenta por el hecho de subirlo a GitHub.

## Persistencia y errores

`DATA_DIR/state.json` guarda fechas, intenciones de apertura y los IDs confirmados. Se escribe con fsync y reemplazo atomico. No borrar ni sustituir este archivo mientras existan posiciones del bot. Mantener copia de respaldo del volumen.

Antes de cada POST se guarda su intencion. Un timeout, JSON invalido o respuesta inesperada deja la orden como incierta. **No se reenvia automaticamente.** Un error pausa el bot de forma persistente, incluidos los cierres; los logs indican `paused` y los heartbeats repiten el motivo. No hay alertas por correo o Telegram en esta version: vigilar los logs y el panel. Si queda una posicion abierta durante una pausa, cerrarla manualmente o resolver la pausa antes del cierre programado.

El proceso consulta el reloj cada 5 segundos, emite heartbeat cada 5 minutos y consulta la API solo cuando hay una accion debida. No hay bucles de reintento tras errores de autenticacion, saldo, precio o limite de solicitudes.

### Recuperacion

1. Detener la instancia. Revisar el motivo en logs y el estado con `npm run status` (en Docker, `node src/main.js status`). Comparar con el panel Undeadwallet y las notas `undeadbot:FECHA:SIMBOLO:long`.
2. Para una apertura `pending`, identificar la operacion real de forma inequívoca. Si existe, conservar su ID en el registro de ese dia con `status: "opened"` e `id`, y agregar a `positions` el objeto `{ "id": ID, "symbol": "BTC", "day": "YYYY-MM-DD", "status": "open" }` correspondiente. Si ya esta cerrada usar `status: "closed"`. Si se confirma que nunca se abrio, cambiar la entrada del dia a `status: "rejected"`. **No borrar el dia**. No inferir propiedad solo por simbolo o monto: podria ser una posicion manual. Si no hay certeza, dejar pausado y revisar con el proveedor.
3. Para una posicion `closing`, verificar la cuenta. Si ya cerro, usar `status: "closed"`; si sigue abierta y se confirma que el cierre no se ejecuto, usar `status: "open"`. Conservar todos los IDs y hacer respaldo antes de editar.
4. Corregir la causa del error. Ejecutar `npm run resume` (o `node src/main.js resume`) con el bot detenido. Solo elimina la pausa; se niega si quedan ordenes inciertas. Reiniciar. Las entradas del dia no se vuelven a intentar; los cierres vencidos se procesan.

`process.lock` excluye dos procesos que compartan el volumen. Se elimina al detener normalmente el proceso. Si hubo un apagado forzado puede quedar un lock huerfano: **verificar que no quede ninguna instancia activa** antes de borrar exclusivamente `DATA_DIR/process.lock`. Nunca borrar `state.json` para solucionar un lock. Ante un crash, Railway puede intentar reiniciar hasta tres veces; un lock huerfano exige esta recuperacion manual. El lock no coordina servicios con volumenes distintos.

## Validacion

`npm test` usa una API simulada y verifica horarios, tamanos, cierres propios, reinicios, entradas tardias, timeout, rechazos, ventana de entrada, dry-run y almacenamiento. No requiere key ni red. GitHub Actions ejecuta pruebas y comprobaciones de sintaxis en cada push/PR.

Contrato implementado a partir del [SDK publico](https://undeadwallet.com/api/trading/agent/sdkagent) y [OpenAPI](https://undeadwallet.com/api/trading/agent/docsapi), version 1.0, consultados el 8 de octubre de 2026. Falta la prueba autenticada de lectura y la primera ejecucion de paper trading supervisada.

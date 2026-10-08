# Undeadbot: estrategia diaria

Paper trading con saldo virtual USDG. Operar automaticamente todos los dias, incluidos fines de semana, en la zona America/Monterrey.

Abrir una posicion long en BTC, ETH y SOL a las 08:50, con 100 USDG de margen por activo y apalancamiento 3x. Maximo tres posiciones propias abiertas y 300 USDG de margen total. No abrir si falta saldo para las tres posiciones. No gestionar posiciones manuales.

Cerrar las posiciones propias a las 17:55 del mismo dia. Si el bot estaba desconectado, cerrar las pendientes al volver. No hay stop-loss ni take-profit en esta estrategia.

Solo entrar si el bot ya estaba activo antes de las 08:50. Ventana de ejecucion de 60 segundos para completar las tres solicitudes; omitir entradas tardias. No repetir aperturas en la misma fecha. No acumular posiciones de dias anteriores.

Consultar las reglas y la cuenta antes de operar; consultar activos antes de abrir. Revisar el reloj cada 5 segundos. Ante errores, registrar el motivo y pausar, sin reintentar ordenes automaticamente. Una respuesta incierta requiere revision manual. Guardar los IDs en almacenamiento persistente y enviar una note explicativa en cada orden.

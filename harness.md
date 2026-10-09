# Undeadbot: ciclos de dos horas

Paper trading con saldo virtual USDG. Operar automaticamente todos los dias, las 24 horas, en America/Monterrey.

Abrir posiciones long en BTC, ETH y SOL cada dos horas a los diez minutos de cada hora par: 00:10, 02:10, 04:10, 06:10, 08:10, 10:10, 12:10, 14:10, 16:10, 18:10, 20:10 y 22:10. Usar 25 USDG de margen por activo y apalancamiento 10x. Maximo tres posiciones propias y 75 USDG de margen por ciclo. Requerir saldo para las tres. No gestionar posiciones manuales.

Cerrar cada grupo 100 minutos despues de abrir: 01:50, 03:50, 05:50, 07:50, 09:50, 11:50, 13:50, 15:50, 17:50, 19:50, 21:50 y 23:50. Ejemplos: 10:10 a 11:50, 12:10 a 13:50. Si el bot estaba desconectado, cerrar pendientes al volver. Conservar el cierre original de las 17:55 para posiciones heredadas de la estrategia diaria anterior. No hay stop-loss ni take-profit.

Entrar solamente si el bot estaba activo antes del inicio del ciclo. Ventana de 60 segundos para completar las tres solicitudes. Omitir entradas tardias y no repetir un ciclo parcial o completado. No abrir mientras queden posiciones propias abiertas.

Consultar /learn y la cuenta antes de operar; consultar activos antes de abrir. /learn registra en el proveedor la version vigente para la API key; no contiene la estrategia local ni se compara con este archivo. Revisar el reloj cada 5 segundos. Consultar cuenta y /learn para el panel cada 60 segundos. Ante un error de lectura del panel, conservar la ultima lectura y detener esos refrescos hasta reiniciar; no enviar ordenes desde el panel. Ante errores de operativa, registrar y pausar sin reintentar ordenes automaticamente. Las respuestas inciertas requieren revision manual. Guardar IDs y ciclos en almacenamiento persistente y enviar note en cada orden.

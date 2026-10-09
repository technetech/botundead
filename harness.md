# Undeadbot: ciclos de dos horas

Paper trading con saldo virtual USDG. Operar automaticamente todos los dias, las 24 horas, en America/Monterrey.

Abrir posiciones long en BTC, ETH y SOL cada dos horas a los veinticinco minutos de cada hora par: 00:25, 02:25, 04:25, 06:25, 08:25, 10:25, 12:25, 14:25, 16:25, 18:25, 20:25 y 22:25. Usar 25 USDG de margen por activo y apalancamiento 10x. Maximo tres posiciones propias y 75 USDG de margen por ciclo. Requerir saldo para las tres. No gestionar posiciones manuales.

Cerrar cada grupo 90 minutos despues de abrir: 01:55, 03:55, 05:55, 07:55, 09:55, 11:55, 13:55, 15:55, 17:55, 19:55, 21:55 y 23:55. Ejemplos: 10:25 a 11:55, 12:25 a 13:55. Si el bot estaba desconectado, cerrar pendientes al volver. Conservar el cierre original de las 17:55 para posiciones heredadas de la estrategia diaria anterior. No hay stop-loss ni take-profit.

Entrar solamente si el bot estaba activo antes del inicio del ciclo. Ventana de 60 segundos para completar las tres solicitudes. Omitir entradas tardias y no repetir un ciclo parcial o completado. No abrir mientras queden posiciones propias abiertas.

Consultar /learn y la cuenta antes de operar; consultar activos antes de abrir. /learn registra en el proveedor la version vigente para la API key; no contiene la estrategia local ni se compara con este archivo. Revisar el reloj cada 5 segundos. Consultar cuenta y /learn para el panel cada 60 segundos. Ante un error de lectura del panel, conservar la ultima lectura y detener esos refrescos hasta reiniciar; no enviar ordenes desde el panel. Ante errores de operativa, registrar y pausar sin reintentar ordenes automaticamente. Las respuestas inciertas requieren revision manual. Guardar IDs y ciclos en almacenamiento persistente y enviar note en cada orden.

# Lógica de negocio

> Documento **vivo**. Acá va la regla del dominio (planilla peruana, vencimientos
> SUNAT/SUNAFIL, contabilidad); la arquitectura y las reglas de proceso viven en
> `CLAUDE.md`. Cada regla nueva que aparezca se escribe acá, no allá.
>
> El archivo estaba vacío hasta el 04/09/2026. La primera sección es Cajas; la regla de
> planilla y vencimientos sigue viviendo solo en los comentarios del código
> (`conceptos.service.ts`, `configuracion.service.ts`, `bd.sql`) y falta volcarla.

---

## Cajas chicas

Módulo `tesoreria/cajas` (intranet) + `cliente/cajas` (portal). Tablas: `caja_chica`,
`caja_chica_movimiento`, `caja_chica_concepto` (sección 10 de `bd.sql`).

### Qué es una caja chica acá

Un **fondo acotado** que una empresa cliente abre con un monto, gasta y **cierra**. No es
una cuenta bancaria: por eso no se reusa `tesoreria_cuenta` de la sección 7, que modela
el saldo permanente de la empresa y no tiene apertura, cierre ni rendición.

Una empresa puede tener varias cajas a la vez (oficina, obra, sucursal), pero no dos con
el mismo nombre — al elegirlas en un desplegable serían indistinguibles.

### El saldo

**`saldo_actual = SUM(ingresos) − SUM(egresos)`** sobre los movimientos que cuentan.

Un movimiento **cuenta para el saldo** solo si cumple las dos condiciones:

```
estado = 'REGISTRADO'  AND  revision = 'APROBADO'
```

Son dos preguntas distintas y por eso son dos columnas: `estado` dice si el movimiento
sigue vivo (un ANULADO no cuenta), `revision` dice si el estudio ya lo validó.

- **La apertura también es un movimiento** (tipo `INGRESO`, `tabla_origen =
  'caja_chica_apertura'`). Sin eso el monto inicial no aparece en el estado de cuenta y
  las columnas no cuadran con el saldo: se ve "saldo 300" con gastos por 200 y ningún
  ingreso.
- El saldo se **guarda** en `caja_chica.saldo_actual` en vez de calcularse con un `SUM()`
  cada vez, porque se muestra en toda pantalla y el libro crece sin límite. Lo mantiene
  el service **dentro de la misma transacción** que el movimiento.

### El saldo corrido se recalcula, no se ajusta

Después de cualquier escritura (crear, editar, anular, aprobar, corregir la apertura) se
**recalcula la cadena entera** de `saldo_anterior`/`saldo_posterior` de esa caja,
ordenada por `(fecha, id_movimiento)`.

El motivo: un movimiento puede entrar con **fecha retroactiva**, anterior a otros ya
cargados. Si el saldo se mantuviera con ajustes incrementales, la columna "saldo" de las
filas anteriores quedaría congelada con el valor viejo y el estado de cuenta mostraría
una última fila que no coincide con el saldo real de la caja. Un contador que ve eso deja
de confiar en el reporte entero.

Recalcular es barato: una caja chica tiene decenas o cientos de movimientos, no millones.

### El saldo no puede quedar negativo en NINGÚN punto de la línea de tiempo

No alcanza con que el saldo final sea positivo. Se valida el **punto más bajo** de la
cadena y **en qué fecha ocurre**: un gasto con fecha retroactiva puede dejar la caja en
rojo en el pasado aunque hoy cierre bien, y eso significa que la plata no estaba ese día.

El mensaje de error dice el monto, el saldo resultante, **la fecha del punto más bajo** y
qué hacer ("registrá la reposición con su fecha real"). Sin la fecha, el usuario no puede
encontrar el problema.

### Correcciones y bajas

| Situación | Qué corresponde | Por qué |
|---|---|---|
| Se tipeó mal el fondo inicial | Editar la caja | Aplica la **diferencia** contra el monto anterior y sincroniza el movimiento de apertura. No recalcula desde cero: los movimientos ya registrados se respetan |
| La empresa está mal | Cerrar y abrir otra | Cambiar `id_empresa` no es corregir: los movimientos ya cargados quedarían atribuidos a un cliente que no es. El DTO de edición ni siquiera acepta el campo |
| Un gasto está mal | Anular y registrar de nuevo | Anular revierte el saldo y deja el motivo. Nunca se borra: el arqueo de ese día ya se firmó con el movimiento adentro |
| El tipo está mal (gasto ↔ ingreso) | Anular y registrar de nuevo | Convertirlo por edición movería el saldo por el **doble** del monto |
| La caja ya no se usa | **Cerrar**, no eliminar | Eliminar solo se permite en una caja sin movimientos. Los gastos son el respaldo de plata que ya salió y el cliente los tiene rendidos |

Una caja **CERRADA** no acepta movimientos ni correcciones de ningún tipo. No se exige
saldo cero para cerrarla: ese saldo restante **es** el dato de la rendición, y obligar a
"cuadrar en cero" solo empuja a inventar un movimiento de ajuste.

### Revisión de lo que carga el cliente

El portal cliente puede **registrar gastos**, y es la única pantalla del portal que
escribe un importe. Convive con la regla de `cliente.module.ts` ("nada que sea un monto")
porque el monto **no entra a contabilidad solo**:

1. El cliente carga el gasto con su boleta → nace **`POR_REVISAR`**.
2. Se ve en su estado de cuenta, pero **no descuenta** del saldo.
3. El estudio lo **aprueba** (recién ahí entra a la cadena de saldos) o lo **rechaza** con
   un motivo, que es lo único que le dice al cliente qué corregir.

Reglas del circuito:

- El cliente registra **solo EGRESOS**. Reponer el fondo es un ingreso y lo entrega el
  estudio o el dueño: si el cliente pudiera cargarlo, se auto-aumentaría el saldo
  disponible y la revisión no serviría de nada.
- El cliente **no puede aprobar**: la ruta no existe en su controller, y `revision` no
  está en su DTO (mandarlo da 400 por `forbidNonWhitelisted`).
- La **descripción es obligatoria** en el portal (opcional en la intranet): el estudio
  revisa el gasto sin haber estado ahí, y "S/ 45.00" sin contexto no se puede aprobar ni
  rechazar con criterio.
- Un movimiento `POR_REVISAR` **no se edita ni se anula** — se aprueba o se rechaza.
  Todavía no movió nada.
- Solo se revisa lo que está `POR_REVISAR`: volver a tocar algo aprobado movería el saldo
  dos veces, y lo rechazado el cliente tiene que cargarlo de nuevo.
- Lo que espera revisión se muestra **aparte del saldo** (`total_por_revisar`) y en un
  aviso arriba de la pantalla, en los dos lados. Un gasto que "no aparece" en el saldo se
  vuelve a cargar dos y tres veces.

### Conceptos

Catálogo **global** (no por empresa): "movilidad" significa lo mismo para las 171.
Cada concepto es de `GASTO`, `INGRESO` o `AMBOS`, y el service valida que sirva para el
tipo de movimiento. Sin esa validación se guardan gastos etiquetados como reposiciones y
el reporte por concepto deja de significar algo.

El concepto es **opcional**: obligarlo frena la carga en el caso real (alguien apurado
registrando el taxi) y el dato importante es el monto con su comprobante.

### Comprobantes

Van a `storage-privado/caja-comprobantes` y se sirven por endpoint con guard, **nunca**
desde `uploads/`: una boleta trae RUC, razón social y montos de un cliente del estudio, y
`uploads/` es estático y sin login.

La carga es en **dos pasos** (subir archivo → guardar movimiento) para que los datos del
movimiento pasen por un DTO validado de verdad: en `multipart/form-data` todo llega como
string y `@IsNumber()`/`@IsDateString()` dejarían de servir.

# Desplegar al hosting — backend e intranet

Todo va por SSH con el alias `barba`. Ni FileZilla ni el gestor de archivos de
cPanel hacen falta.

> Este archivo cubre **los dos proyectos** aunque viva en el repo del backend:
> `erp-backend` y `erp-frontend` son repos git separados y la carpeta que los
> contiene no es un repo, así que un documento en la raíz no se versionaría y no
> llegaría a otra PC.
>
> El **sitio público** no tiene deploy propio: vive dentro de `erp-frontend`
> (`src/app/web/`, rutas `/`, `/servicios`, `/nosotros`, `/contacto`) y sale en
> el mismo build. Existió un Angular aparte, `erp-web`, que se eliminó el
> 03/09/2026 tras migrar todo a `erp-frontend`.

---

## Backend (`erp-backend`)

```bash
cd erp-backend
npm run deploy      # compila, respalda, sube y reinicia
```

Después probar: login y el tablero de vencimientos.

```bash
npm run deploy:ok         # si quedó bien: borra el respaldo
npm run deploy:rollback   # si falló: vuelve al main.js anterior
```

| Comando | Qué hace |
|---|---|
| `npm run restart` | reinicia la API sin subir nada |
| `npm run logs` | errores en vivo (salir con Ctrl+C) |

**Sube un solo archivo.** Webpack empaqueta todo el backend en un `main.js` de
~1,6 MB que vive en la raíz de la app — en el servidor NO existe carpeta `dist/`.

---

## Intranet (`erp-frontend`)

```bash
cd erp-frontend
npm run deploy:preview   # muestra qué haría, SIN tocar nada
npm run deploy           # sube de verdad
```

Después abrir el sistema y recargar con **Ctrl+Shift+R**.

**Correr siempre el preview primero.** Es el único despliegue que borra archivos.

**Por qué borra**: Angular pone un hash en el nombre de cada chunk, así que cada
build genera archivos nuevos y los viejos quedan huérfanos. Subiendo por FTP nada
se borraría nunca: en el hosting hermano de Montero se llegó a **15.296 chunks y
946 MB** contra los ~200 archivos de un build limpio.

**Cómo funciona** (`tools/deploy.mjs`): empaqueta el build en un `.tgz`, lo sube
por `scp` a una carpeta temporal del servidor, y allí corre `rsync --delete`
contra la carpeta pública. El rsync corre **en el servidor** porque Windows no
trae rsync y el hosting sí.

⚠️ **Las exclusiones de `tools/deploy.mjs` no se tocan sin leer.** La carpeta
pública es la raíz del dominio y no contiene solo el intranet:

```
barba.difusioneslaborales.com/
├── index.html  chunk-*.js  styles-*.css  assets/  media/   <- intranet
├── api/                 <- la API del ERP               ⚠️ excluida
├── cgi-bin/             <- del hosting                  ⚠️ excluida
└── .well-known/         <- validación de dominio / SSL  ⚠️ excluida
```

Sin la exclusión de `/api`, `--delete` borra la API entera (incluido su `.env`).

`assets/` y `media/` **sí** salen del build (`src/assets` y las fuentes de
bootstrap-icons), por eso no están excluidas. Comprobado contra el servidor: no
hay ahí ni un archivo que no produzca el build.

El `.htaccess` de la raíz también viaja en el build (`src/.htaccess`). Es el que
hace dos cosas imprescindibles: que `/api` **no** se lo coma el fallback de
Angular, y que `index.html` nunca quede cacheado en el navegador. El deploy
aborta si el build no lo generó.

Si algo sale mal no hay rollback automático: se compila el commit anterior y se
vuelve a desplegar.

---

## Setup en una PC nueva (una sola vez)

Los dos `deploy` usan el alias SSH `barba`, que **no viaja con git** (apunta a una
llave privada). Sin este paso fallan con `Could not resolve hostname barba`.

**1. Generar una llave para esta PC**

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -C "nombre-de-esta-pc"
cat ~/.ssh/id_ed25519.pub
```

**2. Autorizarla en cPanel**

`SSH Access` → `Manage SSH Keys` → `Import Key`:

- Name: un nombre que identifique la PC
- Private key: **vacío**
- Passphrase: **vacío**
- Public key: pegar la salida del `cat` de arriba, en una sola línea

Guardar, y después `Manage` → **Authorize**. Sin autorizar no funciona.

**3. Crear el alias** en `~/.ssh/config`

Desde Git Bash, sin importar cómo se llame el usuario de Windows de esa PC:

```bash
mkdir -p ~/.ssh
nano ~/.ssh/config
```

Pegar tal cual, **sin cambiar nada**:

```
Host barba
    HostName barba.difusioneslaborales.com
    User difusion
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 60
```

> Ojo con los dos usuarios distintos que aparecen acá: la **ruta** del archivo
> depende del usuario de **Windows** de cada PC (y `~` lo resuelve solo), mientras
> que el `User difusion` de adentro es el usuario del **hosting** y es siempre el
> mismo en todas las máquinas.

**4. Probar**

```bash
ssh barba "hostname && node -v"
```

La primera vez pregunta por la huella del servidor: responder `yes`.

---

## Cómo está montado el servidor

```
/home/difusion/barba.difusioneslaborales.com/
├── index.html  chunk-*.js  assets/  media/  .htaccess   <- intranet (raíz del dominio)
└── api/
    ├── main.js          <- esto reemplaza el deploy del backend
    ├── package.json  package-lock.json  node_modules/
    ├── .htaccess        <- monta la app: sin el bloque Passenger de acá, /api no
    │                       existe para el servidor. Ver "Si /api devuelve 404".
    ├── tmp/             <- touch tmp/restart.txt reinicia (= botón Restart de cPanel)
    ├── stderr.log       <- acá salen los errores
    └── storage-privado/  logs/  uploads/   <- archivos de clientes, no se tocan
```

Esta disposición **no es un accidente**: cPanel monta cada app Node en la URI que
se le indica (`Application URL = barba.difusioneslaborales.com/api`), y los otros
proyectos del hosting están organizados igual. Mover la API fuera de la carpeta
pública obliga a reconfigurar cPanel y a reinstalar dependencias — `node_modules`
es un **symlink** a `~/nodevenv/<ruta-de-la-app>/24/lib/node_modules`, y esa ruta
espeja la de la app.

### ⚠️ Es una cuenta de cPanel compartida

El mismo usuario `difusion` aloja también `app.transportesmontero.com`, `tirno.`,
`yunta.`, `dentaonepiece.` y varios más. Un `rm -rf` o un `rsync` mal apuntado por
SSH alcanza a todos. Por eso cada proyecto tiene un guard que compara el `name`
del `package.json` y aborta si no coincide, imprimiendo siempre el destino antes
de tocar nada:

- backend: `scripts/deploy-guard.js` (`PROYECTO_ESPERADO`, `DESTINO`)
- intranet: `tools/deploy.mjs` (`PROYECTO_ESPERADO`, `HOST`, `REMOTO`, `EXCLUIR`)

Si copias este proyecto como base para otro cliente, hay que ajustar **esos
archivos** y los scripts de `package.json`.

---

## Configurar la app Node en cPanel (una sola vez)

`Setup Node.js App` → `CREATE APPLICATION`, con exactamente estos valores:

| Campo | Valor |
|---|---|
| Node.js version | `24.20.0` |
| Application mode | `Production` |
| Application root | `barba.difusioneslaborales.com/api` |
| Application URL | `barba.difusioneslaborales.com` + `api` |
| Application startup file | `main.js` |

**La URL tiene que terminar en `/api`, no en `/`.** `environment.ts` del intranet
apunta a `https://barba.difusioneslaborales.com/api`, y si la app se monta en la
raíz Passenger se queda con el dominio entero y el intranet deja de servirse.

Después de crear la app, subir a mano **una sola vez** (el deploy diario no los
manda):

```bash
scp package.json package-lock.json barba:~/barba.difusioneslaborales.com/api/
```

### Variables de entorno

En producción **no hay archivo `.env`**. Se cargan desde la sección
*Environment variables* de la misma pantalla de Node.js App: cPanel las escribe
como `SetEnv` dentro de `api/.htaccess` y Passenger se las pasa al proceso.
`ConfigModule` las lee igual que leería un `.env`.

> Por eso `api/` está excluida del deploy del intranet: ese `.htaccess` tiene las
> contraseñas de producción y lo genera cPanel, no el repo.

| Variable | Valor en producción | Notas |
|---|---|---|
| `API_PREFIX` | `api` | tiene que coincidir con el `PassengerBaseURI` |
| `DB_HOST` | `127.0.0.1` | |
| `DB_PORT` | `3306` | |
| `DB_USER` | `difusion_barba` | |
| `DB_PASSWORD` | la del usuario de cPanel | el nombre es `DB_PASSWORD`, no `DB_PASS` |
| `DB_DATABASE` | `difusion_barba` | |
| `JWT_SECRET` | uno nuevo, largo y aleatorio | |
| `JWT_EXPIRES_IN` | `8h` | |
| `REFRESH_TOKEN_EXPIRES_DAYS` | `30` | opcional, el código ya usa 30 por defecto |
| `FRONTEND_URL` | `https://barba.difusioneslaborales.com` | **con `https://`** — es la base de los enlaces de los correos |
| `CREDENCIALES_ENCRYPTION_KEY` | 32 bytes en base64 | **sin ésta la API no arranca**, ver abajo |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | los del correo del estudio | sin ellas no salen correos |
| `PORT` | **no ponerla** | Passenger asigna el puerto |
| `NODE_ENV` | **no ponerla** | la pone el `Application mode = Production` |
| `ENABLE_SUNAT_SYNC_CRON` | **no ponerla** | ausente = apagado, que es lo que queremos (ver playwright, más abajo) |

⚠️ `CREDENCIALES_ENCRYPTION_KEY` no es opcional:
[credenciales-crypto.service.ts:17](libs/security/src/credenciales-crypto.service.ts#L17)
lanza en `onModuleInit()` si falta o si no decodifica a exactamente 32 bytes, y
eso tumba el arranque de Nest entero — la API no levanta, no es que falle un
módulo suelto.

Y **no se cambia a la ligera**: cifra las Claves SOL guardadas en la tabla de
credenciales SUNAT. Si esa tabla ya tiene filas, generar una llave nueva las deja
indescifrables y hay que volver a cargarlas todas a mano. Generar una nueva solo
si la tabla está vacía:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Por último, botón **Run NPM Install**.

---

## Cuando cambian las dependencias del backend

`npm run deploy` sube **solo** `main.js`. Si tocaste `package.json`:

1. Subir también `package.json` y `package-lock.json`
2. Correr **"Run NPM Install"** desde la pantalla de Node.js App de cPanel

Usar ese botón y **no** `npm install` por SSH: la consola SSH usa el Node del
sistema (v22), mientras que la app corre en el Node del entorno de cPanel (v24).
Instalar con el Node equivocado deja `bcrypt` —el único módulo nativo del
proyecto— compilado contra la versión errada, y el login falla con
`NODE_MODULE_VERSION`. La app arranca igual, así que el error solo aparece al
intentar iniciar sesión.

**Nunca subir `node_modules`** desde Windows por la misma razón.

### `playwright` no funciona en este hosting

Está en `dependencies` y lo usan los clientes de scraping de SUNAT y SUNAFIL
(`sunat-buzon.client.ts`, `sunat-scraping.client.ts`,
`sunat-tregistro-scraping.client.ts`, `sunat-login.client.ts`). Un hosting
compartido no tiene binario de Chromium ni permite instalarlo, así que
`chromium.launch()` falla en producción.

Hoy no rompe nada porque el cron está apagado (`ENABLE_SUNAT_SYNC_CRON=false`) y
esas rutas se disparan a mano. Antes de encender el cron hay que resolverlo: o
esas tareas corren desde una PC/VPS, o se reemplaza el scraping por la API de
SIRE. `npm install` sí funciona: el paquete instala, lo que falta es el navegador.

---

## Si `/api` devuelve 404

Lo primero es mirar **qué tipo de 404** es, porque eso solo ya dice dónde está el
problema:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  -X POST https://barba.difusioneslaborales.com/api/auth/login \
  -H "Content-Type: application/json" -d "{}"
```

| Respuesta | Qué significa |
|---|---|
| `400 application/json` | **Está todo bien.** Es Nest validando el body vacío: la API responde. |
| `404 text/html` | Passenger no está montado. La petición nunca llegó a Node, la contesta LiteSpeed. |
| `404 application/json` | Sí llegó a Nest, pero la ruta no existe. Revisar `API_PREFIX` contra el `setGlobalPrefix`. |

Otra señal de lo mismo: si `https://barba.difusioneslaborales.com/api/main.js`
**se descarga** (200, ~1,9 MB), el servidor está tratando `api/` como una carpeta
de archivos estáticos, que es justo lo que hace cuando la app no está montada.

### Reponer el bloque de Passenger

El `.htaccess` de `api/` es lo que le dice al servidor que esa URI es una app Node.
Usar la interfaz de *Setup Node.js App* puede dejarlo **vacío (0 bytes)**, y a
partir de ahí ni *Restart* ni *Save* lo regeneran. Ojo con esto al diagnosticar:
`cloudlinux-selector restart` devuelve `{"result": "success"}` con el sitio caído,
porque el proceso Node arranca perfecto — lo que falta es el enrutamiento hacia él.

Cuando pasa, hay que escribirlo a mano. Son estas seis líneas y nada más:

```apache
# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION BEGIN
PassengerAppRoot "/home/difusion/barba.difusioneslaborales.com/api"
PassengerBaseURI "/api"
PassengerNodejs "/home/difusion/nodevenv/barba.difusioneslaborales.com/api/24/bin/node"
PassengerAppType node
PassengerStartupFile main.js
# DO NOT REMOVE. CLOUDLINUX PASSENGER CONFIGURATION END
```

**Las variables de entorno no hacen falta en este archivo.** cPanel a veces las
escribe ahí como `SetEnv`, pero la app anda igual sin ellas: se las pasa el selector
de CloudLinux desde su propia configuración. Los valores de producción se siguen
editando en *Setup Node.js App* → *Environment variables*.

Para verificar:

```bash
ssh barba "grep -c Passenger ~/barba.difusioneslaborales.com/api/.htaccess"
```

Tiene que devolver `5`. Si devuelve `0`, el bloque no está.

Si hubiera que rearmarlo desde cero, los otros proyectos del hosting sirven de
molde: `app.transportesmontero.com/montero-api/.htaccess` tiene el mismo bloque con
sus propias rutas.

⚠️ Escribir ese archivo desde Windows **con saltos de línea LF**. Un `\r` al final
de una línea `SetEnv` entra dentro del valor y deja, por ejemplo, una contraseña de
base de datos que no coincide con ninguna.

**Lo que NO es**: el `.htaccess` de la raíz del dominio (el que sube el intranet)
no tiene nada que ver. Su regla sobre `/api` es un `RewriteRule ^ - [L]`, o sea
"dejá pasar esto sin tocarlo", y es correcta. Si esa regla fuera el problema,
`/api/main.js` devolvería el `index.html` de Angular en vez del archivo real.

### El código del backend queda descargable

Passenger sirve los archivos que existan en la carpeta antes de pasarle la petición
a la app, así que `main.js` y `package.json` se bajan por HTTP desde internet. Las
contraseñas no se exponen —`.htaccess` da 403 y los `.log` 404— pero el código
compilado sí. Se cierra agregando al mismo `.htaccess`:

```apache
<FilesMatch "^(main\.js|package(-lock)?\.json)$">
  Require all denied
</FilesMatch>
```

No interfiere con la app: Passenger lee `main.js` del disco, no por HTTP.

---

## Sitio público

No tiene deploy propio: vive dentro de `erp-frontend` (`src/app/web/`) y se sube
con `npm run deploy` de ese proyecto, como cualquier otra ruta. Las páginas son
`/`, `/servicios`, `/nosotros` y `/contacto`, declaradas en `app.routes.ts`.

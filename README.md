# opencode-batch-commands

Plugin para **OpenCode 2** que agrega el tool `batch`: ejecuta varios comandos
shell **en paralelo** y devuelve un **resumen compacto** en vez de todos los
outputs completos. Pensado para correr tests, greps o builds independientes en
un solo paso sin inflar el contexto del modelo.

[![tests](https://github.com/joacomedel/opencode-batch-commands/actions/workflows/test.yml/badge.svg)](https://github.com/joacomedel/opencode-batch-commands/actions/workflows/test.yml)

## Características

- **Paralelismo con pool**: hasta N comandos a la vez (default 8), configurable por llamada.
- **Timeout por comando**: default 120000 ms; al vencer, se mata el **grupo de procesos completo** (hijos y nietos, sin huérfanos).
- **Salida compacta**: stdout/stderr se truncan con recorte head+tail (default 4000 chars por stream).
- **Truncado opcional con límite de seguridad**: con `truncate: false` el agente pide los outputs completos; si un comando supera 64 KB (stdout+stderr), se recorta con head+tail y se deriva igual al spill.
- **Override por comando**: `timeout`, `max_output` y `truncate` se pueden pisar por comando, además de por llamada.
- **Memoria acotada**: cada stream guarda hasta 1 MB en RAM; si se pasa, el resto se derrama en vivo a un archivo temporal (un output de GBs no revienta el proceso).
- **Spill a archivo**: si hubo truncado, el output completo se guarda en `/tmp/opencode/batch/` y el resumen informa la ruta, el tamaño y las líneas; los spills viejos se limpian al cargar el plugin y en cada uso.
- **Progreso en vivo**: reporta `x/N comandos completados` mientras corre.
- **Defaults por options**: `concurrency`, `max_output`, `timeout`, `truncate` y `spill_ttl_ms` configurables desde `opencode.jsonc`.
- **Sin dependencias**: un solo archivo JS, no importa `@opencode/plugin`; se copia y funciona.

## Requisitos

- OpenCode 2
- Node 20 o superior (el que ya usa OpenCode)

## Instalación

### Global (todos tus proyectos)

```bash
mkdir -p ~/.config/opencode/plugins
cp src/batch.js ~/.config/opencode/plugins/batch.js
```

### Por proyecto

```bash
mkdir -p .opencode/plugins
cp ruta/al/repo/src/batch.js .opencode/plugins/batch.js
```

OpenCode carga automáticamente los plugins que están en `.opencode/plugins/`
(proyecto) y en `~/.config/opencode/plugins/` (global). No hace falta
registrarlo en `opencode.jsonc`.

### Traerlo a otra máquina

```bash
git clone https://github.com/joacomedel/opencode-batch-commands.git
mkdir -p ~/.config/opencode/plugins
cp opencode-batch-commands/src/batch.js ~/.config/opencode/plugins/
```

Listo: no hay que instalar nada más (el plugin no tiene dependencias).

## Uso

El modelo llama al tool `batch` solo, o vos lo pedís desde el prompt:

```text
Corré en paralelo "npm test" y "npm run lint" y dame el resumen de ambos.
```

### Parámetros

El tool devuelve un **único string de texto** con el resumen (no es un array).

| Parámetro     | Tipo       | Default       | Descripción                                                        |
| ------------- | ---------- | ------------- | ------------------------------------------------------------------ |
| `commands`    | `array`    | —             | Lista de comandos (requerido). Cada uno acepta `command`, `workdir`, `timeout`, `max_output` y `truncate`; los tres últimos pisan los defaults de la llamada. |
| `concurrency` | `number`   | `8` (options) | Cuántos comandos correr a la vez.                                  |
| `max_output`  | `number`   | `4000` (options) | Cuántos caracteres conservar por stdout/stderr. Con `truncate: false` solo aplica al recorte por límite de seguridad. |
| `truncate`    | `boolean`  | `true` (options) | `false` devuelve stdout/stderr completos, salvo que un comando supere el límite de seguridad (64 KB), en cuyo caso se recorta y deriva igual. |

Los valores marcados como `(options)` son los defaults; se pueden cambiar por
configuración (ver Configuración por options) o pisar en cada llamada.

### Ejemplo de llamada

```json
{
  "commands": [
    { "command": "npm test" },
    { "command": "npm run lint", "workdir": "packages/api" },
    { "command": "git status --short", "timeout": 15000 }
  ],
  "concurrency": 4,
  "max_output": 4000
}
```

### Truncado: elegir por llamada o por comando

- **`truncate: true` (default)**: ideal para uso general. Si un output supera
  `max_output`, se muestra el inicio y el final, y el resumen indica dónde está
  el archivo con todo (por ejemplo
  `[output completo (1.2 MB, 8400 líneas): /tmp/opencode/batch/....log]`). Con
  `grep` o una lectura parcial del archivo alcanza para encontrar el dato
  puntual, sin volver a ejecutar el comando.
- **`truncate: false`**: el agente lo pide cuando necesita el detalle entero
  inline (por ejemplo, va a analizar todo el output). Tiene un límite de
  seguridad: si un comando (stdout+stderr) supera 64 KB, se muestra inicio y
  final igual que en `truncate: true` y el output completo queda en el spill.
  Así un output de MBs no infla el contexto por accidente; usalo con criterio.

Los mismos campos (`truncate`, `max_output` y `timeout`) se pueden pasar dentro
de cada comando para pisar lo de la llamada, por ejemplo: correr `npm test`
truncado a 2000 chars y `git log` completo.

### Configuración por options

Cuando el plugin se carga desde `opencode.jsonc` (como paquete o directorio),
podés fijar defaults:

```jsonc
{
  "plugins": [
    {
      "package": "ruta/al/plugin",
      "options": {
        "concurrency": 4,
        "max_output": 8000,
        "timeout": 300000,
        "truncate": true,
        "spill_ttl_ms": 43200000
      }
    }
  ]
}
```

Cualquier valor de la llamada pisa estos defaults.

### Formato del resumen

```text
BATCH: 2 comandos, 1 ok, 1 con error

$ npm test
exit 1 en 5321ms
--- stderr ---
...(inicio y final del error)...

$ npm run lint
exit 0 en 2104ms
--- stdout ---
...(inicio y final del output)...
```

## Cómo funciona

- `setup(ctx)` registra el tool con `ctx.tool.transform()` (API de plugins V2)
  y lee los defaults de `ctx.options`.
- Cada comando corre con `spawn(..., { shell: true, detached: true })` y
  captura stdout/stderr con memoria acotada; al timeout se mata el grupo de
  procesos completo (`SIGKILL` a `-pid`).
- Un pool de workers limita la concurrencia (los resultados salen en el orden
  de entrada, no en el orden de finalización) y reporta `x/N` por
  `context.progress`.
- Si un stream supera 1 MB, el resto se derrama a un archivo temporal; de ahí
  sale el spill final (header + stdout + stderr) en
  `/tmp/opencode/batch/<fecha>-<n>-<slug>-<rand>.log`. `pruneSpill()` borra los
  archivos más viejos que `spill_ttl_ms` (default 24 h) cada vez que se usa el
  tool y también al arrancar el plugin.

## Desarrollo

```bash
git clone https://github.com/joacomedel/opencode-batch-commands.git
cd opencode-batch-commands
npm test
```

Los tests usan el runner nativo de Node (`node --test`), no requieren
dependencias ni OpenCode corriendo: simulan el contexto del plugin y ejecutan
comandos reales (`echo`, `exit`, etc.).

Estructura:

```text
src/batch.js        # el plugin completo (un solo archivo)
test/batch.test.js  # tests del resumen, errores, truncado, límite de seguridad y limpieza
```

Para probarlo a mano en OpenCode, copiá `src/batch.js` a tu carpeta de plugins
(global o del proyecto) y pedile al agente que corra algo con `batch`.

## Contribuir

Se aceptan forks y PRs. Antes de mandar cambios:

1. Corré `npm test` y verificá que pasa.
2. Mantené el plugin **sin dependencias** y en **un solo archivo** (así se puede
   copiar a mano a cualquier config).
3. Respetá la API de plugins de OpenCode 2
   ([docs](https://opencode.ai/v2/docs/build/plugins)).

Algunas ideas si querés extenderlo: cancelación de comandos en curso, salida en
streaming, buffer configurable, o una UI de progreso más rica.

## Licencia

[MIT](LICENSE). Copyright (c) 2026 joacomedel.

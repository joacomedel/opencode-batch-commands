# opencode-batch-commands

Plugin para **OpenCode 2** que agrega el tool `batch`: ejecuta varios comandos
shell **en paralelo** y devuelve un **resumen compacto** en vez de todos los
outputs completos. Pensado para correr tests, greps o builds independientes en
un solo paso sin inflar el contexto del modelo.

[![tests](https://github.com/joacomedel/opencode-batch-commands/actions/workflows/test.yml/badge.svg)](https://github.com/joacomedel/opencode-batch-commands/actions/workflows/test.yml)

## Características

- **Paralelismo con pool**: hasta N comandos a la vez (default 8), configurable por llamada.
- **Timeout por comando**: default 120000 ms; al vencer, el proceso se mata con SIGKILL.
- **Salida compacta**: stdout/stderr se truncan con recorte head+tail (default 4000 chars por stream).
- **Truncado opcional**: con `truncate: false` el agente pide los outputs completos sin recortar.
- **Spill a archivo**: si hubo truncado, el output completo se guarda en `/tmp/opencode/batch/` y el resumen informa la ruta, el tamaño y las líneas (los logs de más de 24 h se limpian solos al usar el tool).
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

| Parámetro     | Tipo       | Default  | Descripción                                                        |
| ------------- | ---------- | -------- | ------------------------------------------------------------------ |
| `commands`    | `array`    | —        | Lista de comandos (requerido). Cada uno acepta `command` (string), `workdir` (string) y `timeout` (number, ms). |
| `concurrency` | `number`   | `8`      | Cuántos comandos correr a la vez.                                  |
| `max_output`  | `number`   | `4000`   | Cuántos caracteres conservar por stdout/stderr. Se ignora si `truncate` es `false`. |
| `truncate`    | `boolean`  | `true`   | `false` devuelve stdout/stderr completos sin recortar ni derivar a archivo. |

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

### Truncado: elegir por llamada

- **`truncate: true` (default)**: ideal para uso general. Si un output supera
  `max_output`, se muestra el inicio y el final, y el resumen indica dónde está
  el archivo con todo (por ejemplo
  `[output completo (1.2 MB, 8400 líneas): /tmp/opencode/batch/....log]`). Con
  `grep` o una lectura parcial del archivo alcanza para encontrar el dato
  puntual, sin volver a ejecutar el comando.
- **`truncate: false`**: el agente lo pide cuando necesita el detalle entero
  inline (por ejemplo, va a analizar todo el output). Ojo: outputs muy grandes
  consumen contexto; usalo con criterio.

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

- `setup(ctx)` registra el tool con `ctx.tool.transform()` (API de plugins V2).
- Cada comando corre con `spawn(..., { shell: true })` y captura stdout/stderr.
- Un pool de workers limita la concurrencia (los resultados salen en el orden
  de entrada, no en el orden de finalización).
- Al truncar, `spillResult()` escribe el output completo en
  `/tmp/opencode/batch/<fecha>-<n>-<slug>-<rand>.log`; `pruneSpill()` borra ahí
  los archivos de más de 24 h cada vez que se usa el tool.

## Benchmark

Hay un A/B medido entre este plugin y OpenCode pelado en
[`benchmark/`](benchmark/README.md): misma tarea, mismo modelo, 3 corridas por
condición, tokens y costo medidos con `opencode session export`.

| modelo | costo con plugin | costo sin plugin | chars de tools en contexto |
| ------ | ---------------- | ---------------- | -------------------------- |
| DeepSeek V4.1 Flash | $0,00150 | $0,00235 | −64% |
| LongCat 2.5 Preview Free | $0 | $0 | +36% de contexto (el modelo no supo usar el retorno) |

Con un modelo que maneja bien el retorno (un string, no un array), el plugin
reduce el costo ~36% y el output de herramientas que entra al contexto ~64%.
El caso LongCat queda documentado como ejemplo de mal uso (y motivó el hint de
la descripción del tool).

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
test/batch.test.js  # tests del resumen, errores, truncado y truncate:false
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

Algunas ideas si querés extenderlo: truncado por comando en vez de por llamada,
cancelación de comandos en curso, salida en streaming, o retención configurable
del spill.

## Licencia

[MIT](LICENSE). Copyright (c) 2026 joacomedel.

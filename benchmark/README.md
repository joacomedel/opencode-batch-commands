# Benchmark: plugin `batch` vs OpenCode pelado

¿Consume más o menos tokens usar el plugin `batch` que usar OpenCode sin el
plugin? Este benchmark corre la **misma tarea, con el mismo modelo y el mismo
workspace**, N veces en cada condición, y mide los tokens de cada sesión.

- **Modelo**: `opencode-go/longcat-2.5-preview-free` (gratis, costo $0).
- **Condición `con`**: con el plugin `batch` cargado (el que está en
  `~/.config/opencode/plugins/batch.js`).
- **Condición `sin`**: plugin movido temporalmente fuera de la carpeta de
  plugins (el runner lo restaura al terminar, incluso si falla).
- **Tarea fija** (idéntica en ambas): correr `npm test`, `npm run lint`,
  `npm run typecheck` y `npm run build`, y reportar cuáles pasan y cuáles fallan.

## Método

1. El runner limpia el workspace (`git checkout` + `git clean`).
2. Corre `opencode run --standalone --auto --format json` con el prompt fijo.
   `--standalone` usa un server privado por corrida, así el estado del plugin
   es el del disco al arrancar (sin cachés del server compartido).
3. Guarda los logs (`--print-logs`) y verifica en ellos que el plugin `batch`
   se haya cargado (condición `con`) o no (condición `sin`).
4. Exporta la sesión con `opencode session export <id>` y extrae:
   - `input`: tokens de entrada no cacheados (suma de todos los pedidos).
   - `output` / `reasoning`: tokens de salida y de razonamiento.
   - `cache_read`: tokens de entrada leídos de caché.
   - `contexto.total` = `input` + `cache_read` + `cache_write` (todo lo que el
     modelo tuvo que procesar como entrada, cacheado o no).
   - `chars.tools`: caracteres de resultados de tools que entraron al contexto
     (suma de todos los `content` de tool results).
   - `batch` / `shell`: llamadas a `batch` y a `shell` (directas o dentro de
     Code Mode), y `batch_failed`: intentos de `batch` que fallaron.
5. Alterna condiciones (`con`, `sin`, `con`, `sin`, ...) para repartir efectos
   de caché y de momento de uso del modelo.

## Cómo correrlo

```bash
./runner/run-bench.sh              # 3 corridas por condición (default)
RUNS=5 ./runner/run-bench.sh       # 5 corridas por condición
MODEL=otro/modelo RUNS=1 ./runner/run-bench.sh
```

Los resultados de cada modelo se guardan en `results/<modelo>/` (no se pisan
entre corridas de modelos distintos).

Requiere: `opencode` V2 en el PATH, `git`, `jq` y `timeout`.

## Estructura

```text
workspace/           # proyecto de prueba (4 checks con output determinista)
runner/run-bench.sh  # orquestador del A/B
results/<modelo>/    # salidas crudas por modelo: runs JSON, logs, exports, summary.tsv
```

Cada check del workspace genera entre ~16 KB y ~40 KB de output (`lint` falla
a propósito para que haya un caso de error).

## Resultados — LongCat 2.5 Preview Free (2026-10-01)

**Con LongCat 2.5 Preview Free, OpenCode pelado consumió ~36% menos que la
variante con el plugin.** Los resultados fueron consistentes en las 3 corridas
de cada condición.

### Números por corrida

| condición | run | input | cache.read | contexto.total | output | reasoning | seg | steps |
| --------- | --- | ----- | ---------- | -------------- | ------ | --------- | --- | ----- |
| con       | 1   | 21179 | 22144      | 43323          | 621    | 339       | 29  | 3     |
| con       | 2   | 13060 | 30336      | 43396          | 645    | 378       | 38  | 3     |
| con       | 3   | 21181 | 22144      | 43325          | 625    | 303       | 29  | 3     |
| sin       | 1   | 18653 | 13312      | 31965          | 304    | 212       | 22  | 2     |
| sin       | 2   | 20355 | 11648      | 32003          | 309    | 203       | 24  | 2     |
| sin       | 3   | 12224 | 19712      | 31936          | 235    | 214       | 21  | 2     |

Promedios: **con = 43.348** tokens de contexto, **sin = 31.968**
(+11.380, +36%). Sumando salida y razonamiento: 44.318 vs 32.461 (+36,5%).

### Por qué pasó

En las 3 corridas "con", LongCat intentó usar `batch` desde Code Mode y su
propio código JavaScript falló siempre de la misma forma:

```js
const results = await tools.batch({ commands: [...] })
results.forEach(...) // TypeError: results.forEach is not a function
```

`batch` devuelve **un string** con el resumen, no un array. El modelo nunca
llegó a ver el resumen, quemó un round-trip extra y después re-corrió los
4 comandos con `shell` (sin `tail`). Ese paso de más es todo el delta: en
ambas condiciones entraron al contexto ~32k chars de resultados de tools.

Dato no menor: el tool `shell` built-in **ya trunca la salida** (cola, ~8k
chars) y deriva el output completo a
`~/.local/share/opencode/shell/<hash>/sh_*.out`. O sea, "pelado" ya es
bastante económico de fábrica.

### Conclusión

- Con este modelo, el plugin **salió más caro**: +11.380 tokens de contexto
  (+36%), +3 pasos en vez de 2, +10 s de latencia. La causa no es el plugin
  sino el uso incorrecto que hace el modelo de su retorno.
- El potencial del plugin (1 llamada en paralelo con resumen de 4k chars por
  comando, vs 4 llamadas con colas de ~8k chars) no se materializó acá. Un
  modelo que lo use bien debería dar vuelta el resultado (1 round-trip menos).
- Limitaciones: n=3, un solo modelo, una sola tarea. El modelo es gratis, así
  que el costo en dólares es $0 en ambas condiciones; se midió tokens
  procesados (input + cache.read + cache.write), que es lo que escala el
  contexto y la latencia.
- Los resultados crudos de cada corrida están en
  `results/<modelo>/` (`summary.tsv`, `run-*.json`, `logs-*.txt`,
  `export-*.json`). Hay un smoke test previo archivado en `results-smoke/`.

### Próximos pasos

1. ~~Repetir con un modelo más fuerte~~ → hecho: ver la sección de DeepSeek
   V4.1 Flash más abajo.
2. ~~Hint en la descripción del tool~~ → aplicado en `src/batch.js` (PR #1 del
   repo del plugin) y presente en la corrida de DeepSeek; falta re-medir
   LongCat con el hint para ver si le evita el error de `forEach`.
3. Probar una tarea con salidas gigantes (>50 KB por comando) donde el
   truncado propio del plugin (head+tail) marque más diferencia.

## Resultados — DeepSeek V4.1 Flash (2026-10-01)

El JavaScript **no se rompió**: en 3/3 corridas DeepSeek usó `batch`
correctamente (cero `TypeError`, `shell=0`, sin fallback). Además aprovechó las
opciones del tool: `concurrency: 4`, `max_output: 3000` y hasta
`truncate: false` para una verificación puntual con `tail`.

### Números por corrida

| condición | run | input | cache.read | contexto.total | output | reasoning | costo | seg | steps | batch | chars.tools |
| --------- | --- | ----- | ---------- | -------------- | ------ | --------- | ----- | --- | ----- | ----- | ----------- |
| con       | 1   | 13537 | 34432      | 47969          | 567    | 255       | $0,002627 | 15 | 4 | 2 | 8629 |
| con       | 2   | 3112  | 20736      | 23848          | 348    | 142       | $0,000823 | 10 | 2 | 1 | 8198 |
| con       | 3   | 3372  | 33920      | 37292          | 325    | 419       | $0,001054 | 12 | 3 | 2 | 8614 |
| sin       | 1   | 11121 | 11520      | 22641          | 390    | 130       | $0,002015 | 15 | 2 | 0 | 6144 |
| sin       | 2   | 11513 | 30976      | 42489          | 500    | 604       | $0,002482 | 13 | 3 | 0 | 32344 |
| sin       | 3   | 11486 | 30848      | 42334          | 618    | 627       | $0,002562 | 14 | 3 | 0 | 32193 |

Promedios:

- **Contexto total**: 36.370 (con) vs 35.821 (sin) → empate estadístico.
- **Costo**: **$0,00150 vs $0,00235 → con plugin ~36% más barato** (menos
  input no cacheado: 6.674 vs 11.373 tokens, y menos salida+razonamiento:
  685 vs 956).
- **chars de tools en contexto**: 8.480 vs 23.560 → **−64%**.

### Lectura

Con un modelo competente el plugin hace lo que promete: 1–2 llamadas `batch`
en vez de 4 `shell`, resúmenes chicos (−64% de chars de tools) y ningún
round-trip perdido. El contexto total queda parejo porque el modelo a veces
agrega pasos que re-envían contexto (cacheado, casi gratis); la diferencia
real se ve en lo facturable: input fresco y output, donde el plugin gana.

## Comparación entre modelos

| modelo | contexto con | contexto sin | costo con | costo sin | veredicto |
| ------ | ------------ | ------------ | --------- | --------- | --------- |
| LongCat 2.5 Preview Free | 43.348 | 31.968 | $0 | $0 | plugin peor (+36%), por mal uso del modelo |
| DeepSeek V4.1 Flash | 36.370 | 35.821 | $0,00150 | $0,00235 | plugin mejor: −36% de costo, −64% de chars de tools |

Moraleja: el resultado depende de que el modelo sepa manejar el retorno del
tool. LongCat (3/3) iteró el string como si fuera array; DeepSeek (3/3) lo usó
bien y rentabilizó el plugin. El hint del PR #1 apunta exactamente al problema
de LongCat.

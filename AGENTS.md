# AGENTS.md

Guía para agentes de IA que trabajen en este repo.

## Qué es

Plugin de OpenCode 2 (`src/batch.js`) que registra el tool `batch`: comandos
shell en paralelo con resumen compacto, truncado opcional y spill a archivo.
Referencia de la API: <https://opencode.ai/v2/docs/build/plugins>.

## Reglas del repo

- **Un solo archivo**: el plugin entero vive en `src/batch.js`, y debe poder
  copiarse solo (sin hermanos ni dependencias) a una carpeta de plugins.
- **Cero dependencias npm**: no importar `@opencode/plugin` ni paquetes
  externos; solo builtins de Node.
- **Probar antes de dar algo por listo**: `npm test` (runner nativo de Node,
  los tests simulan el ctx y ejecutan comandos reales).
- **Idioma**: comentarios, README y descripciones del tool en español.
- **Compatibilidad**: API de plugins V2; mantener el default `truncate: true`
  para no romper el comportamiento existente.

## Estructura

```text
src/batch.js        # plugin completo (default export con id + setup)
test/batch.test.js  # tests: resumen, errores, truncado, truncate:false
benchmark/          # A/B histórico del plugin vs OpenCode pelado (ver benchmark/README.md)
```

## Verificación rápida

```bash
npm test
```

Para probar contra OpenCode de verdad: copiar `src/batch.js` a
`~/.config/opencode/plugins/` o `.opencode/plugins/` y pedir una corrida con
`batch`.

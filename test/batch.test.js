import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/batch.js"

// Comando portable que genera 2000 caracteres "x" en stdout.
const LONG_OUTPUT = "head -c 2000 /dev/zero | tr '\\0' 'x'"

// Simula el ctx del plugin para capturar el tool registrado, sin OpenCode.
async function loadTool() {
  let tool
  const ctx = {
    tool: {
      transform: async (callback) => {
        callback({
          add: (definition) => {
            tool = definition
          },
        })
        return { dispose: async () => {} }
      },
    },
  }
  await plugin.setup(ctx)
  assert.ok(tool, "el plugin debe registrar un tool")
  assert.equal(tool.name, "batch")
  return tool
}

test("corre varios comandos en paralelo y devuelve un resumen", async () => {
  const tool = await loadTool()
  const { content } = await tool.execute(
    { commands: [{ command: "echo uno" }, { command: "echo dos" }] },
    {},
  )
  assert.equal(typeof content, "string")
  assert.match(content, /BATCH: 2 comandos, 2 ok, 0 con error/)
  assert.match(content, /\$ echo uno/)
  assert.match(content, /\$ echo dos/)
  assert.match(content, /--- stdout ---\nuno/)
  assert.match(content, /--- stdout ---\ndos/)
})

test("reporta comandos con error y su exit code", async () => {
  const tool = await loadTool()
  const { content } = await tool.execute({ commands: [{ command: "exit 3" }] }, {})
  assert.match(content, /BATCH: 1 comandos, 0 ok, 1 con error/)
  assert.match(content, /exit 3 en \d+ms/)
})

test("sin comandos no ejecuta nada", async () => {
  const tool = await loadTool()
  const { content } = await tool.execute({ commands: [] }, {})
  assert.match(content, /no se recibieron comandos/)
})

test("por defecto trunca y deriva el output completo a un archivo", async () => {
  const tool = await loadTool()
  const { content } = await tool.execute(
    { commands: [{ command: LONG_OUTPUT }], max_output: 40 },
    {},
  )
  assert.match(content, /\[recortado \d+ chars\]/)

  const match = content.match(/\[output completo \([^)]*\): ([^\]]+)\]/)
  assert.ok(match, "debe informar la ruta del output completo")
  const spillPath = match[1]
  assert.ok(existsSync(spillPath), `el archivo de spill debe existir: ${spillPath}`)
  assert.ok(
    spillPath.startsWith(join(tmpdir(), "opencode", "batch")),
    `el spill debe vivir en el directorio esperado: ${spillPath}`,
  )
  unlinkSync(spillPath)
})

test("truncate:false devuelve el output completo sin recortar ni derivar", async () => {
  const tool = await loadTool()
  const { content } = await tool.execute(
    { commands: [{ command: LONG_OUTPUT }], max_output: 40, truncate: false },
    {},
  )
  assert.doesNotMatch(content, /recortado/)
  assert.doesNotMatch(content, /output completo/)
  assert.ok(content.includes("x".repeat(2000)), "debe incluir los 2000 chars de stdout")
})

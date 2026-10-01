import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// TMPDIR nuevo antes de importar el plugin: asi el directorio de spill lo
// crea el plugin desde cero y se pueden verificar sus permisos.
const REAL_TMP = tmpdir()
const BASE = mkdtempSync(join(REAL_TMP, "batch-perms-test-"))
process.env.TMPDIR = BASE

const { default: plugin } = await import("../src/batch.js")

const LONG_OUTPUT = "head -c 2000 /dev/zero | tr '\\0' 'x'"

async function loadTool() {
  let tool
  const ctx = {
    options: undefined,
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
  return tool
}

test("el directorio y los archivos de spill se crean con permisos privados", async () => {
  const tool = await loadTool()
  const { content } = await tool.execute(
    { commands: [{ command: LONG_OUTPUT }], max_output: 40 },
    {},
  )
  const spillPath = content.match(/\[output completo \([^)]*\): ([^\]]+)\]/)?.[1]
  assert.ok(spillPath, "debe derivar el output completo")
  assert.equal(
    statSync(join(BASE, "opencode")).mode & 0o777,
    0o700,
    "el directorio opencode debe ser 0700",
  )
  assert.equal(
    statSync(join(BASE, "opencode", "batch")).mode & 0o777,
    0o700,
    "el directorio batch debe ser 0700",
  )
  assert.equal(statSync(spillPath).mode & 0o777, 0o600, "el spill debe ser 0600")
})

after(() => {
  rmSync(BASE, { recursive: true, force: true })
})

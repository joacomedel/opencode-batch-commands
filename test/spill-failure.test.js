import { test, after } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Estos tests rompen a proposito el derrame a archivo. Se aisla TMPDIR antes
// de importar el plugin para no tocar el /tmp/opencode/batch real.
const REAL_TMP = tmpdir()
const BASE = mkdtempSync(join(REAL_TMP, "batch-spill-test-"))
process.env.TMPDIR = BASE

const { default: plugin } = await import("../src/batch.js")

const HUGE_OUTPUT = "head -c 2000000 /dev/zero | tr '\\0' 'y'"

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

test("si el mkdir del spill falla, el resumen avisa y conserva lo retenido", async () => {
  // $BASE/opencode como ARCHIVO: mkdir($BASE/opencode/batch) falla (ENOTDIR).
  writeFileSync(join(BASE, "opencode"), "bloqueo")
  const tool = await loadTool()
  const { content } = await tool.execute(
    { commands: [{ command: HUGE_OUTPUT }], max_output: 200 },
    {},
  )
  assert.doesNotMatch(content, /\(sin output\)/, "no debe reportar output vacio")
  assert.match(
    content,
    /output completo (no disponible|puede estar incompleto)/,
    "debe avisar que el derrame fallo",
  )
  assert.match(content, /y{50}/, "debe conservar parte del output retenido")
})

test(
  "si el open del .tmp falla async, no crashea y el resumen avisa",
  { skip: typeof process.getuid === "function" ? process.getuid() === 0 : false },
  async () => {
    rmSync(join(BASE, "opencode"), { force: true })
    const batchDir = join(BASE, "opencode", "batch")
    mkdirSync(batchDir, { recursive: true })
    chmodSync(batchDir, 0o500)
    const tool = await loadTool()
    const { content } = await tool.execute(
      { commands: [{ command: HUGE_OUTPUT }], max_output: 200 },
      {},
    )
    assert.doesNotMatch(content, /\(sin output\)/, "no debe reportar output vacio")
    assert.match(content, /output completo (no disponible|puede estar incompleto)/)
    assert.match(content, /y{50}/, "debe conservar parte del output retenido")
  },
)

after(() => {
  try {
    chmodSync(join(BASE, "opencode", "batch"), 0o700)
  } catch {}
  rmSync(BASE, { recursive: true, force: true })
})

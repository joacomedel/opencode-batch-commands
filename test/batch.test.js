import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, statSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/batch.js"

// Comandos portables que generan output determinista.
const LONG_OUTPUT = "head -c 2000 /dev/zero | tr '\\0' 'x'"
const HUGE_OUTPUT = "head -c 2000000 /dev/zero | tr '\\0' 'y'"
const BIG_OUTPUT = "head -c 100000 /dev/zero | tr '\\0' 'z'"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Simula el ctx del plugin para capturar el tool registrado, sin OpenCode.
async function loadTool(options) {
  let tool
  const ctx = {
    options,
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

function spillPathFrom(content) {
  const match = content.match(/\[output completo \([^)]*\): ([^\]]+)\]/)
  return match ? match[1] : null
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

  const spillPath = spillPathFrom(content)
  assert.ok(spillPath, "debe informar la ruta del output completo")
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

test("truncate:false con output gigante aplica el limite de seguridad y deriva a spill", async () => {
  const tool = await loadTool()
  const { content } = await tool.execute(
    { commands: [{ command: BIG_OUTPUT }], truncate: false },
    {},
  )
  assert.match(content, /límite de seguridad/)
  assert.match(content, /\[recortado \d+ chars\]/)
  assert.equal(
    content.includes("z".repeat(100_000)),
    false,
    "no debe entrar el output completo al resumen",
  )

  const spillPath = spillPathFrom(content)
  assert.ok(spillPath, "debe informar la ruta del output completo")
  assert.ok(statSync(spillPath).size > 90_000, "el spill debe tener el output completo (~100 KB)")
  const full = readFileSync(spillPath, "utf8")
  assert.ok(full.trimEnd().endsWith("z"), "el spill debe conservar el final del output")
  unlinkSync(spillPath)
})

test("max_output y truncate se pueden pisar por comando", async () => {
  const tool = await loadTool()
  const { content } = await tool.execute(
    {
      commands: [
        { command: LONG_OUTPUT, truncate: true, max_output: 50 },
        { command: LONG_OUTPUT },
      ],
      truncate: false,
    },
    {},
  )
  assert.match(content, /\[recortado \d+ chars\]/, "el primer comando debe truncarse")
  assert.ok(content.includes("x".repeat(2000)), "el segundo comando debe venir completo")
  const spillPath = spillPathFrom(content)
  if (spillPath) unlinkSync(spillPath)
})

test("los defaults se configuran por options del plugin", async () => {
  const tool = await loadTool({ max_output: 60, truncate: true, timeout: 5000 })
  const { content } = await tool.execute({ commands: [{ command: LONG_OUTPUT }] }, {})
  assert.match(content, /\[recortado \d+ chars\]/, "debe aplicar el max_output de options")
  assert.ok(content.length < 4000)
  const spillPath = spillPathFrom(content)
  assert.ok(spillPath, "debe derivar el output completo")
  unlinkSync(spillPath)
})

test("reporta progreso mientras corre", async () => {
  const tool = await loadTool()
  const progresos = []
  await tool.execute(
    { commands: [{ command: "echo a" }, { command: "echo b" }] },
    { progress: async (event) => progresos.push(event.status) },
  )
  assert.equal(progresos[0], "corriendo 2 comandos")
  assert.ok(
    progresos.some((status) => /2\/2 comandos completados/.test(status)),
    `debe reportar comandos completados: ${progresos.join(" | ")}`,
  )
})

test("al timeout mata tambien los procesos nietos", async () => {
  const tool = await loadTool()
  const { content } = await tool.execute(
    { commands: [{ command: "sh -c 'sleep 30 & echo NIETO=$!; wait'", timeout: 700 }] },
    {},
  )
  assert.match(content, /timeout 700ms/)
  const match = content.match(/NIETO=(\d+)/)
  assert.ok(match, "debe imprimir el pid del proceso nieto")
  const pid = Number(match[1])

  let vivo = true
  for (let i = 0; i < 15 && vivo; i++) {
    await sleep(100)
    try {
      process.kill(pid, 0)
    } catch {
      vivo = false
    }
  }
  assert.equal(vivo, false, `el proceso nieto ${pid} deberia haber muerto con el timeout`)
})

test("outputs gigantes se derraman a archivo sin agotar memoria", async () => {
  const tool = await loadTool()
  const { content } = await tool.execute(
    { commands: [{ command: HUGE_OUTPUT }], max_output: 200 },
    {},
  )
  assert.match(content, /\[recortado \d+ chars\]/)
  const spillPath = spillPathFrom(content)
  assert.ok(spillPath, "debe derivar el output completo")
  assert.ok(statSync(spillPath).size > 1_900_000, "el spill debe tener el output completo (~2 MB)")
  const full = readFileSync(spillPath, "utf8")
  assert.ok(full.trimEnd().endsWith("y"), "el spill debe conservar el final del output")
  unlinkSync(spillPath)
})

test("setup limpia spills viejos al cargar el plugin", async () => {
  const dir = join(tmpdir(), "opencode", "batch")
  mkdirSync(dir, { recursive: true })
  const viejo = join(dir, `test-viejo-${Date.now()}.log`)
  const nuevo = join(dir, `test-nuevo-${Date.now()}.log`)
  writeFileSync(viejo, "viejo")
  writeFileSync(nuevo, "nuevo")
  const hace25hs = new Date(Date.now() - 25 * 60 * 60 * 1000)
  utimesSync(viejo, hace25hs, hace25hs)

  await loadTool()

  assert.equal(existsSync(viejo), false, "el spill viejo debe borrarse al cargar el plugin")
  assert.ok(existsSync(nuevo), "los spills recientes no se tocan")
  unlinkSync(nuevo)
})

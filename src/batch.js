// Plugin OpenCode V2: tool "batch" para correr varios comandos shell en paralelo.
// No importa @opencode/plugin a proposito para poder soltarlo sin dependencias.
// Registra un unico tool que ejecuta N comandos con un pool de concurrencia y
// devuelve solo un resumen compacto (ahorra contexto y round-trips al modelo).
// Por defecto trunca stdout/stderr con recorte head+tail; con truncate:false
// devuelve los outputs completos sin recortar. Si un stdout/stderr supera
// max_output se muestra inicio+final y el output completo se guarda en
// /tmp/opencode/batch/<archivo>.log. La ruta se informa con tamano y cantidad
// de lineas para decidir si vale la pena consultarlo. Si no hubo truncado, no
// se escribe ni se menciona ningun archivo.

import { spawn } from "node:child_process"
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_OUTPUT = 4_000
const SPILL_DIR = join(tmpdir(), "opencode", "batch")
const SPILL_TTL_MS = 24 * 60 * 60 * 1000

function truncate(text, max) {
  if (typeof text !== "string") return { text: "", truncated: false }
  if (text.length <= max) return { text, truncated: false }
  const half = Math.floor(max / 2)
  return {
    text: `${text.slice(0, half)}\n...[recortado ${text.length - max} chars]...\n${text.slice(-half)}`,
    truncated: true,
  }
}

function runOne(job, signal) {
  const command = job.command
  const workdir = job.workdir
  const timeout = Number.isFinite(job.timeout) ? job.timeout : DEFAULT_TIMEOUT_MS

  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ""
    let stderr = ""
    let finished = false

    let child
    try {
      child = spawn(command, {
        cwd: workdir,
        shell: true,
        signal,
        windowsHide: true,
        env: process.env,
      })
    } catch (err) {
      resolve({ command, workdir, ok: false, code: -1, ms: 0, stdout: "", stderr: String(err) })
      return
    }

    const timer = setTimeout(() => {
      if (finished) return
      stderr += `\n[timeout ${timeout}ms]`
      try {
        child.kill("SIGKILL")
      } catch {}
    }, timeout)

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    const done = (code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({
        command,
        workdir,
        ok: code === 0,
        code,
        ms: Date.now() - started,
        stdout,
        stderr,
      })
    }

    child.on("close", (code) => done(code === null ? -1 : code))
    child.on("error", (err) => {
      stderr += `\n${String(err)}`
      done(-1)
    })
  })
}

async function runPool(jobs, concurrency, signal) {
  const results = new Array(jobs.length)
  let cursor = 0

  const worker = async () => {
    while (true) {
      const index = cursor++
      if (index >= jobs.length) return
      results[index] = await runOne(jobs[index], signal)
    }
  }

  const size = Math.max(1, Math.min(concurrency, jobs.length))
  await Promise.all(Array.from({ length: size }, worker))
  return results
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function slugify(command) {
  const slug = String(command)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug || "cmd"
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

// Borra archivos de spill mas viejos que SPILL_TTL_MS. Nunca debe fallar la tool.
async function pruneSpill() {
  try {
    const entries = await readdir(SPILL_DIR)
    const now = Date.now()
    await Promise.all(
      entries.map(async (name) => {
        const file = join(SPILL_DIR, name)
        try {
          const info = await stat(file)
          if (now - info.mtimeMs > SPILL_TTL_MS) await unlink(file)
        } catch {}
      }),
    )
  } catch {}
}

// Guarda stdout+stderr completos de un comando y devuelve la ruta del archivo.
async function spillResult(result, index) {
  await mkdir(SPILL_DIR, { recursive: true })
  const rand = Math.random().toString(16).slice(2, 6)
  const file = join(SPILL_DIR, `${stamp()}-${index + 1}-${slugify(result.command)}-${rand}.log`)
  const parts = [
    `$ ${result.command}${result.workdir ? `   (cwd: ${result.workdir})` : ""}`,
    `exit ${result.code} en ${result.ms}ms`,
  ]
  if (result.stdout) parts.push("--- stdout ---\n" + result.stdout)
  if (result.stderr) parts.push("--- stderr ---\n" + result.stderr)
  if (!result.stdout && !result.stderr) parts.push("(sin output)")
  const content = parts.join("\n")
  await writeFile(file, content, "utf8")
  return {
    path: file,
    bytes: Buffer.byteLength(content, "utf8"),
    lines: content.split("\n").length,
  }
}

// Aplica truncado head+tail (o lo saltea si doTruncate es false).
// Solo si hubo truncado persiste el output completo.
async function prepare(result, maxOutput, index, doTruncate) {
  const out = doTruncate ? truncate(result.stdout, maxOutput) : { text: result.stdout, truncated: false }
  const err = doTruncate ? truncate(result.stderr, maxOutput) : { text: result.stderr, truncated: false }
  let spill = null
  let spillError = null
  if (out.truncated || err.truncated) {
    try {
      spill = await spillResult(result, index)
    } catch (writeErr) {
      spillError = String(writeErr?.message ?? writeErr)
    }
  }
  return { ...result, stdoutOut: out.text, stderrOut: err.text, spill, spillError }
}

function format(results) {
  const lines = []
  const failed = results.filter((r) => !r.ok).length
  lines.push(`BATCH: ${results.length} comandos, ${results.length - failed} ok, ${failed} con error`)
  for (const r of results) {
    lines.push("")
    lines.push(`$ ${r.command}${r.workdir ? `   (cwd: ${r.workdir})` : ""}`)
    lines.push(`exit ${r.code} en ${r.ms}ms`)
    if (r.spill) {
      const lineCount = `${r.spill.lines} línea${r.spill.lines === 1 ? "" : "s"}`
      lines.push(`[output completo (${formatSize(r.spill.bytes)}, ${lineCount}): ${r.spill.path}]`)
    }
    if (r.spillError) lines.push(`[output completo no disponible: ${r.spillError}]`)
    if (r.stdoutOut) lines.push("--- stdout ---\n" + r.stdoutOut)
    if (r.stderrOut) lines.push("--- stderr ---\n" + r.stderrOut)
    if (!r.stdoutOut && !r.stderrOut) lines.push("(sin output)")
  }
  return lines.join("\n")
}

export default {
  id: "batch-commands",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "batch",
        description:
          "Ejecuta varios comandos shell en paralelo y devuelve un resumen compacto. " +
          "Ideal para correr tests, greps o builds independientes en un solo paso sin llenar el contexto. " +
          "Si un output se recorta, muestra inicio y final e informa la ruta del archivo con el output completo " +
          "(consultalo con grep o lectura parcial si necesitás un dato puntual; no re-ejecutes el comando). " +
          "Con truncate:false devuelve los outputs completos sin recortar, cuando necesitás el detalle entero.",
        input: {
          type: "object",
          properties: {
            commands: {
              type: "array",
              description: "Lista de comandos a ejecutar en paralelo.",
              items: {
                type: "object",
                properties: {
                  command: { type: "string", description: "Comando a correr." },
                  workdir: { type: "string", description: "Directorio de trabajo (opcional)." },
                  timeout: { type: "number", description: "Timeout en ms (default 120000)." },
                },
                required: ["command"],
                additionalProperties: false,
              },
            },
            concurrency: {
              type: "number",
              description: `Cuantos comandos correr a la vez (default ${DEFAULT_CONCURRENCY}).`,
            },
            max_output: {
              type: "number",
              description: `Cuanto output conservar por comando, en chars (default ${DEFAULT_MAX_OUTPUT}; se ignora si truncate es false).`,
            },
            truncate: {
              type: "boolean",
              description: "Si es false, devuelve stdout/stderr completos sin recortar ni derivar a archivo (default: true).",
            },
          },
          required: ["commands"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const jobs = Array.isArray(input?.commands) ? input.commands : []
          if (jobs.length === 0) return { content: "BATCH: no se recibieron comandos." }

          const concurrency = Number.isFinite(input?.concurrency)
            ? input.concurrency
            : DEFAULT_CONCURRENCY
          const maxOutput = Number.isFinite(input?.max_output)
            ? input.max_output
            : DEFAULT_MAX_OUTPUT
          const doTruncate = input?.truncate !== false

          await context?.progress?.({ status: `corriendo ${jobs.length} comandos` })

          const results = await runPool(jobs, concurrency, context?.signal)
          await pruneSpill()
          const prepared = await Promise.all(results.map((r, i) => prepare(r, maxOutput, i, doTruncate)))
          return { content: format(prepared) }
        },
      })
    })
  },
}

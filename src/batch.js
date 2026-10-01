// Plugin OpenCode V2: tool "batch" para correr varios comandos shell en paralelo.
// No importa @opencode/plugin a proposito para poder soltarlo sin dependencias.
// Registra un unico tool que ejecuta N comandos con un pool de concurrencia y
// devuelve solo un resumen compacto (ahorra contexto y round-trips al modelo).
//
// Caracteristicas:
// - Truncado por defecto (head+tail, max_output) con spill del output completo
//   a /tmp/opencode/batch/<archivo>.log; truncate:false devuelve todo inline
//   hasta el limite de seguridad (64 KB por comando); si se supera, recorta
//   con head+tail igual y deriva al spill.
// - truncate y max_output se pueden pisar por comando, ademas de por llamada.
// - Memoria acotada: cada stream guarda hasta 1 MB en memoria; si se pasa,
//   deriva el resto a un archivo temporal y conserva cabeza y cola para el
//   recorte (asi un output de GBs no revienta el proceso).
// - Al vencer el timeout se mata el grupo de procesos completo (nietos incluidos).
// - Si un comando falla, el resumen agrega "posibles errores:" con las lineas
//   clave del output (hasta 5), para no tener que abrir el spill.
// - Progreso en vivo via context.progress (x/N completados).
// - Limpieza de spill: barre los archivos mas viejos que spill_ttl_ms al
//   cargar el plugin y en cada uso del tool.
// - Defaults configurables por plugin options: concurrency, max_output,
//   timeout, truncate y spill_ttl_ms.

import { spawn } from "node:child_process"
import { createReadStream, createWriteStream } from "node:fs"
import { appendFile, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_OUTPUT = 4_000
const DEFAULT_SPILL_TTL_MS = 24 * 60 * 60 * 1000
const SPILL_DIR = join(tmpdir(), "opencode", "batch")
const BUFFER_LIMIT = 1024 * 1024
const KEEP_MIN = 64 * 1024
const KEEP_MAX = 1024 * 1024
// Limite de seguridad para truncate:false: si stdout+stderr de un comando
// superan este tope, se recorta con head+tail y se deriva el completo al
// spill (un output de MBs no debe entrar entero al contexto por accidente).
const SAFETY_CAP_CHARS = 64 * 1024
const ERROR_SIGNAL_LIMIT = 5
const ERROR_LINE_RE =
  /(error|fail|cannot|no such file|not found|not ok|exception|timed out|timeout|eacces|enoent|✖)/i

function truncate(text, max) {
  if (typeof text !== "string") return { text: "", truncated: false }
  if (text.length <= max) return { text, truncated: false }
  const half = Math.floor(max / 2)
  return {
    text: `${text.slice(0, half)}\n...[recortado ${text.length - max} chars]...\n${text.slice(-half)}`,
    truncated: true,
  }
}

// Captura un stream con memoria acotada. Hasta BUFFER_LIMIT guarda todo el
// texto; despues deriva a un archivo temporal y mantiene cabeza y cola para
// el recorte. `fullText()` devuelve el contenido completo (leyendo el archivo
// si hubo derrame).
class StreamCapture {
  constructor(keepBytes, filePath) {
    this.keep = keepBytes
    this.filePath = filePath
    this.parts = []
    this.buffered = 0
    this.pending = []
    this.head = ""
    this.tailParts = []
    this.tailSize = 0
    this.total = 0
    this.lines = 0
    this.stream = null
    this.startPromise = null
  }

  get overflow() {
    return this.stream !== null
  }

  push(text) {
    if (!text) return
    this.total += text.length
    this.lines += (text.match(/\n/g) ?? []).length
    const headLeft = this.keep - this.head.length
    if (headLeft > 0) this.head += text.slice(0, headLeft)
    this.tailParts.push(text)
    this.tailSize += text.length
    if (this.tailSize > this.keep * 2) {
      const joined = this.tailParts.join("")
      const tail = joined.slice(-this.keep)
      this.tailParts = [tail]
      this.tailSize = tail.length
    }
    if (this.stream) {
      this.stream.write(text)
      return
    }
    if (this.startPromise) {
      this.pending.push(text)
      return
    }
    if (this.buffered + text.length <= BUFFER_LIMIT) {
      this.parts.push(text)
      this.buffered += text.length
      return
    }
    this.pending.push(text)
    this.startPromise = this.start()
  }

  async start() {
    try {
      await mkdir(SPILL_DIR, { recursive: true })
      this.stream = createWriteStream(this.filePath, { flags: "a" })
      const queued = [this.parts.join(""), ...this.pending]
      this.parts = []
      this.buffered = 0
      this.pending = []
      for (const chunk of queued) {
        if (chunk) this.stream.write(chunk)
      }
    } catch (err) {
      this.startPromise = null
      this.pending = []
      throw err
    }
  }

  async finish() {
    if (this.startPromise) {
      try {
        await this.startPromise
      } catch {}
    }
    if (this.stream) {
      await new Promise((resolve) => this.stream.end(resolve))
    }
  }

  text() {
    return this.parts.join("")
  }

  tailText() {
    return this.tailParts.join("")
  }

  async fullText() {
    if (this.overflow) return readFile(this.filePath, "utf8")
    return this.text()
  }

  // Texto para mostrar en el resumen, respetando maxOutput.
  async display(maxOutput) {
    if (!this.overflow) return truncate(this.text(), maxOutput)
    if (this.total <= maxOutput) {
      return { text: await readFile(this.filePath, "utf8"), truncated: false }
    }
    const half = Math.floor(maxOutput / 2)
    const head = this.head.slice(0, half)
    const tail = this.tailText().slice(-half)
    return {
      text: `${head}\n...[recortado ${this.total - maxOutput} chars]...\n${tail}`,
      truncated: true,
    }
  }
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

// Mata el grupo de procesos del comando (hijos y nietos incluidos).
function killTree(child, state) {
  if (state.killed) return
  state.killed = true
  try {
    if (process.platform !== "win32" && child?.pid) process.kill(-child.pid, "SIGKILL")
    else child?.kill("SIGKILL")
  } catch {}
}

function runOne(job, index, signal, defaults) {
  const command = job.command
  const workdir = job.workdir
  const timeout = Number.isFinite(job.timeout) ? job.timeout : defaults.timeout
  const maxOutput = Number.isFinite(job.max_output) ? job.max_output : defaults.maxOutput
  const doTruncate = job.truncate !== undefined ? job.truncate !== false : defaults.truncate
  const keepBytes = Math.min(Math.max(KEEP_MIN, maxOutput), KEEP_MAX)
  const rand = Math.random().toString(16).slice(2, 6)
  const spillBase = join(SPILL_DIR, `${stamp()}-${index + 1}-${slugify(command)}-${rand}.log`)

  const stdout = new StreamCapture(keepBytes, `${spillBase}.stdout.tmp`)
  const stderr = new StreamCapture(keepBytes, `${spillBase}.stderr.tmp`)
  const killState = { killed: false }

  return new Promise((resolve) => {
    const started = Date.now()
    let finished = false
    let child

    const onAbort = () => killTree(child, killState)
    try {
      child = spawn(command, {
        cwd: workdir,
        shell: true,
        signal,
        detached: process.platform !== "win32",
        windowsHide: true,
        env: process.env,
      })
    } catch (err) {
      resolve({ command, workdir, ok: false, code: -1, ms: 0, stdout, stderr, maxOutput, doTruncate, spillBase })
      return
    }

    signal?.addEventListener?.("abort", onAbort)

    const timer = setTimeout(() => {
      if (finished) return
      stderr.push(`\n[timeout ${timeout}ms]`)
      killTree(child, killState)
    }, timeout)

    child.stdout?.on("data", (chunk) => stdout.push(chunk.toString()))
    child.stderr?.on("data", (chunk) => stderr.push(chunk.toString()))

    const done = async (code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener?.("abort", onAbort)
      try {
        await Promise.all([stdout.finish(), stderr.finish()])
      } catch {}
      resolve({
        command,
        workdir,
        ok: code === 0,
        code: code === null ? -1 : code,
        ms: Date.now() - started,
        stdout,
        stderr,
        maxOutput,
        doTruncate,
        spillBase,
      })
    }

    child.on("close", (code) => void done(code))
    child.on("error", (err) => {
      stderr.push(`\n${String(err)}`)
      void done(-1)
    })
  })
}

async function runPool(jobs, concurrency, signal, defaults, onDone) {
  const results = new Array(jobs.length)
  let cursor = 0
  let completed = 0

  const worker = async () => {
    while (true) {
      const index = cursor++
      if (index >= jobs.length) return
      results[index] = await runOne(jobs[index], index, signal, defaults)
      completed++
      onDone?.(completed)
    }
  }

  const size = Math.max(1, Math.min(concurrency, jobs.length))
  await Promise.all(Array.from({ length: size }, worker))
  return results
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const trim = (n, unit) => `${n.toFixed(1).replace(/\.0$/, "")} ${unit}`
  if (bytes < 1024 * 1024) return trim(bytes / 1024, "KB")
  return trim(bytes / (1024 * 1024), "MB")
}

// Borra archivos de spill mas viejos que ttlMs. Nunca debe fallar la tool.
async function pruneSpill(ttlMs) {
  try {
    const entries = await readdir(SPILL_DIR)
    const now = Date.now()
    await Promise.all(
      entries.map(async (name) => {
        const file = join(SPILL_DIR, name)
        try {
          const info = await stat(file)
          if (now - info.mtimeMs > ttlMs) await unlink(file)
        } catch {}
      }),
    )
  } catch {}
}

async function cleanupTemps(result) {
  for (const cap of [result.stdout, result.stderr]) {
    if (cap.overflow && cap.filePath) {
      try {
        await unlink(cap.filePath)
      } catch {}
    }
  }
}

// Arma el archivo con el output completo (header + stdout + stderr) a partir
// del texto buffereado o de los archivos temporales del derrame.
async function spillResult(result) {
  await mkdir(SPILL_DIR, { recursive: true })
  const path = result.spillBase
  const header = [
    `$ ${result.command}${result.workdir ? `   (cwd: ${result.workdir})` : ""}`,
    `exit ${result.code} en ${result.ms}ms`,
    "",
  ].join("\n")
  await writeFile(path, header, "utf8")

  for (const [name, cap] of [["stdout", result.stdout], ["stderr", result.stderr]]) {
    if (cap.total === 0) continue
    if (cap.overflow) {
      await appendFile(path, `--- ${name} ---\n`, "utf8")
      await pipeline(createReadStream(cap.filePath), createWriteStream(path, { flags: "a" }))
      await appendFile(path, "\n", "utf8")
    } else {
      await appendFile(path, `--- ${name} ---\n${cap.text()}\n`, "utf8")
    }
  }
  if (result.stdout.total === 0 && result.stderr.total === 0) {
    await appendFile(path, "(sin output)\n", "utf8")
  }

  const info = await stat(path)
  return {
    path,
    bytes: info.size,
    lines: result.stdout.lines + result.stderr.lines + 4,
  }
}

// Resuelve truncado/spill por comando. Solo si hubo truncado se persiste el
// output completo; los temporales del derrame siempre se limpian.
async function prepare(result) {
  let out
  let err
  let safety = false
  if (result.doTruncate) {
    out = await result.stdout.display(result.maxOutput)
    err = await result.stderr.display(result.maxOutput)
  } else if (result.stdout.total + result.stderr.total <= SAFETY_CAP_CHARS) {
    out = { text: await result.stdout.fullText(), truncated: false }
    err = { text: await result.stderr.fullText(), truncated: false }
  } else {
    // Limite de seguridad: aunque el modelo pidio truncate:false, un output
    // gigante no entra completo al contexto; se recorta y se deriva al spill.
    safety = true
    const showMax = Math.min(result.maxOutput, SAFETY_CAP_CHARS)
    out = await result.stdout.display(showMax)
    err = await result.stderr.display(showMax)
  }

  let spill = null
  let spillError = null
  if (out.truncated || err.truncated) {
    try {
      spill = await spillResult(result)
    } catch (writeErr) {
      spillError = String(writeErr?.message ?? writeErr)
    }
  }
  await cleanupTemps(result)
  return { ...result, stdoutOut: out.text, stderrOut: err.text, spill, spillError, safety }
}

// Busca lineas que parezcan errores en el texto ya recortado, para que el
// resumen sea autosuficiente cuando un comando falla.
function errorSignals(text, limit = ERROR_SIGNAL_LIMIT) {
  if (!text) return []
  const seen = new Set()
  const signals = []
  for (const raw of String(text).split("\n")) {
    const line = raw.trim()
    if (!line || line.length > 300 || !ERROR_LINE_RE.test(line)) continue
    if (seen.has(line)) continue
    seen.add(line)
    signals.push(line.slice(0, 200))
    if (signals.length >= limit) break
  }
  return signals
}

function format(results) {
  const lines = []
  const failed = results.filter((r) => !r.ok).length
  lines.push(`BATCH: ${results.length} comandos, ${results.length - failed} ok, ${failed} con error`)
  for (const r of results) {
    lines.push("")
    lines.push(`$ ${r.command}${r.workdir ? `   (cwd: ${r.workdir})` : ""}`)
    lines.push(`exit ${r.code} en ${r.ms}ms`)
    if (!r.ok) {
      const senales = errorSignals(`${r.stdoutOut ?? ""}\n${r.stderrOut ?? ""}`)
      if (senales.length > 0) {
        lines.push("posibles errores:")
        for (const senal of senales) lines.push(`- ${senal}`)
      }
    }
    if (r.safety) {
      lines.push(
        `[truncate:false superó el límite de seguridad (${formatSize(SAFETY_CAP_CHARS)} por comando): ` +
          `se muestra inicio y final]`,
      )
    }
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
    const opt = ctx?.options ?? {}
    const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)
    const defaults = {
      timeout: positive(opt.timeout, DEFAULT_TIMEOUT_MS),
      concurrency: positive(opt.concurrency, DEFAULT_CONCURRENCY),
      maxOutput: positive(opt.max_output, DEFAULT_MAX_OUTPUT),
      truncate: opt.truncate !== false,
      spillTtlMs: positive(opt.spill_ttl_ms, DEFAULT_SPILL_TTL_MS),
    }

    // Higiene: barre los spills viejos al cargar el plugin, no solo al usarlo.
    await pruneSpill(defaults.spillTtlMs)

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "batch",
        description:
          "Ejecuta varios comandos shell en paralelo y devuelve un resumen compacto. " +
          "Devuelve un único string de texto con el resumen: no es un array, no lo iteres ni lo indexes; " +
          "en Code Mode asignalo a una variable y devolvelo tal cual. " +
          "Usalo para 2 o más comandos con salida voluminosa (tests, builds, greps); " +
          "para un solo comando o salidas chicas, usá shell directo. " +
          "El resumen alcanza para decidir si los comandos pasaron o fallaron: no re-ejecutes comandos " +
          "ni explores el proyecto para confirmarlo. " +
          "Si un output se recorta, muestra inicio y final e informa la ruta del archivo con el output completo; " +
          "abrilo con grep o lectura parcial solo si el pedido exige un dato que el resumen no tenga. " +
          "Si un comando falla, incluye 'posibles errores:' con las líneas clave de su output. " +
          `Con truncate:false devuelve los outputs completos, salvo que un comando supere el límite de ` +
          `seguridad (${formatSize(SAFETY_CAP_CHARS)} por comando): ahí recorta y deriva igual al archivo.`,
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
                  timeout: { type: "number", description: `Timeout en ms (opcional; default ${defaults.timeout}).` },
                  max_output: {
                    type: "number",
                    description: `Cuanto output conservar de este comando, en chars (opcional; pisa el default de la llamada).`,
                  },
                  truncate: {
                    type: "boolean",
                    description: "Truncado para este comando (opcional; pisa el default de la llamada).",
                  },
                },
                required: ["command"],
                additionalProperties: false,
              },
            },
            concurrency: {
              type: "number",
              description: `Cuantos comandos correr a la vez (default ${defaults.concurrency}).`,
            },
            max_output: {
              type: "number",
              description: `Cuanto output conservar por comando, en chars (default ${defaults.maxOutput}; con truncate:false solo aplica al recorte por límite de seguridad).`,
            },
            truncate: {
              type: "boolean",
              description: `Si es false, devuelve stdout/stderr completos (default: true), salvo que el comando supere el límite de seguridad (${formatSize(SAFETY_CAP_CHARS)}).`,
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
            : defaults.concurrency
          const maxOutput = Number.isFinite(input?.max_output)
            ? input.max_output
            : defaults.maxOutput
          const doTruncate = input?.truncate !== undefined ? input.truncate !== false : defaults.truncate
          const callDefaults = { ...defaults, maxOutput, truncate: doTruncate }

          try {
            await context?.progress?.({ status: `corriendo ${jobs.length} comandos` })
          } catch {}

          const onDone = (n) => {
            try {
              const pending = context?.progress?.({ status: `batch: ${n}/${jobs.length} comandos completados` })
              if (pending && typeof pending.catch === "function") pending.catch(() => {})
            } catch {}
          }

          const results = await runPool(jobs, concurrency, context?.signal, callDefaults, onDone)
          await pruneSpill(defaults.spillTtlMs)
          const prepared = await Promise.all(results.map((r) => prepare(r)))
          return { content: format(prepared) }
        },
      })
    })
  },
}

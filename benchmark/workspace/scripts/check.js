// Output determinista que simula el resultado de un check del proyecto.
// Uso: node scripts/check.js <test|lint|typecheck|build> [lineas]
// Sin dependencias ni red, para que el benchmark sea reproducible.

const name = process.argv[2] ?? "check"
const lines = Number(process.argv[3] ?? 480)

let seed = 7
for (const ch of name) seed = (seed * 31 + ch.charCodeAt(0)) % 2147483647
const rand = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)]

const modules = [
  "auth", "billing", "cart", "checkout", "inventory",
  "orders", "search", "users", "webhooks", "reporting",
]
const files = ["index", "service", "store", "helpers", "types", "schema", "client", "worker"]
const verbs = ["creates", "updates", "deletes", "loads", "validates", "maps", "filters"]
const conds = ["correctly", "without side effects", "with defaults", "under concurrency", "on empty input"]
const rules = [
  "no-unused-vars", "eqeqeq", "no-console", "prefer-const",
  "no-shadow", "consistent-return", "no-floating-promises",
]
const descriptions = [
  "'value' is assigned a value but never used",
  "unexpected any",
  "missing explicit return type",
  "prefer const over let",
  "console statement left in code",
  "promise returned but not awaited",
  "expected '===' and instead saw '=='",
]

console.log(`> bench-app@1.0.0 ${name}`)
console.log("")

let errors = 0
for (let i = 1; i <= lines; i++) {
  const mod = pick(modules)
  const file = pick(files)
  if (name === "test") {
    const ms = Math.floor(rand() * 300)
    console.log(`ok ${i} - ${mod}: ${pick(verbs)} ${pick(conds)} (${ms}ms)`)
  } else if (name === "lint") {
    const level = rand() < 0.05 ? "error" : "warning"
    if (level === "error") errors++
    const line = Math.floor(rand() * 400) + 1
    const col = Math.floor(rand() * 100) + 1
    console.log(`src/${mod}/${file}.ts:${line}:${col}  ${level.padEnd(7)}  ${pick(rules)}  ${pick(descriptions)}`)
  } else if (name === "typecheck") {
    const ms = Math.floor(rand() * 120)
    console.log(`src/${mod}/${file}.ts  ${pick(["ok", "ok", "ok", "cached"])} (${ms}ms)`)
  } else {
    const kb = (rand() * 400 + 5).toFixed(1)
    const ms = Math.floor(rand() * 400)
    console.log(`[build] chunk ${i} ${mod}-${pick(["vendor", "runtime", "page", "widget"])} ${kb} KB (${ms}ms)`)
  }
}

console.log("")
if (name === "test") {
  console.log(`# tests ${lines}`)
  console.log(`# pass ${lines - 2}`)
  console.log(`# skipped 2`)
  console.log(`# duration_ms ${Math.floor(rand() * 9000 + 1000)}`)
  process.exit(0)
} else if (name === "lint") {
  console.log(`x ${errors} problems (${errors} errors, ${lines - errors} warnings)`)
  process.exit(1)
} else if (name === "typecheck") {
  console.log(`Found 0 errors in ${lines} files (4 cached).`)
  process.exit(0)
} else {
  console.log(`Build finished in ${(rand() * 5 + 1).toFixed(1)}s -> dist/`)
  process.exit(0)
}

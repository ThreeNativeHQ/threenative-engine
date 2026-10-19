import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) throw new Error("TN_ANIMAL_NATIVE_CONSOLE_MISSING");
const rows = JSON.parse(await readFile(path, "utf8"));
if (!Array.isArray(rows) || rows.length === 0) throw new Error("TN_ANIMAL_NATIVE_CONSOLE_EMPTY");
for (const row of rows)
  if (
    !row ||
    !["log", "warning", "error"].includes(row.type) ||
    typeof row.text !== "string" ||
    row.text.trim().length === 0
  )
    throw new Error("TN_ANIMAL_NATIVE_CONSOLE_INVALID");
const errors = rows.filter((row) => row.type === "error");
if (errors.length) throw new Error(`TN_ANIMAL_NATIVE_CONSOLE_ERRORS: ${errors.length}`);
console.log(
  JSON.stringify({
    path,
    entries: rows.length,
    errorEntries: 0,
    pass: true,
    unavailable: ["runtimeDiagnostics", "network"],
  }),
);

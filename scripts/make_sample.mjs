// Writes data/sample-events.csv from the seeded generator: node scripts/make_sample.mjs [seed]
import { writeFileSync } from "node:fs";
import { generateSample, modelToCSV } from "../src/dora.js";

const seed = Number.parseInt(process.argv[2] ?? "42", 10);
const out = new URL("../data/sample-events.csv", import.meta.url);
writeFileSync(out, modelToCSV(generateSample(seed)));
console.log(`Wrote ${out.pathname} (seed ${seed})`);

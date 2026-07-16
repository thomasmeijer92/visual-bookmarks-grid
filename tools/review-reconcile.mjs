import { createRequire } from "node:module";
createRequire(import.meta.url)("./review-cli.cjs").run("reconcile");

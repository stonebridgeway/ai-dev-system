// The Electron binary for this package: the electron package fetches it on
// first use (it has no install script), so this resolves — and downloads —
// it, and prints where it is.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const binary = require("electron");
console.log(binary);

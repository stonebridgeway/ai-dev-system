/**
 * A model of five kilobytes shaped like the pinned BGE-M3 export, for tests.
 *
 * The real export is 570 MB from a host a test run may not reach,
 * so without a stand-in the path from model files to a ranked search result —
 * transformers.js loading a local directory, onnxruntime running the graph in
 * the worker thread, pooling, normalising, vectors into the index, a hybrid
 * query scoring them — ran nowhere but on a user's machine. This one goes
 * through all of it: the same five file names, the same
 * tokenizer class (XLM-RoBERTa with a Unigram vocabulary and Metaspace
 * splitting, as BGE-M3's), the same `config.json` model type, the same inputs
 * and output name, the same `int8` file name — and 1024-dimension vectors.
 *
 * What it computes is chosen so a test can tell dense ranking from keyword
 * ranking: a vocabulary of four topics, each word's embedding pointing along
 * its topic's axes, summed over the words of a text. "postgres storage" lands
 * next to "database query" with no word in common. The graph is written here
 * byte by byte in ONNX's protobuf encoding, so nothing binary is committed and
 * nothing needs Python to make it.
 */
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

/** Words of the vocabulary, by topic. */
export const SYNTHETIC_TOPICS = Object.freeze({
  database: Object.freeze(["database", "sql", "query", "index", "table", "postgres", "storage", "schema"]),
  frontend: Object.freeze(["css", "layout", "button", "component", "react", "design", "browser", "page"]),
  security: Object.freeze(["auth", "token", "password", "secret", "login", "permission", "credential", "encryption"]),
  delivery: Object.freeze(["docker", "deploy", "release", "pipeline", "container", "build", "rollout", "image"])
});

const SPECIALS = Object.freeze(["<s>", "<pad>", "</s>", "<unk>"]);
const WIDTH = 16;
const OUTPUT_WIDTH = 1024;

// ONNX protobuf field numbers and enums used below.
const FLOAT = 1;
const INT64 = 7;
const ATTRIBUTE_INT = 2;

function varint(value) {
  let remaining = BigInt(value);
  if (remaining < 0n) remaining += 1n << 64n;
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

const field = (number, wire) => varint((number << 3) | wire);
const integer = (number, value) => Buffer.concat([field(number, 0), varint(value)]);
const bytes = (number, value) => {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return Buffer.concat([field(number, 2), varint(payload.length), payload]);
};
const message = (...parts) => Buffer.concat(parts.flat());

const dimension = (value) => (typeof value === "number" ? bytes(1, integer(1, value)) : bytes(1, bytes(2, value)));
const valueInfo = (name, type, dims) => message(
  bytes(1, name),
  bytes(2, bytes(1, message(integer(1, type), bytes(2, message(...dims.map(dimension))))))
);
const tensor = (name, type, dims, raw) => message(...dims.map((value) => integer(1, value)), integer(2, type), bytes(8, name), bytes(9, raw));
const intAttribute = (name, value) => message(bytes(1, name), integer(3, value), integer(20, ATTRIBUTE_INT));
const node = (op, inputs, outputs, attributes = []) => message(
  ...inputs.map((input) => bytes(1, input)),
  ...outputs.map((output) => bytes(2, output)),
  bytes(3, `${op}_${outputs[0]}`),
  bytes(4, op),
  ...attributes.map((attribute) => bytes(5, attribute))
);

/** The vocabulary in id order: specials, then `▁word` for every topic word, then `<mask>`. */
function vocabulary() {
  const words = Object.values(SYNTHETIC_TOPICS).flat().map((word) => `▁${word}`);
  return [...SPECIALS, ...words, "<mask>"];
}

/** Each word along its topic's four axes, everything else faint; padding is zero. */
function embeddingTable(pieces) {
  const topicOf = new Map();
  Object.values(SYNTHETIC_TOPICS).forEach((words, topic) => words.forEach((word) => topicOf.set(`▁${word}`, topic)));
  const table = new Float32Array(pieces.length * WIDTH);
  pieces.forEach((piece, row) => {
    for (let column = 0; column < WIDTH; column += 1) {
      let value = piece === "<pad>" ? 0 : 0.01;
      const topic = topicOf.get(piece);
      if (topic !== undefined && Math.floor(column / 4) === topic) value = 1 + (((row * 7) + column) % 5) / 10;
      table[(row * WIDTH) + column] = value;
    }
  });
  return table;
}

/**
 * The graph: look each token up, zero the padding, sum over the sequence and
 * repeat the 16 numbers to 1024 — `last_hidden_state` of shape
 * `[batch, 1, 1024]`, whose first position is what `cls` pooling takes.
 * Opset 13, where `Unsqueeze` and `ReduceSum` take their axes as inputs.
 */
function onnxModel(pieces) {
  const table = embeddingTable(pieces);
  const int64s = (values) => Buffer.from(new BigInt64Array(values.map(BigInt)).buffer);
  const graph = message(
    bytes(1, node("Gather", ["embeddings", "input_ids"], ["gathered"], [intAttribute("axis", 0)])),
    bytes(1, node("Cast", ["attention_mask"], ["mask"], [intAttribute("to", FLOAT)])),
    bytes(1, node("Unsqueeze", ["mask", "last_axis"], ["mask_3d"])),
    bytes(1, node("Mul", ["gathered", "mask_3d"], ["masked"])),
    bytes(1, node("ReduceSum", ["masked", "sequence_axis"], ["summed"], [intAttribute("keepdims", 1)])),
    bytes(1, node("Tile", ["summed", "repeats"], ["last_hidden_state"])),
    bytes(2, "synthetic-bge-m3"),
    bytes(5, tensor("embeddings", FLOAT, [pieces.length, WIDTH], Buffer.from(table.buffer))),
    bytes(5, tensor("repeats", INT64, [3], int64s([1, 1, OUTPUT_WIDTH / WIDTH]))),
    bytes(5, tensor("last_axis", INT64, [1], int64s([2]))),
    bytes(5, tensor("sequence_axis", INT64, [1], int64s([1]))),
    bytes(11, valueInfo("input_ids", INT64, ["batch_size", "sequence_length"])),
    bytes(11, valueInfo("attention_mask", INT64, ["batch_size", "sequence_length"])),
    bytes(12, valueInfo("last_hidden_state", FLOAT, ["batch_size", 1, OUTPUT_WIDTH]))
  );
  return message(integer(1, 7), bytes(2, "ai-dev-system"), bytes(7, graph), bytes(8, message(bytes(1, ""), integer(2, 13))));
}

function tokenizerFiles(pieces) {
  const special = (id, content, extra = {}) => ({ id, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true, ...extra });
  const token = (id) => ({ SpecialToken: { id, type_id: 0 } });
  const sequence = (id) => ({ Sequence: { id, type_id: 0 } });
  const tokenizer = {
    version: "1.0",
    truncation: null,
    padding: null,
    added_tokens: [...SPECIALS.map((content, id) => special(id, content)), special(pieces.length - 1, "<mask>", { lstrip: true })],
    normalizer: { type: "Lowercase" },
    pre_tokenizer: { type: "Metaspace", replacement: "▁", prepend_scheme: "always", split: true },
    post_processor: {
      type: "TemplateProcessing",
      single: [token("<s>"), sequence("A"), token("</s>")],
      pair: [token("<s>"), sequence("A"), token("</s>"), token("</s>"), sequence("B"), token("</s>")],
      special_tokens: { "<s>": { id: "<s>", ids: [0], tokens: ["<s>"] }, "</s>": { id: "</s>", ids: [2], tokens: ["</s>"] } }
    },
    decoder: { type: "Metaspace", replacement: "▁", prepend_scheme: "always", split: true },
    model: { type: "Unigram", unk_id: 3, byte_fallback: false, vocab: pieces.map((piece, index) => [piece, index < SPECIALS.length || piece === "<mask>" ? 0 : -1]) }
  };
  const names = { bos_token: "<s>", eos_token: "</s>", unk_token: "<unk>", sep_token: "</s>", pad_token: "<pad>", cls_token: "<s>", mask_token: "<mask>" };
  return {
    "tokenizer.json": `${JSON.stringify(tokenizer)}\n`,
    "tokenizer_config.json": `${JSON.stringify({ tokenizer_class: "XLMRobertaTokenizer", model_max_length: 8192, ...names })}\n`,
    "special_tokens_map.json": `${JSON.stringify(names)}\n`,
    "config.json": `${JSON.stringify({
      model_type: "xlm-roberta",
      architectures: ["XLMRobertaModel"],
      hidden_size: OUTPUT_WIDTH,
      vocab_size: pieces.length,
      max_position_embeddings: 8194,
      pad_token_id: 1,
      bos_token_id: 0,
      eos_token_id: 2
    })}\n`
  };
}

/**
 * The five files, by the names the pinned manifest uses.
 *
 * @returns {Record<string, Buffer>}
 */
export function syntheticModelFiles() {
  const pieces = vocabulary();
  const text = tokenizerFiles(pieces);
  return {
    "config.json": Buffer.from(text["config.json"]),
    "tokenizer.json": Buffer.from(text["tokenizer.json"]),
    "tokenizer_config.json": Buffer.from(text["tokenizer_config.json"]),
    "special_tokens_map.json": Buffer.from(text["special_tokens_map.json"]),
    "onnx/model_int8.onnx": onnxModel(pieces)
  };
}

/**
 * A manifest for files made by {@link syntheticModelFiles}, pinned the way the
 * real one is: every file by sha256, the revision derived from them.
 *
 * @param {Record<string, Buffer>} files
 * @param {object} [overrides] - `sources`, mostly.
 * @returns {object}
 */
export function syntheticManifest(files, overrides = {}) {
  const digests = Object.fromEntries(Object.entries(files).map(([name, body]) => [name, crypto.createHash("sha256").update(body).digest("hex")]));
  const revision = crypto.createHash("sha1").update(JSON.stringify(digests)).digest("hex");
  return {
    model: "BAAI/bge-m3",
    export: "ai-dev/synthetic-bge-m3",
    revision,
    dtype: "int8",
    dimensions: OUTPUT_WIDTH,
    pooling: "cls",
    license: "MIT",
    sources: [],
    files: digests,
    ...overrides
  };
}

/**
 * Write the synthetic model into `dir` and return its manifest.
 *
 * @param {string} dir
 * @returns {Promise<{ dir: string, manifest: object, files: Record<string, Buffer> }>}
 */
export async function writeSyntheticModel(dir) {
  const files = syntheticModelFiles();
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split("/"));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, body);
  }
  return { dir: path.resolve(dir), manifest: syntheticManifest(files), files };
}

#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import sys
import time


MODEL_NAME = "BAAI/bge-m3"
DEFAULT_MODEL_DIR = Path(os.environ.get("BGE_M3_MODEL_DIR", Path.home() / ".codex" / "models" / "bge-m3"))


def print_json(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, indent=2))
    sys.stdout.write("\n")


def fail(message, code=1):
    print_json({"ok": False, "error": message})
    raise SystemExit(code)


def load_model(model_dir, device):
    if not model_dir.exists():
        fail(f"Model directory does not exist: {model_dir}")
    if not (model_dir / "pytorch_model.bin").exists():
        fail(f"Missing model weights: {model_dir / 'pytorch_model.bin'}")

    from sentence_transformers import SentenceTransformer

    started = time.time()
    model = SentenceTransformer(str(model_dir), device=device)
    return model, round(time.time() - started, 3)


def parse_text_payload(raw):
    value = raw.strip()
    if not value:
        return [], {}

    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return [value], {}

    if isinstance(payload, list):
        return [str(item) for item in payload], {}
    if isinstance(payload, dict):
        texts = payload.get("texts", [])
        if isinstance(texts, str):
            texts = [texts]
        elif not isinstance(texts, list):
            fail("JSON field 'texts' must be a string or list of strings")
        options = {
            key: payload[key]
            for key in ("normalize", "batch_size", "prefix")
            if key in payload
        }
        return [str(item) for item in texts], options
    fail("Input JSON must be a list of strings or an object with a 'texts' field")


def read_texts(args):
    texts = list(args.text or [])
    options = {}

    if args.input_json:
        more_texts, options = parse_text_payload(Path(args.input_json).read_text(encoding="utf-8-sig"))
        texts.extend(more_texts)
    elif not sys.stdin.isatty():
        raw = sys.stdin.read()
        if raw.strip():
            more_texts, options = parse_text_payload(raw)
            texts.extend(more_texts)

    prefix = args.prefix if args.prefix is not None else options.get("prefix", "")
    if prefix:
        texts = [f"{prefix}{text}" for text in texts]
    return texts, options


def rounded_vector(vector, precision):
    return [round(float(value), precision) for value in vector]


def command_embed(args):
    texts, options = read_texts(args)
    if not texts:
        fail("No texts provided. Use --text, --input-json, or stdin.")

    normalize = not args.no_normalize
    if "normalize" in options:
        normalize = bool(options["normalize"])

    batch_size = args.batch_size
    if "batch_size" in options:
        batch_size = int(options["batch_size"])

    model_dir = Path(args.model_dir).expanduser()
    model, load_seconds = load_model(model_dir, args.device)
    started = time.time()
    embeddings = model.encode(
        texts,
        batch_size=batch_size,
        normalize_embeddings=normalize,
        show_progress_bar=args.progress,
    )
    encode_seconds = round(time.time() - started, 3)
    vectors = [rounded_vector(row, args.precision) for row in embeddings]

    print_json(
        {
            "ok": True,
            "model": MODEL_NAME,
            "model_dir": str(model_dir),
            "device": args.device,
            "count": len(vectors),
            "dimensions": len(vectors[0]) if vectors else 0,
            "normalized": normalize,
            "load_seconds": load_seconds,
            "encode_seconds": encode_seconds,
            "embeddings": vectors,
        }
    )


def command_smoke(args):
    model_dir = Path(args.model_dir).expanduser()
    model, load_seconds = load_model(model_dir, args.device)
    texts = [
        "query: prepare project MCP knowledge base",
        "passage: prepare_project creates AGENTS.md project-map quality-gate and syncs Obsidian registry",
    ]
    started = time.time()
    embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    encode_seconds = round(time.time() - started, 3)
    similarity = float(embeddings[0] @ embeddings[1])
    print_json(
        {
            "ok": True,
            "model": MODEL_NAME,
            "model_dir": str(model_dir),
            "device": args.device,
            "dimensions": int(embeddings.shape[1]),
            "load_seconds": load_seconds,
            "encode_seconds": encode_seconds,
            "similarity": round(similarity, 6),
        }
    )


def build_parser():
    parser = argparse.ArgumentParser(description="Local BGE-M3 embedding helper for AI Dev System")
    parser.add_argument("--model-dir", default=str(DEFAULT_MODEL_DIR))
    parser.add_argument("--device", default=os.environ.get("BGE_M3_DEVICE", "cpu"))

    sub = parser.add_subparsers(dest="command", required=True)

    embed = sub.add_parser("embed", help="Embed text from args, a JSON file, or stdin")
    embed.add_argument("--text", action="append", help="Text to embed. Can be passed multiple times.")
    embed.add_argument("--input-json", help="JSON file with a list of strings or {'texts': [...]}.")
    embed.add_argument("--prefix", default=None, help="Optional prefix, e.g. 'query: ' or 'passage: '.")
    embed.add_argument("--batch-size", type=int, default=8)
    embed.add_argument("--precision", type=int, default=6)
    embed.add_argument("--no-normalize", action="store_true")
    embed.add_argument("--progress", action="store_true")
    embed.set_defaults(func=command_embed)

    smoke = sub.add_parser("smoke", help="Load the local model and encode a fixed pair")
    smoke.set_defaults(func=command_smoke)

    return parser


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

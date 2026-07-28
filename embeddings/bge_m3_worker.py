#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import sys
import time


MODEL_NAME = "BAAI/bge-m3"
DEFAULT_MODEL_DIR = Path(os.environ.get("BGE_M3_MODEL_DIR", Path.home() / ".codex" / "models" / "bge-m3"))


def write_json(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def rounded_vector(vector, precision):
    return [round(float(value), precision) for value in vector]


def load_model(model_dir, device):
    if not model_dir.exists():
        raise RuntimeError(f"Model directory does not exist: {model_dir}")
    if not (model_dir / "pytorch_model.bin").exists():
        raise RuntimeError(f"Missing model weights: {model_dir / 'pytorch_model.bin'}")

    from sentence_transformers import SentenceTransformer

    started = time.time()
    model = SentenceTransformer(str(model_dir), device=device)
    return model, round(time.time() - started, 3)


def clean_texts(payload):
    texts = payload.get("texts", [])
    text = payload.get("text")
    if isinstance(texts, str):
        texts = [texts]
    if text and not texts:
        texts = [text]
    if not isinstance(texts, list):
        raise ValueError("texts must be a list of strings")
    cleaned = [str(value).strip() for value in texts if str(value).strip()]
    if not cleaned:
        raise ValueError("texts or text is required")
    if len(cleaned) > 64:
        raise ValueError("worker accepts at most 64 texts per request")
    prefix = str(payload.get("prefix") or "")
    if prefix:
        cleaned = [f"{prefix}{value}" for value in cleaned]
    return cleaned


def handle_embed(model, payload, load_seconds, model_dir, device):
    texts = clean_texts(payload)
    normalize = bool(payload.get("normalize", True))
    batch_size = max(1, min(int(payload.get("batch_size") or 8), 64))
    precision = max(2, min(int(payload.get("precision") or 6), 10))
    include_embeddings = bool(payload.get("include_embeddings", True))

    started = time.time()
    embeddings = model.encode(
        texts,
        batch_size=batch_size,
        normalize_embeddings=normalize,
        show_progress_bar=False,
    )
    encode_seconds = round(time.time() - started, 3)
    vectors = [rounded_vector(row, precision) for row in embeddings]
    result = {
        "ok": True,
        "model": MODEL_NAME,
        "model_dir": str(model_dir),
        "device": device,
        "count": len(vectors),
        "dimensions": len(vectors[0]) if vectors else 0,
        "normalized": normalize,
        "load_seconds": load_seconds,
        "encode_seconds": encode_seconds,
        "backend": "bge-m3-worker",
    }
    if include_embeddings:
        result["embeddings"] = vectors
    else:
        result["embedding_preview"] = [row[:8] for row in vectors]
    return result


def main():
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")

    parser = argparse.ArgumentParser(description="Warm BGE-M3 JSONL embedding worker")
    parser.add_argument("--model-dir", default=str(DEFAULT_MODEL_DIR))
    parser.add_argument("--device", default=os.environ.get("BGE_M3_DEVICE", "cpu"))
    args = parser.parse_args()

    model_dir = Path(args.model_dir).expanduser()
    try:
        model, load_seconds = load_model(model_dir, args.device)
        write_json({
            "type": "ready",
            "ok": True,
            "model": MODEL_NAME,
            "model_dir": str(model_dir),
            "device": args.device,
            "load_seconds": load_seconds,
        })
    except Exception as err:
        write_json({"type": "ready", "ok": False, "error": str(err)})
        raise SystemExit(1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            payload = json.loads(line)
            request_id = payload.get("id")
            method = payload.get("method", "embed")
            if method == "shutdown":
                write_json({"id": request_id, "ok": True, "shutdown": True})
                break
            if method == "ping":
                write_json({"id": request_id, "ok": True, "ready": True, "backend": "bge-m3-worker"})
                continue
            if method != "embed":
                raise ValueError(f"Unknown method: {method}")
            result = handle_embed(model, payload, load_seconds, model_dir, args.device)
            result["id"] = request_id
            write_json(result)
        except Exception as err:
            write_json({"id": request_id, "ok": False, "error": str(err)})


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
import argparse
from array import array
from collections import Counter
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import time


SKIP_DIRS = {
    ".git",
    ".obsidian",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".venv",
    "venv",
    "env",
    "__pycache__",
}

SEMANTIC_DIMENSIONS = 1024
MAX_VECTOR_FEATURES = 512
DENSE_MODEL_NAME = "BAAI/bge-m3"
DENSE_DIMENSIONS = 1024
DEFAULT_DENSE_TEXT_LIMIT = 1200
HYBRID_CANDIDATE_LIMIT = 500
DEFAULT_DENSE_MODEL_DIR = Path(os.environ.get("BGE_M3_MODEL_DIR", Path.home() / ".codex" / "models" / "bge-m3"))
INDEX_SCHEMA_VERSION = 2
SQLITE_READ_RETRY_DELAYS = (0.15, 0.35, 0.75)
DEFAULT_REBUILD_LOCK_TIMEOUT = 600.0

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "if", "in", "into",
    "is", "it", "of", "on", "or", "that", "the", "this", "to", "use", "with", "what", "when",
    "where", "which", "who", "why",
    "а", "без", "бы", "в", "во", "вот", "для", "до", "его", "ее", "если", "же", "за", "и",
    "из", "или", "к", "как", "ко", "ли", "на", "не", "но", "о", "об", "от", "по", "при",
    "с", "со", "так", "то", "у", "что", "это", "я",
}

SEMANTIC_ALIASES = {
    "bug": [
        "bug", "bugs", "error", "errors", "failure", "failures", "exception", "regression",
        "broken", "debug", "fix", "issue", "баг", "ошибка", "ошибки", "сбой", "падает",
        "исправить", "починить", "регрессия",
    ],
    "feature": [
        "feature", "implementation", "implement", "build", "add behavior", "new behavior",
        "фича", "фичу", "функция", "реализовать", "добавить", "сделать",
    ],
    "review": [
        "review", "code review", "diff", "pull request", "pr", "audit", "ревью", "проверка",
        "проверь", "посмотри код",
    ],
    "quality": [
        "quality", "quality gate", "test", "tests", "lint", "typecheck", "coverage", "ci",
        "verification", "qa", "browser qa", "playwright", "accessibility", "overflow", "console error",
        "качество", "проверки", "тест", "тесты", "линт", "тайпчек",
    ],
    "frontend": [
        "frontend", "front-end", "ui", "ux", "interface", "responsive", "layout", "component",
        "design", "figma", "website", "landing", "редизайн", "дизайн", "интерфейс", "сайт",
        "лендинг", "верстка", "адаптив",
    ],
    "backend": [
        "backend", "api", "server", "database", "db", "sql", "postgres", "redis", "celery",
        "queue", "worker", "fastapi", "сервер", "бэкенд", "база данных", "очередь",
    ],
    "project": [
        "project", "repository", "repo", "workspace", "project map", "agents.md", "репозиторий",
        "проект", "карта проекта", "агент",
    ],
    "knowledge": [
        "knowledge", "docs", "documentation", "note", "notes", "obsidian", "vault", "база знаний",
        "документация", "заметка", "обсидиан",
    ],
    "skill": [
        "skill", "skills", "workflow", "runbook", "prompt", "routing", "скилл", "скиллы",
        "навык", "воркфлоу", "промпт",
    ],
    "skill_taxonomy": [
        "skill taxonomy", "skills map", "skill map", "skill groups", "skill domains",
        "skill subgroups", "related skills", "routing skills", "группы скиллов",
        "домены скиллов", "подгруппы скиллов", "связанные навыки",
        "маршрутизация навыков", "таксономия скиллов", "каталог скиллов",
    ],
    "mcp": [
        "mcp", "model context protocol", "server", "tool", "tools", "мцп", "мсп", "сервер",
        "тул", "тулсы", "инструмент",
    ],
    "semantic_search": [
        "semantic", "semantics", "embedding", "embeddings", "vector", "vectors", "hybrid search",
        "meaning", "similarity", "семантический", "семантика", "эмбеддинг", "эмбеддинги",
        "вектор", "вектора", "по смыслу", "гибридный поиск",
    ],
    "integration": [
        "integration", "integrate", "connector", "oauth", "webhook", "api integration",
        "интеграция", "коннектор", "вебхук",
    ],
    "database_migration": [
        "database migration", "schema migration", "alembic", "backfill", "rollback",
        "миграция базы", "миграцию базы", "миграция схемы", "схема базы", "бэкфил", "откат миграции",
    ],
    "api_contract": [
        "api contract", "openapi", "response schema", "request schema", "backward compatibility",
        "контракт api", "контракт апи", "схема ответа", "схема запроса", "обратная совместимость",
    ],
    "security": [
        "security", "threat model", "authorization", "authentication", "vulnerability", "xss", "csrf",
        "безопасность", "модель угроз", "авторизация", "аутентификация", "уязвимость",
    ],
    "secrets": [
        "secret", "credential", "dependency audit", "supply chain", "lockfile",
        "секрет", "учетные данные", "зависимости", "цепочка поставок", "утечка ключа",
    ],
    "devops": [
        "deployment", "release", "rollback", "ci/cd", "github actions",
        "деплой", "развертывание", "релиз", "откат", "сборочный пайплайн",
    ],
    "container": [
        "docker", "dockerfile", "compose", "container", "kubernetes", "helm",
        "докер", "контейнер", "кубернетес", "кубер", "хелм",
    ],
    "data_pipeline": [
        "data pipeline", "etl", "ingestion", "lineage", "data quality",
        "пайплайн данных", "загрузка данных", "импорт данных", "качество данных", "происхождение данных",
    ],
    "llm": [
        "llm", "rag", "embedding", "prompt", "tool calling", "structured output",
        "нейросеть", "эмбеддинг", "промпт", "вызов инструментов", "структурированный ответ",
    ],
    "landing_conversion": [
        "landing", "conversion", "cta", "hero", "pricing", "trust proof",
        "лендинг", "конверсия", "призыв к действию", "первый экран", "тарифы", "доверие",
    ],
    "accessibility": [
        "accessibility", "a11y", "wcag", "keyboard navigation", "screen reader",
        "доступность", "клавиатурная навигация", "скринридер", "читалка экрана",
    ],
    "gmail": ["gmail", "google mail", "email", "mail", "почта", "емейл"],
    "google_sheets": ["google sheets", "sheets", "spreadsheet", "таблица", "таблицы", "гугл таблицы"],
    "figma": ["figma", "figjam", "фигма"],
    "github": ["github", "git", "pull request", "pr", "issue", "actions", "ci"],
}


def print_json(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, indent=2))
    sys.stdout.write("\n")


def read_text(path):
    return path.read_text(encoding="utf-8-sig", errors="replace")


def sha_id(*parts):
    value = "\x1f".join(str(part) for part in parts)
    return hashlib.sha1(value.encode("utf-8", errors="replace")).hexdigest()


def rel_path(root, path):
    return path.relative_to(root).as_posix()


def first_heading(text, fallback):
    for line in text.splitlines():
        match = re.match(r"^#\s+(.+)$", line.strip())
        if match:
            return match.group(1).strip()
    return fallback


def clean_preview(text, limit=360):
    return re.sub(r"\s+", " ", text).strip()[:limit]


def stable_hash(value):
    digest = hashlib.blake2b(value.encode("utf-8", errors="replace"), digest_size=8).digest()
    return int.from_bytes(digest, "big", signed=False)


def normalize_token(token):
    token = token.lower().strip("_-.+#")
    if len(token) < 2:
        return ""
    if token in STOPWORDS:
        return ""
    return token


def tokenize_semantic(text):
    tokens = []
    for raw in re.findall(r"[0-9A-Za-zА-Яа-яЁё_+#.-]+", text.lower(), flags=re.UNICODE):
        for part in re.split(r"[_+#.-]+", raw):
            token = normalize_token(part)
            if token:
                tokens.append(token)
    return tokens


def semantic_terms(text):
    lowered = text.lower()
    tokens = tokenize_semantic(lowered)
    terms = list(tokens)

    for canonical, aliases in SEMANTIC_ALIASES.items():
        for alias in aliases:
            if alias in lowered:
                terms.extend([f"alias:{canonical}", canonical])
                break

    for token in tokens:
        if len(token) >= 5:
            limit = min(len(token), 24)
            for size in (3, 4):
                for index in range(0, max(0, limit - size + 1)):
                    terms.append(f"ng:{token[index:index + size]}")
        if token.endswith("ing") and len(token) > 5:
            terms.append(token[:-3])
        if token.endswith("ed") and len(token) > 4:
            terms.append(token[:-2])
    return terms


def add_vector_features(weights, text, base_weight=1.0, max_chars=60000):
    if not text:
        return
    counts = Counter(semantic_terms(text[:max_chars]))
    for term, count in counts.items():
        if not term:
            continue
        dim = stable_hash(term) % SEMANTIC_DIMENSIONS
        weights[dim] = weights.get(dim, 0.0) + base_weight * (1.0 + math.log(count))


def build_semantic_vector(doc):
    weights = {}
    add_vector_features(weights, doc.get("title", ""), 5.0, 2000)
    add_vector_features(weights, doc.get("categories", ""), 3.0, 2000)
    add_vector_features(weights, doc.get("source", ""), 2.5, 1000)
    add_vector_features(weights, doc.get("path", ""), 2.0, 4000)
    add_vector_features(weights, doc.get("body", ""), 1.0, 60000)

    if not weights:
        return {}, 0.0

    selected = sorted(weights.items(), key=lambda item: abs(item[1]), reverse=True)[:MAX_VECTOR_FEATURES]
    norm = math.sqrt(sum(value * value for _, value in selected))
    if norm <= 0:
        return {}, 0.0
    vector = {str(dim): round(value / norm, 8) for dim, value in selected}
    return vector, 1.0


def build_query_vector(query):
    doc = {
        "title": query,
        "categories": "",
        "source": "",
        "path": "",
        "body": query,
    }
    vector, _ = build_semantic_vector(doc)
    return vector


def sparse_dot(left, right):
    if not left or not right:
        return 0.0
    if len(left) > len(right):
        left, right = right, left
    score = 0.0
    for key, value in left.items():
        score += float(value) * float(right.get(key, 0.0))
    return score


def dense_passage_text(doc, limit=DEFAULT_DENSE_TEXT_LIMIT):
    parts = [
        f"Title: {doc.get('title', '')}",
        f"Scope: {doc.get('scope', '')}",
        f"Source: {doc.get('source', '')}",
        f"Categories: {doc.get('categories', '')}",
        f"Path: {doc.get('path', '')}",
        "",
        str(doc.get("body", "")),
    ]
    text = "\n".join(part for part in parts if part is not None)
    text = re.sub(r"\s+", " ", text).strip()
    return f"passage: {text[:limit]}"


def dense_query_text(query):
    return f"query: {query.strip()}"


def dense_content_hash(text):
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def document_content_hash(doc):
    payload = "\x1f".join([
        str(doc.get("scope", "")),
        str(doc.get("title", "")),
        str(doc.get("path", "")),
        str(doc.get("source", "")),
        str(doc.get("categories", "")),
        str(doc.get("body", "")),
    ])
    return hashlib.sha256(payload.encode("utf-8", errors="replace")).hexdigest()


def source_fingerprint(docs):
    digest = hashlib.sha256()
    for doc in sorted(docs, key=lambda item: item["id"]):
        digest.update(doc["id"].encode("utf-8", errors="replace"))
        digest.update(b"\x1f")
        digest.update(doc["content_hash"].encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def doc_is_membrane_skill(doc):
    source = str(doc.get("source", "")).lower()
    path_value = str(doc.get("path", "")).lower()
    return "membrane/application-skills" in source or "membrane/application-skills" in path_value


def should_dense_index_doc(doc, args):
    if doc_is_membrane_skill(doc) and not getattr(args, "dense_include_membrane", False):
        return False
    return True


def dense_vector_to_blob(values):
    vector = array("f", (float(value) for value in values))
    return vector.tobytes()


def dense_blob_to_vector(blob):
    vector = array("f")
    vector.frombytes(bytes(blob))
    return vector


def dense_vector_from_json_file(path_value):
    if not path_value:
        return None
    path = Path(path_value)
    if not path.exists():
        return None
    payload = json.loads(read_text(path))
    if isinstance(payload, dict):
        payload = payload.get("embedding") or payload.get("vector") or payload.get("embeddings", [None])[0]
    if not isinstance(payload, list):
        return None
    return array("f", (float(value) for value in payload))


def dense_dot(query_vector, blob):
    if not query_vector or not blob:
        return 0.0
    vector = dense_blob_to_vector(blob)
    if len(vector) != len(query_vector):
        return 0.0
    return sum(left * right for left, right in zip(query_vector, vector))


def dense_doc_records(docs, args):
    records = []
    for doc in docs:
        if not should_dense_index_doc(doc, args):
            continue
        text = dense_passage_text(doc, args.dense_text_limit)
        records.append({
            "id": doc["id"],
            "text": text,
            "content_hash": dense_content_hash(text),
            "mtime": float(doc.get("mtime") or 0.0),
        })
    return records


def read_existing_index(index_path, reader):
    last_error = None
    attempts = len(SQLITE_READ_RETRY_DELAYS) + 1
    for attempt in range(attempts):
        con = None
        try:
            con = connect(index_path)
            return reader(con)
        except sqlite3.OperationalError as exc:
            message = str(exc).lower()
            if "locked" not in message and "busy" not in message:
                raise
            last_error = exc
            if attempt < len(SQLITE_READ_RETRY_DELAYS):
                time.sleep(SQLITE_READ_RETRY_DELAYS[attempt])
        finally:
            if con is not None:
                con.close()
    raise RuntimeError(f"SQLite index remained busy after {attempts} attempts: {index_path}") from last_error


@contextmanager
def index_rebuild_lock(index_path, timeout=DEFAULT_REBUILD_LOCK_TIMEOUT):
    lock_path = Path(f"{index_path}.rebuild.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(lock_path, "a+b")
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b"\0")
        handle.flush()

    deadline = time.monotonic() + max(0.0, float(timeout))
    locked = False
    try:
        while not locked:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Timed out waiting for search-index rebuild lock: {lock_path}") from exc
                time.sleep(0.1)
        yield
    finally:
        if locked:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def load_existing_dense_cache(index_path):
    index_path = Path(index_path)
    if not index_path.exists():
        return {}

    def read(con):
        table = con.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dense_vectors'"
        ).fetchone()
        if not table:
            return {}
        columns = {row[1] for row in con.execute("PRAGMA table_info(dense_vectors)").fetchall()}
        required = {"id", "vector", "dimensions", "model", "content_hash", "mtime"}
        if not required.issubset(columns):
            return {}
        cache = {}
        for row in con.execute("SELECT id, vector, dimensions, model, content_hash, mtime FROM dense_vectors"):
            cache[row["id"]] = {
                "vector": row["vector"],
                "dimensions": int(row["dimensions"]),
                "model": row["model"],
                "content_hash": row["content_hash"],
                "mtime": float(row["mtime"] or 0.0),
            }
        return cache

    return read_existing_index(index_path, read)


def load_existing_meta(index_path):
    index_path = Path(index_path)
    if not index_path.exists():
        return {}

    def read(con):
        table = con.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
        ).fetchone()
        if not table:
            return {}
        return {
            str(row["key"]): str(row["value"])
            for row in con.execute("SELECT key, value FROM meta")
        }

    return read_existing_index(index_path, read)


def preserve_existing_dense_vectors(docs, args, index_path):
    records = dense_doc_records(docs, args)
    cache = load_existing_dense_cache(index_path)
    vectors = {}
    for record in records:
        cached = cache.get(record["id"])
        if (
            cached
            and cached.get("model") == DENSE_MODEL_NAME
            and cached.get("dimensions") == DENSE_DIMENSIONS
            and cached.get("content_hash") == record["content_hash"]
        ):
            vectors[record["id"]] = {
                "vector": cached["vector"],
                "content_hash": record["content_hash"],
                "mtime": record["mtime"],
                "reused": True,
            }
    return vectors, {
        "eligible": len(records),
        "reused": len(vectors),
        "encoded": 0,
        "pending": max(0, len(records) - len(vectors)),
    }


def load_dense_model(model_dir, device):
    try:
        from sentence_transformers import SentenceTransformer
    except Exception as err:
        raise RuntimeError(
            "sentence-transformers is required for dense BGE-M3 embeddings. "
            "Run this command with the embeddings virtualenv Python."
        ) from err

    model_dir = Path(model_dir).expanduser()
    if not model_dir.exists():
        raise RuntimeError(f"Dense model directory does not exist: {model_dir}")
    if not (model_dir / "pytorch_model.bin").exists():
        raise RuntimeError(f"Dense model weights are missing: {model_dir / 'pytorch_model.bin'}")
    return SentenceTransformer(str(model_dir), device=device)


def encode_dense_texts(model, texts, batch_size=8, progress=False):
    embeddings = model.encode(
        texts,
        batch_size=max(1, int(batch_size)),
        normalize_embeddings=True,
        show_progress_bar=progress,
    )
    return [dense_vector_to_blob(row) for row in embeddings]


def build_dense_vectors(docs, args, index_path=None):
    records = dense_doc_records(docs, args)
    cache = load_existing_dense_cache(index_path) if getattr(args, "dense_incremental", True) else {}
    vectors = {}
    to_encode = []
    reused = 0

    for record in records:
        cached = cache.get(record["id"])
        if (
            cached
            and cached.get("model") == DENSE_MODEL_NAME
            and cached.get("dimensions") == DENSE_DIMENSIONS
            and cached.get("content_hash") == record["content_hash"]
        ):
            vectors[record["id"]] = {
                "vector": cached["vector"],
                "content_hash": record["content_hash"],
                "mtime": record["mtime"],
                "reused": True,
            }
            reused += 1
        else:
            to_encode.append(record)

    if to_encode:
        model = load_dense_model(args.dense_model_dir, args.dense_device)
        blobs = encode_dense_texts(
            model,
            [record["text"] for record in to_encode],
            args.dense_batch_size,
            args.dense_progress,
        )
        for record, blob in zip(to_encode, blobs):
            vectors[record["id"]] = {
                "vector": blob,
                "content_hash": record["content_hash"],
                "mtime": record["mtime"],
                "reused": False,
            }

    return vectors, {
        "eligible": len(records),
        "reused": reused,
        "encoded": len(to_encode),
    }


def build_dense_query_vector(query, model_dir, device):
    try:
        model = load_dense_model(model_dir, device)
        blob = encode_dense_texts(model, [dense_query_text(query)], 1, False)[0]
        return dense_blob_to_vector(blob)
    except Exception:
        return None


def should_skip_markdown(rel):
    lower = rel.lower()
    if lower.startswith("03-skills-catalog/groups/all-skills/"):
        return True
    if lower.startswith("03-skills-catalog/sources/"):
        return True
    if lower.startswith("03-skills-catalog/registries/"):
        return True
    if lower.startswith("09-mcp/search-index/"):
        return True
    return False


def infer_scope(rel):
    lower = rel.lower()
    name = Path(rel).name.lower()
    if lower.startswith("02-knowledge/projects/"):
        return "projects"
    if lower.startswith("04-agent-workflows/") or lower.startswith("06-prompts/"):
        return "workflows"
    if lower.startswith("07-quality-gates/") or "quality" in name or "gate" in name or re.search(r"(^|[\s._-])qa($|[\s._-])", name):
        return "quality"
    if lower.startswith("03-skills-catalog/"):
        return "skills"
    return "knowledge"


def iter_markdown_docs(vault_root):
    for dirpath, dirnames, filenames in os.walk(vault_root):
        dirnames[:] = [name for name in dirnames if name not in SKIP_DIRS]
        current = Path(dirpath)
        for filename in filenames:
            if not filename.lower().endswith(".md"):
                continue
            path = current / filename
            rel = rel_path(vault_root, path)
            if should_skip_markdown(rel):
                continue
            text = read_text(path)
            yield {
                "id": sha_id("note", rel),
                "scope": infer_scope(rel),
                "title": first_heading(text, Path(filename).stem),
                "path": rel,
                "source": "vault-note",
                "categories": "",
                "body": text,
                "preview": clean_preview(text),
                "mtime": path.stat().st_mtime,
            }


def load_skill_docs(vault_root):
    registry = vault_root / "03-skills-catalog" / "registries" / "skills.index.json"
    if not registry.exists():
        return []
    try:
        items = json.loads(read_text(registry))
    except Exception:
        return []

    docs = []
    for item in items:
        name = str(item.get("name") or "unnamed-skill")
        source = str(item.get("source") or "")
        categories = ", ".join(str(value) for value in item.get("categories") or [])
        body_parts = [
            name,
            source,
            str(item.get("type") or ""),
            str(item.get("primary_group") or ""),
            str(item.get("primary_group_label") or ""),
            " ".join(str(value) for value in item.get("subgroups") or []),
            " ".join(str(value) for value in item.get("task_types") or []),
            " ".join(str(value) for value in item.get("platforms") or []),
            " ".join(str(value) for value in item.get("related_skills") or []),
            " ".join(str(value) for value in item.get("frameworks") or []),
            " ".join(str(value) for value in item.get("languages") or []),
            " ".join(str(value) for value in item.get("conflicts") or []),
            str(item.get("maturity") or ""),
            str(item.get("trust_level") or ""),
            str(item.get("quality_status") or ""),
            str(item.get("quality_grade") or ""),
            f"quality score {item.get('quality_score')}" if item.get("quality_score") is not None else "",
            f"skill schema {item.get('skill_schema_version')}" if item.get("skill_schema_version") is not None else "",
            categories,
            str(item.get("description") or ""),
            str(item.get("use_when") or ""),
            " ".join(str(value) for value in item.get("requires") or []),
            str(item.get("compatibility") or ""),
            str(item.get("path") or ""),
        ]
        body = "\n".join(part for part in body_parts if part)
        docs.append({
            "id": sha_id("skill", source, name),
            "scope": "skills",
            "title": name,
            "path": f"03-skills-catalog/{item.get('path') or ''}".rstrip("/"),
            "source": source,
            "categories": categories,
            "body": body,
            "preview": clean_preview(body),
            "mtime": registry.stat().st_mtime,
        })
    return docs


def parse_project_path(text):
    patterns = [
        r"project_path:\s*[\"']?([^\"'\r\n]+)",
        r"-\s+Real git root:\s*`([^`]+)`",
        r"-\s+Repository path:\s*`([^`]+)`",
        r"-\s+Root:\s*`([^`]+)`",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            value = match.group(1).strip()
            if value:
                return Path(value)
    return None


def safe_child(root, child):
    try:
        root_resolved = root.resolve()
        child_resolved = child.resolve()
        return root_resolved == child_resolved or root_resolved in child_resolved.parents
    except Exception:
        return False


def load_project_file_docs(vault_root):
    projects_dir = vault_root / "02-knowledge" / "Projects"
    if not projects_dir.exists():
        return []

    docs = []
    for card in projects_dir.glob("*.md"):
        if card.name.lower() == "projects index.md":
            continue
        text = read_text(card)
        project_root = parse_project_path(text)
        if not project_root or not project_root.is_absolute() or not project_root.exists():
            continue
        for rel, scope, source, categories in [
            (Path(".ai-dev") / "project-brief.md", "projects", "project-brief", "project, handoff"),
            (Path(".ai-dev") / "project-map.md", "projects", "project-map", "project"),
            (Path(".ai-dev") / "quality-gate.md", "projects", "project-quality-gate", "project, quality"),
            (Path("AGENTS.md"), "projects", "project-agents", "project, rules"),
        ]:
            file_path = project_root / rel
            if not file_path.exists() or not safe_child(project_root, file_path):
                continue
            body = read_text(file_path)
            display_path = f"{project_root}{os.sep}{rel}"
            docs.append({
                "id": sha_id("project-file", str(file_path)),
                "scope": scope,
                "title": f"{project_root.name} / {rel.as_posix()}",
                "path": display_path,
                "source": source,
                "categories": categories,
                "body": body,
                "preview": clean_preview(body),
                "mtime": file_path.stat().st_mtime,
            })
    return docs


def connect(index_path):
    index_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(index_path, timeout=10.0)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout = 10000")
    return con


def collect_documents(vault_root, include_external_project_files=True):
    vault_root = Path(vault_root)
    docs = []
    docs.extend(iter_markdown_docs(vault_root))
    docs.extend(load_skill_docs(vault_root))
    if include_external_project_files:
        docs.extend(load_project_file_docs(vault_root))
    for doc in docs:
        doc["content_hash"] = document_content_hash(doc)
    return docs


def index_status(args):
    vault_root = Path(args.vault_root)
    index_path = Path(args.index_path)
    docs = collect_documents(vault_root, args.include_external_project_files)
    current = {doc["id"]: doc for doc in docs}
    current_fingerprint = source_fingerprint(docs)

    if not index_path.exists():
        print_json({
            "index_path": str(index_path),
            "index_exists": False,
            "stale": True,
            "schema_current": False,
            "reasons": ["index_missing"],
            "built_at": "",
            "indexed_document_count": 0,
            "current_document_count": len(docs),
            "added_count": len(docs),
            "changed_count": 0,
            "deleted_count": 0,
            "added": [doc["path"] for doc in docs[:20]],
            "changed": [],
            "deleted": [],
            "source_fingerprint": current_fingerprint,
            "indexed_fingerprint": "",
            "dense_enabled": False,
            "dense_documents": 0,
            "dense_pending_documents": 0,
        })
        return

    con = connect(index_path)
    try:
        tables = {
            row["name"]
            for row in con.execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        }
        if "documents" not in tables:
            print_json({
                "index_path": str(index_path),
                "index_exists": True,
                "stale": True,
                "schema_current": False,
                "reasons": ["documents_table_missing"],
                "built_at": "",
                "indexed_document_count": 0,
                "current_document_count": len(docs),
                "added_count": len(docs),
                "changed_count": 0,
                "deleted_count": 0,
                "added": [doc["path"] for doc in docs[:20]],
                "changed": [],
                "deleted": [],
                "source_fingerprint": current_fingerprint,
                "indexed_fingerprint": "",
                "dense_enabled": False,
                "dense_documents": 0,
                "dense_pending_documents": 0,
            })
            return

        columns = {row["name"] for row in con.execute("PRAGMA table_info(documents)")}
        schema_current = "content_hash" in columns
        select_hash = "content_hash" if schema_current else "'' AS content_hash"
        indexed_rows = con.execute(
            f"SELECT id, path, mtime, {select_hash} FROM documents"
        ).fetchall()
        indexed = {str(row["id"]): row for row in indexed_rows}
        current_ids = set(current)
        indexed_ids = set(indexed)
        added_ids = sorted(current_ids - indexed_ids)
        deleted_ids = sorted(indexed_ids - current_ids)
        changed_ids = sorted(
            doc_id for doc_id in current_ids & indexed_ids
            if not schema_current or str(indexed[doc_id]["content_hash"] or "") != current[doc_id]["content_hash"]
        )

        meta = {}
        if "meta" in tables:
            meta = {
                str(row["key"]): str(row["value"])
                for row in con.execute("SELECT key, value FROM meta")
            }
        reasons = []
        if not schema_current:
            reasons.append("schema_outdated")
        if added_ids:
            reasons.append("sources_added")
        if changed_ids:
            reasons.append("sources_changed")
        if deleted_ids:
            reasons.append("sources_deleted")
        indexed_fingerprint = meta.get("source_fingerprint", "")
        if schema_current and not reasons and indexed_fingerprint and indexed_fingerprint != current_fingerprint:
            reasons.append("source_fingerprint_mismatch")

        dense_enabled = meta.get("dense_enabled", "false").lower() == "true"
        dense_documents = int(meta.get("dense_documents", "0") or 0)
        dense_pending = int(meta.get("dense_pending_documents", "0") or 0)
        print_json({
            "index_path": str(index_path),
            "index_exists": True,
            "stale": bool(reasons),
            "schema_current": schema_current,
            "schema_version": int(meta.get("schema_version", "0") or 0),
            "reasons": reasons,
            "built_at": meta.get("built_at", ""),
            "indexed_document_count": len(indexed),
            "current_document_count": len(docs),
            "added_count": len(added_ids),
            "changed_count": len(changed_ids),
            "deleted_count": len(deleted_ids),
            "added": [current[doc_id]["path"] for doc_id in added_ids[:20]],
            "changed": [current[doc_id]["path"] for doc_id in changed_ids[:20]],
            "deleted": [str(indexed[doc_id]["path"]) for doc_id in deleted_ids[:20]],
            "source_fingerprint": current_fingerprint,
            "indexed_fingerprint": indexed_fingerprint,
            "dense_enabled": dense_enabled,
            "dense_documents": dense_documents,
            "dense_pending_documents": dense_pending,
        })
    finally:
        con.close()


def rebuild(args):
    timeout = float(os.environ.get("AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT", DEFAULT_REBUILD_LOCK_TIMEOUT))
    with index_rebuild_lock(args.index_path, timeout=timeout):
        return rebuild_locked(args)


def rebuild_locked(args):
    vault_root = Path(args.vault_root)
    index_path = Path(args.index_path)
    docs = collect_documents(vault_root, args.include_external_project_files)
    previous_meta = load_existing_meta(index_path)

    preserve_dense = bool(
        getattr(args, "preserve_dense", False)
        and previous_meta.get("dense_enabled", "false").lower() == "true"
    )
    if preserve_dense and not args.dense_embeddings:
        args.dense_text_limit = int(previous_meta.get("dense_text_limit", args.dense_text_limit) or args.dense_text_limit)
        args.dense_include_membrane = previous_meta.get("dense_include_membrane", "false").lower() == "true"

    dense_vectors = {}
    dense_stats = {"eligible": 0, "reused": 0, "encoded": 0, "pending": 0}
    dense_started = time.time()
    if args.dense_embeddings:
        dense_vectors, dense_stats = build_dense_vectors(docs, args, index_path)
        dense_stats["pending"] = 0
    elif preserve_dense:
        dense_vectors, dense_stats = preserve_existing_dense_vectors(docs, args, index_path)
    dense_active = bool(args.dense_embeddings or preserve_dense)
    dense_seconds = round(time.time() - dense_started, 3) if dense_active else 0.0

    con = connect(index_path)
    con.executescript(
        """
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS documents;
        DROP TABLE IF EXISTS docs_fts;
        DROP TABLE IF EXISTS semantic_vectors;
        DROP TABLE IF EXISTS dense_vectors;
        DROP TABLE IF EXISTS meta;
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE documents(
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          title TEXT NOT NULL,
          path TEXT NOT NULL,
          source TEXT NOT NULL,
          categories TEXT NOT NULL,
          preview TEXT NOT NULL,
          mtime REAL NOT NULL,
          content_hash TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE docs_fts USING fts5(
          id UNINDEXED,
          title,
          body,
          path,
          source,
          categories,
          tokenize='unicode61'
        );
        CREATE TABLE semantic_vectors(
          id TEXT PRIMARY KEY,
          vector TEXT NOT NULL,
          norm REAL NOT NULL
        );
        CREATE TABLE dense_vectors(
          id TEXT PRIMARY KEY,
          vector BLOB NOT NULL,
          dimensions INTEGER NOT NULL,
          model TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          mtime REAL NOT NULL
        );
        CREATE INDEX dense_vectors_hash_idx ON dense_vectors(content_hash);
        """
    )

    semantic_documents = 0
    dense_documents = 0
    dense_reused_documents = 0
    dense_encoded_documents = 0
    for doc in docs:
        con.execute(
            "INSERT INTO documents(id, scope, title, path, source, categories, preview, mtime, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                doc["id"],
                doc["scope"],
                doc["title"],
                doc["path"],
                doc["source"],
                doc["categories"],
                doc["preview"],
                doc["mtime"],
                doc["content_hash"],
            ),
        )
        con.execute(
            "INSERT INTO docs_fts(id, title, body, path, source, categories) VALUES (?, ?, ?, ?, ?, ?)",
            (
                doc["id"],
                doc["title"],
                doc["body"],
                doc["path"],
                doc["source"],
                doc["categories"],
            ),
        )
        vector, norm = build_semantic_vector(doc)
        if vector:
            semantic_documents += 1
        con.execute(
            "INSERT INTO semantic_vectors(id, vector, norm) VALUES (?, ?, ?)",
            (
                doc["id"],
                json.dumps(vector, ensure_ascii=False, separators=(",", ":")),
                norm,
            ),
        )
        dense_entry = dense_vectors.get(doc["id"])
        if dense_entry:
            dense_documents += 1
            if dense_entry.get("reused"):
                dense_reused_documents += 1
            else:
                dense_encoded_documents += 1
            con.execute(
                "INSERT INTO dense_vectors(id, vector, dimensions, model, content_hash, mtime) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    doc["id"],
                    dense_entry["vector"],
                    DENSE_DIMENSIONS,
                    DENSE_MODEL_NAME,
                    dense_entry["content_hash"],
                    dense_entry["mtime"],
                ),
            )

    by_scope = {}
    for doc in docs:
        by_scope[doc["scope"]] = by_scope.get(doc["scope"], 0) + 1

    dense_pending_documents = max(0, int(dense_stats.get("pending", 0)))
    dense_eligible_documents = int(dense_stats.get("eligible", 0)) if dense_active else 0
    con.execute("INSERT INTO meta(key, value) VALUES ('schema_version', ?)", (str(INDEX_SCHEMA_VERSION),))
    con.execute("INSERT INTO meta(key, value) VALUES ('built_at', ?)", (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),))
    con.execute("INSERT INTO meta(key, value) VALUES ('source_fingerprint', ?)", (source_fingerprint(docs),))
    con.execute("INSERT INTO meta(key, value) VALUES ('document_count', ?)", (str(len(docs)),))
    con.execute("INSERT INTO meta(key, value) VALUES ('semantic_dimensions', ?)", (str(SEMANTIC_DIMENSIONS),))
    con.execute("INSERT INTO meta(key, value) VALUES ('semantic_documents', ?)", (str(semantic_documents),))
    con.execute("INSERT INTO meta(key, value) VALUES ('dense_enabled', ?)", ("true" if dense_active else "false",))
    con.execute("INSERT INTO meta(key, value) VALUES ('dense_model', ?)", (DENSE_MODEL_NAME,))
    con.execute("INSERT INTO meta(key, value) VALUES ('dense_model_dir', ?)", (str(Path(args.dense_model_dir).expanduser()),))
    con.execute("INSERT INTO meta(key, value) VALUES ('dense_dimensions', ?)", (str(DENSE_DIMENSIONS),))
    con.execute("INSERT INTO meta(key, value) VALUES ('dense_documents', ?)", (str(dense_documents),))
    con.execute("INSERT INTO meta(key, value) VALUES ('dense_reused_documents', ?)", (str(dense_reused_documents),))
    con.execute("INSERT INTO meta(key, value) VALUES ('dense_encoded_documents', ?)", (str(dense_encoded_documents),))
    con.execute("INSERT INTO meta(key, value) VALUES ('dense_eligible_documents', ?)", (str(dense_eligible_documents),))
    con.execute("INSERT INTO meta(key, value) VALUES ('dense_pending_documents', ?)", (str(dense_pending_documents),))
    con.execute("INSERT INTO meta(key, value) VALUES ('dense_skipped_documents', ?)", (str(max(0, len(docs) - dense_eligible_documents)),))
    con.execute("INSERT INTO meta(key, value) VALUES ('dense_include_membrane', ?)", ("true" if getattr(args, "dense_include_membrane", False) else "false",))
    con.execute("INSERT INTO meta(key, value) VALUES ('dense_incremental', ?)", ("true" if getattr(args, "dense_incremental", True) else "false",))
    con.execute("INSERT INTO meta(key, value) VALUES ('dense_text_limit', ?)", (str(args.dense_text_limit),))
    con.commit()
    con.close()

    print_json({
        "index_path": str(index_path),
        "document_count": len(docs),
        "semantic_documents": semantic_documents,
        "semantic_dimensions": SEMANTIC_DIMENSIONS,
        "schema_version": INDEX_SCHEMA_VERSION,
        "source_fingerprint": source_fingerprint(docs),
        "dense_enabled": dense_active,
        "dense_documents": dense_documents,
        "dense_reused_documents": dense_reused_documents,
        "dense_encoded_documents": dense_encoded_documents,
        "dense_eligible_documents": dense_eligible_documents,
        "dense_pending_documents": dense_pending_documents,
        "dense_skipped_documents": max(0, len(docs) - dense_eligible_documents) if dense_active else len(docs),
        "dense_preserved": bool(preserve_dense and not args.dense_embeddings),
        "dense_include_membrane": bool(getattr(args, "dense_include_membrane", False)),
        "dense_incremental": bool(getattr(args, "dense_incremental", True)),
        "dense_dimensions": DENSE_DIMENSIONS if dense_active else 0,
        "dense_seconds": dense_seconds,
        "dense_model": DENSE_MODEL_NAME if dense_active else "",
        "by_scope": by_scope,
    })


def fts_query(query):
    terms = re.findall(r"[\w]+", query, flags=re.UNICODE)
    cleaned = []
    for term in terms:
        if not term:
            continue
        term = term.replace('"', "")
        if len(term) > 2:
            cleaned.append(f"{term}*")
        else:
            cleaned.append(term)
    return " ".join(cleaned)


def split_csv(value):
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def add_scope_filter(where, params, scope):
    if not scope or scope == "all":
        return
    if scope == "quality":
        where.append("(d.scope = ? OR d.categories LIKE ? OR d.source LIKE ?)")
        params.extend(["quality", "%quality%", "%quality%"])
        return
    where.append("d.scope = ?")
    params.append(scope)


def add_like_filter(where, params, field, values):
    if not values:
        return
    clauses = []
    for value in values:
        clauses.append(f"d.{field} LIKE ?")
        params.append(f"%{value}%")
    where.append("(" + " OR ".join(clauses) + ")")


def row_to_result(row):
    return {
        "scope": row["scope"],
        "title": row["title"],
        "path": row["path"],
        "source": row["source"],
        "categories": row["categories"],
        "score": row["score"],
        "preview": row["snippet"] or row["preview"],
    }


def add_common_filters(where, params, args):
    add_scope_filter(where, params, args.scope)

    if args.project:
        value = f"%{args.project}%"
        where.append("(d.title LIKE ? OR d.path LIKE ? OR d.source LIKE ?)")
        params.extend([value, value, value])
    add_like_filter(where, params, "source", split_csv(args.source))
    add_like_filter(where, params, "categories", split_csv(args.categories))
    for folder in split_csv(args.folders):
        where.append("d.path LIKE ?")
        params.append(f"{folder.rstrip('/')}%")


def keyword_candidate_rows(con, args, limit):
    match_query = fts_query(args.query)
    if not match_query:
        return []

    params = [match_query]
    where = ["docs_fts MATCH ?"]
    add_common_filters(where, params, args)
    sql = f"""
      SELECT
        d.id,
        d.scope,
        d.title,
        d.path,
        d.source,
        d.categories,
        d.preview,
        bm25(docs_fts) AS raw_score,
        snippet(docs_fts, 2, '[', ']', '...', 18) AS snippet
      FROM docs_fts
      JOIN documents d ON d.id = docs_fts.id
      WHERE {' AND '.join(where)}
      ORDER BY raw_score ASC
      LIMIT ?
    """
    try:
        return con.execute(sql, [*params, limit]).fetchall()
    except sqlite3.OperationalError:
        return []


def semantic_candidate_rows(con, args):
    params = []
    where = []
    add_common_filters(where, params, args)
    sql = f"""
      SELECT
        d.id,
        d.scope,
        d.title,
        d.path,
        d.source,
        d.categories,
        d.preview,
        v.vector
      FROM documents d
      JOIN semantic_vectors v ON v.id = d.id
      {'WHERE ' + ' AND '.join(where) if where else ''}
    """
    return con.execute(sql, params).fetchall()


def table_exists(con, name):
    row = con.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        (name,),
    ).fetchone()
    return bool(row)


def meta_value(con, key, fallback=""):
    if not table_exists(con, "meta"):
        return fallback
    row = con.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else fallback


def dense_candidate_rows(con, args):
    if not table_exists(con, "dense_vectors"):
        return []
    params = []
    where = []
    add_common_filters(where, params, args)
    sql = f"""
      SELECT
        d.id,
        d.scope,
        d.title,
        d.path,
        d.source,
        d.categories,
        d.preview,
        v.vector AS dense_vector,
        v.dimensions AS dense_dimensions
      FROM documents d
      JOIN dense_vectors v ON v.id = d.id
      {'WHERE ' + ' AND '.join(where) if where else ''}
    """
    return con.execute(sql, params).fetchall()


def clamp_weight(value, fallback):
    try:
        number = float(value)
    except Exception:
        return fallback
    return max(0.0, min(1.0, number))


def lexical_boost(query, row):
    query_terms = set(tokenize_semantic(query))
    if not query_terms:
        return 0.0
    haystack = " ".join(
        str(row.get(key, ""))
        for key in ("title", "path", "source", "categories", "preview")
    ).lower()
    matches = sum(1 for term in query_terms if term in haystack)
    return min(0.15, 0.15 * (matches / max(1, len(query_terms))))


def row_is_membrane_skill(row):
    source = str(row.get("source", "")).lower()
    path = str(row.get("path", "")).lower()
    return "membrane/application-skills" in source or "membrane/application-skills" in path


def query_has_app_integration_intent(query):
    lowered = query.lower()
    app_words = (
        "gmail", "google sheets", "google drive", "slack", "notion", "linear", "jira",
        "figma", "github", "stripe", "shopify", "salesforce", "hubspot", "discord",
        "почта", "таблица", "таблицы", "фигма",
    )
    intent_words = (
        "integrat", "connect", "sync", "import", "export", "webhook", "oauth", "send",
        "read from", "write to", "интеграц", "подключ", "синхрон", "импорт", "экспорт",
        "вебхук", "отправ", "прочит",
    )
    if any(word in lowered for word in app_words) and any(word in lowered for word in intent_words):
        return True
    return "app integration" in lowered or "application skill" in lowered


def query_excludes_membrane(query):
    lowered = query.lower()
    if "membrane" not in lowered and "мембран" not in lowered:
        return False
    return bool(re.search(r"(без|exclude|filter|hide|noise|noisy|шум|скры|фильтр|не\s+показыв|не\s+тащ)", lowered))


def hybrid_result(row, score, keyword_score, semantic_score, dense_score):
    return {
        "scope": row["scope"],
        "title": row["title"],
        "path": row["path"],
        "source": row["source"],
        "categories": row["categories"],
        "score": round(score, 6),
        "keyword_score": round(keyword_score, 6),
        "semantic_score": round(semantic_score, 6),
        "dense_score": round(dense_score, 6),
        "mode": "hybrid",
        "preview": row.get("snippet") or row["preview"],
    }


def canonical_result_key(item):
    scope = str(item.get("scope") or "")
    title = re.sub(r"\s+", " ", str(item.get("title") or "")).strip().casefold()
    result_path = str(item.get("path") or "").replace("\\", "/").casefold()
    is_skill_entity = scope == "skills" and (
        result_path.startswith("03-skills-catalog/cards/")
        or ("/sources/" in result_path and result_path.endswith("/skill.md"))
    )
    if is_skill_entity and title:
        return f"skill:{title}"
    return f"path:{result_path}"


def result_entity_priority(item):
    result_path = str(item.get("path") or "").replace("\\", "/").casefold()
    source = str(item.get("source") or "").casefold()
    if "/sources/custom/" in result_path and result_path.endswith("/skill.md"):
        return 40
    if "/sources/" in result_path and result_path.endswith("/skill.md") and source != "vault-note":
        return 30
    if result_path.startswith("03-skills-catalog/cards/"):
        return 20
    return 10


def collapse_search_results(results):
    collapsed = {}
    order = []
    for item in results:
        key = canonical_result_key(item)
        if key not in collapsed:
            collapsed[key] = dict(item)
            collapsed[key]["collapsed_duplicates"] = []
            order.append(key)
            continue
        current = collapsed[key]
        all_duplicates = [
            *current.get("collapsed_duplicates", []),
            current.get("path"),
            item.get("path"),
        ]
        if result_entity_priority(item) > result_entity_priority(current):
            ranking = {
                name: current[name]
                for name in ("score", "keyword_score", "semantic_score", "dense_score", "mode")
                if name in current
            }
            replacement = dict(item)
            replacement.update(ranking)
            replacement["collapsed_duplicates"] = all_duplicates
            collapsed[key] = replacement
        else:
            current["collapsed_duplicates"] = all_duplicates

    output = []
    for key in order:
        item = collapsed[key]
        duplicates = [value for value in item.pop("collapsed_duplicates", []) if value and value != item.get("path")]
        unique_duplicates = list(dict.fromkeys(duplicates))
        if unique_duplicates:
            item["duplicate_count"] = len(unique_duplicates)
            item["collapsed_duplicates"] = unique_duplicates
        output.append(item)
    return output


def hybrid_search(args):
    index_path = Path(args.index_path)
    if not index_path.exists():
        raise SystemExit(f"Search index does not exist: {index_path}")

    query = args.query.strip()
    if not query:
        print_json([])
        return

    limit = max(1, min(args.limit, 50))
    # Retrieval depth must not change when callers only change output size.
    # A fixed pool keeps the ranking prefix stable and avoids hiding relevant
    # dense candidates behind a small requested limit.
    candidate_limit = HYBRID_CANDIDATE_LIMIT
    semantic_weight = clamp_weight(args.semantic_weight, 0.20)
    keyword_weight = clamp_weight(args.keyword_weight, 0.45)
    dense_weight = clamp_weight(getattr(args, "dense_weight", 0.35), 0.35)
    app_integration_intent = query_has_app_integration_intent(query)
    excludes_membrane = query_excludes_membrane(query)

    query_vector = build_query_vector(query)
    con = connect(index_path)
    rows_by_id = {}
    keyword_scores = {}
    semantic_scores = {}
    dense_scores = {}

    try:
        dense_available = table_exists(con, "dense_vectors") and meta_value(con, "dense_enabled", "false") == "true"
        dense_query_vector = None
        if dense_available and dense_weight > 0:
            dense_query_vector = dense_vector_from_json_file(getattr(args, "dense_query_vector_path", ""))
            if dense_query_vector is None:
                dense_query_vector = build_dense_query_vector(
                    query,
                    getattr(args, "dense_model_dir", DEFAULT_DENSE_MODEL_DIR),
                    getattr(args, "dense_device", "cpu"),
                )
        if dense_query_vector is None:
            dense_weight = 0.0

        total_weight = keyword_weight + semantic_weight + dense_weight
        if total_weight <= 0:
            keyword_weight = 0.45
            semantic_weight = 0.20
            dense_weight = 0.35 if dense_query_vector is not None else 0.0
            total_weight = keyword_weight + semantic_weight + dense_weight
        keyword_weight /= total_weight
        semantic_weight /= total_weight
        dense_weight /= total_weight

        keyword_rows = keyword_candidate_rows(con, args, candidate_limit)
        for rank, row in enumerate(keyword_rows):
            row_dict = dict(row)
            rows_by_id[row_dict["id"]] = row_dict
            keyword_scores[row_dict["id"]] = 1.0 / (rank + 1)

        semantic_rows = semantic_candidate_rows(con, args)
        semantic_ranked = []
        for row in semantic_rows:
            row_dict = dict(row)
            try:
                vector = json.loads(row_dict.get("vector") or "{}")
            except Exception:
                vector = {}
            score = sparse_dot(query_vector, vector)
            if score <= 0:
                continue
            semantic_ranked.append((score, row_dict))

        semantic_ranked.sort(key=lambda item: item[0], reverse=True)
        for score, row_dict in semantic_ranked[:candidate_limit]:
            rows_by_id.setdefault(row_dict["id"], row_dict)
            semantic_scores[row_dict["id"]] = max(0.0, min(1.0, score))

        if dense_query_vector is not None and dense_weight > 0:
            dense_ranked = []
            for row in dense_candidate_rows(con, args):
                row_dict = dict(row)
                score = dense_dot(dense_query_vector, row_dict.get("dense_vector"))
                if score <= 0:
                    continue
                row_dict.pop("dense_vector", None)
                dense_ranked.append((score, row_dict))
            dense_ranked.sort(key=lambda item: item[0], reverse=True)
            for score, row_dict in dense_ranked[:candidate_limit]:
                rows_by_id.setdefault(row_dict["id"], row_dict)
                dense_scores[row_dict["id"]] = max(0.0, min(1.0, score))
    finally:
        con.close()

    combined = []
    for doc_id, row in rows_by_id.items():
        keyword_score = keyword_scores.get(doc_id, 0.0)
        semantic_score = semantic_scores.get(doc_id, 0.0)
        dense_score = dense_scores.get(doc_id, 0.0)
        boost = lexical_boost(query, row)
        score = (
            (keyword_weight * keyword_score) +
            (semantic_weight * semantic_score) +
            (dense_weight * dense_score) +
            boost
        )
        if row_is_membrane_skill(row):
            if excludes_membrane:
                score *= 0.12
            elif not app_integration_intent:
                score *= 0.35
        elif row.get("source") == "vault-note":
            score += 0.04
        if score <= 0:
            continue
        combined.append(hybrid_result(row, score, keyword_score, semantic_score, dense_score))

    combined.sort(key=lambda item: (-item["score"], item["path"]))
    print_json(collapse_search_results(combined)[:limit])


def search(args):
    index_path = Path(args.index_path)
    if not index_path.exists():
        raise SystemExit(f"Search index does not exist: {index_path}")

    query = args.query.strip()
    if not query:
        print_json([])
        return

    con = connect(index_path)
    params = []
    where = []
    match_query = fts_query(query)
    if not match_query:
        print_json([])
        return

    where.append("docs_fts MATCH ?")
    params.append(match_query)
    add_common_filters(where, params, args)

    limit = max(1, min(args.limit, 50))
    sql = f"""
      SELECT
        d.scope,
        d.title,
        d.path,
        d.source,
        d.categories,
        d.preview,
        bm25(docs_fts) AS score,
        snippet(docs_fts, 2, '[', ']', '...', 18) AS snippet
      FROM docs_fts
      JOIN documents d ON d.id = docs_fts.id
      WHERE {' AND '.join(where)}
      ORDER BY score ASC
      LIMIT ?
    """
    candidate_limit = max(50, min(250, limit * 5))
    params.append(candidate_limit)

    try:
        rows = con.execute(sql, params).fetchall()
    except sqlite3.OperationalError:
        like = f"%{query}%"
        fallback_where = []
        fallback_params = [like, like, like, like]
        add_scope_filter(fallback_where, fallback_params, args.scope)
        fallback_sql = f"""
          SELECT
            d.scope,
            d.title,
            d.path,
            d.source,
            d.categories,
            d.preview,
            0.0 AS score,
            d.preview AS snippet
          FROM docs_fts
          JOIN documents d ON d.id = docs_fts.id
          WHERE (docs_fts.title LIKE ? OR docs_fts.body LIKE ? OR d.path LIKE ? OR d.source LIKE ?)
          {'AND ' + ' AND '.join(fallback_where) if fallback_where else ''}
          LIMIT ?
        """
        rows = con.execute(fallback_sql, [*fallback_params, candidate_limit]).fetchall()
    finally:
        con.close()

    print_json(collapse_search_results([row_to_result(row) for row in rows])[:limit])


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="AI Dev System SQLite FTS helper")
    sub = parser.add_subparsers(dest="command", required=True)

    rebuild_parser = sub.add_parser("rebuild")
    rebuild_parser.add_argument("--vault-root", required=True)
    rebuild_parser.add_argument("--index-path", required=True)
    rebuild_parser.add_argument("--include-external-project-files", action="store_true")
    rebuild_parser.add_argument("--dense-embeddings", action="store_true")
    rebuild_parser.add_argument("--dense-model-dir", default=str(DEFAULT_DENSE_MODEL_DIR))
    rebuild_parser.add_argument("--dense-device", default=os.environ.get("BGE_M3_DEVICE", "cpu"))
    rebuild_parser.add_argument("--dense-batch-size", type=int, default=8)
    rebuild_parser.add_argument("--dense-text-limit", type=int, default=DEFAULT_DENSE_TEXT_LIMIT)
    rebuild_parser.add_argument("--dense-progress", action="store_true")
    rebuild_parser.add_argument("--dense-include-membrane", action="store_true")
    rebuild_parser.add_argument("--no-dense-incremental", action="store_false", dest="dense_incremental")
    rebuild_parser.add_argument("--preserve-dense", action="store_true")
    rebuild_parser.set_defaults(dense_incremental=True, func=rebuild)

    status_parser = sub.add_parser("status")
    status_parser.add_argument("--vault-root", required=True)
    status_parser.add_argument("--index-path", required=True)
    status_parser.add_argument("--include-external-project-files", action="store_true")
    status_parser.set_defaults(func=index_status)

    search_parser = sub.add_parser("search")
    search_parser.add_argument("--index-path", required=True)
    search_parser.add_argument("--query", required=True)
    search_parser.add_argument("--scope", default="all")
    search_parser.add_argument("--limit", type=int, default=10)
    search_parser.add_argument("--project", default="")
    search_parser.add_argument("--source", default="")
    search_parser.add_argument("--categories", default="")
    search_parser.add_argument("--folders", default="")
    search_parser.set_defaults(func=search)

    hybrid_parser = sub.add_parser("hybrid")
    hybrid_parser.add_argument("--index-path", required=True)
    hybrid_parser.add_argument("--query", required=True)
    hybrid_parser.add_argument("--scope", default="all")
    hybrid_parser.add_argument("--limit", type=int, default=10)
    hybrid_parser.add_argument("--project", default="")
    hybrid_parser.add_argument("--source", default="")
    hybrid_parser.add_argument("--categories", default="")
    hybrid_parser.add_argument("--folders", default="")
    hybrid_parser.add_argument("--semantic-weight", type=float, default=0.20)
    hybrid_parser.add_argument("--keyword-weight", type=float, default=0.45)
    hybrid_parser.add_argument("--dense-weight", type=float, default=0.35)
    hybrid_parser.add_argument("--dense-model-dir", default=str(DEFAULT_DENSE_MODEL_DIR))
    hybrid_parser.add_argument("--dense-device", default=os.environ.get("BGE_M3_DEVICE", "cpu"))
    hybrid_parser.add_argument("--dense-query-vector-path", default="")
    hybrid_parser.set_defaults(func=hybrid_search)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

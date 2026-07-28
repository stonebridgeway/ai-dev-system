import contextlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import search_cli


class SearchFreshnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp.name) / "vault"
        self.index = self.vault / "09-mcp" / "search-index" / "test.sqlite"
        (self.vault / "02-knowledge").mkdir(parents=True)
        registry = self.vault / "03-skills-catalog" / "registries"
        registry.mkdir(parents=True)
        (registry / "skills.index.json").write_text("[]\n", encoding="utf-8")
        self.note = self.vault / "02-knowledge" / "sample.md"
        self.note.write_text("# Sample\n\nInitial searchable content.\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def args(self, **overrides):
        values = {
            "vault_root": str(self.vault),
            "index_path": str(self.index),
            "include_external_project_files": True,
            "dense_embeddings": False,
            "dense_model_dir": "",
            "dense_device": "cpu",
            "dense_batch_size": 1,
            "dense_text_limit": 1200,
            "dense_progress": False,
            "dense_include_membrane": False,
            "dense_incremental": True,
            "preserve_dense": True,
        }
        values.update(overrides)
        return SimpleNamespace(**values)

    def call_json(self, function, args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            function(args)
        return json.loads(output.getvalue())

    def test_taxonomy_alias_connects_russian_and_english_terms(self):
        russian = set(search_cli.semantic_terms(
            "группы скиллов домены подгруппы маршрутизация и связанные навыки"
        ))
        english = set(search_cli.semantic_terms(
            "skill taxonomy groups subgroups routing and related skills"
        ))
        self.assertIn("alias:skill_taxonomy", russian)
        self.assertIn("alias:skill_taxonomy", english)

    def test_status_detects_add_change_and_delete(self):
        self.call_json(search_cli.rebuild, self.args(preserve_dense=False))
        self.assertFalse(self.call_json(search_cli.index_status, self.args())["stale"])

        added = self.vault / "02-knowledge" / "added.md"
        added.write_text("# Added\n", encoding="utf-8")
        status = self.call_json(search_cli.index_status, self.args())
        self.assertTrue(status["stale"])
        self.assertEqual(status["added_count"], 1)

        self.call_json(search_cli.rebuild, self.args())
        self.note.write_text("# Sample\n\nChanged searchable content.\n", encoding="utf-8")
        status = self.call_json(search_cli.index_status, self.args())
        self.assertEqual(status["changed_count"], 1)

        self.call_json(search_cli.rebuild, self.args())
        added.unlink()
        status = self.call_json(search_cli.index_status, self.args())
        self.assertEqual(status["deleted_count"], 1)

    def test_fast_rebuild_preserves_only_matching_dense_vectors(self):
        self.call_json(search_cli.rebuild, self.args(preserve_dense=False))
        doc = search_cli.collect_documents(self.vault, True)[0]
        dense_hash = search_cli.dense_content_hash(search_cli.dense_passage_text(doc, 1200))
        vector = search_cli.dense_vector_to_blob([0.0] * search_cli.DENSE_DIMENSIONS)

        con = sqlite3.connect(self.index)
        con.execute(
            "INSERT INTO dense_vectors(id, vector, dimensions, model, content_hash, mtime) VALUES (?, ?, ?, ?, ?, ?)",
            (doc["id"], vector, search_cli.DENSE_DIMENSIONS, search_cli.DENSE_MODEL_NAME, dense_hash, doc["mtime"]),
        )
        for key, value in {
            "dense_enabled": "true",
            "dense_text_limit": "1200",
            "dense_include_membrane": "false",
            "dense_documents": "1",
            "dense_pending_documents": "0",
        }.items():
            con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, value))
        con.commit()
        con.close()

        rebuilt = self.call_json(search_cli.rebuild, self.args())
        self.assertTrue(rebuilt["dense_enabled"])
        self.assertEqual(rebuilt["dense_documents"], 1)
        self.assertEqual(rebuilt["dense_pending_documents"], 0)

        self.note.write_text("# Sample\n\nDense content changed.\n", encoding="utf-8")
        rebuilt = self.call_json(search_cli.rebuild, self.args())
        self.assertTrue(rebuilt["dense_enabled"])
        self.assertEqual(rebuilt["dense_documents"], 0)
        self.assertEqual(rebuilt["dense_pending_documents"], 1)

    def test_busy_dense_cache_is_not_silently_treated_as_empty(self):
        self.index.parent.mkdir(parents=True, exist_ok=True)
        self.index.touch()
        with (
            mock.patch.object(search_cli, "SQLITE_READ_RETRY_DELAYS", (0, 0)),
            mock.patch.object(
                search_cli,
                "connect",
                side_effect=sqlite3.OperationalError("database is locked"),
            ) as connect,
        ):
            with self.assertRaisesRegex(RuntimeError, "remained busy"):
                search_cli.load_existing_dense_cache(self.index)
        self.assertEqual(connect.call_count, 3)

    def test_rebuild_lock_blocks_a_second_owner(self):
        with search_cli.index_rebuild_lock(self.index, timeout=0):
            with self.assertRaisesRegex(TimeoutError, "rebuild lock"):
                with search_cli.index_rebuild_lock(self.index, timeout=0):
                    self.fail("Second lock owner should not enter the critical section")

    def test_skill_card_and_source_collapse_to_one_canonical_result(self):
        results = search_cli.collapse_search_results([
            {
                "scope": "skills",
                "title": "frontend-quality-gate",
                "path": "03-skills-catalog/cards/custom/frontend-quality-gate.md",
                "source": "vault-note",
                "score": 0.9,
            },
            {
                "scope": "skills",
                "title": "frontend-quality-gate",
                "path": "03-skills-catalog/sources/custom/frontend-quality-gate/SKILL.md",
                "source": "custom",
                "score": 0.7,
            },
        ])
        self.assertEqual(len(results), 1)
        self.assertEqual(
            results[0]["path"],
            "03-skills-catalog/sources/custom/frontend-quality-gate/SKILL.md",
        )
        self.assertEqual(results[0]["score"], 0.9)
        self.assertEqual(results[0]["duplicate_count"], 1)

    def test_unrelated_skill_group_note_is_not_collapsed_by_title(self):
        results = search_cli.collapse_search_results([
            {
                "scope": "skills",
                "title": "Frontend",
                "path": "03-skills-catalog/groups/frontend.md",
                "source": "vault-note",
                "score": 0.9,
            },
            {
                "scope": "skills",
                "title": "Frontend",
                "path": "03-skills-catalog/groups/frontend-index.md",
                "source": "vault-note",
                "score": 0.8,
            },
        ])
        self.assertEqual(len(results), 2)

    def test_hybrid_candidate_pool_is_independent_of_output_limit(self):
        self.call_json(search_cli.rebuild, self.args(preserve_dense=False))
        base = {
            "index_path": str(self.index),
            "query": "searchable content",
            "scope": "all",
            "project": "",
            "source": "",
            "categories": "",
            "folders": "",
            "semantic_weight": 0.2,
            "keyword_weight": 0.8,
            "dense_weight": 0,
            "dense_model_dir": "",
            "dense_device": "cpu",
            "dense_query_vector_path": "",
        }

        observed = []
        original = search_cli.keyword_candidate_rows

        def record_limit(connection, args, limit):
            observed.append(limit)
            return original(connection, args, limit)

        with mock.patch.object(search_cli, "keyword_candidate_rows", side_effect=record_limit):
            self.call_json(search_cli.hybrid_search, SimpleNamespace(**base, limit=1))
            self.call_json(search_cli.hybrid_search, SimpleNamespace(**base, limit=20))

        self.assertEqual(
            observed,
            [search_cli.HYBRID_CANDIDATE_LIMIT, search_cli.HYBRID_CANDIDATE_LIMIT],
        )


if __name__ == "__main__":
    unittest.main()

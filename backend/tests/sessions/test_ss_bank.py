"""The bank repositories: PostgREST must give what memory mode gives, bundle for bundle."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from uuid import UUID

import pytest

from app.config import StartupConfigError
from app.errors import AppError, ErrorCode
from app.repositories.bank import (
    BankPassage,
    EditionInfo,
    InMemoryBankRepository,
    PostgrestBankRepository,
)
from tests.sessions.ss_postgrest import TOKEN, FakePostgrest
from tests.sessions.ss_support import (
    DATA,
    HADITH,
    HADITH_EDITION,
    QURAN,
    QURAN_EDITION,
    QURAN_PASSAGES,
    ctx,
)
from tests.support import make_settings

LEARNER = ctx(token=TOKEN)


def make_pair(*, in_chunk: int = 3):
    fake = FakePostgrest()
    memory = InMemoryBankRepository((QURAN, HADITH))
    return memory, PostgrestBankRepository(fake.client(), in_chunk=in_chunk), fake


def by_id(items):
    return sorted(items, key=lambda item: item.id)


# --- edition facts -------------------------------------------------------------------------------


@pytest.mark.parametrize("edition", [QURAN_EDITION, HADITH_EDITION])
def test_edition_facts_are_the_same_in_both_implementations(edition: UUID) -> None:
    memory, postgrest, _ = make_pair()
    expected = memory.edition(LEARNER, edition)
    assert expected is not None
    assert postgrest.edition(LEARNER, edition) == expected
    assert expected.status == "published" and expected.selectable and not expected.hidden


def test_edition_values_and_defaults_follow_the_content_format() -> None:
    memory, _, _ = make_pair()
    quran = memory.edition(LEARNER, QURAN_EDITION)
    hadith = memory.edition(LEARNER, HADITH_EDITION)
    assert quran.default_paths == ("quran",) and hadith.default_paths == ("matn",)
    assert quran.content_format == "quran" and hadith.content_format == "hadith_collection"
    assert quran.edition_key == "quran-hafs-quranenc" and quran.bank_version == 1
    assert (
        quran.source_title == "QuranEnc" and quran.source_url == "https://mcp.islamiccontent.org/"
    )
    assert EditionInfo.default_paths.fget(replace(quran, content_format="other")) == ()  # type: ignore[attr-defined]


def test_unknown_and_revoked_editions_are_never_returned() -> None:
    memory, postgrest, fake = make_pair()
    unknown = UUID("11111111-1111-4111-8111-0000000000ee")
    assert memory.edition(LEARNER, unknown) is None and postgrest.edition(LEARNER, unknown) is None
    memory.set_status(QURAN_EDITION, "revoked")
    fake.set_edition_status("revoked", str(QURAN_EDITION))
    for repo in (memory, postgrest):
        assert repo.edition(LEARNER, QURAN_EDITION) is None
        assert (
            repo.passages(
                LEARNER, QURAN_EDITION, bank_version=1, section_ordinals=[1], paths=["quran"]
            )
            == []
        )
        assert (
            repo.questions(LEARNER, QURAN_EDITION, bank_version=1, passage_ids=QURAN_PASSAGES) == []
        )
        assert repo.sections(LEARNER, QURAN_EDITION, [1]) == {}
        assert repo.units(LEARNER, QURAN_EDITION, [1]) == {}
        assert repo.section_units(LEARNER, QURAN_EDITION, [1]) == []
        assert (
            repo.lessons(LEARNER, QURAN_EDITION, bank_version=1, passage_ids=QURAN_PASSAGES) == {}
        )
        assert repo.edition(LEARNER, HADITH_EDITION) is not None  # another edition is unaffected


def test_a_superseded_edition_is_still_readable_but_not_selectable() -> None:
    memory, postgrest, fake = make_pair()
    memory.set_status(QURAN_EDITION, "superseded")
    fake.set_edition_status("superseded", str(QURAN_EDITION))
    for repo in (memory, postgrest):
        edition = repo.edition(LEARNER, QURAN_EDITION)
        assert edition is not None and edition.status == "superseded" and not edition.selectable


def test_hidden_and_archived_editions_stop_new_selection_only() -> None:
    memory, postgrest, fake = make_pair()
    memory.set_status(QURAN_EDITION, "published", hidden=True)
    fake.tables["book_editions"][0]["catalog_hidden"] = True
    for repo in (memory, postgrest):
        edition = repo.edition(LEARNER, QURAN_EDITION)
        assert edition is not None and edition.hidden and not edition.selectable
    fake.tables["book_editions"][0].update(catalog_hidden=False, archived_at="2026-10-01T00:00:00Z")
    archived = postgrest.edition(LEARNER, QURAN_EDITION)
    assert archived is not None and archived.hidden and not archived.selectable


def test_the_edition_read_asks_only_for_readable_columns() -> None:
    _, postgrest, fake = make_pair()
    postgrest.edition(LEARNER, QURAN_EDITION)
    asked = {r.url.path: r.url.params["select"] for r in fake.requests}
    assert "raw_storage_path" not in asked["/rest/v1/book_editions"]
    assert "review_record" not in asked["/rest/v1/book_editions"]
    assert "license_record" not in asked["/rest/v1/sources"]


# --- passages, questions, sections, units, lessons -----------------------------------------------


@pytest.mark.parametrize(
    ("edition", "sections", "paths"),
    [
        (QURAN_EDITION, [1, 2, 3], ["quran"]),
        (QURAN_EDITION, [2], ["quran"]),
        (QURAN_EDITION, [3, 1], ["quran"]),
        (HADITH_EDITION, [1, 2, 3, 4], ["matn", "sanad", "grade"]),
        (HADITH_EDITION, [1, 2], ["matn"]),
        (HADITH_EDITION, [4], ["sanad", "grade"]),
    ],
)
def test_passages_with_their_parts_match_by_scope_and_paths(
    edition: UUID, sections: list[int], paths: list[str]
) -> None:
    memory, postgrest, _ = make_pair()
    args = dict(bank_version=1, section_ordinals=sections, paths=paths)
    expected = memory.passages(LEARNER, edition, **args)
    assert expected and by_id(postgrest.passages(LEARNER, edition, **args)) == by_id(expected)
    assert all(p.section_ordinal in sections and p.path in paths for p in expected)
    assert all(part.id for p in expected for part in p.parts) and all(p.parts for p in expected)


def test_passages_of_another_bank_version_scope_or_path_are_not_returned() -> None:
    memory, postgrest, _ = make_pair()
    for repo in (memory, postgrest):
        assert (
            repo.passages(
                LEARNER, QURAN_EDITION, bank_version=2, section_ordinals=[1], paths=["quran"]
            )
            == []
        )
        assert (
            repo.passages(
                LEARNER, QURAN_EDITION, bank_version=1, section_ordinals=[9], paths=["quran"]
            )
            == []
        )
        assert (
            repo.passages(
                LEARNER, QURAN_EDITION, bank_version=1, section_ordinals=[], paths=["quran"]
            )
            == []
        )
        assert (
            repo.passages(LEARNER, QURAN_EDITION, bank_version=1, section_ordinals=[1], paths=[])
            == []
        )
        assert (
            repo.passages(
                LEARNER, QURAN_EDITION, bank_version=1, section_ordinals=[1], paths=["matn"]
            )
            == []
        )


def test_a_passage_value_object_gives_the_policy_view() -> None:
    memory, _, _ = make_pair()
    (first, *_) = sorted(
        memory.passages(
            LEARNER, QURAN_EDITION, bank_version=1, section_ordinals=[1], paths=["quran"]
        ),
        key=lambda p: p.ordinal,
    )
    info = first.info()
    assert info.id == first.id and info.section_ordinal == 1 and info.path == "quran"
    assert info.start == (1, 0) and info.word_count == 12
    assert [p.ordinal for p in info.parts] == [1, 2, 3, 4]
    assert sum(p.word_count for p in info.parts) == first.word_count
    broken = BankPassage(first.id, 1, 1, "quran", "nonsense", "1:1", 1, "x", first.parts)
    with pytest.raises(ValueError):
        broken.info()


def test_questions_match_and_are_read_in_chunks() -> None:
    memory, postgrest, fake = make_pair(in_chunk=2)
    expected = memory.questions(LEARNER, QURAN_EDITION, bank_version=1, passage_ids=QURAN_PASSAGES)
    got = postgrest.questions(LEARNER, QURAN_EDITION, bank_version=1, passage_ids=QURAN_PASSAGES)
    assert len(expected) == len(QURAN["questions"]) and by_id(got) == by_id(expected)
    assert len(fake.calls_to("/question_items")) == 2  # four passages, two ids per filter
    assert {r.url.params["status"] for r in fake.calls_to("/question_items")} == {"eq.published"}
    some = memory.questions(LEARNER, QURAN_EDITION, bank_version=1, passage_ids=QURAN_PASSAGES[:1])
    assert {q.passage_id for q in some} == {QURAN_PASSAGES[0]}
    assert (
        memory.questions(LEARNER, QURAN_EDITION, bank_version=2, passage_ids=QURAN_PASSAGES) == []
    )
    assert postgrest.questions(LEARNER, QURAN_EDITION, bank_version=1, passage_ids=[]) == []


def test_a_question_keeps_references_only_never_text() -> None:
    memory, _, _ = make_pair()
    questions = memory.questions(
        LEARNER,
        HADITH_EDITION,
        bank_version=1,
        passage_ids=[UUID(p["id"]) for p in HADITH["passages"]],
    )
    sample = next(q for q in questions if q.type == "word_choice")
    assert all(ref.count(":") == 1 for ref in sample.token_refs)
    assert sample.option_refs is not None and sample.correct_ref in sample.option_refs
    assert sample.info().covered_part_ids == sample.covered_part_ids


@pytest.mark.parametrize("edition", [QURAN_EDITION, HADITH_EDITION])
def test_sections_units_and_lessons_match(edition: UUID) -> None:
    memory, postgrest, _ = make_pair(in_chunk=4)
    bundle = QURAN if edition == QURAN_EDITION else HADITH
    ordinals = [s["ordinal"] for s in bundle["sections"]]
    assert postgrest.sections(LEARNER, edition, ordinals + [99]) == memory.sections(
        LEARNER, edition, ordinals
    )
    unit_ordinals = [u["ordinal"] for u in bundle["units"]]
    wanted = memory.units(LEARNER, edition, unit_ordinals + [999])
    assert set(wanted) == set(unit_ordinals)
    got = postgrest.units(LEARNER, edition, unit_ordinals + [999])
    assert {o: replace(u, section_ordinal=None) for o, u in wanted.items()} == got
    assert postgrest.section_units(LEARNER, edition, ordinals) == memory.section_units(
        LEARNER, edition, ordinals
    )
    assert (
        postgrest.section_units(LEARNER, edition, [99])
        == []
        == memory.section_units(LEARNER, edition, [99])
    )
    passage_ids = [UUID(p["id"]) for p in bundle["passages"]]
    lessons = memory.lessons(LEARNER, edition, bank_version=1, passage_ids=passage_ids)
    assert len(lessons) == len(passage_ids)
    assert postgrest.lessons(LEARNER, edition, bank_version=1, passage_ids=passage_ids) == lessons
    assert memory.lessons(LEARNER, edition, bank_version=2, passage_ids=passage_ids) == {}


def test_units_keep_the_verbatim_text_and_expose_surfaces() -> None:
    memory, _, _ = make_pair()
    unit = memory.units(LEARNER, QURAN_EDITION, [1])[1]
    source = QURAN["units"][0]
    assert unit.text == source["canonicalText"] and unit.reference == source["reference"]
    assert (
        unit.surface(0)
        == source["canonicalText"][source["tokens"][0]["s"] : source["tokens"][0]["e"]]
    )
    assert unit.token(1).n == source["tokens"][1]["n"] and unit.section_ordinal == 1
    hadith = memory.units(LEARNER, HADITH_EDITION, [1])[1]
    assert hadith.hadith_meta is not None and hadith.hadith_meta["fortyNumber"] == 1


# --- memory mode from configuration --------------------------------------------------------------


def test_the_memory_bank_loads_the_bundles_named_in_the_settings() -> None:
    paths = f"{DATA / 'synthetic_bundle.json'}, {DATA / 'synthetic_bundle_hadith.json'}"
    bank = InMemoryBankRepository.from_settings(make_settings(QATRA_CONTENT_BUNDLES=paths))
    assert bank.edition(ctx(), QURAN_EDITION) is not None
    assert bank.edition(ctx(), HADITH_EDITION) is not None  # no token is needed in memory mode


def test_without_bundles_the_memory_bank_is_empty() -> None:
    bank = InMemoryBankRepository.from_settings(make_settings())
    assert bank.edition(ctx(), QURAN_EDITION) is None
    assert (
        InMemoryBankRepository.from_settings(make_settings(QATRA_CONTENT_BUNDLES=" , ")).edition(
            ctx(), QURAN_EDITION
        )
        is None
    )


@pytest.mark.parametrize("content", ["not json", "[]", '{"bundleVersion": 1}'])
def test_a_bad_bundle_file_is_a_names_only_configuration_error(
    tmp_path: Path, content: str
) -> None:
    path = tmp_path / "secret-folder" / "bundle.json"
    path.parent.mkdir()
    path.write_text(content, encoding="utf-8")
    with pytest.raises(StartupConfigError) as raised:
        InMemoryBankRepository.from_settings(make_settings(QATRA_CONTENT_BUNDLES=str(path)))
    assert "QATRA_CONTENT_BUNDLES entry 1" in str(raised.value)
    assert "secret-folder" not in str(raised.value) and "not json" not in str(raised.value)
    with pytest.raises(StartupConfigError):
        InMemoryBankRepository.from_settings(
            make_settings(QATRA_CONTENT_BUNDLES=str(tmp_path / "missing.json"))
        )


def test_a_bundle_that_is_valid_json_but_malformed_inside_is_refused(tmp_path: Path) -> None:
    broken = json.loads(json.dumps(QURAN))
    del broken["passages"][0]["parts"]
    path = tmp_path / "bundle.json"
    path.write_text(json.dumps(broken, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(StartupConfigError):
        InMemoryBankRepository.from_settings(make_settings(QATRA_CONTENT_BUNDLES=str(path)))


# --- the PostgREST bank needs a learner ----------------------------------------------------------


def test_the_postgrest_bank_needs_the_learners_token() -> None:
    _, postgrest, fake = make_pair()
    with pytest.raises(AppError) as raised:
        postgrest.edition(ctx(token=None), QURAN_EDITION)
    assert raised.value.code is ErrorCode.unauthenticated and fake.requests == []
    fake.token = "another-token"
    with pytest.raises(AppError) as expired:
        postgrest.edition(LEARNER, QURAN_EDITION)
    assert expired.value.code is ErrorCode.unauthenticated

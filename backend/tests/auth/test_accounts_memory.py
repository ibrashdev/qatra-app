"""``InMemoryAccounts``: the memory-mode twin must behave like the SQL of ``0005_rls_functions.sql``
(uniqueness, atomic registration, the recovery reservation, the epoch rule, the throttle buckets,
deletion) and like the profile policies of ``0002_identity.sql``."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from app.repositories.accounts import (
    AccountNotFoundError,
    EpochMismatchError,
    InMemoryAccounts,
    InvalidAccountValueError,
    InvalidStateError,
    ProfileMissing,
    ProfileUnavailable,
    ProfileValueRejected,
    RepositoryUnavailable,
    UsernameTakenError,
)
from tests.auth.auth_support import FakeClock

HASH_A = b"\xaa" * 32
HASH_B = b"\xbb" * 32
HASH_C = b"\xcc" * 32
KEY_1 = b"\x01" * 32
KEY_2 = b"\x02" * 32


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def store(clock: FakeClock) -> InMemoryAccounts:
    return InMemoryAccounts(clock=clock)


def alias() -> str:
    return f"u.{uuid4()}@qatra.invalid"


def make_account(
    store: InMemoryAccounts,
    name: str = "sample_user_01",
    *,
    display: str | None = None,
    code_hash: bytes = HASH_A,
    is_demo: bool = False,
    **overrides: object,
) -> UUID:
    user_id = uuid4()
    values: dict[str, object] = {
        "user_id": user_id,
        "username_display": display or name,
        "username_normalized": name,
        "internal_auth_alias": alias(),
        "is_demo": is_demo,
        "terms_version": "2026-10-04",
        "language": "ar",
        "time_zone": "Asia/Dubai",
        "recovery_code_hash": code_hash,
    }
    values.update(overrides)
    store.register_account(**values)  # type: ignore[arg-type]
    return user_id


def open_session(
    store: InMemoryAccounts, user_id: UUID, session_hash: bytes, clock: FakeClock, epoch: int = 0
) -> UUID:
    return store.create_app_session(
        user_id=user_id,
        session_hash=session_hash,
        encrypted_auth_tokens=b"blob",
        auth_epoch=epoch,
        expires_at=clock.now + timedelta(days=30),
    )


# --- registration ---------------------------------------------------------------------------------


def test_registration_creates_handle_profile_and_first_active_code(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    user_id = make_account(store, "sample_user_01", display="Sample_User_01")
    handle = store.find_handle("sample_user_01")
    assert handle is not None and handle.user_id == user_id
    assert (handle.username_display, handle.auth_epoch, handle.is_demo) == (
        "Sample_User_01",
        0,
        False,
    )
    profile = store.read_profile(user_id=user_id, access_token=None)
    assert (profile.language, profile.time_zone, profile.session_minutes) == (
        "ar",
        "Asia/Dubai",
        10,
    )
    assert profile.terms_version == "2026-10-04" and profile.terms_accepted_at == clock.now
    assert profile.reminder_settings == {} and profile.pending_settings is None
    assert store.code_count(user_id, active_only=True) == 1
    assert store.find_handle("someone_else") is None


def test_a_duplicate_username_alias_or_user_raises_and_leaves_no_partial_rows(
    store: InMemoryAccounts,
) -> None:
    first = make_account(store, "taken_name")
    with pytest.raises(UsernameTakenError):
        make_account(store, "taken_name")
    shared = store.find_handle("taken_name")
    assert shared is not None
    with pytest.raises(UsernameTakenError):
        make_account(store, "another_name", internal_auth_alias=shared.internal_auth_alias)
    with pytest.raises(UsernameTakenError):
        make_account(store, "third_name", user_id=first)
    assert store.find_handle("another_name") is None and store.find_handle("third_name") is None
    assert store.code_count(first) == 1  # nothing was added to the existing account


@pytest.mark.parametrize(
    "overrides",
    [
        {"username_normalized": "ab", "username_display": "ab"},
        {"username_normalized": "a" * 25, "username_display": "a" * 25},
        {"username_normalized": "Upper_Case", "username_display": "Upper_Case"},
        {"username_normalized": "has space", "username_display": "has space"},
        {"username_normalized": "éee", "username_display": "eee"},  # not NFKC
        {"username_display": "x"},
        {"internal_auth_alias": "user@example.com"},
        {"internal_auth_alias": "u.not-a-uuid@qatra.invalid"},
        {"language": "fr"},
        {"time_zone": "Mars/Olympus"},
        {"terms_version": "   "},
        {"recovery_code_hash": b"short"},
    ],
)
def test_values_that_break_a_database_check_are_rejected_without_partial_rows(
    store: InMemoryAccounts, overrides: dict[str, object]
) -> None:
    with pytest.raises(InvalidAccountValueError):
        make_account(store, "valid_name", **overrides)
    assert store.find_handle("valid_name") is None
    assert store.find_handle(str(overrides.get("username_normalized", "valid_name"))) is None
    assert store.session_count() == 0


def test_accept_terms_updates_the_version_and_the_time(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    user_id = make_account(store, terms_version="2026-01-01")
    clock.advance(hours=2)
    accepted = store.accept_terms(user_id, "2026-10-04")
    row = store.read_profile(user_id=user_id, access_token=None)
    assert accepted == clock.now == row.terms_accepted_at and row.terms_version == "2026-10-04"
    with pytest.raises(AccountNotFoundError):
        store.accept_terms(uuid4(), "2026-10-04")


# --- recovery -------------------------------------------------------------------------------------


def reserve(store: InMemoryAccounts, user_id: UUID, grant_hash: bytes, clock: FakeClock) -> bool:
    active = store.recovery_active_code(user_id)
    assert active is not None
    return store.recovery_reserve(
        user_id=user_id,
        code_id=active.code_id,
        grant_id=uuid4(),
        grant_hash=grant_hash,
        grant_expires_at=clock.now + timedelta(minutes=10),
    )


def test_the_active_code_is_the_one_not_consumed_and_not_reserved(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    user_id = make_account(store, code_hash=HASH_A)
    active = store.recovery_active_code(user_id)
    assert active is not None and active.code_hash == HASH_A
    assert store.recovery_active_code(uuid4()) is None
    assert reserve(store, user_id, HASH_B, clock)
    assert store.recovery_active_code(user_id) is None  # reserved: not usable by a second request
    clock.advance(minutes=11)
    assert store.recovery_active_code(user_id) is not None  # the reservation expired


def test_only_one_grant_can_hold_a_code(store: InMemoryAccounts, clock: FakeClock) -> None:
    user_id = make_account(store)
    active = store.recovery_active_code(user_id)
    assert active is not None
    kwargs = {"user_id": user_id, "code_id": active.code_id}
    expiry = clock.now + timedelta(minutes=10)
    assert store.recovery_reserve(
        **kwargs, grant_id=uuid4(), grant_hash=HASH_B, grant_expires_at=expiry
    )
    assert not store.recovery_reserve(
        **kwargs, grant_id=uuid4(), grant_hash=HASH_C, grant_expires_at=expiry
    )
    assert store.grant_statuses(user_id) == ["active"]


def test_reserve_refuses_a_foreign_or_consumed_code(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    owner, stranger = make_account(store, "owner_name"), make_account(store, "stranger_name")
    code = store.recovery_active_code(owner)
    assert code is not None
    expiry = clock.now + timedelta(minutes=10)
    assert not store.recovery_reserve(
        user_id=stranger, code_id=code.code_id, grant_id=uuid4(), grant_hash=HASH_B,
        grant_expires_at=expiry,
    )  # fmt: skip
    assert not store.recovery_reserve(
        user_id=owner, code_id=uuid4(), grant_id=uuid4(), grant_hash=HASH_B, grant_expires_at=expiry
    )
    store.recovery_rotate(owner, HASH_C)
    assert not store.recovery_reserve(
        user_id=owner, code_id=code.code_id, grant_id=uuid4(), grant_hash=HASH_B,
        grant_expires_at=expiry,
    )  # fmt: skip


def test_an_expired_active_grant_releases_its_slot_for_the_next_reservation(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    user_id = make_account(store)
    assert reserve(store, user_id, HASH_B, clock)
    clock.advance(minutes=11)
    assert reserve(store, user_id, HASH_C, clock)
    assert sorted(store.grant_statuses(user_id)) == ["active", "cancelled"]


def test_an_expired_executing_grant_keeps_its_slot_until_it_is_reviewed(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    user_id = make_account(store)
    assert reserve(store, user_id, HASH_B, clock)
    assert store.recovery_begin(HASH_B) is not None
    clock.advance(minutes=11)
    assert not reserve(store, user_id, HASH_C, clock)  # the live-grant rule still holds


def test_begin_takes_a_valid_grant_exactly_once(store: InMemoryAccounts, clock: FakeClock) -> None:
    user_id = make_account(store)
    assert reserve(store, user_id, HASH_B, clock)
    ticket = store.recovery_begin(HASH_B)
    assert ticket is not None and ticket.user_id == user_id
    assert store.recovery_begin(HASH_B) is None  # now executing
    assert store.recovery_begin(HASH_C) is None  # unknown
    assert store.grant_statuses(user_id) == ["executing"]


def test_begin_refuses_an_expired_grant(store: InMemoryAccounts, clock: FakeClock) -> None:
    user_id = make_account(store)
    assert reserve(store, user_id, HASH_B, clock)
    clock.advance(minutes=10, seconds=1)
    assert store.recovery_begin(HASH_B) is None


def test_release_cancels_the_grant_and_frees_the_code(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    user_id = make_account(store)
    assert reserve(store, user_id, HASH_B, clock)
    ticket = store.recovery_begin(HASH_B)
    assert ticket is not None
    store.recovery_release(ticket.grant_id)
    assert store.grant_statuses(user_id) == ["cancelled"]
    assert store.recovery_active_code(user_id) is not None
    store.recovery_release(ticket.grant_id)  # repeating changes nothing
    assert reserve(store, user_id, HASH_C, clock)


def test_consume_replaces_the_code_bumps_the_epoch_and_revokes_every_session(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    user_id = make_account(store, code_hash=HASH_A)
    open_session(store, user_id, HASH_A, clock)
    open_session(store, user_id, HASH_B, clock)
    assert reserve(store, user_id, HASH_C, clock)
    ticket = store.recovery_begin(HASH_C)
    assert ticket is not None
    assert store.recovery_consume(ticket.grant_id, KEY_1) == 1
    assert store.epoch_of(user_id) == 1 and store.live_session_count(user_id) == 0
    assert store.grant_statuses(user_id) == ["consumed"]
    active = store.recovery_active_code(user_id)
    assert active is not None and active.code_hash == KEY_1  # the new code; the old one is spent
    assert store.code_count(user_id) == 2 and store.code_count(user_id, active_only=True) == 1
    with pytest.raises(InvalidStateError):
        store.recovery_consume(ticket.grant_id, KEY_2)  # a second consume fails


def test_consume_needs_an_executing_grant(store: InMemoryAccounts, clock: FakeClock) -> None:
    user_id = make_account(store)
    active = store.recovery_active_code(user_id)
    assert active is not None
    grant_id = uuid4()
    assert store.recovery_reserve(
        user_id=user_id,
        code_id=active.code_id,
        grant_id=grant_id,
        grant_hash=HASH_B,
        grant_expires_at=clock.now + timedelta(minutes=10),
    )  # active, not executing
    with pytest.raises(InvalidStateError):
        store.recovery_consume(grant_id, KEY_1)
    with pytest.raises(InvalidStateError):
        store.recovery_consume(uuid4(), KEY_1)


def test_rotation_replaces_the_code_and_cancels_a_pending_grant(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    user_id = make_account(store, code_hash=HASH_A)
    assert reserve(store, user_id, HASH_B, clock)
    store.recovery_rotate(user_id, HASH_C)
    assert store.grant_statuses(user_id) == ["cancelled"]
    active = store.recovery_active_code(user_id)
    assert active is not None and active.code_hash == HASH_C
    assert store.epoch_of(user_id) == 0  # rotation changes neither sessions nor the epoch
    with pytest.raises(RepositoryUnavailable):
        store.recovery_rotate(uuid4(), HASH_C)


# --- sessions -------------------------------------------------------------------------------------


def test_a_session_is_read_with_the_account_fields(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    user_id = make_account(store, display="Sample_User_01", is_demo=True)
    session_id = open_session(store, user_id, HASH_A, clock)
    stored = store.read_app_session(HASH_A)
    assert stored is not None
    assert (stored.session_id, stored.user_id, stored.auth_epoch) == (session_id, user_id, 0)
    assert (stored.username_display, stored.is_demo) == ("Sample_User_01", True)
    assert stored.internal_auth_alias.endswith("@qatra.invalid")
    assert stored.encrypted_auth_tokens == b"blob"
    assert store.read_app_session(HASH_B) is None


def test_a_session_is_not_live_when_revoked_expired_or_stale(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    user_id = make_account(store)
    open_session(store, user_id, HASH_A, clock)
    open_session(store, user_id, HASH_B, clock)
    open_session(store, user_id, HASH_C, clock)
    store.revoke_app_session(HASH_A)
    assert store.read_app_session(HASH_A) is None
    store.revoke_app_session(HASH_A)  # idempotent
    clock.advance(days=30, seconds=1)
    assert store.read_app_session(HASH_B) is None  # expired
    other = make_account(store, "other_name")
    open_session(store, other, KEY_1, clock)
    assert store.bump_auth_epoch(other) == 1
    assert store.read_app_session(KEY_1) is None  # epoch no longer current


def test_create_session_requires_the_current_epoch(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    user_id = make_account(store)
    store.bump_auth_epoch(user_id)
    with pytest.raises(EpochMismatchError):
        open_session(store, user_id, HASH_A, clock, epoch=0)
    with pytest.raises(EpochMismatchError):
        open_session(store, uuid4(), HASH_A, clock)
    open_session(store, user_id, HASH_A, clock, epoch=1)
    assert store.read_app_session(HASH_A) is not None


def test_bump_revokes_all_sessions_including_the_callers(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    user_id = make_account(store)
    open_session(store, user_id, HASH_A, clock)
    open_session(store, user_id, HASH_B, clock)
    assert store.bump_auth_epoch(user_id) == 1
    assert store.live_session_count(user_id) == 0
    with pytest.raises(AccountNotFoundError):
        store.bump_auth_epoch(uuid4())


def test_token_updates_apply_to_live_sessions_only(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    user_id = make_account(store)
    session_id = open_session(store, user_id, HASH_A, clock)
    store.update_session_tokens(session_id, b"renewed")
    stored = store.read_app_session(HASH_A)
    assert stored is not None and stored.encrypted_auth_tokens == b"renewed"
    store.revoke_app_session(HASH_A)
    store.update_session_tokens(session_id, b"too late")  # quiet no-op
    assert store.stored_tokens(user_id) == [b"renewed"]


def test_session_hashes_are_unique(store: InMemoryAccounts, clock: FakeClock) -> None:
    user_id = make_account(store)
    open_session(store, user_id, HASH_A, clock)
    with pytest.raises(RepositoryUnavailable):
        open_session(store, user_id, HASH_A, clock)


# --- throttle -------------------------------------------------------------------------------------


def test_failures_accumulate_per_key_in_one_minute_buckets(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    assert store.throttle_check([KEY_1, KEY_2]) == {KEY_1: 0, KEY_2: 0}
    store.throttle_record([KEY_1, KEY_2], "failure")
    store.throttle_record([KEY_1], "failure")
    store.throttle_record([KEY_1, KEY_1], "failure")  # a repeated key counts once per call
    assert store.throttle_check([KEY_1, KEY_2]) == {KEY_1: 3, KEY_2: 1}
    assert len(store.throttle_rows()) == 2  # one bucket per key in the same minute


def test_the_window_is_the_current_minute_and_the_fourteen_before(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    store.throttle_record([KEY_1], "failure")
    clock.advance(minutes=14)
    assert store.throttle_check([KEY_1]) == {KEY_1: 1}  # still inside: 14 buckets back
    clock.advance(minutes=1)
    assert store.throttle_check([KEY_1]) == {KEY_1: 0}  # the 15th bucket back is out
    store.throttle_record([KEY_1], "failure")
    assert store.throttle_check([KEY_1]) == {KEY_1: 1}


def test_a_success_clears_every_bucket_of_the_given_keys_only(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    store.throttle_record([KEY_1, KEY_2], "failure")
    clock.advance(minutes=3)
    store.throttle_record([KEY_1, KEY_2], "failure")
    store.throttle_record([KEY_1], "success")
    assert store.throttle_check([KEY_1, KEY_2]) == {KEY_1: 0, KEY_2: 2}


def test_an_unknown_outcome_is_rejected(store: InMemoryAccounts) -> None:
    with pytest.raises(RepositoryUnavailable):
        store.throttle_record([KEY_1], "maybe")


def test_rows_older_than_a_day_are_purged_at_most_one_hundred_per_call(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    keys = [i.to_bytes(32, "big") for i in range(250)]
    store.throttle_record(keys, "failure")
    clock.advance(hours=25)
    store.throttle_record([KEY_1], "failure")
    assert len(store.throttle_rows()) == 250 - 100 + 1
    store.throttle_record([KEY_1], "failure")
    assert len(store.throttle_rows()) == 250 - 200 + 1
    store.throttle_record([KEY_1], "failure")
    assert len(store.throttle_rows()) == 1


# --- deletion -------------------------------------------------------------------------------------


def test_deleting_removes_every_personal_row_of_the_account_only(
    store: InMemoryAccounts, clock: FakeClock
) -> None:
    gone, kept = make_account(store, "gone_name"), make_account(store, "kept_name")
    open_session(store, gone, HASH_A, clock)
    open_session(store, kept, HASH_B, clock)
    assert reserve(store, gone, HASH_C, clock)
    store.throttle_record([KEY_1, KEY_2], "failure")
    store.delete_personal_rows(gone, KEY_1)
    assert not store.account_exists(gone) and store.find_handle("gone_name") is None
    assert store.session_count(gone) == 0 and store.code_count(gone) == 0
    assert store.grant_statuses(gone) == []
    with pytest.raises(ProfileMissing):
        store.read_profile(user_id=gone, access_token=None)
    assert store.account_exists(kept) and store.read_app_session(HASH_B) is not None
    assert store.throttle_check([KEY_1, KEY_2]) == {KEY_1: 0, KEY_2: 1}  # the IP-style key stays
    store.delete_personal_rows(gone, None)  # repeating is harmless
    make_account(store, "gone_name")  # the name is free again


# --- profile store --------------------------------------------------------------------------------


def test_profile_updates_touch_only_the_five_learner_columns(store: InMemoryAccounts) -> None:
    user_id = make_account(store)
    row = store.update_profile(
        user_id=user_id,
        access_token=None,
        changes={
            "language": "en",
            "session_minutes": 15,
            "reminder_settings": {"inApp": False},
            "pending_settings": {"sessionMinutes": 5, "effectiveDate": "2026-10-05"},
            "time_zone": "Europe/London",
        },
    )
    assert (row.language, row.session_minutes, row.time_zone) == ("en", 15, "Europe/London")
    assert row.reminder_settings == {"inApp": False}
    assert row.pending_settings == {"sessionMinutes": 5, "effectiveDate": "2026-10-05"}
    assert store.read_profile(user_id=user_id, access_token="ignored") == row
    for forbidden in ("terms_version", "terms_accepted_at", "is_demo", "created_at", "user_id"):
        with pytest.raises(ProfileUnavailable):
            store.update_profile(user_id=user_id, access_token=None, changes={forbidden: "x"})
    with pytest.raises(ProfileUnavailable):
        store.update_profile(user_id=user_id, access_token=None, changes={})


def test_the_profile_trigger_rejects_an_unknown_zone_and_the_checks_reject_bad_values(
    store: InMemoryAccounts,
) -> None:
    user_id = make_account(store)
    for changes in (
        {"time_zone": "Mars/Olympus"},
        {"pending_settings": {"timeZone": "Mars/Olympus", "effectiveDate": "2026-10-05"}},
        {"language": "fr"},
        {"session_minutes": 7},
    ):
        with pytest.raises(ProfileValueRejected):
            store.update_profile(user_id=user_id, access_token=None, changes=changes)
    assert store.read_profile(user_id=user_id, access_token=None).language == "ar"  # unchanged
    with pytest.raises(ProfileMissing):
        store.update_profile(user_id=uuid4(), access_token=None, changes={"language": "en"})
    assert store.read_terms_version(user_id=user_id, access_token=None) == "2026-10-04"


def test_the_clock_defaults_to_real_time() -> None:
    store = InMemoryAccounts()
    user_id = make_account(store)
    stamp = store.read_profile(user_id=user_id, access_token=None).created_at
    assert abs((datetime.now(UTC) - stamp).total_seconds()) < 5
    assert "redacted" in repr(store)

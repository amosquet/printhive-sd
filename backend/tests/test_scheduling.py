from datetime import UTC, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pytest

from backend.scheduling import is_shift_eligible


@pytest.mark.parametrize(
    ("start", "duration", "expected"),
    [
        ("2026-11-16T10:00:00", timedelta(hours=1), True),
        ("2026-11-16T15:00:00", timedelta(hours=4), False),  # FR-10 example
        ("2026-11-16T08:00:00", timedelta(hours=1), True),
        ("2026-11-16T07:59:59", timedelta(hours=1), False),
        ("2026-11-16T17:00:00", timedelta(hours=1), False),
        ("2026-11-16T18:00:00", timedelta(hours=1), False),
        ("2026-11-16T16:00:00", timedelta(hours=1, microseconds=-1), True),
        ("2026-11-16T16:00:00", timedelta(hours=1), False),
        ("2026-11-16T16:00:00", timedelta(hours=1, microseconds=1), False),
    ],
)
def test_daytime_shift(start, duration, expected):
    assert (
        is_shift_eligible(
            datetime.fromisoformat(start),
            duration,
            datetime(2026, 11, 16, 8),
            datetime(2026, 11, 16, 17),
        )
        is expected
    )


@pytest.mark.parametrize(
    ("start", "hours", "expected"),
    [
        ("2026-11-16T23:00:00", 2, True),
        ("2026-11-17T01:00:00", 2, True),
        ("2026-11-17T04:00:00", 2, False),
        ("2026-11-17T05:00:00", 2, False),
    ],
)
def test_overnight_shift(start, hours, expected):
    assert (
        is_shift_eligible(
            datetime.fromisoformat(start),
            timedelta(hours=hours),
            datetime(2026, 11, 16, 22),
            datetime(2026, 11, 17, 6),
        )
        is expected
    )


@pytest.mark.parametrize("duration", [timedelta(0), timedelta(seconds=-1)])
def test_invalid_duration(duration):
    with pytest.raises(ValueError, match="duration must be positive"):
        is_shift_eligible(
            datetime(2026, 11, 16, 10),
            duration,
            datetime(2026, 11, 16, 8),
            datetime(2026, 11, 16, 17),
        )


@pytest.mark.parametrize("end_hour", [8, 7])
def test_invalid_shift(end_hour):
    with pytest.raises(ValueError, match="Shift end must be after"):
        is_shift_eligible(
            datetime(2026, 11, 16, 8),
            timedelta(minutes=1),
            datetime(2026, 11, 16, 8),
            datetime(2026, 11, 16, end_hour),
        )


@pytest.mark.parametrize("aware_index", [0, 1, 2])
def test_mixed_timezone_awareness(aware_index):
    times = [datetime(2026, 11, 16, hour) for hour in (10, 8, 17)]
    times[aware_index] = times[aware_index].replace(tzinfo=UTC)
    with pytest.raises(ValueError, match="all naive or all timezone-aware"):
        is_shift_eligible(times[0], timedelta(hours=1), times[1], times[2])


def test_aware_times_with_different_offsets():
    assert is_shift_eligible(
        datetime(2026, 11, 16, 15, tzinfo=UTC),
        timedelta(hours=1),
        datetime(2026, 11, 16, 8, tzinfo=timezone(timedelta(hours=-5))),
        datetime(2026, 11, 16, 17, tzinfo=timezone(timedelta(hours=-5))),
    )


@pytest.mark.parametrize("hours, expected", [(2, True), (3, False)])
def test_elapsed_duration_across_daylight_saving_fallback(hours, expected):
    # Use system IANA data when available; Windows may need the tzdata package.
    try:
        eastern = ZoneInfo("America/Indiana/Indianapolis")
    except ZoneInfoNotFoundError:
        pytest.skip("IANA timezone data is unavailable")
    assert (
        is_shift_eligible(
            datetime(2026, 11, 1, 0, 30, tzinfo=eastern),
            timedelta(hours=hours),
            datetime(2026, 11, 1, 0, tzinfo=eastern),
            datetime(2026, 11, 1, 2, 30, tzinfo=eastern),
        )
        is expected
    )

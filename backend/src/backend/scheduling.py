from datetime import UTC, datetime, timedelta


def is_shift_eligible(
    start_time: datetime,
    duration: timedelta,
    shift_start: datetime,
    shift_end: datetime,
) -> bool:
    """Check FR-10: a print must finish strictly before its active shift ends.

    Supply complete dates, including the next date for overnight shift ends.
    Datetimes must be either all naive in the same local-time convention or
    all timezone-aware. Aware times are compared in UTC for elapsed durations.
    Invalid durations, shift intervals, or mixed awareness raise ValueError.
    """
    times = (start_time, shift_start, shift_end)
    aware = [value.utcoffset() is not None for value in times]
    if any(aware) and not all(aware):
        raise ValueError("Datetimes must be all naive or all timezone-aware")
    if all(aware):
        start_time, shift_start, shift_end = (value.astimezone(UTC) for value in times)
    if duration <= timedelta(0):
        raise ValueError("Print duration must be positive")
    if shift_end <= shift_start:
        raise ValueError("Shift end must be after shift start")

    return shift_start <= start_time < shift_end and duration < shift_end - start_time

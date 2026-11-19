"""Behavioral acceptance tests for the scheduler prerequisite (no hardware)."""

import itertools
import unittest
from datetime import UTC, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from backend.priority_scheduling import (
    PriorityPolicy,
    QueuedJob,
    StaffShift,
    effective_priority,
    eligible_jobs,
    known_total_duration,
    remaining_staffed_seconds,
)

NOW = datetime(2026, 11, 15, 15, tzinfo=UTC)


class SchedulingTests(unittest.TestCase):
    def job(self, job_id="job", *, wait=0, priority=0, duration=60):
        return QueuedJob(job_id, NOW - timedelta(hours=wait), priority, duration)

    def rank(self, jobs, *, now=NOW, shifts=None, rate=1):
        if shifts is None:
            shifts = [StaffShift(NOW, NOW + timedelta(hours=2))]
        return eligible_jobs(jobs, shifts, now=now, policy=PriorityPolicy(rate))

    def test_sdp_four_hour_job_remains_queued_with_two_hours_left(self):
        job = self.job(duration=4 * 3600)
        self.assertEqual(self.rank([job]), ())
        self.assertEqual(job.duration_s, 14400)

    def test_strict_shift_boundary(self):
        jobs = [self.job(str(d), duration=d) for d in (7199, 7200, 7201)]
        self.assertEqual([j.job_id for j in self.rank(jobs)], ["7199"])

    def test_exact_shift_start_and_end(self):
        job = self.job()
        self.assertEqual(self.rank([job]), (job,))
        self.assertEqual(self.rank([job], now=NOW + timedelta(hours=2)), ())

    def test_no_shift_or_future_shift_prevents_eligibility(self):
        self.assertEqual(self.rank([self.job()], shifts=[]), ())
        shifts = [StaffShift(NOW + timedelta(seconds=1), NOW + timedelta(hours=2))]
        self.assertEqual(self.rank([self.job()], shifts=shifts), ())

    def test_unknown_and_invalid_durations_never_authorize_dispatch(self):
        for value in (None, 0, -1, float("nan"), float("inf"), True):
            with self.subTest(duration=value):
                self.assertEqual(self.rank([self.job(duration=value)]), ())

    def test_high_priority_ineligible_job_does_not_block_shorter_job(self):
        long = self.job("long", priority=100, duration=14400)
        short = self.job("short")
        self.assertEqual(self.rank([long, short]), (short,))

    def test_overlapping_and_adjacent_shifts_extend_continuous_coverage(self):
        shifts = [
            StaffShift(NOW + timedelta(hours=1), NOW + timedelta(hours=2)),
            StaffShift(NOW - timedelta(hours=1), NOW + timedelta(minutes=30)),
            StaffShift(NOW + timedelta(minutes=30), NOW + timedelta(hours=1)),
            StaffShift(NOW, NOW + timedelta(minutes=45)),
        ]
        self.assertEqual(remaining_staffed_seconds(shifts, NOW), 7200)

    def test_one_second_staffing_gap_cannot_be_bridged(self):
        shifts = [
            StaffShift(NOW, NOW + timedelta(hours=1)),
            StaffShift(NOW + timedelta(hours=1, seconds=1), NOW + timedelta(hours=3)),
        ]
        self.assertEqual(remaining_staffed_seconds(shifts, NOW), 3600)
        self.assertEqual(self.rank([self.job(duration=3601)], shifts=shifts), ())

    def test_ended_shift_does_not_make_future_shift_active(self):
        shifts = [
            StaffShift(NOW - timedelta(hours=2), NOW),
            StaffShift(NOW + timedelta(seconds=1), NOW + timedelta(hours=1)),
        ]
        self.assertEqual(remaining_staffed_seconds(shifts, NOW), 0)

    def test_overnight_shift(self):
        shift = StaffShift(NOW.replace(hour=23), (NOW + timedelta(days=1)).replace(hour=7))
        clock = (NOW + timedelta(days=1)).replace(hour=1)
        self.assertEqual(remaining_staffed_seconds([shift], clock), 6 * 3600)

    def test_dst_fallback_uses_elapsed_time(self):
        zone = ZoneInfo("America/Indiana/Indianapolis")
        start = datetime(2026, 11, 1, 1, 0, tzinfo=zone, fold=0)
        end = datetime(2026, 11, 1, 2, 0, tzinfo=zone)
        self.assertEqual(remaining_staffed_seconds([StaffShift(start, end)], start), 7200)

    def test_equivalent_timezones_give_same_priority_and_shift_window(self):
        local = NOW.astimezone(timezone(timedelta(hours=-5)))
        self.assertEqual(self.rank([self.job(wait=1)]), self.rank([self.job(wait=1)], now=local))

    def test_priority_formula_and_aging_allow_old_low_priority_job_to_win(self):
        old = self.job("old", wait=4, priority=0)
        new = self.job("new", priority=3)
        self.assertEqual(effective_priority(old, NOW, PriorityPolicy(1)), 4)
        self.assertEqual(self.rank([new, old]), (old, new))

    def test_zero_aging_is_explicit_and_uses_initial_priority(self):
        old = self.job("old", wait=100)
        new = self.job("new", priority=1)
        self.assertEqual(self.rank([old, new], rate=0), (new, old))

    def test_score_then_submission_then_id_are_independent_of_input_order(self):
        older = self.job("z", wait=1, priority=0)
        a = self.job("a", priority=1)
        b = self.job("b", priority=1)
        for order in itertools.permutations((older, a, b)):
            self.assertEqual(self.rank(iter(order)), (older, a, b))

    def test_repeated_ticks_are_pure_and_new_arrivals_can_age(self):
        old = self.job("old", wait=1)
        later = QueuedJob("later", NOW + timedelta(hours=1), 0, 60)
        self.assertEqual(self.rank([old]), self.rank([old]))
        self.assertEqual(self.rank([later, old], now=NOW + timedelta(hours=1)), (old, later))
        self.assertEqual(old.submitted_at, NOW - timedelta(hours=1))

    def test_empty_queue(self):
        self.assertEqual(self.rank([]), ())

    def test_member_durations_must_all_be_known_before_batch_sum(self):
        self.assertEqual(known_total_duration([10, 20, 30.5]), 60.5)
        for values in ([], [10, None], [10, 0], [10, -1], [10, float("nan")],
                       [10, float("inf")], [1e308, 1e308]):
            with self.subTest(values=values):
                self.assertIsNone(known_total_duration(values))

    def test_rejects_duplicate_ids_and_future_submissions_even_outside_shift(self):
        for jobs in ([self.job(), self.job()], [self.job(wait=-1)]):
            with self.subTest(jobs=jobs), self.assertRaises(ValueError):
                self.rank(jobs, shifts=[])

    def test_rejects_naive_timestamps_and_nonpositive_shifts(self):
        naive = NOW.replace(tzinfo=None)
        for start, end in ((naive, NOW), (NOW, naive), (NOW, NOW),
                           (NOW, NOW - timedelta(seconds=1))):
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                StaffShift(start, end)
        with self.assertRaises(ValueError):
            QueuedJob("job", naive, 0, 60)
        with self.assertRaises(ValueError):
            self.rank([], now=naive)

    def test_rejects_invalid_priority_configuration_and_ids(self):
        for value in (-1, float("nan"), float("inf"), True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                PriorityPolicy(value)
        for value in (float("nan"), float("inf"), True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.job(priority=value)
        for job_id in ("", " ", 1):
            with self.subTest(job_id=job_id), self.assertRaises(ValueError):
                self.job(job_id)

    def test_priority_overflow_fails_explicitly(self):
        with self.assertRaises(ValueError):
            self.rank([self.job(wait=100, priority=1e308)], rate=1e308)


if __name__ == "__main__":
    unittest.main()

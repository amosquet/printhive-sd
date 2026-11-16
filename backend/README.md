# PrintHive backend

Python 3.13, managed with `uv`. Scheduling decisions live in
`src/backend/priority_scheduling.py`; see [the scheduling design and integration notes](../doc/Scheduling-Foundation.md).

Run the scheduling acceptance tests from the repository root:

```sh
PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -v
```

The module takes an explicit clock, concrete staff shifts, queued-job metadata,
and a configured priority-aging rate. It returns eligible jobs in priority order.
It does not dispatch prints. PR #4's batching subsystem is a separate pending
integration dependency.

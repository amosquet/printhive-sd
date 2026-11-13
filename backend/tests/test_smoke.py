from backend import main


def test_backend_main_runs(capsys) -> None:
    main()
    captured = capsys.readouterr()
    assert "Hello from backend!" in captured.out

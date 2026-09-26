from publish_service import display_name


def test_known_user() -> None:
    assert display_name({"name": "Pavan"}) == "Pavan"


def test_missing_user_falls_back() -> None:
    assert display_name(None) == "Guest"

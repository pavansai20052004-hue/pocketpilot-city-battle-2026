from pricing import total_after_discount


def test_regular_discount() -> None:
    assert total_after_discount(100, 10) == 90


def test_no_discount_keeps_original_amount() -> None:
    assert total_after_discount(100, None) == 100
